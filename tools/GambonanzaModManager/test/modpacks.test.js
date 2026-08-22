'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../src/main/paths');
const modpacks = require('../src/main/modpacks');

// Each test gets a fresh manager root (modpacks.json + park dirs) and a fresh
// fake game Mods dir - the two sides of the park/unpark swap.

let modsDir;

beforeEach(() => {
  paths.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'gmm-mp-root-')));
  modsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gmm-mp-game-')), 'Mods');
  fs.mkdirSync(modsDir, { recursive: true });
});

function makeMod(dir, folder, extra = {}) {
  const mod = path.join(dir, folder);
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, 'mod.json'), JSON.stringify({ id: folder, entry: 'X.Y', ...extra }));
  fs.writeFileSync(path.join(mod, `${folder}.dll`), 'MZ');
  return mod;
}

function folders(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name).sort();
  } catch {
    return [];
  }
}

test('first load seeds a Default modpack that is active', async () => {
  const data = await modpacks.load();
  assert.equal(data.activeId, 'default');
  assert.equal(data.modpacks.length, 1);
  assert.equal(data.modpacks[0].name, 'Default');
});

test('summary lists the active modpack\'s mods from the game Mods dir', async () => {
  makeMod(modsDir, 'SpeedMod', { name: 'Speed Mod' });
  makeMod(modsDir, 'GambitApi');
  const sum = await modpacks.summary({ modsDir });
  assert.equal(sum.modpacks.length, 1);
  const only = sum.modpacks[0];
  assert.equal(only.active, true);
  assert.equal(only.modCount, 2);
  assert.deepEqual(only.mods.map((m) => m.name), ['GambitApi', 'Speed Mod']);
  assert.equal(only.mods.every((m) => m.enabled), true);
});

test('a disabled mod is still a member, just turned off', async () => {
  makeMod(modsDir, 'SpeedMod', { enabled: false });
  const sum = await modpacks.summary({ modsDir });
  assert.equal(sum.modpacks[0].modCount, 1);
  assert.equal(sum.modpacks[0].mods[0].enabled, false);
});

test('select swaps mods between the game dir and the park dirs', async () => {
  makeMod(modsDir, 'SpeedMod');
  makeMod(modsDir, 'GambitApi');

  const rec = await modpacks.create({ name: 'Fresh' });
  await modpacks.select({ id: rec.id, modsDir });

  // Default's mods are parked; the game dir is now the (empty) new modpack.
  assert.deepEqual(folders(modsDir), []);
  assert.deepEqual(folders(modpacks.parkDir('default')), ['GambitApi', 'SpeedMod']);

  // Mods installed while Fresh is active belong to Fresh...
  makeMod(modsDir, 'Kamikaze');

  // ...and switching back restores Default exactly, parking Fresh's mod.
  await modpacks.select({ id: 'default', modsDir });
  assert.deepEqual(folders(modsDir), ['GambitApi', 'SpeedMod']);
  assert.deepEqual(folders(modpacks.parkDir(rec.id)), ['Kamikaze']);

  const sum = await modpacks.summary({ modsDir });
  assert.equal(sum.activeId, 'default');
  assert.equal(sum.modpacks.find((p) => p.id === rec.id).modCount, 1);
  assert.equal(sum.modpacks.find((p) => p.id === 'default').modCount, 2);
});

test('select without a game dir only changes the bookkeeping', async () => {
  makeMod(modsDir, 'SpeedMod');
  const rec = await modpacks.create({ name: 'NoGame' });
  await modpacks.select({ id: rec.id, modsDir: null });
  // Nothing moved - the mod is still where it was.
  assert.deepEqual(folders(modsDir), ['SpeedMod']);
  assert.equal((await modpacks.load()).activeId, rec.id);
});

test('re-selecting the active modpack drains an interrupted swap', async () => {
  const rec = await modpacks.create({ name: 'Half' });
  await modpacks.select({ id: rec.id, modsDir });
  // Simulate a swap that died halfway: a mod still sitting in the park dir.
  makeMod(modpacks.parkDir(rec.id), 'Straggler');

  await modpacks.select({ id: rec.id, modsDir });
  assert.deepEqual(folders(modsDir), ['Straggler']);
  assert.deepEqual(folders(modpacks.parkDir(rec.id)), []);
});

test('dot-entries stay put during a swap', async () => {
  makeMod(modsDir, 'SpeedMod');
  fs.mkdirSync(path.join(modsDir, '.SpeedMod.replaced-123'), { recursive: true });
  fs.writeFileSync(path.join(modsDir, '.DS_Store'), 'x');

  const rec = await modpacks.create({ name: 'Other' });
  await modpacks.select({ id: rec.id, modsDir });

  assert.deepEqual(folders(modpacks.parkDir('default')), ['SpeedMod']);
  assert.ok(fs.existsSync(path.join(modsDir, '.DS_Store')));
});

test('create validates the name and trims it', async () => {
  await assert.rejects(() => modpacks.create({ name: '   ' }), /needs a name/);
  const rec = await modpacks.create({ name: `  Cool pack ${'x'.repeat(60)}` });
  assert.equal(rec.name.length, 40);
  assert.ok(rec.id.startsWith('p-'));
});

test('rename and describe change the record', async () => {
  const rec = await modpacks.create({ name: 'Old' });
  await modpacks.rename({ id: rec.id, name: 'New' });
  await modpacks.describe({ id: rec.id, summary: 'A fine setup', author: 'me' });
  const data = await modpacks.load();
  const found = data.modpacks.find((p) => p.id === rec.id);
  assert.equal(found.name, 'New');
  assert.equal(found.summary, 'A fine setup');
  assert.equal(found.author, 'me');
  await assert.rejects(() => modpacks.rename({ id: 'nope', name: 'X' }), /no longer exists/);
});

test('remove refuses the active and the last modpack, deletes parked mods', async () => {
  await modpacks.load();
  await assert.rejects(() => modpacks.remove({ id: 'default' }), /selected one cannot be deleted/);

  const rec = await modpacks.create({ name: 'Doomed' });
  makeMod(modpacks.parkDir(rec.id), 'ParkedMod');
  await modpacks.remove({ id: rec.id });
  assert.ok(!fs.existsSync(modpacks.parkDir(rec.id)));
  assert.equal((await modpacks.load()).modpacks.length, 1);
});

test('registryId is recorded on create', async () => {
  const rec = await modpacks.create({ name: 'Packy', registryId: 'gambit-variety-pack' });
  assert.equal(rec.registryId, 'gambit-variety-pack');
  const plain = await modpacks.create({ name: 'Plain' });
  assert.equal(plain.registryId, null);
});

test('touchPlayed stamps the active modpack', async () => {
  await modpacks.load();
  const rec = await modpacks.touchPlayed();
  assert.equal(rec.id, 'default');
  assert.ok(rec.lastPlayedAt);
});

test('select rejects unknown modpacks', async () => {
  await modpacks.load();
  await assert.rejects(() => modpacks.select({ id: 'ghost', modsDir }), /no longer exists/);
});

// ---- texture packs travel with the modpack --------------------------------

test('select reports the texture packs the modpack wears, in order', async () => {
  const rec = await modpacks.create({ name: 'Pretty', texturePackIds: ['tp-abc123', 'tp-def456'] });
  const result = await modpacks.select({ id: rec.id, modsDir });
  assert.deepEqual(result.texturePackIds, ['tp-abc123', 'tp-def456']);

  await modpacks.setTexturePacks({ texturePackIds: ['tp-999999'] });
  assert.deepEqual((await modpacks.active()).texturePackIds, ['tp-999999']);
});

test('the worn stack keeps its order and drops duplicates', async () => {
  const rec = await modpacks.create({ name: 'Stacked' });
  await modpacks.setTexturePacks({ id: rec.id, texturePackIds: ['tp-c', 'tp-a', 'tp-c', 'tp-b'] });
  const found = (await modpacks.load()).modpacks.find((p) => p.id === rec.id);
  assert.deepEqual(found.texturePackIds, ['tp-c', 'tp-a', 'tp-b']);
});

test('setTexturePacks targets the active modpack by default', async () => {
  const rec = await modpacks.create({ name: 'Other' });
  await modpacks.setTexturePacks({ texturePackIds: ['tp-onactive'] });
  const data = await modpacks.load();
  assert.deepEqual(data.modpacks.find((p) => p.id === 'default').texturePackIds, ['tp-onactive']);
  assert.deepEqual(data.modpacks.find((p) => p.id === rec.id).texturePackIds, []);
});

test('forgetTexturePack clears a deleted pack out of every stack, keeping the rest', async () => {
  const a = await modpacks.create({ name: 'A', texturePackIds: ['tp-doomed', 'tp-safe'] });
  const b = await modpacks.create({ name: 'B', texturePackIds: ['tp-doomed'] });
  const c = await modpacks.create({ name: 'C', texturePackIds: ['tp-safe', 'tp-other'] });
  await modpacks.forgetTexturePack('tp-doomed');
  const byId = new Map((await modpacks.load()).modpacks.map((p) => [p.id, p]));
  assert.deepEqual(byId.get(a.id).texturePackIds, ['tp-safe']);
  assert.deepEqual(byId.get(b.id).texturePackIds, []);
  assert.deepEqual(byId.get(c.id).texturePackIds, ['tp-safe', 'tp-other']);
});

test('adoptTexturePacks credits the worn stack to the active modpack, once', async () => {
  // A record migrated from instances.json has no opinion about texture packs.
  fs.mkdirSync(paths.modpacksDir(), { recursive: true });
  fs.writeFileSync(path.join(paths.modpacksDir(), 'modpacks.json'), JSON.stringify({
    activeId: 'default',
    modpacks: [{ id: 'default', name: 'Default' }, { id: 'p-other', name: 'Other' }],
  }));

  await modpacks.adoptTexturePacks(['tp-worn', 'tp-under']);
  let data = await modpacks.load();
  assert.deepEqual(data.modpacks.find((p) => p.id === 'default').texturePackIds, ['tp-worn', 'tp-under']);
  assert.deepEqual(data.modpacks.find((p) => p.id === 'p-other').texturePackIds, []);

  // Second launch: the question has been answered, so nothing moves.
  await modpacks.setTexturePacks({ texturePackIds: [] });
  await modpacks.adoptTexturePacks(['tp-something-else']);
  data = await modpacks.load();
  assert.deepEqual(data.modpacks.find((p) => p.id === 'default').texturePackIds, []);
});

test('a pre-1.7.1 record with a single texturePackId reads as a one-pack stack', async () => {
  fs.mkdirSync(paths.modpacksDir(), { recursive: true });
  fs.writeFileSync(path.join(paths.modpacksDir(), 'modpacks.json'), JSON.stringify({
    activeId: 'default',
    modpacks: [
      { id: 'default', name: 'Default', texturePackId: 'tp-worn' },
      { id: 'p-bare', name: 'Bare', texturePackId: null },
    ],
  }));
  const data = await modpacks.load();
  assert.deepEqual(data.modpacks.find((p) => p.id === 'default').texturePackIds, ['tp-worn']);
  assert.deepEqual(data.modpacks.find((p) => p.id === 'p-bare').texturePackIds, []);
  // Already answered, so adoption leaves them alone.
  await modpacks.adoptTexturePacks(['tp-else']);
  assert.deepEqual((await modpacks.active()).texturePackIds, ['tp-worn']);
});

// ---- migration ------------------------------------------------------------

test('instances.json and its park dirs become modpacks', async () => {
  const legacy = paths.legacyInstancesDir();
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'instances.json'), JSON.stringify({
    activeId: 'i-abc',
    instances: [
      { id: 'default', name: 'Default', modpackId: null, createdAt: '2026-01-01T00:00:00.000Z', lastPlayedAt: null },
      { id: 'i-abc', name: 'Chaos', modpackId: 'gambit-variety-pack', createdAt: '2026-02-02T00:00:00.000Z', lastPlayedAt: null },
    ],
  }));
  makeMod(path.join(legacy, 'default', 'Mods'), 'ParkedMod');

  const data = await modpacks.load();
  assert.equal(data.activeId, 'i-abc');
  assert.deepEqual(data.modpacks.map((p) => p.name), ['Default', 'Chaos']);
  // modpackId was the registry pack an instance came from; that is registryId now.
  assert.equal(data.modpacks[1].registryId, 'gambit-variety-pack');
  // Parked mods came along without being moved out of their own folder.
  assert.deepEqual(folders(modpacks.parkDir('default')), ['ParkedMod']);
  assert.ok(!fs.existsSync(legacy));

  // Migrating is a one-off: the second load reads the new file.
  const again = await modpacks.load();
  assert.equal(again.modpacks.length, 2);
});
