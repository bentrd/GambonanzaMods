'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const net = require('../src/main/net');

test('assertAllowedUrl: GitHub hosts pass', () => {
  assert.ok(net.assertAllowedUrl('https://api.github.com/repos/a/b'));
  assert.ok(net.assertAllowedUrl('https://github.com/a/b/releases/download/v1/m.zip'));
  assert.ok(net.assertAllowedUrl('https://objects.githubusercontent.com/whatever'));
  assert.ok(net.assertAllowedUrl('https://bentrd.github.io/GambonanzaMods/registry/index.json'));
});

test('assertAllowedUrl: anything else is refused', () => {
  assert.throws(() => net.assertAllowedUrl('https://evil.example.com/mod.zip'), /only talks to GitHub/);
  assert.throws(() => net.assertAllowedUrl('http://github.com/a/b'), /non-HTTPS/);
  assert.throws(() => net.assertAllowedUrl('file:///etc/passwd'), /non-HTTPS/);
  assert.throws(() => net.assertAllowedUrl('https://github.com.evil.com/x'), /only talks to GitHub/);
  assert.throws(() => net.assertAllowedUrl('not a url'), /not a valid URL/);
});

test('assertAllowedUrl: requireRepo pins downloads to the claimed repo', () => {
  const good = 'https://github.com/bentrd/GambonanzaMods/releases/download/v1.0.0/SpeedMod.zip';
  assert.ok(net.assertAllowedUrl(good, { requireRepo: 'bentrd/GambonanzaMods' }));

  const wrongRepo = 'https://github.com/somebody/else/releases/download/v1/SpeedMod.zip';
  assert.throws(
    () => net.assertAllowedUrl(wrongRepo, { requireRepo: 'bentrd/GambonanzaMods' }),
    /does not belong to bentrd\/GambonanzaMods/,
  );

  const notARelease = 'https://github.com/bentrd/GambonanzaMods/raw/main/x.zip';
  assert.throws(
    () => net.assertAllowedUrl(notARelease, { requireRepo: 'bentrd/GambonanzaMods' }),
    /does not belong to/,
  );
});
