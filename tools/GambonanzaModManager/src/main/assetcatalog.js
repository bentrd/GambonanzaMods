'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const paths = require('./paths');
const net = require('./net');
const log = require('./log');

// The catalogue of everything a texture pack can replace: 682 sprites and
// textures, and 1229 localised strings in 11 languages.
//
// None of it is read from the player's install. Reading Unity .assets files
// needs UnityPy, which needs Python, which is exactly the hassle this feature
// exists to delete - so the metadata is generated once by a maintainer
// (tools/build-asset-catalog.py) and published to GitHub Pages, and the
// preview PNGs come from the companion site that already hosts one image per
// asset:
//
//   catalog.json  bentrd.github.io/GambonanzaMods/registry/assets/    (has rects)
//   texts.json    same                                                (all languages)
//   <id>.png      bentrd.github.io/GambonanzaAssets/assets/img/       (19 MB of art)
//
// The two agree by construction: the generator reproduces the site's id rule
// exactly, so every id here resolves to an image over there.
//
// Everything is cached on disk under the app's own data directory and served
// to the renderer as data: URLs. That keeps the sandboxed UI off the network
// entirely - it never learns a host name, and the CSP needs no widening.

const CATALOG_URLS = [
  'https://bentrd.github.io/GambonanzaMods/registry/assets/catalog.json',
  'https://raw.githubusercontent.com/bentrd/GambonanzaMods/main/registry/assets/catalog.json',
];

const TEXTS_URLS = [
  'https://bentrd.github.io/GambonanzaMods/registry/assets/texts.json',
  'https://raw.githubusercontent.com/bentrd/GambonanzaMods/main/registry/assets/texts.json',
  // The companion site publishes the same table; it is the upstream of ours.
  'https://bentrd.github.io/GambonanzaAssets/assets/texts.json',
];

const IMAGE_BASE = 'https://bentrd.github.io/GambonanzaAssets/assets/img';

/** Catalogue metadata is small and changes only on a game update. */
const TTL_MS = 12 * 60 * 60 * 1000;

/** A single asset PNG. The biggest in the game is a 1920x1080 boss sheet. */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

const memory = { catalog: null, texts: null };

function cacheDir() {
  return path.join(paths.cacheDir(), 'assets');
}

function imageCacheDir() {
  return path.join(cacheDir(), 'img');
}

/** Ids come from a generated catalogue, but they still index the filesystem. */
function safeId(id) {
  const clean = String(id || '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clean)) throw new Error(`not a valid asset id: ${id}`);
  return clean;
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

/**
 * Fetch the first URL that answers with something usable, falling back to
 * whatever is already cached. Never throws - an offline manager shows the
 * catalogue it saw last time rather than an error page.
 */
async function fetchWithCache(name, urls, validate, { force = false } = {}) {
  const now = Date.now();
  const held = memory[name];
  if (!force && held && now - held.fetchedAt < TTL_MS) return held;

  const file = path.join(cacheDir(), `${name}.json`);
  const cached = await readJson(file);

  if (!force && cached && now - (cached.fetchedAt || 0) < TTL_MS && validate(cached.data)) {
    memory[name] = { data: cached.data, fetchedAt: cached.fetchedAt, source: 'cache' };
    return memory[name];
  }

  for (const url of urls) {
    const res = await net.getJson(url, { accept: 'application/json', timeoutMs: 20000 });
    if (res.ok && validate(res.data)) {
      const record = { data: res.data, fetchedAt: now, source: url };
      await writeJson(file, record).catch(() => {});
      memory[name] = record;
      log.info('assets', `fetched ${name} (build ${res.data.build || '?'})`, { url });
      return record;
    }
    if (!res.ok) log.warn('assets', `${name} from ${url}: ${res.error}`);
  }

  if (cached && validate(cached.data)) {
    memory[name] = { data: cached.data, fetchedAt: cached.fetchedAt, source: 'cache', stale: true };
    return memory[name];
  }
  return null;
}

const validCatalog = (d) => !!d && Array.isArray(d.entries) && d.entries.length > 0;
const validTexts = (d) => !!d && Array.isArray(d.sections) && Array.isArray(d.languages);

async function getCatalog({ force = false } = {}) {
  const record = await fetchWithCache('catalog', CATALOG_URLS, validCatalog, { force });
  if (!record) throw new Error('could not load the asset catalogue - check your internet connection and try again');
  return record;
}

async function getTexts({ force = false } = {}) {
  const record = await fetchWithCache('texts', TEXTS_URLS, validTexts, { force });
  if (!record) throw new Error('could not load the text catalogue - check your internet connection and try again');
  return record;
}

/**
 * What the renderer browses. Entries are trimmed to the fields the UI needs;
 * rects and atlas ids stay in the main process, which is the only side that
 * composites anything.
 */
async function browseCatalog({ force = false } = {}) {
  const { data, source, stale } = await getCatalog({ force });
  return {
    build: data.build,
    counts: data.counts,
    categories: data.categories,
    source,
    stale: !!stale,
    entries: data.entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      name: e.name,
      label: e.label,
      width: e.width,
      height: e.height,
      category: e.category,
      format: e.format,
      compressed: !!e.compressed,
      atlas: e.atlas || null,
      spriteCount: e.spriteCount || 0,
    })),
  };
}

async function browseTexts({ force = false } = {}) {
  const { data, source, stale } = await getTexts({ force });
  return { ...data, source, stale: !!stale };
}

/** The full record, rects included. Used by the compositor, not the UI. */
async function findEntry(id) {
  const { data } = await getCatalog({});
  const entry = data.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`"${id}" is not in the asset catalogue - it may have been renamed by a game update`);
  return entry;
}

/**
 * The original PNG for one asset, cached on disk forever (the catalogue's
 * build id is baked into the folder name, so a game update gets fresh art
 * rather than a stale hit).
 */
const inFlight = new Map();

async function imageFile(id) {
  const clean = safeId(id);
  const { data } = await getCatalog({});
  const dir = path.join(imageCacheDir(), String(data.build || 'unknown'));
  const file = path.join(dir, `${clean}.png`);
  try {
    await fsp.access(file);
    return file;
  } catch { /* not cached yet */ }

  // The grid asks for a preview and the detail pane asks for the same one a
  // moment later. Two downloads to one path collide on net.js's shared .part
  // file and one of them fails with a bare ENOENT, so share the promise.
  const held = inFlight.get(file);
  if (held) return held;

  const pending = net.download(`${IMAGE_BASE}/${clean}.png`, file, {
    maxBytes: MAX_IMAGE_BYTES,
    timeoutMs: 60000,
  }).then(() => file).finally(() => inFlight.delete(file));
  inFlight.set(file, pending);
  return pending;
}

/** True when the companion site publishes art for this id. */
async function hasImage(id) {
  try {
    await imageFile(id);
    return true;
  } catch {
    return false;
  }
}

async function imageBytes(id) {
  return fsp.readFile(await imageFile(id));
}

/** Preview for the renderer. data: URLs keep the UI off the network. */
async function imageDataUrl(id) {
  const bytes = await imageBytes(id);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

/**
 * Several previews in one round trip. A missing image is reported as null
 * rather than failing the batch: the companion site can be one game build
 * behind, and an asset it has not published yet should grey out, not explode.
 */
async function imageDataUrls(ids) {
  const wanted = (Array.isArray(ids) ? ids : []).slice(0, 200);
  const out = {};
  await Promise.all(wanted.map(async (id) => {
    try {
      out[id] = await imageDataUrl(id);
    } catch (err) {
      out[id] = null;
      log.warn('assets', `preview for ${id} unavailable: ${err.message}`);
    }
  }));
  return out;
}

module.exports = {
  getCatalog,
  getTexts,
  browseCatalog,
  browseTexts,
  findEntry,
  imageFile,
  hasImage,
  imageBytes,
  imageDataUrl,
  imageDataUrls,
  safeId,
  IMAGE_BASE,
  CATALOG_URLS,
  TEXTS_URLS,
};
