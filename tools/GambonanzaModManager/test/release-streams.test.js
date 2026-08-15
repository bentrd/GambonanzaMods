'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/main/config');

// The home repo publishes three kinds of release and the manager must only ever
// offer the first two as updates. These used to be told apart by "manager-v* is
// the app, everything else is the framework", which quietly swept a standalone
// mod release into the framework lane.

test('framework tags are plain v<number>', () => {
  assert.ok(config.isFrameworkTag('v1.3.3'));
  assert.ok(config.isFrameworkTag('v2.0.0-rc1'));
  assert.ok(!config.isManagerTag('v1.3.3'));
});

test('manager tags carry the manager-v prefix', () => {
  assert.ok(config.isManagerTag('manager-v1.1.0'));
  assert.ok(!config.isFrameworkTag('manager-v1.1.0'));
});

test('standalone mod releases belong to neither stream', () => {
  for (const tag of ['mod-impatient-v1.0.0', 'mod-spikes-v2.1.0']) {
    assert.ok(!config.isFrameworkTag(tag), `${tag} must not read as a framework release`);
    assert.ok(!config.isManagerTag(tag), `${tag} must not read as a manager release`);
  }
});

test('junk tags are not a framework release', () => {
  for (const tag of ['', null, undefined, 'nightly', 'version-1', 'vNext']) {
    assert.ok(!config.isFrameworkTag(tag), `${tag} must not read as a framework release`);
  }
});
