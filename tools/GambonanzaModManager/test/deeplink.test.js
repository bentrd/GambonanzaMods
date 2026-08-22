'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parse } = require('../src/main/deeplink');

test('the three page types parse', () => {
  assert.deepEqual(parse('gmm://mod/en-passant'), { type: 'mod', id: 'en-passant' });
  assert.deepEqual(parse('gmm://modpack/gambit-variety-pack'), { type: 'modpack', id: 'gambit-variety-pack' });
  assert.deepEqual(parse('gmm://texturepack/midnight-chess'), { type: 'texturepack', id: 'midnight-chess' });
});

test('cosmetic variations are tolerated', () => {
  // trailing slash, no-slash form, case, query/hash noise
  assert.deepEqual(parse('gmm://mod/en-passant/'), { type: 'mod', id: 'en-passant' });
  assert.deepEqual(parse('gmm:mod/en-passant'), { type: 'mod', id: 'en-passant' });
  assert.deepEqual(parse('GMM://MOD/EN-PASSANT'), { type: 'mod', id: 'en-passant' });
  assert.deepEqual(parse('gmm://mod/en-passant?utm=discord#x'), { type: 'mod', id: 'en-passant' });
});

test('everything else is null, never a throw', () => {
  // wrong scheme / type
  assert.equal(parse('https://mod/en-passant'), null);
  assert.equal(parse('gmm://settings/anything'), null);
  assert.equal(parse('gmm://install/mod'), null);
  // ids the registry could never contain
  assert.equal(parse('gmm://mod/UPPER CASE'), null);
  assert.equal(parse('gmm://mod/a'), null);                       // too short
  assert.equal(parse(`gmm://mod/${'a'.repeat(60)}`), null);       // too long
  assert.equal(parse('gmm://mod/-leading-dash'), null);
  assert.equal(parse('gmm://mod/has_underscore'), null);
  // no smuggling paths or extra segments
  assert.equal(parse('gmm://mod/../../etc/passwd'), null);
  assert.equal(parse('gmm://mod/en-passant/extra'), null);
  assert.equal(parse('gmm://mod'), null);
  // junk input
  assert.equal(parse(''), null);
  assert.equal(parse('not a url'), null);
  assert.equal(parse(null), null);
  assert.equal(parse(42), null);
  assert.equal(parse(`gmm://mod/${'a'.repeat(500)}`), null);      // over the length cap
});
