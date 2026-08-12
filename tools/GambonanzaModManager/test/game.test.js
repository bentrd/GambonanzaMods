'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const game = require('../src/main/game');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gmm-test-'));
}

test('parseLibraryFolders: new nested format', () => {
  const vdf = `
"libraryfolders"
{
  "0"
  {
    "path"    "/home/me/.local/share/Steam"
  }
  "1"
  {
    "path"    "D:\\\\SteamLibrary"
    "label"   ""
  }
}`;
  const libs = game.parseLibraryFolders(vdf);
  assert.deepEqual(libs, ['/home/me/.local/share/Steam', 'D:\\SteamLibrary']);
});

test('parseLibraryFolders: legacy flat format', () => {
  const vdf = `
"LibraryFolders"
{
  "TimeNextStatsReport"  "123"
  "1"  "E:\\\\Games\\\\Steam"
}`;
  assert.deepEqual(game.parseLibraryFolders(vdf), ['E:\\Games\\Steam']);
});

test('findManagedDir: macOS app bundle layout', () => {
  const dir = tempDir();
  const managed = path.join(dir, 'Gambonanza.app', 'Contents', 'Resources', 'Data', 'Managed');
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, 'Assembly-CSharp.dll'), 'x');
  assert.equal(game.findManagedDir(dir), managed);
});

test('findManagedDir: windows/linux layout', () => {
  const dir = tempDir();
  const managed = path.join(dir, 'Gambonanza_Data', 'Managed');
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, 'Assembly-CSharp.dll'), 'x');
  assert.equal(game.findManagedDir(dir), managed);
});

test('findManagedDir: rejects folders with no game inside', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'Gambonanza_Data', 'Managed'), { recursive: true });
  // no Assembly-CSharp.dll
  assert.equal(game.findManagedDir(dir), null);
});

test('deriveModsDir: windows layout puts Mods next to the exe', () => {
  const managed = path.join('C:', 'Steam', 'steamapps', 'common', 'Gambonanza', 'Gambonanza_Data', 'Managed');
  const mods = game.deriveModsDir(path.join('C:', 'Steam', 'steamapps', 'common', 'Gambonanza'), managed);
  assert.equal(mods, path.join('C:', 'Steam', 'steamapps', 'common', 'Gambonanza', 'Mods'));
});

test('deriveModsDir: mac layout puts Mods next to the .app', () => {
  const gameDir = '/Users/me/Library/Application Support/Steam/steamapps/common/Gambonanza';
  const managed = path.join(gameDir, 'Gambonanza.app', 'Contents', 'Resources', 'Data', 'Managed');
  assert.equal(game.deriveModsDir(gameDir, managed), path.join(gameDir, 'Mods'));
});

test('normalizePickedPath climbs out of app internals', () => {
  const base = '/x/steamapps/common/Gambonanza';
  assert.equal(game.normalizePickedPath(`${base}/Gambonanza.app`), base);
  assert.equal(game.normalizePickedPath(`${base}/Gambonanza_Data`), base);
  assert.equal(game.normalizePickedPath(`${base}/Gambonanza_Data/Managed`), base);
  assert.equal(game.normalizePickedPath(base), base);
});

test('hasPatchMarker: finds the marker, including across chunk boundaries', async () => {
  const dir = tempDir();
  const plain = path.join(dir, 'plain.dll');
  fs.writeFileSync(plain, Buffer.alloc(4096, 0x41));
  assert.equal(await game.hasPatchMarker(plain), false);

  const marked = path.join(dir, 'marked.dll');
  fs.writeFileSync(marked, Buffer.concat([Buffer.alloc(100), Buffer.from(game.PATCH_MARKER), Buffer.alloc(100)]));
  assert.equal(await game.hasPatchMarker(marked), true);

  // Straddle the 1 MB read boundary on purpose.
  const straddle = path.join(dir, 'straddle.dll');
  const chunk = 1 << 20;
  const before = Buffer.alloc(chunk - 5, 0x42);
  fs.writeFileSync(straddle, Buffer.concat([before, Buffer.from(game.PATCH_MARKER), Buffer.alloc(64)]));
  assert.equal(await game.hasPatchMarker(straddle), true);
});

test('inspect: reports a full picture for a fake patched install', async () => {
  const dir = tempDir();
  const managed = path.join(dir, 'Gambonanza_Data', 'Managed');
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, 'Assembly-CSharp.dll'), `patched ${game.PATCH_MARKER} bytes`);
  fs.writeFileSync(path.join(managed, 'Assembly-CSharp.dll.orig'), 'vanilla bytes');
  for (const dll of game.FRAMEWORK_DLLS) fs.writeFileSync(path.join(managed, dll), 'x');

  const vanillaSha = await game.sha256File(path.join(managed, 'Assembly-CSharp.dll.orig'));
  fs.writeFileSync(path.join(managed, game.INSTALL_FILE), JSON.stringify({
    version: '1.1.0',
    gameAssemblySha256: vanillaSha,
  }));

  const info = await game.inspect(dir);
  assert.equal(info.valid, true);
  assert.equal(info.patched, true);
  assert.equal(info.frameworkComplete, true);
  assert.equal(info.gameUpdated, false);
  assert.equal(info.state, 'patched');
  assert.equal(info.frameworkVersion, '1.1.0');
  assert.equal(info.modsDir, path.join(dir, 'Mods'));
});

test('inspect: detects a Steam update under the patch', async () => {
  const dir = tempDir();
  const managed = path.join(dir, 'Gambonanza_Data', 'Managed');
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, 'Assembly-CSharp.dll'), `patched ${game.PATCH_MARKER}`);
  fs.writeFileSync(path.join(managed, 'Assembly-CSharp.dll.orig'), 'NEW vanilla from steam update');
  for (const dll of game.FRAMEWORK_DLLS) fs.writeFileSync(path.join(managed, dll), 'x');
  fs.writeFileSync(path.join(managed, game.INSTALL_FILE), JSON.stringify({
    version: '1.1.0',
    gameAssemblySha256: 'sha-of-the-OLD-vanilla',
  }));

  const info = await game.inspect(dir);
  assert.equal(info.gameUpdated, true);
  assert.equal(info.state, 'stale');
});

test('inspect: detects a Steam update that wiped the patch marker', async () => {
  // The realistic Steam-update shape: the dll is new vanilla (marker gone),
  // but our framework DLLs and install record survived.
  const dir = tempDir();
  const managed = path.join(dir, 'Gambonanza_Data', 'Managed');
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, 'Assembly-CSharp.dll'), 'brand new vanilla from steam');
  for (const dll of game.FRAMEWORK_DLLS) fs.writeFileSync(path.join(managed, dll), 'x');
  fs.writeFileSync(path.join(managed, game.INSTALL_FILE), JSON.stringify({
    version: '1.1.0',
    gameAssemblySha256: 'sha-of-the-old-vanilla',
  }));

  const info = await game.inspect(dir);
  assert.equal(info.patched, false);
  assert.equal(info.gameUpdated, true);
  assert.equal(info.state, 'stale');
});

test('inspect: unpatched vanilla install', async () => {
  const dir = tempDir();
  const managed = path.join(dir, 'Gambonanza_Data', 'Managed');
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, 'Assembly-CSharp.dll'), 'vanilla');
  const info = await game.inspect(dir);
  assert.equal(info.valid, true);
  assert.equal(info.patched, false);
  assert.equal(info.state, 'unpatched');
});

test('inspect: invalid folder gives a reason, not a throw', async () => {
  const info = await game.inspect(tempDir());
  assert.equal(info.valid, false);
  assert.match(info.reason, /does not look like a Gambonanza install/);
});
