'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { compareTags } = require('../src/main/versions');

test('numeric comparison', () => {
  assert.ok(compareTags('1.2.0', '1.1.9') > 0);
  assert.ok(compareTags('1.10.0', '1.9.0') > 0);
  assert.ok(compareTags('0.9', '1.0') < 0);
  assert.equal(compareTags('1.2.3', '1.2.3'), 0);
});

test('prefixes are ignored', () => {
  assert.equal(compareTags('v1.2.3', '1.2.3'), 0);
  assert.equal(compareTags('manager-v2.0.0', '2.0.0'), 0);
  assert.ok(compareTags('manager-v2.1.0', 'v2.0.9') > 0);
});

test('missing segments count as zero', () => {
  assert.equal(compareTags('1.2', '1.2.0'), 0);
  assert.ok(compareTags('1.2.1', '1.2') > 0);
});

test('pre-release loses to the release', () => {
  assert.ok(compareTags('1.2.0-rc1', '1.2.0') < 0);
  assert.ok(compareTags('1.2.0', '1.2.0-rc1') > 0);
  assert.ok(compareTags('1.2.0-rc2', '1.2.0-rc1') > 0);
});

test('garbage does not throw', () => {
  assert.equal(compareTags('', ''), 0);
  assert.equal(compareTags(null, undefined), 0);
  assert.ok(Number.isFinite(compareTags('abc', 'abd')) || compareTags('abc', 'abd') < 0);
});
