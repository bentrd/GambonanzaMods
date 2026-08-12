'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const zip = require('../src/main/zip');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gmm-zip-'));
}

test('sanitizeEntryName strips traversal and absolute paths', () => {
  assert.equal(zip.sanitizeEntryName('mod/mod.json'), 'mod/mod.json');
  assert.equal(zip.sanitizeEntryName('mod\\windows\\style.dll'), 'mod/windows/style.dll');
  assert.equal(zip.sanitizeEntryName('../../../etc/passwd'), null);
  assert.equal(zip.sanitizeEntryName('a/../../etc/passwd'), null);
  assert.equal(zip.sanitizeEntryName('/absolute/path'), null);
  assert.equal(zip.sanitizeEntryName('C:\\Windows\\evil.dll'), null);
  assert.equal(zip.sanitizeEntryName('a/./b'), 'a/b');
  assert.equal(zip.sanitizeEntryName(''), null);
});

test('isInside', () => {
  assert.equal(zip.isInside('/a/b', '/a/b/c'), true);
  assert.equal(zip.isInside('/a/b', '/a/bc'), false);
  assert.equal(zip.isInside('/a/b', '/a/b'), false);
  assert.equal(zip.isInside('/a/b', '/a/b/../x'), false);
});

test('extract: writes safe entries, skips hostile ones', async () => {
  const dir = tempDir();
  const zipPath = path.join(dir, 'evil.zip');
  const archive = new AdmZip();
  archive.addFile('MyMod/mod.json', Buffer.from('{"id":"m"}'));
  archive.addFile('MyMod/Mod.dll', Buffer.from('MZ fake'));
  // addFile() normalises "../", so smuggle the hostile name in after the fact
  // - same bytes a genuinely malicious zip would carry.
  archive.addFile('placeholder.txt', Buffer.from('gotcha'));
  archive.getEntries().find((e) => e.entryName === 'placeholder.txt').entryName = '../escape.txt';
  archive.writeZip(zipPath);

  const dest = path.join(dir, 'out');
  const written = await zip.extract(zipPath, dest);
  assert.deepEqual(written.sort(), ['MyMod/Mod.dll', 'MyMod/mod.json']);
  assert.ok(!fs.existsSync(path.join(dir, 'escape.txt')));
});

test('findModRoot: finds mod.json at any reasonable depth', () => {
  const dir = tempDir();
  const nested = path.join(dir, 'release', 'MyMod');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'mod.json'), '{}');
  assert.equal(zip.findModRoot(dir), nested);
});

test('findModRoot: falls back to the first folder with a DLL', () => {
  const dir = tempDir();
  const nested = path.join(dir, 'bin');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'Thing.dll'), 'x');
  assert.equal(zip.findModRoot(dir), nested);
});

test('findModRoot: empty archive gives null', () => {
  assert.equal(zip.findModRoot(tempDir()), null);
});
