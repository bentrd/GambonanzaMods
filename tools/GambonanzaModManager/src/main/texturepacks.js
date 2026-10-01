'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const paths = require('./paths');
const log = require('./log');
const net = require('./net');
const png = require('./png');
const zip = require('./zip');
const wav = require('./wav');
const catalog = require('./assetcatalog');

// Resource packs: named sets of image, audio and text overrides, worn in
// precedence order. A modpack points at one of these; switching modpacks switches the
// art with the mods, because "my setup" is both.
//
// On disk:
//
//   <userData>/texturepacks/state.json          which packs are worn, in order
//   <userData>/texturepacks/<id>/resourcepack.json
//   <userData>/texturepacks/<id>/images/<assetId>.png    what the user drew
//   <userData>/texturepacks/<id>/atlases/<atlasId>.png   what the game loads
//   <userData>/texturepacks/.merged/                     the stack, flattened
//
// The two image folders are the whole trick. The game does not draw sprites
// from individual files - it draws them from big sheets, 210 gambit icons on
// one 512x512 texture. So replacing one icon means rewriting that sheet: take
// the pristine one from the catalogue, paste the new icon into its rectangle,
// and hand the whole sheet to the framework. images/ keeps the artwork so it
// stays re-editable and readable to anyone who opens the zip; atlases/ is the
// derived result, regenerated from images/ whenever anything changes.
//
// Doing it here rather than in-game is what keeps the runtime side trivial:
// the framework never has to read pixels back off the GPU, work out a sprite
// rectangle, or reason about colour space. It calls LoadImage and is done.
//
// A pack can also re-cut a sprite: say the game should take it from a different
// rectangle of its sheet, so art painted past the original one shows up. That
// is one record in `sprites` - no pixels - which the framework applies to the
// loaded sprite's mesh. See setCut().
//
// Several packs can be worn at once, first in the list winning. That is the
// reason .merged/ exists, and it is not a nicety: a pack's atlases/ are WHOLE
// sheets, so handing the game two packs that both touch SPR_Gambits would let
// the second sheet paint over the first one's icon and silently lose it.
// Layering has to happen at the level of individual overrides - resolve one
// winner per asset across the stack, then composite those onto the pristine
// sheet exactly once. See buildMerged().

const MANIFEST = 'resourcepack.json';
const LEGACY_MANIFEST = 'texturepack.json';
async function manifestIn(dir) {
  return (await readJson(path.join(dir, MANIFEST))) || readJson(path.join(dir, LEGACY_MANIFEST));
}
const FORMAT_VERSION = 1;

/** Combined download limit for images, text and audio. */
const MAX_PACK_BYTES = 192 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Paths + ids
// ---------------------------------------------------------------------------

function stateFile() {
  return path.join(paths.texturePacksDir(), 'state.json');
}

function packDir(id) {
  return path.join(paths.texturePacksDir(), safePackId(id));
}

function newId() {
  return `tp-${crypto.randomBytes(4).toString('hex')}`;
}

/** Pack ids name directories, so they get the same scrutiny as an asset id. */
function safePackId(id) {
  const clean = String(id || '');
  if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(clean)) throw new Error(`not a valid pack id: ${id}`);
  return clean;
}

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 48);
  if (!n) throw new Error('a resource pack needs a name');
  return n;
}

/** Where the game reads the applied pack from: a sibling of Mods/. */
function gamePackDir(modsDir) {
  return path.join(path.dirname(modsDir), 'ResourcePacks');
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
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await fsp.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

function emptyManifest({ id, name, author = '', gameBuild = null }) {
  const now = new Date().toISOString();
  return {
    formatVersion: FORMAT_VERSION,
    id,
    name,
    author,
    summary: '',
    description: '',
    version: '1.0.0',
    gameBuild,
    createdAt: now,
    updatedAt: now,
    images: [],
    sprites: [],
    texts: [],
    textures: [],
    audio: [],
  };
}

async function readManifest(id) {
  const manifest = await manifestIn(packDir(id));
  if (!manifest) throw new Error('that resource pack no longer exists');
  manifest.images ||= [];
  manifest.sprites ||= [];
  manifest.texts ||= [];
  manifest.textures ||= [];
  manifest.audio ||= [];
  return manifest;
}

async function saveManifest(manifest) {
  manifest.updatedAt = new Date().toISOString();
  await writeJson(path.join(packDir(manifest.id), MANIFEST), manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * `{ activeIds: [...] }`, highest precedence first. Reads the pre-1.7 single
 * `activeId` as a one-element stack, so upgrading keeps whatever was worn.
 */
async function readState() {
  const raw = (await readJson(stateFile())) || {};
  if (Array.isArray(raw.activeIds)) return { activeIds: raw.activeIds.filter(Boolean) };
  return { activeIds: raw.activeId ? [raw.activeId] : [] };
}

async function writeState(state) {
  await writeJson(stateFile(), state);
}

async function dirBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirBytes(full);
    else total += await fsp.stat(full).then((s) => s.size, () => 0);
  }
  return total;
}

/** Everything the Resource packs tab renders from. */
async function summary() {
  const state = await readState();
  const root = paths.texturePacksDir();
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return { activeIds: [], packs: [] };
  }

  const packs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const manifest = await manifestIn(path.join(root, entry.name));
    if (!manifest || manifest.id !== entry.name) continue;
    packs.push({
      id: manifest.id,
      name: manifest.name,
      author: manifest.author || '',
      summary: manifest.summary || '',
      description: manifest.description || '',
      version: manifest.version || '1.0.0',
      gameBuild: manifest.gameBuild || null,
      registryId: manifest.registryId || null,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      imageCount: manifest.images?.length || 0,
      cutCount: manifest.sprites?.length || 0,
      textCount: manifest.texts?.length || 0,
      audioCount: manifest.audio?.length || 0,
      bytes: await dirBytes(path.join(root, entry.name)),
    });
  }
  packs.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  // A pack deleted behind the app's back should not leave a phantom in the
  // stack. `order` is what the UI numbers the cards with.
  const activeIds = state.activeIds.filter((id) => packs.some((p) => p.id === id));
  for (const pack of packs) {
    pack.order = activeIds.indexOf(pack.id);
    pack.active = pack.order >= 0;
  }
  return { activeIds, packs };
}

/** The selected pack's full contents, for the panel under the cards. */
async function detail(id) {
  const manifest = await readManifest(id);
  const state = await readState();
  return {
    ...manifest,
    active: state.activeIds.includes(manifest.id),
    order: state.activeIds.indexOf(manifest.id),
    // Derived payload is an implementation detail; the UI shows sources.
    textures: undefined,
    textureCount: manifest.textures.length,
  };
}

// ---------------------------------------------------------------------------
// Create / rename / delete
// ---------------------------------------------------------------------------

async function create({ name, author = '' } = {}) {
  const clean = cleanName(name);
  const id = newId();
  let gameBuild = null;
  try { gameBuild = (await catalog.getCatalog({})).data.build || null; } catch { /* offline: unknown build */ }

  const manifest = emptyManifest({ id, name: clean, author, gameBuild });
  await fsp.mkdir(path.join(packDir(id), 'images'), { recursive: true });
  await fsp.mkdir(path.join(packDir(id), 'atlases'), { recursive: true });
  await saveManifest(manifest);
  log.info('texturepacks', `created "${clean}" (${id})`);
  return { id, name: clean };
}

async function rename({ id, name }) {
  const manifest = await readManifest(id);
  manifest.name = cleanName(name);
  await saveManifest(manifest);
  return { id: manifest.id, name: manifest.name };
}

/** Free-text fields the publish form edits. */
async function describe({ id, author, summary: text, description, version }) {
  const manifest = await readManifest(id);
  if (author !== undefined) manifest.author = String(author || '').trim().slice(0, 48);
  if (text !== undefined) manifest.summary = String(text || '').trim().slice(0, 140);
  if (description !== undefined) manifest.description = String(description || '').trim().slice(0, 4000);
  if (version !== undefined) manifest.version = String(version || '').trim().slice(0, 20) || '1.0.0';
  await saveManifest(manifest);
  return detail(id);
}

async function remove({ id, modsDir = null }) {
  const state = await readState();
  const manifest = await readManifest(id);
  if (state.activeIds.includes(id)) {
    // Deleting something the game is wearing has to take it off first, or the
    // game keeps loading art whose source is gone. The rest of the stack
    // stays on, and re-flattens without it.
    await setActive({ ids: state.activeIds.filter((x) => x !== id), modsDir });
  }
  await fsp.rm(packDir(id), { recursive: true, force: true });
  log.info('texturepacks', `deleted "${manifest.name}" (${id})`);
  return { id };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Set the worn stack - highest precedence first, empty for none. The applied
 * copy lives inside the game folder, so launching from Steam directly still
 * gets it: the same property that makes modpack switching work.
 */
async function setActive({ ids = [], modsDir = null }) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean))];
  // Fail before touching the game folder, and name the pack that is wrong
  // rather than leaving the caller to guess which of five it was.
  for (const id of wanted) await readManifest(id);

  await writeState({ activeIds: wanted });
  if (modsDir) await syncToGame({ ids: wanted, modsDir });
  log.info('texturepacks', wanted.length ? `wearing ${wanted.join(' > ')}` : 'turned resource packs off');
  return { activeIds: wanted };
}

/**
 * Put the worn stack into the game folder, or clear it.
 *
 * One pack is a straight copy of art it already composited. Two or more have
 * to be flattened first - see buildMerged() for why a copy of both would lose
 * edits rather than layer them.
 */
async function syncToGame({ ids = [], modsDir }) {
  const stack = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  const target = gamePackDir(modsDir);
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.rm(path.join(path.dirname(modsDir), 'TexturePacks'), { recursive: true, force: true });
  if (!stack.length) return { applied: [] };

  const { dir, manifest } = stack.length === 1
    ? { dir: packDir(stack[0]), manifest: await readManifest(stack[0]) }
    : await buildMerged(stack);

  await fsp.mkdir(path.join(target, 'atlases'), { recursive: true });
  for (const texture of [...manifest.textures, ...manifest.audio]) {
    const to = path.join(target, texture.file);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(path.join(dir, texture.file), to);
  }

  // The framework reads only what it needs; editor metadata stays home.
  const runtime = {
    formatVersion: FORMAT_VERSION,
    id: manifest.id,
    name: manifest.name,
    author: manifest.author,
    version: manifest.version,
    gameBuild: manifest.gameBuild,
    textures: manifest.textures,
    sprites: (manifest.sprites || []).map((s) => ({ name: s.name, texture: s.texture, rect: s.rect })),
    audio: manifest.audio,
    texts: manifest.texts.map((t) => ({ section: t.section, key: t.key, values: t.values })),
  };
  await writeJson(path.join(target, MANIFEST), runtime);

  // A manager update can arrive before the framework update. Keep images and
  // text working in older frameworks, which only read TexturePacks/. The new
  // runtime prefers ResourcePacks/; audio never needs a second copy.
  if (runtime.textures.length || runtime.texts.length) {
    const legacy = path.join(path.dirname(modsDir), 'TexturePacks');
    for (const texture of runtime.textures) {
      const to = path.join(legacy, texture.file);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(path.join(target, texture.file), to);
    }
    const { audio, ...legacyRuntime } = runtime;
    await writeJson(path.join(legacy, LEGACY_MANIFEST), legacyRuntime);
  }

  return { applied: stack, textures: manifest.textures.length, sprites: runtime.sprites.length, texts: manifest.texts.length, audio: manifest.audio.length };
}

/** Re-copy whatever is worn. Called after every edit and on startup. */
async function reapply({ modsDir }) {
  if (!modsDir) return { applied: [] };
  const state = await readState();
  return syncToGame({ ids: state.activeIds, modsDir });
}

// ---------------------------------------------------------------------------
// Image overrides
// ---------------------------------------------------------------------------

/**
 * Which sheet an asset ends up rewriting: its atlas if it is a sprite, itself
 * if it is a whole texture. Takes either shape - catalogue entries call the id
 * `id`, the records inside a manifest call it `assetId`.
 */
function targetOf(entry) {
  const self = entry.assetId || entry.id;
  return entry.kind === 'sprite' ? entry.atlasId : self;
}

/**
 * Add or replace one image override.
 *
 * The incoming PNG is scaled to the asset's exact size if it isn't already -
 * nearest-neighbour, because this is pixel art and anything smoother is mush.
 * Handing back `resized` lets the UI say so rather than silently changing
 * someone's artwork.
 */
async function setImage({ id, assetId, bytes }) {
  const manifest = await readManifest(id);
  const entry = await catalog.findEntry(catalog.safeId(assetId));
  // A re-cut sprite is as big as its cut: the art fills the rectangle the game
  // will actually take, not the one the catalogue remembers.
  const rect = entry.kind === 'sprite' ? rectOf(manifest, entry) : null;
  const width = rect ? rect[2] : entry.width;
  const height = rect ? rect[3] : entry.height;
  let image = png.decode(Buffer.from(bytes));
  const resized = image.width !== width || image.height !== height;
  const given = { width: image.width, height: image.height };
  if (resized) image = png.resizeNearest(image, width, height);

  const file = path.join('images', `${entry.id}.png`);
  const record = {
    assetId: entry.id,
    kind: entry.kind,
    name: entry.name,
    label: entry.label,
    category: entry.category,
    width,
    height,
    format: entry.format || null,
    compressed: !!entry.compressed,
    atlasId: entry.kind === 'sprite' ? entry.atlasId : entry.id,
    atlasName: entry.kind === 'sprite' ? entry.atlas : entry.name,
    // Where this art is pasted, for good. Moving the cut afterwards does not
    // drag it along: the pixels stay where they were painted.
    rect,
    base: entry.kind === 'sprite' ? entry.rect : null,
    file,
    addedAt: new Date().toISOString(),
  };
  manifest.images = manifest.images.filter((i) => i.assetId !== entry.id).concat(record);

  // Compose BEFORE anything touches images/. Rebuilding a sheet needs the
  // pristine original, which is a network fetch when the cache has been
  // evicted - and a failure there used to leave the new art on disk with a
  // stale sheet beside it, so the manager showed one thing and the game
  // loaded another until some unrelated edit quietly published it.
  await composeTarget(manifest, targetOf(entry), { [entry.id]: image });

  await fsp.mkdir(path.join(packDir(id), 'images'), { recursive: true });
  await fsp.writeFile(path.join(packDir(id), file), png.encode(image));
  await saveManifest(manifest);
  return { entry: record, resized, given };
}

async function removeImage({ id, assetId }) {
  const manifest = await readManifest(id);
  const record = manifest.images.find((i) => i.assetId === assetId);
  if (!record) return detail(id);

  manifest.images = manifest.images.filter((i) => i.assetId !== assetId);
  // Same order, same reason: the file goes last, once the sheet without it
  // exists. Deleting first and failing to compose would strand the manifest
  // pointing at a file that is no longer there.
  await composeTarget(manifest, record.atlasId);
  await saveManifest(manifest);
  await fsp.rm(path.join(packDir(id), record.file), { force: true });
  return detail(id);
}

// ---------------------------------------------------------------------------
// Re-cut sprites
// ---------------------------------------------------------------------------

/**
 * `[x, y, width, height]` in whole sheet pixels, measured from the BOTTOM left
 * like every rect in the catalogue - or a refusal that says what is wrong.
 */
function cleanRect(rect, entry) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isInteger)) {
    throw new Error('a cut is four whole numbers: left, bottom, width, height');
  }
  const [x, y, w, h] = rect;
  if (w < 1 || h < 1) throw new Error('a cut needs to be at least one pixel each way');
  if (x < 0 || y < 0 || x + w > entry.atlasWidth || y + h > entry.atlasHeight) {
    throw new Error(`that cut runs off the edge of ${entry.atlas} (${entry.atlasWidth}x${entry.atlasHeight})`);
  }
  return [x, y, w, h];
}

/** The rectangle the game takes a sprite from, in this pack. */
function rectOf(manifest, entry) {
  return manifest.sprites.find((s) => s.assetId === entry.id)?.rect || entry.rect;
}

/**
 * Re-cut a sprite: tell the game to take it from a different rectangle of its
 * sheet. This is how a 20x4 mouth becomes a 40x19 one - paint the bigger mouth
 * on the sheet, then widen the cut to take it all in.
 *
 * Nothing is composited. The sheet's pixels are whatever the pack's images
 * make them; the cut only says which of them belong to this sprite. In the
 * game the sprite's original pixels stay exactly where they were on screen and
 * the cut grows (or shrinks) around them.
 */
async function setCut({ id, assetId, rect }) {
  const manifest = await readManifest(id);
  const entry = await catalog.findEntry(catalog.safeId(assetId));
  if (entry.kind !== 'sprite') throw new Error('only a sprite has a cut - a whole sheet is drawn as it is');
  const record = {
    assetId: entry.id,
    name: entry.name,
    label: entry.label,
    category: entry.category,
    atlasId: entry.atlasId,
    texture: entry.atlas,
    rect: cleanRect(rect, entry),
    original: entry.rect,
  };
  manifest.sprites = manifest.sprites.filter((s) => s.assetId !== entry.id).concat(record);
  await saveManifest(manifest);
  return { entry: record };
}

async function removeCut({ id, assetId }) {
  const manifest = await readManifest(id);
  if (!manifest.sprites.some((s) => s.assetId === assetId)) return detail(id);
  manifest.sprites = manifest.sprites.filter((s) => s.assetId !== assetId);
  await saveManifest(manifest);
  return detail(id);
}

/**
 * The game's own art for one asset, to paint over. For a re-cut sprite that is
 * the cut's worth of the vanilla sheet rather than the catalogue's PNG, so the
 * canvas is the size the pack will ask for and the original sits in it exactly
 * where it will stay on screen.
 */
async function originalBytes({ id = null, assetId }) {
  const entry = await catalog.findEntry(catalog.safeId(assetId));
  const cut = id && entry.kind === 'sprite'
    ? (await readManifest(id)).sprites.find((s) => s.assetId === entry.id)
    : null;
  if (!cut) return catalog.imageBytes(entry.id);
  const sheet = png.decode(await catalog.imageBytes(entry.atlasId));
  const [x, y, w, h] = cut.rect;
  return png.encode(png.crop(sheet, x, sheet.height - y - h, w, h));
}

/** A sheet as this pack leaves it: its composited copy, or the game's own. */
async function sheetBytes({ id, assetId }) {
  const manifest = await readManifest(id);
  const entry = await catalog.findEntry(catalog.safeId(assetId));
  if (entry.kind !== 'texture') throw new Error(`${entry.name} is a sprite, not a sheet`);
  const built = manifest.textures.find((t) => t.targetId === entry.id);
  return built ? fsp.readFile(path.join(packDir(id), built.file)) : catalog.imageBytes(entry.id);
}

const GUIDE_GAME = [255, 0, 255, 255];
const GUIDE_PACK = [0, 200, 255, 255];

/**
 * A see-through image the size of a sheet with every sprite's cut outlined on
 * it - a layer to drop over the sheet in an image editor. The outline is the
 * outermost ring of pixels INSIDE each cut: paint on or within it and the game
 * shows it, paint past it and it does not. Cuts this pack changed are drawn in
 * a second colour.
 */
async function guideBytes({ id = null, assetId }) {
  const sheet = await catalog.findEntry(catalog.safeId(assetId));
  if (sheet.kind !== 'texture') throw new Error(`${sheet.name} is a sprite, not a sheet`);
  const cuts = id ? (await readManifest(id)).sprites : [];
  const { data } = await catalog.getCatalog({});
  const guide = { width: sheet.width, height: sheet.height, data: Buffer.alloc(sheet.width * sheet.height * 4) };
  const draw = ([x, y, w, h], colour) => png.outline(guide, x, sheet.height - y - h, w, h, colour);
  const sprites = data.entries.filter((e) => e.kind === 'sprite' && e.atlasId === sheet.id);
  // The pack's own cuts go on last so they are never hidden under a neighbour.
  for (const sprite of sprites) if (!cuts.some((c) => c.assetId === sprite.id)) draw(sprite.rect, GUIDE_GAME);
  for (const cut of cuts) if (cut.atlasId === sheet.id) draw(cut.rect, GUIDE_PACK);
  return png.encode(guide);
}

/**
 * Rebuild one sheet from the pristine original plus every override that lands
 * on it, and record it as the pack's runtime payload.
 *
 * Always from pristine, never incrementally: that is what makes removing an
 * override actually remove it, and what stops two edits to the same sheet from
 * stacking into a mess.
 */
async function composeTarget(manifest, targetId, pending = {}) {
  // targetId comes from the fetched catalogue rather than from the user, but
  // it still names a file inside the pack - validate it like any other id.
  catalog.safeId(targetId);
  const wholeSheet = manifest.images.find((i) => i.kind === 'texture' && i.assetId === targetId);
  const sprites = manifest.images.filter((i) => i.kind === 'sprite' && i.atlasId === targetId);

  const outFile = path.join('atlases', `${targetId}.png`);
  const outPath = path.join(packDir(manifest.id), outFile);

  if (!wholeSheet && !sprites.length) {
    manifest.textures = manifest.textures.filter((t) => t.targetId !== targetId);
    await fsp.rm(outPath, { force: true });
    return;
  }

  const target = await catalog.findEntry(targetId);

  // Base layer: the user's own full-sheet art if they replaced the whole
  // thing, otherwise the vanilla sheet from the catalogue.
  const base = wholeSheet
    ? (pending[wholeSheet.assetId] || png.decode(await fsp.readFile(path.join(packDir(manifest.id), wholeSheet.file))))
    : png.decode(await catalog.imageBytes(targetId));

  if (base.width !== target.width || base.height !== target.height) {
    throw new Error(`${target.name} is ${target.width}x${target.height} but the image is ${base.width}x${base.height}`);
  }

  const sheet = png.clone(base);
  for (const sprite of sprites) {
    // `pending` holds art that has been accepted but not yet written to disk.
    const art = pending[sprite.assetId]
      || png.decode(await fsp.readFile(path.join(packDir(manifest.id), sprite.file)));
    const [x, y, w, h] = sprite.rect;
    // Unity texture rectangles start at the bottom-left; images start at the top.
    png.paste(sheet, art, x, sheet.height - y - h);
  }

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, png.encode(sheet));

  const record = {
    targetId,
    name: target.name,
    label: target.label,
    width: target.width,
    height: target.height,
    format: target.format || null,
    file: outFile.split(path.sep).join('/'),
  };
  manifest.textures = manifest.textures.filter((t) => t.targetId !== targetId).concat(record);
}

// ---------------------------------------------------------------------------
// Flattening a stack of packs
// ---------------------------------------------------------------------------

/** Where the flattened stack is built. Dot-prefixed so summary() skips it. */
function mergedDir() {
  return path.join(paths.texturePacksDir(), '.merged');
}

/**
 * Resolve a worn stack down to one winner per asset and per text key.
 *
 * Highest precedence first, so the FIRST pack to claim something keeps it.
 * This is the whole point of merging at the override level: two packs that
 * each replace one icon on SPR_Gambits contribute one icon each, where
 * layering their finished sheets would have thrown the earlier one away.
 */
async function resolveStack(ids) {
  const audio = new Map();
  const images = new Map();   // assetId -> { record, dir }
  const cuts = new Map();     // assetId -> record
  const texts = new Map();    // section/key/lang -> { section, key, value }
  const packs = [];

  for (const id of ids) {
    const manifest = await readManifest(id);
    packs.push(manifest);
    for (const record of manifest.audio) {
      if (!audio.has(record.assetId)) audio.set(record.assetId, { record, dir: packDir(id) });
    }
    // A cut belongs with the art it was drawn for. Where a higher pack already
    // repainted the sprite, its cut (or its lack of one) is the one that fits
    // those pixels - a lower pack's would frame somebody else's drawing.
    for (const record of manifest.sprites) {
      const ownArt = manifest.images.some((i) => i.assetId === record.assetId);
      const repainted = images.has(record.assetId) || (images.has(record.atlasId) && !ownArt);
      if (!cuts.has(record.assetId) && !repainted) cuts.set(record.assetId, record);
    }
    for (const record of manifest.images) {
      if (!images.has(record.assetId)) images.set(record.assetId, { record, dir: packDir(id) });
    }
    for (const text of manifest.texts) {
      for (const value of text.values || []) {
        const key = `${text.section}\u0000${text.key}\u0000${value.lang}`;
        if (!texts.has(key)) {
          texts.set(key, { section: text.section, key: text.key, original: text.original || '', value });
        }
      }
    }
  }

  // Back into the manifest shape the framework reads: one entry per
  // section/key holding every language that survived the merge.
  const byKey = new Map();
  for (const { section, key, original, value } of texts.values()) {
    const id = `${section}\u0000${key}`;
    if (!byKey.has(id)) byKey.set(id, { section, key, original, values: [] });
    byKey.get(id).values.push(value);
  }

  return { images, cuts, audio, texts: [...byKey.values()], packs };
}

/**
 * Composite one sheet from a resolved stack. Same rules as composeTarget -
 * always from pristine, bottom-left rectangles - except the art for each
 * override is read from whichever pack won it.
 */
async function composeMergedTarget(images, targetId, outDir) {
  catalog.safeId(targetId);
  const layers = [...images.values()].filter(({ record }) => targetOf(record) === targetId);
  const wholeSheet = layers.find(({ record }) => record.kind === 'texture');
  const sprites = layers.filter(({ record }) => record.kind === 'sprite');
  if (!wholeSheet && !sprites.length) return null;

  const target = await catalog.findEntry(targetId);
  const base = wholeSheet
    ? png.decode(await fsp.readFile(path.join(wholeSheet.dir, wholeSheet.record.file)))
    : png.decode(await catalog.imageBytes(targetId));

  if (base.width !== target.width || base.height !== target.height) {
    throw new Error(`${target.name} is ${target.width}x${target.height} but the image is ${base.width}x${base.height}`);
  }

  const sheet = png.clone(base);
  for (const { record, dir } of [...sprites].reverse()) {
    const art = png.decode(await fsp.readFile(path.join(dir, record.file)));
    const [x, y, w, h] = record.rect;
    png.paste(sheet, art, x, sheet.height - y - h);
  }

  const file = path.posix.join('atlases', `${targetId}.png`);
  const outPath = path.join(outDir, 'atlases', `${targetId}.png`);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, png.encode(sheet));

  return {
    targetId,
    name: target.name,
    label: target.label,
    width: target.width,
    height: target.height,
    format: target.format || null,
    file,
  };
}

/**
 * Flatten a worn stack into .merged/ and describe the result like a manifest,
 * so syncToGame can copy it exactly as it copies a single pack.
 *
 * Cached on a signature of "which packs, in what order, last edited when":
 * compositing re-decodes a pristine 2048x2048 sheet per atlas, and re-doing
 * that on every startup and every unrelated edit would be felt.
 */
async function buildMerged(ids) {
  const { images, cuts, audio, texts, packs } = await resolveStack(ids);
  const signature = packs.map((m) => `${m.id}@${m.updatedAt || ''}`).join('|');
  const dir = mergedDir();
  const stampFile = path.join(dir, 'build.json');

  const manifest = {
    formatVersion: FORMAT_VERSION,
    id: 'merged',
    name: packs.length === 2
      ? `${packs[0].name} + ${packs[1].name}`
      : `${packs[0].name} + ${packs.length - 1} more`,
    author: [...new Set(packs.map((m) => m.author).filter(Boolean))].join(', '),
    version: FORMAT_VERSION.toString(),
    // Any pack built against a different game build is the pack's problem to
    // report; the stack claims the newest one anybody built against.
    gameBuild: packs.map((m) => m.gameBuild).filter(Boolean).sort().pop() || null,
    texts,
    sprites: [...cuts.values()],
    textures: [],
    audio: [],
  };

  const cached = await readJson(stampFile);
  if (cached?.signature === signature && Array.isArray(cached.textures) && Array.isArray(cached.audio)) {
    manifest.textures = cached.textures;
    manifest.audio = cached.audio || [];
    return { dir, manifest };
  }

  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(path.join(dir, 'atlases'), { recursive: true });
  for (const targetId of [...new Set([...images.values()].map(({ record }) => targetOf(record)))]) {
    const record = await composeMergedTarget(images, targetId, dir);
    if (record) manifest.textures.push(record);
  }

  for (const { record, dir: source } of audio.values()) {
    await fsp.mkdir(path.join(dir, 'audio'), { recursive: true });
    await fsp.copyFile(path.join(source, record.file), path.join(dir, record.file));
    manifest.audio.push(record);
  }
  await writeJson(stampFile, { signature, textures: manifest.textures, audio: manifest.audio });
  log.info('texturepacks', `flattened ${ids.length} packs into ${manifest.textures.length} sheet(s)`);
  return { dir, manifest };
}

/** Rebuild every sheet. Used after an import, and by the repair path. */
async function recomposeAll(manifest) {
  const targets = [...new Set(manifest.images.map(targetOf))];
  manifest.textures = [];
  for (const target of targets) await composeTarget(manifest, target);
  return manifest;
}

// ---------------------------------------------------------------------------
// Text overrides
// ---------------------------------------------------------------------------

/**
 * `lang` is a game language code, or "*" for every language - which is what
 * most people want, because most people write their joke once in English and
 * expect to see it whatever the game is set to.
 */
async function setText({ id, section, key, lang = '*', value, original = '' }) {
  const manifest = await readManifest(id);
  const cleanSection = String(section || '').trim();
  const cleanKey = String(key || '').trim();
  if (!cleanSection || !cleanKey) throw new Error('pick a string to override first');

  const text = String(value ?? '');
  // An empty override is worse than none: some screens fall back to printing
  // the raw key, which looks like a bug rather than a re-skin.
  if (!text.trim()) throw new Error('the replacement text cannot be empty - remove the override instead');
  if (text.length > 2000) throw new Error('that replacement is too long');

  const code = lang === '*' ? '*' : String(lang).trim();
  const existing = manifest.texts.find((t) => t.section === cleanSection && t.key === cleanKey);
  const record = existing || { section: cleanSection, key: cleanKey, values: [], original: '' };
  record.original = original || record.original || '';
  record.values = record.values.filter((v) => v.lang !== code).concat({ lang: code, value: text });
  if (!existing) manifest.texts.push(record);

  await saveManifest(manifest);
  return { entry: record, markup: markupWarnings(text) };
}

async function removeText({ id, section, key, lang = null }) {
  const manifest = await readManifest(id);
  const record = manifest.texts.find((t) => t.section === section && t.key === key);
  if (!record) return detail(id);
  if (lang) {
    record.values = record.values.filter((v) => v.lang !== lang);
    if (!record.values.length) manifest.texts = manifest.texts.filter((t) => t !== record);
  } else {
    manifest.texts = manifest.texts.filter((t) => t !== record);
  }
  await saveManifest(manifest);
  return detail(id);
}

/**
 * The game rewrites a handful of characters into colour codes before drawing
 * a string (LocalizationManager.RewriteDescription), so an innocent underscore
 * turns into "#F4C530" on screen. Warn rather than mangle or forbid: in a
 * gambit description these characters are exactly how you colour a word.
 */
const COLOUR_SENTINELS = ['&', '|', '∏', '°', '£', '^', '*', '§', '_', '¨', '€', '~', '}', '@', 'Ø', '‡', '∑', 'π', '≈', 'µ', 'æ', 'ƒ', '◊', '∞', '√', '∆', '∂', '©', '∫', '≠'];

function markupWarnings(text) {
  const found = COLOUR_SENTINELS.filter((c) => text.includes(c));
  return found.length ? found : null;
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/**
 * Write the pack out as a zip anyone can hand around: manifest, the artwork,
 * and the composited sheets, so the person receiving it needs no network at
 * all to play with it.
 */
async function exportPack({ id, destPath }) {
  const manifest = await readManifest(id);
  if (!manifest.images.length && !manifest.sprites.length && !manifest.texts.length && !manifest.audio.length) {
    throw new Error('this pack is empty - add something to it first');
  }
  const bytes = await zip.create(packDir(id), destPath, { root: manifest.id });
  log.info('texturepacks', `exported "${manifest.name}" to ${destPath}`, { bytes });
  return { path: destPath, bytes };
}

/**
 * Read one back in. The zip is untrusted: every path is re-derived from the
 * catalogue rather than believed, the manifest is rebuilt field by field, and
 * the sheets are recomposited from the artwork so a doctored atlas cannot
 * smuggle in something the images don't account for.
 */
async function importPack({ zipPath }) {
  const scratch = path.join(paths.tempDir(), `tp-import-${crypto.randomBytes(4).toString('hex')}`);
  try {
    await zip.extract(zipPath, scratch);
    const root = await findPackRoot(scratch);
    if (!root) throw new Error('that zip does not contain a resource pack (no resourcepack.json or texturepack.json inside)');

    const incoming = await manifestIn(root);
    if (!incoming || typeof incoming !== 'object') throw new Error('the pack manifest is unreadable');

    const id = newId();
    const manifest = emptyManifest({
      id,
      name: cleanName(incoming.name || 'Imported pack'),
      author: String(incoming.author || '').trim().slice(0, 48),
      gameBuild: incoming.gameBuild || null,
    });
    manifest.summary = String(incoming.summary || '').trim().slice(0, 140);
    manifest.description = String(incoming.description || '').trim().slice(0, 4000);
    manifest.version = String(incoming.version || '1.0.0').trim().slice(0, 20);

    await fsp.mkdir(path.join(packDir(id), 'images'), { recursive: true });
    await fsp.mkdir(path.join(packDir(id), 'atlases'), { recursive: true });

    let skipped = 0;
    for (const raw of Array.isArray(incoming.sprites) ? incoming.sprites : []) {
      try {
        const entry = await catalog.findEntry(catalog.safeId(raw?.assetId));
        if (entry.kind !== 'sprite') throw new Error(`${entry.name} is not a sprite`);
        manifest.sprites = manifest.sprites.filter((s) => s.assetId !== entry.id).concat({
          assetId: entry.id,
          name: entry.name,
          label: entry.label,
          category: entry.category,
          atlasId: entry.atlasId,
          texture: entry.atlas,
          rect: cleanRect(raw.rect, entry),
          original: entry.rect,
        });
      } catch (err) {
        skipped++;
        log.warn('texturepacks', `import skipped a cut: ${err.message}`);
      }
    }

    for (const raw of Array.isArray(incoming.images) ? incoming.images : []) {
      try {
        const entry = await catalog.findEntry(catalog.safeId(raw?.assetId));
        const source = path.join(root, 'images', `${entry.id}.png`);
        const image = png.decode(await fsp.readFile(source));
        // Art for a re-cut sprite was fitted to the cut it was painted for, which
        // need not be the cut the pack ends up with. Its own rectangle is taken
        // at its word only when it stays on the sheet and is exactly the size of
        // the picture; anything else goes back in at the catalogue's size.
        let rect = entry.kind === 'sprite' ? entry.rect : null;
        const sameBase = Array.isArray(raw.base) && raw.base.length === 4 && raw.base.every((v, i) => v === entry.rect?.[i]);
        if (rect && sameBase) {
          try {
            const claimed = cleanRect(raw.rect, entry);
            if (claimed[2] === image.width && claimed[3] === image.height) rect = claimed;
          } catch { /* not a usable rectangle - the catalogue's it is */ }
        }
        const width = rect ? rect[2] : entry.width;
        const height = rect ? rect[3] : entry.height;
        const fitted = image.width === width && image.height === height
          ? image
          : png.resizeNearest(image, width, height);
        const file = path.join('images', `${entry.id}.png`);
        await fsp.writeFile(path.join(packDir(id), file), png.encode(fitted));
        manifest.images.push({
          assetId: entry.id,
          kind: entry.kind,
          name: entry.name,
          label: entry.label,
          category: entry.category,
          width,
          height,
          format: entry.format || null,
          compressed: !!entry.compressed,
          atlasId: entry.kind === 'sprite' ? entry.atlasId : entry.id,
          atlasName: entry.kind === 'sprite' ? entry.atlas : entry.name,
          rect,
          base: entry.kind === 'sprite' ? entry.rect : null,
          file,
          addedAt: new Date().toISOString(),
        });
      } catch (err) {
        skipped++;
        log.warn('texturepacks', `import skipped an image: ${err.message}`);
      }
    }

    for (const raw of Array.isArray(incoming.audio) ? incoming.audio : []) {
      try {
        const entry = await catalog.findAudioEntry(catalog.safeId(raw?.assetId));
        const bytes = await fsp.readFile(path.join(root, 'audio', `${entry.id}.wav`));
        const info = wav.inspect(bytes);
        const file = `audio/${entry.id}.wav`;
        await fsp.mkdir(path.join(packDir(id), 'audio'), { recursive: true });
        await fsp.writeFile(path.join(packDir(id), file), bytes);
        manifest.audio.push({ assetId: entry.id, name: entry.name, label: entry.label, file, ...info });
      } catch (err) { skipped++; log.warn('texturepacks', `import skipped audio: ${err.message}`); }
    }

    for (const raw of Array.isArray(incoming.texts) ? incoming.texts : []) {
      const section = String(raw?.section || '').trim();
      const key = String(raw?.key || '').trim();
      if (!section || !key || !Array.isArray(raw.values)) { skipped++; continue; }
      const values = raw.values
        .filter((v) => v && typeof v.lang === 'string' && typeof v.value === 'string' && v.value.trim())
        .map((v) => ({ lang: v.lang.slice(0, 8), value: v.value.slice(0, 2000) }));
      if (!values.length) { skipped++; continue; }
      manifest.texts.push({ section, key, values, original: String(raw.original || '').slice(0, 2000) });
    }

    if (!manifest.images.length && !manifest.sprites.length && !manifest.texts.length && !manifest.audio.length) {
      throw new Error('nothing in that pack could be matched to this version of the game');
    }

    await recomposeAll(manifest);
    await saveManifest(manifest);
    log.info('texturepacks', `imported "${manifest.name}" (${id})`, { skipped });
    return { id, name: manifest.name, images: manifest.images.length, cuts: manifest.sprites.length, texts: manifest.texts.length, audio: manifest.audio.length, skipped };
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Install a pack from the registry.
 *
 * The zip comes off the author's own GitHub release, pinned to the repo the
 * registry entry names and checked against the SHA-256 CI recorded when a
 * human reviewed it - the same rules a mod download plays by. What lands is
 * still run through importPack, so the manifest is rebuilt from the catalogue
 * and every sheet is recomposited locally rather than trusted.
 */
async function installFromRegistry({ entry, onProgress = () => {}, signal } = {}) {
  if (!entry?.latest?.asset?.url) throw new Error('that resource pack has no release to download yet');
  // No checksum means CI never got to hash this release, so there is nothing
  // to compare the bytes against. Mods refuse that; so does this.
  if (!entry.latest.asset.sha256) {
    throw new Error('that pack has no verified checksum yet - try again once the registry has caught up with its newest release');
  }

  const file = path.join(paths.tempDir(), `tp-${entry.id}-${crypto.randomBytes(3).toString('hex')}.zip`);
  try {
    onProgress({ step: 'download', message: `Downloading ${entry.name}…`, percent: 0 });
    await net.download(entry.latest.asset.url, file, {
      expectedSha256: entry.latest.asset.sha256,
      requireRepo: entry.repo,
      maxBytes: MAX_PACK_BYTES,
      signal,
      onProgress: ({ received, total }) => onProgress({
        step: 'download',
        message: `Downloading ${entry.name}…`,
        percent: total ? Math.round((received / total) * 100) : null,
      }),
    });

    onProgress({ step: 'unpack', message: 'Unpacking and rebuilding the sheets…', percent: null });
    const result = await importPack({ zipPath: file });

    // Registry metadata is better than whatever the zip claims about itself.
    const manifest = await readManifest(result.id);
    manifest.name = cleanName(entry.name || manifest.name);
    manifest.author = String(entry.author || manifest.author || '').slice(0, 48);
    manifest.summary = String(entry.summary || manifest.summary || '').slice(0, 140);
    manifest.description = String(entry.description || manifest.description || '').slice(0, 4000);
    manifest.registryId = entry.id;
    manifest.version = entry.latest.version || manifest.version;
    await saveManifest(manifest);

    log.info('texturepacks', `installed "${manifest.name}" from the registry (${entry.id})`);
    return { ...result, name: manifest.name, registryId: entry.id };
  } finally {
    await fsp.rm(file, { force: true }).catch(() => {});
  }
}

async function findPackRoot(dir, depth = 0) {
  if (depth > 3) return null;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.some((e) => e.isFile() && (e.name === MANIFEST || e.name === LEGACY_MANIFEST))) return dir;
  for (const sub of entries.filter((e) => e.isDirectory() && !e.name.startsWith('__MACOSX'))) {
    const found = await findPackRoot(path.join(dir, sub.name), depth + 1);
    if (found) return found;
  }
  return null;
}

async function setAudio({ id, assetId, bytes }) {
  const manifest = await readManifest(id);
  const entry = await catalog.findAudioEntry(catalog.safeId(assetId));
  const buffer = Buffer.from(bytes);
  const info = wav.inspect(buffer);
  const file = `audio/${entry.id}.wav`;
  await fsp.mkdir(path.join(packDir(id), 'audio'), { recursive: true });
  await fsp.writeFile(path.join(packDir(id), file), buffer);
  const record = { assetId: entry.id, name: entry.name, label: entry.label, file, ...info };
  manifest.audio = manifest.audio.filter((a) => a.assetId !== entry.id).concat(record);
  await saveManifest(manifest);
  return { entry: record };
}

async function removeAudio({ id, assetId }) {
  const manifest = await readManifest(id);
  const record = manifest.audio.find((a) => a.assetId === assetId);
  if (!record) return detail(id);
  manifest.audio = manifest.audio.filter((a) => a !== record);
  await saveManifest(manifest);
  await fsp.rm(path.join(packDir(id), record.file), { force: true });
  return detail(id);
}

module.exports = {
  setAudio,
  removeAudio,
  MAX_PACK_BYTES,
  FORMAT_VERSION,
  gamePackDir,
  summary,
  detail,
  create,
  rename,
  describe,
  remove,
  setActive,
  reapply,
  syncToGame,
  setImage,
  removeImage,
  setCut,
  removeCut,
  originalBytes,
  sheetBytes,
  guideBytes,
  setText,
  removeText,
  markupWarnings,
  exportPack,
  importPack,
  installFromRegistry,
  recomposeAll,
  safePackId,
  targetOf,
};
