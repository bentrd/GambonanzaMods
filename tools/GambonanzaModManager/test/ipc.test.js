'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The privilege boundary has two halves that are edited separately: preload.js
// names the channels the renderer may call, index.js implements them. Wiring
// only one half fails at runtime, in a click nobody may make for weeks - which
// is exactly how "install a community texture pack" once shipped as a button
// that resolved to nothing. These read both files and compare.

const SRC = path.join(__dirname, '..', 'src');
const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(SRC, 'main', 'index.js'), 'utf8');

const collect = (text, re) => {
  const out = new Set();
  for (const match of text.matchAll(re)) out.add(match[1]);
  return out;
};

const exposed = collect(preload, /invoke\('([^']+)'\)/g);
const handled = collect(main, /\bhandle\('([^']+)'/g);
const events = collect(preload, /EVENT_CHANNELS = new Set\(\[([^\]]*)\]/g);

test('every channel the renderer can call has a handler', () => {
  const missing = [...exposed].filter((channel) => !handled.has(channel)).sort();
  assert.deepEqual(missing, [], `preload exposes channels main does not implement: ${missing.join(', ')}`);
});

test('every handler is reachable from the renderer', () => {
  const unreachable = [...handled].filter((channel) => !exposed.has(channel)).sort();
  assert.deepEqual(unreachable, [], `main implements channels nothing can call: ${unreachable.join(', ')}`);
});

test('the bridge covers the texture pack surface', () => {
  // Named explicitly so deleting one is a decision, not an accident.
  for (const channel of [
    'texturepacks:detail', 'texturepacks:create', 'texturepacks:rename', 'texturepacks:describe',
    'texturepacks:delete', 'texturepacks:setWorn', 'texturepacks:catalog', 'texturepacks:texts',
    'texturepacks:previews', 'texturepacks:packPreview', 'texturepacks:pickImage', 'texturepacks:setImage',
    'texturepacks:removeImage', 'texturepacks:setText', 'texturepacks:removeText',
    'texturepacks:downloadOriginal', 'texturepacks:export', 'texturepacks:import',
    'texturepacks:install', 'texturepacks:publish', 'texturepacks:publishIssueUrl', 'texturepacks:openFolder',
  ]) {
    assert.ok(exposed.has(channel), `preload.js is missing ${channel}`);
    assert.ok(handled.has(channel), `index.js is missing a handler for ${channel}`);
  }
});

test('the event allowlist is not empty and the renderer only listens to it', () => {
  const listed = [...events][0] || '';
  const names = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 3, 'the event channel allowlist looks wrong');
  // Every channel main sends on must be in the allowlist, or the listener throws.
  const sent = collect(main, /\bsend\('([^']+)'/g);
  const notAllowed = [...sent].filter((c) => !names.includes(c)).sort();
  assert.deepEqual(notAllowed, [], `main sends events the preload allowlist rejects: ${notAllowed.join(', ')}`);
});

test('every main-process module the entry point requires resolves', () => {
  for (const match of main.matchAll(/require\('(\.\/[^']+)'\)/g)) {
    assert.doesNotThrow(
      () => require.resolve(path.join(SRC, 'main', match[1])),
      `index.js requires ${match[1]}, which does not exist`,
    );
  }
});

test('main-process modules export everything index.js calls on them', () => {
  // Catches the other half of the same failure: a function written, wired into
  // a handler, and never added to module.exports.
  const modules = {
    texturePacks: require('../src/main/texturepacks'),
    assetCatalog: require('../src/main/assetcatalog'),
  };
  for (const [local, mod] of Object.entries(modules)) {
    const called = collect(main, new RegExp(`\\b${local}\\.([A-Za-z0-9_]+)\\s*\\(`, 'g'));
    for (const fn of called) {
      assert.equal(typeof mod[fn], 'function', `${local}.${fn}() is called in index.js but not exported`);
    }
  }
});
