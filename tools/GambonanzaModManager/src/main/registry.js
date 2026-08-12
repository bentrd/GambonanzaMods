'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const config = require('./config');
const paths = require('./paths');
const net = require('./net');
const log = require('./log');

// The mod list the app browses. Three layers, in order of preference:
//
//   1. The published index on GitHub Pages (CDN, no rate limit, refreshed by
//      CI every few hours and on every registry merge).
//   2. The raw file on raw.githubusercontent.com if Pages is down.
//   3. The copy bundled inside the app at build time, so first launch on an
//      offline machine still shows something instead of a spinner forever.
//
// The fetched copy is cached on disk with its ETag; within the TTL we don't
// even hit the network.

const CACHE_FILE = () => path.join(paths.cacheDir(), 'registry-index.json');

let memory = null; // { index, fetchedAt, source }

async function readCache() {
  try {
    return JSON.parse(await fsp.readFile(CACHE_FILE(), 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(record) {
  await fsp.mkdir(paths.cacheDir(), { recursive: true });
  const tmp = `${CACHE_FILE()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(record));
  await fsp.rename(tmp, CACHE_FILE());
}

async function bundledIndex() {
  // Bundled at build time from ../../registry/index.json (electron-builder
  // copies it into resources). Missing in dev checkouts before first build -
  // fall back to the repo file two directories up so `npm start` works too.
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'registry-index.json'),
    path.join(__dirname, '..', '..', '..', '..', 'registry', 'index.json'),
  ];
  for (const file of candidates) {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch { /* next */ }
  }
  return null;
}

function validIndex(data) {
  return data && typeof data === 'object' && Array.isArray(data.mods);
}

/** When the index was generated, for freshness comparison. 0 = unknown. */
function indexTime(index) {
  const t = Date.parse(index?.generatedAt || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * Get the registry index. `force` skips the TTL (the UI's refresh button).
 * Never throws: worst case is { index: bundled-or-empty, source: 'offline' }.
 */
async function getIndex({ force = false } = {}) {
  const now = Date.now();

  if (!force && memory && now - memory.fetchedAt < config.REGISTRY_TTL_MS) {
    return memory;
  }

  const cached = memory ?? await readCache();
  if (!force && cached && now - (cached.fetchedAt || 0) < config.REGISTRY_TTL_MS && validIndex(cached.index)) {
    memory = cached;
    return cached;
  }

  // The index is served through CDNs (GitHub Pages ~10 min edge cache), so a
  // fetch can hand back an OLDER copy than the one we already have - right
  // after a release, some edges still hold the pre-release index. Never let
  // stale-but-successful responses go backwards: keep the freshest of
  // everything we see, and only accept a fetch that isn't older than the
  // cache. generatedAt (stamped by CI) is the clock.
  const cachedTime = validIndex(cached?.index) ? indexTime(cached.index) : -1;
  let best = null;

  for (const url of config.REGISTRY_URLS) {
    const res = await net.getJson(url, {
      accept: 'application/json',
      etag: cached?.url === url ? cached.etag : null,
      timeoutMs: 15000,
    });
    if (res.ok && res.status === 304 && validIndex(cached?.index)) {
      memory = { ...cached, fetchedAt: now, source: 'network' };
      await writeCache(memory).catch(() => {});
      return memory;
    }
    if (res.ok && validIndex(res.data)) {
      const t = indexTime(res.data);
      if (!best || t > indexTime(best.index)) best = { index: res.data, url, etag: res.etag };
      // Fresh enough (not older than what we have): no need to try more URLs.
      if (t >= cachedTime) break;
      log.warn('registry', `${url} served an index older than the cache (CDN lag) - trying the next source`);
      continue;
    }
    log.warn('registry', `could not fetch ${url}`, res.error || `status ${res.status}`);
  }

  if (best && indexTime(best.index) >= cachedTime) {
    memory = { index: best.index, fetchedAt: now, source: 'network', url: best.url, etag: best.etag };
    await writeCache(memory).catch(() => {});
    return memory;
  }

  if (validIndex(cached?.index)) {
    // Every reachable source was older than the cache - keep the cache, but
    // refresh its clock so we do not hammer the CDN until it catches up.
    memory = { ...cached, fetchedAt: now, source: 'cache-newer' };
    return memory;
  }

  if (best) {
    memory = { index: best.index, fetchedAt: now, source: 'network', url: best.url, etag: best.etag };
    await writeCache(memory).catch(() => {});
    return memory;
  }

  const bundled = await bundledIndex();
  memory = {
    index: validIndex(bundled) ? bundled : { schema: 1, mods: [], count: 0 },
    fetchedAt: 0,
    source: 'offline',
    stale: true,
  };
  return memory;
}

module.exports = { getIndex, indexTime };
