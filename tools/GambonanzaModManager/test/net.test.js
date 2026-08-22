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

// --- redirect handling ------------------------------------------------------
//
// The 3xx range is not all redirects. A conditional request answered with 304
// carries no Location, and treating it as a broken redirect made every cached
// registry fetch log a failure (issue #25).

function withStubbedFetch(responses, fn) {
  const real = global.fetch;
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url, options });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch of ${url}`);
    return next;
  };
  return Promise.resolve(fn(seen)).finally(() => { global.fetch = real; });
}

function stubResponse({ status, headers = {}, body = null }) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: '',
    headers: { get: (name) => (map.has(name.toLowerCase()) ? map.get(name.toLowerCase()) : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const INDEX_URL = 'https://bentrd.github.io/GambonanzaMods/registry/index.json';

test('getJson: a 304 is a cache hit, not a redirect with no destination', async () => {
  await withStubbedFetch([stubResponse({ status: 304 })], async (seen) => {
    const res = await net.getJson(INDEX_URL, { etag: 'W/"abc"', accept: 'application/json' });
    assert.equal(res.ok, true);
    assert.equal(res.status, 304);
    assert.equal(res.data, null);
    assert.equal(res.etag, 'W/"abc"');
    assert.equal(seen[0].options.headers['if-none-match'], 'W/"abc"');
  });
});

test('fetchChecked: real redirects are still followed and re-checked', async () => {
  const responses = [
    stubResponse({ status: 302, headers: { location: 'https://objects.githubusercontent.com/asset' } }),
    stubResponse({ status: 200 }),
  ];
  await withStubbedFetch(responses, async () => {
    const { res, url } = await net.fetchChecked('https://github.com/a/b/releases/download/v1/m.zip');
    assert.equal(res.status, 200);
    assert.equal(url, 'https://objects.githubusercontent.com/asset');
  });
});

test('fetchChecked: a redirect off the allowlist is refused', async () => {
  const responses = [stubResponse({ status: 302, headers: { location: 'https://evil.example.com/m.zip' } })];
  await withStubbedFetch(responses, async () => {
    await assert.rejects(
      net.fetchChecked('https://github.com/a/b/releases/download/v1/m.zip'),
      /only talks to GitHub/,
    );
  });
});

test('fetchChecked: a redirect with no Location is still an error', async () => {
  await withStubbedFetch([stubResponse({ status: 302 })], async () => {
    await assert.rejects(
      net.fetchChecked('https://github.com/a/b/releases/download/v1/m.zip'),
      /redirect with no destination/,
    );
  });
});
