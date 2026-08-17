'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mods = require('../src/main/mods');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gmm-mods-'));
}

function makeInstalled(modsDir, folder, { manifest = {}, receipt = null } = {}) {
  const dir = path.join(modsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({ id: folder, entry: 'X.Y', ...manifest }));
  fs.writeFileSync(path.join(dir, `${folder}.dll`), 'MZ');
  if (receipt) fs.writeFileSync(path.join(dir, mods.RECEIPT), JSON.stringify(receipt));
  return dir;
}

test('listInstalled: reads manifests, receipts and sizes', async () => {
  const dir = tempDir();
  makeInstalled(dir, 'SpeedMod', {
    manifest: { name: 'Speed Mod', version: '1.0.0' },
    receipt: { registryId: 'speed-mod', version: '1.0.0', tag: 'v1.0.0', installedAt: '2026-01-01T00:00:00Z' },
  });
  makeInstalled(dir, 'HandMade', { manifest: { enabled: false } });

  const list = await mods.listInstalled(dir);
  assert.equal(list.length, 2);

  const hand = list.find((m) => m.folder === 'HandMade');
  assert.equal(hand.managed, false);
  assert.equal(hand.enabled, false);

  const speed = list.find((m) => m.folder === 'SpeedMod');
  assert.equal(speed.managed, true);
  assert.equal(speed.registryId, 'speed-mod');
  assert.equal(speed.installedTag, 'v1.0.0');
  assert.ok(speed.bytes > 0);
});

test('listInstalled: missing Mods dir is an empty list', async () => {
  assert.deepEqual(await mods.listInstalled(path.join(tempDir(), 'nope')), []);
});

test('setEnabled flips the manifest flag', async () => {
  const dir = tempDir();
  makeInstalled(dir, 'SpeedMod', { manifest: { enabled: true } });
  await mods.setEnabled({ modsDir: dir, folder: 'SpeedMod', enabled: false });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'SpeedMod', 'mod.json'), 'utf8'));
  assert.equal(manifest.enabled, false);
});

test('uninstall removes the folder and refuses traversal', async () => {
  const dir = tempDir();
  makeInstalled(dir, 'SpeedMod');
  await mods.uninstall({ modsDir: dir, folder: 'SpeedMod' });
  assert.ok(!fs.existsSync(path.join(dir, 'SpeedMod')));

  await assert.rejects(
    () => mods.uninstall({ modsDir: dir, folder: '../outside' }),
    /invalid mod folder name/,
  );
});

test('mergeState: pairs registry entries with installed folders', () => {
  const registry = [
    { id: 'speed-mod', name: 'Speed Mod', folder: 'SpeedMod', latest: { tag: 'v1.1.0', version: '1.1.0', asset: { sha256: 'x' } } },
    { id: 'other', name: 'Other', folder: 'Other', latest: null },
  ];
  const installed = [
    { folder: 'SpeedMod', registryId: 'speed-mod', installedTag: 'v1.0.0', manifest: { name: 'Speed Mod' } },
    { folder: 'Custom', registryId: null, manifest: { name: 'My hack' } },
  ];

  const rows = mods.mergeState(registry, installed);
  const speed = rows.find((r) => r.id === 'speed-mod');
  assert.equal(speed.installed, true);
  assert.equal(speed.updateAvailable, true);
  assert.equal(speed.installable, true);

  const other = rows.find((r) => r.id === 'other');
  assert.equal(other.installed, false);
  assert.equal(other.installable, false);

  const manual = rows.find((r) => r.kind === 'manual');
  assert.equal(manual.folder, 'Custom');
  assert.equal(manual.installed, true);
});

test('mergeState: same tag means no update', () => {
  const registry = [{ id: 'a', name: 'A', folder: 'A', latest: { tag: 'v1.0.0', version: '1.0.0', asset: { sha256: 'x' } } }];
  const installed = [{ folder: 'A', registryId: 'a', installedTag: 'v1.0.0' }];
  assert.equal(mods.mergeState(registry, installed)[0].updateAvailable, false);
});

test('resolveInstallPlan: dependencies come first, installed ones skipped', () => {
  const registry = [
    { id: 'kamikaze', folder: 'Kamikaze', dependencies: ['gambit-api'] },
    { id: 'gambit-api', folder: 'GambitApi', dependencies: [] },
    { id: 'unrelated', folder: 'X', dependencies: [] },
  ];

  let plan = mods.resolveInstallPlan(registry[0], registry, []);
  assert.deepEqual(plan.map((p) => p.id), ['gambit-api', 'kamikaze']);

  plan = mods.resolveInstallPlan(registry[0], registry, [{ folder: 'GambitApi', registryId: 'gambit-api' }]);
  assert.deepEqual(plan.map((p) => p.id), ['kamikaze']);
});

test('resolveInstallPlan: outdated installed dependency is refreshed first', () => {
  const registry = [
    { id: 'kamikaze', folder: 'Kamikaze', dependencies: ['gambit-api'] },
    { id: 'gambit-api', folder: 'GambitApi', dependencies: [], latest: { tag: 'v1.3.3', asset: { sha256: 'x' } } },
  ];

  // Behind the registry -> the dependency is reinstalled ahead of the mod.
  let plan = mods.resolveInstallPlan(registry[0], registry,
    [{ folder: 'GambitApi', registryId: 'gambit-api', installedTag: 'v1.1.0' }]);
  assert.deepEqual(plan.map((p) => p.id), ['gambit-api', 'kamikaze']);

  // Current -> skipped as before.
  plan = mods.resolveInstallPlan(registry[0], registry,
    [{ folder: 'GambitApi', registryId: 'gambit-api', installedTag: 'v1.3.3' }]);
  assert.deepEqual(plan.map((p) => p.id), ['kamikaze']);

  // No receipt tag to compare (manual install) -> leave it alone.
  plan = mods.resolveInstallPlan(registry[0], registry,
    [{ folder: 'GambitApi', registryId: 'gambit-api' }]);
  assert.deepEqual(plan.map((p) => p.id), ['kamikaze']);
});

test('findDependents: catches manifest and registry dependencies, by folder or id', () => {
  const registry = [
    { id: 'gambit-api', folder: 'GambitApi', dependencies: [] },
    { id: 'kamikaze-gambit', folder: 'KamikazeGambit', dependencies: ['gambit-api'] },
  ];
  const installed = [
    { folder: 'GambitApi', registryId: 'gambit-api', manifest: { id: 'GambitApi', name: 'Gambit Creation API' } },
    // depends via manifest, by folder id
    { folder: 'SpikesGambit', registryId: null, manifest: { id: 'SpikesGambit', name: "Spikes' Gambit", dependencies: ['GambitApi'] } },
    // depends via registry entry, by registry id
    { folder: 'KamikazeGambit', registryId: 'kamikaze-gambit', manifest: { id: 'KamikazeGambit', name: 'Kamikaze Gambit' } },
    { folder: 'SpeedMod', registryId: 'speed-mod', manifest: { id: 'SpeedMod', name: 'Speed Mod' } },
  ];

  const dependents = mods.findDependents('GambitApi', registry, installed);
  assert.deepEqual(dependents.sort(), ['Kamikaze Gambit', "Spikes' Gambit"]);

  assert.deepEqual(mods.findDependents('SpeedMod', registry, installed), []);
  assert.deepEqual(mods.findDependents('NotInstalled', registry, installed), []);
});

test('resolveInstallPlan: survives a dependency cycle', () => {
  const a = { id: 'a', folder: 'A', dependencies: ['b'] };
  const b = { id: 'b', folder: 'B', dependencies: ['a'] };
  const plan = mods.resolveInstallPlan(a, [a, b], []);
  assert.deepEqual(plan.map((p) => p.id).sort(), ['a', 'b']);
});

test('resolveModpackPlan: installs missing members with deps, skips current ones', () => {
  const registry = [
    { id: 'gambit-api', name: 'API', folder: 'GambitApi', dependencies: [], latest: { tag: 'v1.0.0', version: '1.0.0', asset: { sha256: 'x' } } },
    { id: 'kamikaze', name: 'Kamikaze', folder: 'Kamikaze', dependencies: ['gambit-api'], latest: { tag: 'v1.0.0', version: '1.0.0', asset: { sha256: 'x' } } },
    { id: 'spikes', name: 'Spikes', folder: 'Spikes', dependencies: ['gambit-api'], latest: { tag: 'v1.0.0', version: '1.0.0', asset: { sha256: 'x' } } },
    { id: 'overlay', name: 'Overlay', folder: 'Overlay', dependencies: [], latest: { tag: 'v2.0.0', version: '2.0.0', asset: { sha256: 'x' } } },
  ];
  const pack = { id: 'pack', mods: ['kamikaze', 'spikes', 'overlay'] };

  // Nothing installed: everything comes, the shared dep exactly once, first.
  let plan = mods.resolveModpackPlan(pack, registry, []);
  assert.deepEqual(plan.map((p) => p.id), ['gambit-api', 'kamikaze', 'spikes', 'overlay']);

  // Overlay current, kamikaze behind: only the update and the missing member
  // (whose dep is already on disk) are planned.
  const installed = [
    { folder: 'GambitApi', registryId: 'gambit-api', installedTag: 'v1.0.0' },
    { folder: 'Kamikaze', registryId: 'kamikaze', installedTag: 'v0.9.0' },
    { folder: 'Overlay', registryId: 'overlay', installedTag: 'v2.0.0' },
  ];
  plan = mods.resolveModpackPlan(pack, registry, installed);
  assert.deepEqual(plan.map((p) => p.id), ['kamikaze', 'spikes']);
});

test('resolveModpackPlan: ignores unknown and uninstallable members', () => {
  const registry = [
    { id: 'real', name: 'Real', folder: 'Real', dependencies: [], latest: { tag: 'v1.0.0', version: '1.0.0', asset: { sha256: 'x' } } },
    { id: 'pending', name: 'Pending', folder: 'Pending', dependencies: [], latest: null },
  ];
  const pack = { id: 'pack', mods: ['real', 'pending', 'vanished'] };
  const plan = mods.resolveModpackPlan(pack, registry, []);
  assert.deepEqual(plan.map((p) => p.id), ['real']);
});
