'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const paths = require('./paths');
const log = require('./log');

// Instances: named mod loadouts, exactly one active at a time - the same idea
// as Minecraft launcher profiles. The trick that keeps every other part of the
// app (and the game itself) oblivious: the ACTIVE instance's mods simply ARE
// the game's Mods/ folder, so Steam launches, the framework's mod discovery,
// installs and the My-mods list all keep working untouched. Inactive
// instances hold their mods "parked" under the manager's own data directory,
// and selecting an instance moves folders between the two places.
//
// Corollaries worth spelling out:
//   - Installing a mod always lands in the selected instance, because
//     installing writes to the game's Mods/ folder and that IS the instance.
//   - Launching the game from Steam directly still loads the selected
//     instance - there is no "the launcher forgot to sync" failure mode.
//   - A swap is a handful of directory renames on the same disk; worst case
//     (game and app data on different volumes) it degrades to a copy.

/** Records file. The park dirs live next to it, one folder per instance id. */
function registryFile() {
  return path.join(paths.instancesDir(), 'instances.json');
}

/** Where a NON-active instance's mods wait: instances/<id>/Mods. */
function parkDir(id) {
  return path.join(paths.instancesDir(), id, 'Mods');
}

function newId() {
  return `i-${crypto.randomBytes(4).toString('hex')}`;
}

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n) throw new Error('an instance needs a name');
  return n;
}

async function load() {
  try {
    const data = JSON.parse(await fsp.readFile(registryFile(), 'utf8'));
    if (data && Array.isArray(data.instances) && data.instances.length) return data;
  } catch { /* first run or unreadable - reseed below */ }
  // First run: one "Default" instance that adopts whatever is in the game's
  // Mods/ folder right now. It is active, so adoption needs no file moves.
  const data = {
    activeId: 'default',
    instances: [{ id: 'default', name: 'Default', modpackId: null, createdAt: new Date().toISOString(), lastPlayedAt: null }],
  };
  await save(data);
  return data;
}

async function save(data) {
  const file = registryFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await fsp.rename(tmp, file);
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
    return; // nothing parked / no Mods dir yet - a valid empty instance
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
      log.warn('instances', `could not move ${entry.name}: ${err.message}`);
      failed.push(entry.name);
    }
  }
  if (failed.length) {
    throw new Error(`could not move ${failed.join(', ')} - close the game and try again`);
  }
}

/** Count the mod folders an instance holds (non-dot directories). */
async function countMods(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).length;
  } catch {
    return 0;
  }
}

/**
 * Everything the UI needs: the records plus a live mod count per instance.
 * `modsDir` is the game's Mods folder (null when no valid game is set up) -
 * it answers for the active instance, the park dirs answer for the rest.
 */
async function summary({ modsDir = null } = {}) {
  const data = await load();
  const list = [];
  for (const rec of data.instances) {
    const active = rec.id === data.activeId;
    list.push({
      ...rec,
      active,
      modCount: await countMods(active ? modsDir : parkDir(rec.id)),
    });
  }
  return { activeId: data.activeId, instances: list };
}

async function create({ name, modpackId = null } = {}) {
  const data = await load();
  const rec = {
    id: newId(),
    name: cleanName(name),
    modpackId: modpackId ? String(modpackId).slice(0, 40) : null,
    createdAt: new Date().toISOString(),
    lastPlayedAt: null,
  };
  data.instances.push(rec);
  await save(data);
  await fsp.mkdir(parkDir(rec.id), { recursive: true });
  log.info('instances', `created "${rec.name}" (${rec.id})`);
  return rec;
}

async function rename({ id, name }) {
  const data = await load();
  const rec = data.instances.find((i) => i.id === id);
  if (!rec) throw new Error('that instance no longer exists');
  rec.name = cleanName(name);
  await save(data);
  return rec;
}

async function remove({ id }) {
  const data = await load();
  const rec = data.instances.find((i) => i.id === id);
  if (!rec) throw new Error('that instance no longer exists');
  if (id === data.activeId) throw new Error('switch to another instance first - the selected one cannot be deleted');
  if (data.instances.length === 1) throw new Error('the last instance cannot be deleted');
  data.instances = data.instances.filter((i) => i.id !== id);
  await save(data);
  await fsp.rm(path.join(paths.instancesDir(), id), { recursive: true, force: true });
  log.info('instances', `deleted "${rec.name}" (${id})`);
  return { id };
}

/**
 * Make `id` the selected instance. With a valid game: park the current
 * instance's mods, then bring the target's mods into the game's Mods/
 * folder. Without one, only the bookkeeping changes - the next select with
 * a game present self-heals because draining an empty park dir is a no-op
 * and draining a full one finishes an interrupted swap.
 *
 * Re-selecting the already-active instance is not an error: it drains any
 * leftovers from an interrupted earlier swap back into the game folder.
 */
async function select({ id, modsDir = null }) {
  const data = await load();
  const rec = data.instances.find((i) => i.id === id);
  if (!rec) throw new Error('that instance no longer exists');

  if (modsDir) {
    if (data.activeId && data.activeId !== id) {
      const outgoing = data.instances.find((i) => i.id === data.activeId);
      // Park the outgoing instance only while it still exists; an orphaned
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
  log.info('instances', `selected "${rec.name}" (${id})`);
  return { activeId: id };
}

/** Stamp the selected instance as just-played (the Play button calls this). */
async function touchPlayed() {
  const data = await load();
  const rec = data.instances.find((i) => i.id === data.activeId);
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
  create,
  rename,
  remove,
  select,
  touchPlayed,
};
