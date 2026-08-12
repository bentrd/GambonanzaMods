'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { chooseManagerAsset, currentMacBundle, shq } = require('../src/main/updater');

const ASSETS = [
  { name: 'Gambonanza.Mod.Manager-1.0.1-arm64.dmg' },
  { name: 'Gambonanza.Mod.Manager-1.0.1.dmg' },
  { name: 'Gambonanza.Mod.Manager-1.0.1-arm64-mac.zip' },
  { name: 'Gambonanza.Mod.Manager-1.0.1-mac.zip' },
  { name: 'Gambonanza.Mod.Manager.Setup.1.0.1.exe' },
  { name: 'Gambonanza.Mod.Manager-1.0.1.AppImage' },
];

test('chooseManagerAsset picks the zip (not dmg) per mac arch', () => {
  assert.equal(chooseManagerAsset(ASSETS, 'darwin', 'arm64').name, 'Gambonanza.Mod.Manager-1.0.1-arm64-mac.zip');
  assert.equal(chooseManagerAsset(ASSETS, 'darwin', 'x64').name, 'Gambonanza.Mod.Manager-1.0.1-mac.zip');
});

test('chooseManagerAsset windows and linux', () => {
  assert.equal(chooseManagerAsset(ASSETS, 'win32', 'x64').name, 'Gambonanza.Mod.Manager.Setup.1.0.1.exe');
  assert.equal(chooseManagerAsset(ASSETS, 'linux', 'x64').name, 'Gambonanza.Mod.Manager-1.0.1.AppImage');
});

test('chooseManagerAsset degrades gracefully', () => {
  assert.equal(chooseManagerAsset([], 'darwin', 'arm64'), undefined);
  assert.equal(chooseManagerAsset(ASSETS, 'freebsd', 'x64'), null);
  // arm64 mac with only an x64 zip published still gets a build (Rosetta).
  const onlyX64 = [{ name: 'App-1.0.1-mac.zip' }];
  assert.equal(chooseManagerAsset(onlyX64, 'darwin', 'arm64').name, 'App-1.0.1-mac.zip');
});

test('currentMacBundle extracts the .app root', () => {
  assert.equal(
    currentMacBundle('/Applications/Gambonanza Mod Manager.app/Contents/MacOS/Gambonanza Mod Manager'),
    '/Applications/Gambonanza Mod Manager.app',
  );
  assert.equal(currentMacBundle('/usr/bin/whatever'), null);
});

test('shq quotes shell metacharacters safely', () => {
  assert.equal(shq('/Applications/My App.app'), `'/Applications/My App.app'`);
  assert.equal(shq(`it's.app`), `'it'\\''s.app'`);
  // command substitution stays inert inside single quotes
  assert.ok(shq('$(rm -rf /)').startsWith(`'`));
});
