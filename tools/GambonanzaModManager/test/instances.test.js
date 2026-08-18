'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../src/main/paths');
const instances = require('../src/main/instances');

// Each test gets a fresh manager root (instances.json + park dirs) and a
// fresh fake game Mods dir - the two sides of the park/unpark swap.

let modsDir;

beforeEach(() => {
  paths.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'gmm-inst-root-')));
  modsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gmm-inst-game-')), 'Mods');
  fs.mkdirSync(modsDir, { recursive: true });
});

function makeMod(dir, folder) {
  const mod = path.join(dir, folder);
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, 'mod.json'), JSON.stringify({ id: folder, entry: 'X.Y' }));
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

test('first load seeds a Default instance that is active', async () => {
  const data = await instances.load();
  assert.equal(data.activeId, 'default');
  assert.equal(data.instances.length, 1);
  assert.equal(data.instances[0].name, 'Default');
});

test('summary counts the active instance from the game Mods dir', async () => {
  makeMod(modsDir, 'SpeedMod');
  makeMod(modsDir, 'GambitApi');
  const sum = await instances.summary({ modsDir });
  assert.equal(sum.instances.length, 1);
  assert.equal(sum.instances[0].active, true);
  assert.equal(sum.instances[0].modCount, 2);
});

test('select swaps mods between the game dir and the park dirs', async () => {
  makeMod(modsDir, 'SpeedMod');
  makeMod(modsDir, 'GambitApi');

  const rec = await instances.create({ name: 'Fresh' });
  await instances.select({ id: rec.id, modsDir });

  // Default's mods are parked; the game dir is now the (empty) new instance.
  assert.deepEqual(folders(modsDir), []);
  assert.deepEqual(folders(instances.parkDir('default')), ['GambitApi', 'SpeedMod']);

  // Mods installed while Fresh is active belong to Fresh...
  makeMod(modsDir, 'Kamikaze');

  // ...and switching back restores Default exactly, parking Fresh's mod.
  await instances.select({ id: 'default', modsDir });
  assert.deepEqual(folders(modsDir), ['GambitApi', 'SpeedMod']);
  assert.deepEqual(folders(instances.parkDir(rec.id)), ['Kamikaze']);

  const sum = await instances.summary({ modsDir });
  assert.equal(sum.activeId, 'default');
  assert.equal(sum.instances.find((i) => i.id === rec.id).modCount, 1);
  assert.equal(sum.instances.find((i) => i.id === 'default').modCount, 2);
});

test('select without a game dir only changes the bookkeeping', async () => {
  makeMod(modsDir, 'SpeedMod');
  const rec = await instances.create({ name: 'NoGame' });
  await instances.select({ id: rec.id, modsDir: null });
  // Nothing moved - the mod is still where it was.
  assert.deepEqual(folders(modsDir), ['SpeedMod']);
  assert.equal((await instances.load()).activeId, rec.id);
});

test('re-selecting the active instance drains an interrupted swap', async () => {
  const rec = await instances.create({ name: 'Half' });
  await instances.select({ id: rec.id, modsDir });
  // Simulate a swap that died halfway: a mod still sitting in the park dir.
  makeMod(instances.parkDir(rec.id), 'Straggler');

  await instances.select({ id: rec.id, modsDir });
  assert.deepEqual(folders(modsDir), ['Straggler']);
  assert.deepEqual(folders(instances.parkDir(rec.id)), []);
});

test('dot-entries stay put during a swap', async () => {
  makeMod(modsDir, 'SpeedMod');
  fs.mkdirSync(path.join(modsDir, '.SpeedMod.replaced-123'), { recursive: true });
  fs.writeFileSync(path.join(modsDir, '.DS_Store'), 'x');

  const rec = await instances.create({ name: 'Other' });
  await instances.select({ id: rec.id, modsDir });

  assert.deepEqual(folders(instances.parkDir('default')), ['SpeedMod']);
  assert.ok(fs.existsSync(path.join(modsDir, '.DS_Store')));
  assert.ok(fs.existsSync(path.join(modsDir, '.SpeedMod.replaced-123')));
});

test('create validates the name and trims it', async () => {
  await assert.rejects(() => instances.create({ name: '   ' }), /needs a name/);
  const rec = await instances.create({ name: `  Cool pack ${'x'.repeat(60)}` });
  assert.equal(rec.name.length, 40);
  assert.ok(rec.id.startsWith('i-'));
});

test('rename changes the record', async () => {
  const rec = await instances.create({ name: 'Old' });
  await instances.rename({ id: rec.id, name: 'New' });
  const data = await instances.load();
  assert.equal(data.instances.find((i) => i.id === rec.id).name, 'New');
  await assert.rejects(() => instances.rename({ id: 'nope', name: 'X' }), /no longer exists/);
});

test('remove refuses the active and the last instance, deletes parked mods', async () => {
  await instances.load();
  await assert.rejects(() => instances.remove({ id: 'default' }), /selected one cannot be deleted/);

  const rec = await instances.create({ name: 'Doomed' });
  makeMod(instances.parkDir(rec.id), 'ParkedMod');
  await instances.remove({ id: rec.id });
  assert.ok(!fs.existsSync(instances.parkDir(rec.id)));
  assert.equal((await instances.load()).instances.length, 1);
});

test('modpackId is recorded on create', async () => {
  const rec = await instances.create({ name: 'Packy', modpackId: 'gambit-variety-pack' });
  assert.equal(rec.modpackId, 'gambit-variety-pack');
  const plain = await instances.create({ name: 'Plain' });
  assert.equal(plain.modpackId, null);
});

test('touchPlayed stamps the active instance', async () => {
  await instances.load();
  const rec = await instances.touchPlayed();
  assert.equal(rec.id, 'default');
  assert.ok(rec.lastPlayedAt);
});

test('select rejects unknown instances', async () => {
  await instances.load();
  await assert.rejects(() => instances.select({ id: 'ghost', modsDir }), /no longer exists/);
});
