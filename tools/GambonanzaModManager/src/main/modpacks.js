'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const paths = require('./paths');
const modsApi = require('./mods');
const log = require('./log');

// Modpacks: named setups, exactly one active at a time. A modpack is the whole
// answer to "what is my game right now" - the mods it loads AND the texture
// pack it wears - which is what makes "share my setup" a single object rather
// than a checklist of three tabs.
//
// This used to be two ideas. "Instances" were local loadouts you switched
// between; "modpacks" were registry metadata you installed from. They were the
// same thing seen from two ends, so they are now one: your local modpacks are
// the loadouts, and publishing one is how it becomes a registry entry someone
// else can install.
//
// The trick that keeps every other part of the app (and the game itself)
// oblivious: the ACTIVE modpack's mods simply ARE the game's Mods/ folder, so
// Steam launches, the framework's mod discovery, installs and the mod list all
// keep working untouched. Inactive modpacks hold their mods "parked" under the
// manager's own data directory, and selecting one moves folders between the
// two places.
//
// Corollaries worth spelling out:
//   - Installing a mod always lands in the active modpack, because installing
//     writes to the game's Mods/ folder and that IS the active modpack.
//   - Launching the game from Steam directly still loads the active modpack -
//     there is no "the launcher forgot to sync" failure mode.
//   - A swap is a handful of directory renames on the same disk; worst case
//     (game and app data on different volumes) it degrades to a copy.
//
// The texture pack is a reference, not a copy: the record stores which pack in
// the library this setup wears, and texturepacks.js still owns the art. Two
// modpacks can wear the same pack without duplicating a byte of it.

/** Records file. The park dirs live next to it, one folder per modpack id. */
function registryFile() {
  return path.join(paths.modpacksDir(), 'modpacks.json');
}

/** The pre-1.7 records this module migrates from, once, on first load. */
function legacyFile() {
  return path.join(paths.legacyInstancesDir(), 'instances.json');
}

/** Where a NON-active modpack's mods wait: modpacks/<id>/Mods. */
function parkDir(id) {
  return path.join(paths.modpacksDir(), id, 'Mods');
}

function newId() {
  return `p-${crypto.randomBytes(4).toString('hex')}`;
}

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n) throw new Error('a modpack needs a name');
  return n;
}

function cleanText(value, max) {
  return String(value || '').trim().slice(0, max);
}

/** Normalise one record, filling in fields older files never had. */
function normalize(rec) {
  return {
    id: rec.id,
    name: rec.name,
    author: cleanText(rec.author, 48),
    summary: cleanText(rec.summary, 140),
    description: cleanText(rec.description, 4000),
    // Which texture pack this setup wears. `undefined` means "never asked" -
    // adoptTexturePack() fills it in once, for records migrated from
    // instances.json, so nobody's worn pack silently turns off.
    texturePackId: rec.texturePackId === undefined ? undefined : (rec.texturePackId || null),
    // The registry modpack this was installed from, when it was.
    registryId: rec.registryId || rec.modpackId || null,
    createdAt: rec.createdAt || new Date().toISOString(),
    lastPlayedAt: rec.lastPlayedAt || null,
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function load() {
  const data = await readJson(registryFile());
  if (data && Array.isArray(data.modpacks) && data.modpacks.length) {
    return { activeId: data.activeId, modpacks: data.modpacks.map(normalize) };
  }

  // Migration from instances/. The park dirs are already keyed by the same
  // ids, so the whole thing is one directory rename plus a field rename - not
  // a single mod folder moves. Renaming the directory first means an
  // interrupted migration resumes from the new location on the next launch.
  const legacy = await readJson(legacyFile());
  if (legacy && Array.isArray(legacy.instances) && legacy.instances.length) {
    await adoptLegacyDir();
    const migrated = {
      activeId: legacy.activeId,
      modpacks: legacy.instances.map(normalize),
    };
    await save(migrated);
    await fsp.rm(path.join(paths.modpacksDir(), 'instances.json'), { force: true }).catch(() => {});
    log.info('modpacks', `migrated ${migrated.modpacks.length} instance(s) into modpacks`);
    return migrated;
  }

  // First run: one "Default" modpack that adopts whatever is in the game's
  // Mods/ folder right now. It is active, so adoption needs no file moves.
  const fresh = {
    activeId: 'default',
    modpacks: [normalize({ id: 'default', name: 'Default', texturePackId: null })],
  };
  await save(fresh);
  return fresh;
}

async function save(data) {
  const file = registryFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await fsp.rename(tmp, file);
}

/**
 * Move the whole instances/ folder to modpacks/, park dirs and all. One
 * rename when the destination does not exist yet; otherwise child by child,
 * so a half-finished earlier attempt still ends up complete.
 */
async function adoptLegacyDir() {
  const from = paths.legacyInstancesDir();
  const to = paths.modpacksDir();
  try {
    await moveDir(from, to);
    return;
  } catch { /* destination already exists, or a cross-volume copy failed */ }
  try {
    await fsp.mkdir(to, { recursive: true });
    for (const entry of await fsp.readdir(from)) {
      if (entry === 'instances.json') continue;
      await moveDir(path.join(from, entry), path.join(to, entry))
        .catch((err) => log.warn('modpacks', `could not move ${entry}: ${err.message}`));
    }
    await fsp.rm(from, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    log.warn('modpacks', `could not move the instances folder: ${err.message}`);
  }
}

/** rename() when possible, copy+delete when crossing volumes. */
async function moveDir(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.cp(from, to, { recursive: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

/**
 * Move every mod folder out of `fromDir` into `toDir`. Dot-entries stay put
 * (`.DS_Store`, and mods.js's `.replaced-*` swap debris cleans itself up).
 * Keeps going past individual failures and reports them all at the end, so
 * one locked folder cannot strand the rest of the swap.
 */
async function drain(fromDir, toDir) {
  let entries;
  try {
    entries = await fsp.readdir(fromDir, { withFileTypes: true });
  } catch {
    return; // nothing parked / no Mods dir yet - a valid empty modpack
  }
  const movable = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  if (!movable.length) return;

  await fsp.mkdir(toDir, { recursive: true });
  const failed = [];
  for (const entry of movable) {
    const target = path.join(toDir, entry.name);
    try {
      // A same-named leftover in the destination loses to the incoming copy -
      // the source is always the more recently touched side of the swap.
      await fsp.rm(target, { recursive: true, force: true });
      await moveDir(path.join(fromDir, entry.name), target);
    } catch (err) {
      log.warn('modpacks', `could not move ${entry.name}: ${err.message}`);
      failed.push(entry.name);
    }
  }
  if (failed.length) {
    throw new Error(`could not move ${failed.join(', ')} - close the game and try again`);
  }
}

/**
 * The mods one modpack holds, as the tiles in the contents panel need them.
 * Trimmed down from mods.listInstalled: the panel wants a name, a state and a
 * way back to the registry entry, not an absolute path or a DLL byte count.
 */
async function listMods(dir) {
  const found = await modsApi.listInstalled(dir);
  return found.map((m) => ({
    folder: m.folder,
    name: m.manifest?.name || m.folder,
    version: m.installedVersion || null,
    enabled: m.enabled,
    hasManifest: m.hasManifest,
    registryId: m.registryId,
    managed: m.managed,
  }));
}

/**
 * Everything the UI needs: the records plus each modpack's mods.
 * `modsDir` is the game's Mods folder (null when no valid game is set up) -
 * it answers for the active modpack, the park dirs answer for the rest.
 */
async function summary({ modsDir = null } = {}) {
  const data = await load();
  const list = [];
  for (const rec of data.modpacks) {
    const active = rec.id === data.activeId;
    const dir = active ? modsDir : parkDir(rec.id);
    const mods = dir ? await listMods(dir) : [];
    list.push({
      ...rec,
      texturePackId: rec.texturePackId || null,
      active,
      mods,
      modCount: mods.length,
    });
  }
  return { activeId: data.activeId, modpacks: list };
}

/** The active record, without the mod scan. */
async function active() {
  const data = await load();
  return data.modpacks.find((p) => p.id === data.activeId) || null;
}

async function create({
  name, author = '', summary: text = '', description = '', texturePackId = null, registryId = null,
} = {}) {
  const data = await load();
  const rec = normalize({
    id: newId(),
    name: cleanName(name),
    author,
    summary: text,
    description,
    texturePackId,
    registryId: registryId ? String(registryId).slice(0, 40) : null,
    createdAt: new Date().toISOString(),
  });
  data.modpacks.push(rec);
  await save(data);
  await fsp.mkdir(parkDir(rec.id), { recursive: true });
  log.info('modpacks', `created "${rec.name}" (${rec.id})`);
  return rec;
}

async function rename({ id, name }) {
  return describe({ id, name });
}

/** Edit the record's free-text fields. Only what is passed is touched. */
async function describe({ id, name, author, summary: text, description }) {
  const data = await load();
  const rec = data.modpacks.find((p) => p.id === id);
  if (!rec) throw new Error('that modpack no longer exists');
  if (name !== undefined) rec.name = cleanName(name);
  if (author !== undefined) rec.author = cleanText(author, 48);
  if (text !== undefined) rec.summary = cleanText(text, 140);
  if (description !== undefined) rec.description = cleanText(description, 4000);
  await save(data);
  return rec;
}

async function remove({ id }) {
  const data = await load();
  const rec = data.modpacks.find((p) => p.id === id);
  if (!rec) throw new Error('that modpack no longer exists');
  if (id === data.activeId) throw new Error('switch to another modpack first - the selected one cannot be deleted');
  if (data.modpacks.length === 1) throw new Error('the last modpack cannot be deleted');
  data.modpacks = data.modpacks.filter((p) => p.id !== id);
  await save(data);
  await fsp.rm(path.join(paths.modpacksDir(), id), { recursive: true, force: true });
  log.info('modpacks', `deleted "${rec.name}" (${id})`);
  return { id };
}

/**
 * Make `id` the active modpack. With a valid game: park the outgoing pack's
 * mods, then bring the target's mods into the game's Mods/ folder. Without
 * one, only the bookkeeping changes - the next select with a game present
 * self-heals because draining an empty park dir is a no-op and draining a
 * full one finishes an interrupted swap.
 *
 * Re-selecting the already-active modpack is not an error: it drains any
 * leftovers from an interrupted earlier swap back into the game folder.
 *
 * Returns the record, so the caller can put its texture pack on too.
 */
async function select({ id, modsDir = null }) {
  const data = await load();
  const rec = data.modpacks.find((p) => p.id === id);
  if (!rec) throw new Error('that modpack no longer exists');

  if (modsDir) {
    if (data.activeId && data.activeId !== id) {
      const outgoing = data.modpacks.find((p) => p.id === data.activeId);
      // Park the outgoing modpack only while it still exists; an orphaned
      // activeId (record lost) has nowhere to park and nothing tracking it.
      if (outgoing) await drain(modsDir, parkDir(outgoing.id));
    }
    data.activeId = id;
    await save(data);
    await drain(parkDir(id), modsDir);
  } else {
    data.activeId = id;
    await save(data);
  }
  log.info('modpacks', `selected "${rec.name}" (${id})`);
  return { activeId: id, texturePackId: rec.texturePackId || null, name: rec.name };
}

/** Record which texture pack the active modpack wears. */
async function setTexturePack({ id = null, texturePackId = null } = {}) {
  const data = await load();
  const rec = data.modpacks.find((p) => p.id === (id || data.activeId));
  if (!rec) return null;
  rec.texturePackId = texturePackId || null;
  await save(data);
  return rec;
}

/** A deleted texture pack must not stay referenced by anything. */
async function forgetTexturePack(texturePackId) {
  if (!texturePackId) return;
  const data = await load();
  let touched = false;
  for (const rec of data.modpacks) {
    if (rec.texturePackId === texturePackId) { rec.texturePackId = null; touched = true; }
  }
  if (touched) await save(data);
}

/**
 * One-time reconcile for setups that predate modpacks owning texture packs:
 * the pack the game is currently wearing belongs to whichever setup is active.
 * Records that already answered the question (the key exists, even as null)
 * are left alone, so this is safe to call on every startup.
 */
async function adoptTexturePack(texturePackId) {
  const data = await load();
  let touched = false;
  for (const rec of data.modpacks) {
    if (rec.texturePackId !== undefined) continue;
    rec.texturePackId = rec.id === data.activeId ? (texturePackId || null) : null;
    touched = true;
  }
  if (touched) {
    await save(data);
    log.info('modpacks', `adopted the worn texture pack into "${data.activeId}"`);
  }
}

/** Stamp the active modpack as just-played (the Play button calls this). */
async function touchPlayed() {
  const data = await load();
  const rec = data.modpacks.find((p) => p.id === data.activeId);
  if (rec) {
    rec.lastPlayedAt = new Date().toISOString();
    await save(data);
  }
  return rec || null;
}

module.exports = {
  parkDir,
  load,
  summary,
  active,
  create,
  rename,
  describe,
  remove,
  select,
  setTexturePack,
  forgetTexturePack,
  adoptTexturePack,
  touchPlayed,
};
