'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/main/store');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gmm-store-')), 'settings.json');
}

test('defaults on first run, persistence after', () => {
  const file = tempFile();
  const store = new Store(file);
  assert.equal(store.get('gamePath'), '');
  assert.equal(store.get('autoCheckUpdates'), true);

  store.set('gamePath', '/games/Gambonanza');
  const reloaded = new Store(file);
  assert.equal(reloaded.get('gamePath'), '/games/Gambonanza');
});

test('corrupt settings file falls back to defaults', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{not json');
  const store = new Store(file);
  assert.equal(store.get('autoCheckUpdates'), true);
});

test('unknown keys are rejected and never persisted', () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ gamePath: '/x', injected: 'nope' }));
  const store = new Store(file);
  assert.equal(store.get('gamePath'), '/x');
  assert.equal(store.data.injected, undefined);
  assert.throws(() => store.set('injected', 1), /unknown setting/);
});

test('publicView hides the GitHub token', () => {
  const store = new Store(tempFile());
  store.set('githubToken', 'ghp_secret');
  const view = store.publicView();
  assert.equal(view.githubToken, undefined);
  assert.equal(view.githubSignedIn, true);
});
