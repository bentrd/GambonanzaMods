'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');

const log = require('./log');

// Zip extraction, done by hand rather than with the library's extractAllTo.
// A zip entry named "../../../../etc/whatever" is a classic way to write
// outside the destination folder, and we are unpacking archives fetched from
// the internet into people's game directories.

/** Refuse absurd archives outright rather than filling someone's disk. */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 4000;

function sanitizeEntryName(name) {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const parts = [];
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * Extract `zipPath` into `destDir`. Returns the relative paths written.
 * `strip` drops that many leading path segments, for archives that wrap
 * everything in a single top-level folder.
 */
async function extract(zipPath, destDir, { strip = 0 } = {}) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`archive has ${entries.length} files, which is far more than a mod should contain`);
  }

  let total = 0;
  const written = [];
  await fsp.mkdir(destDir, { recursive: true });

  for (const entry of entries) {
    const safe = sanitizeEntryName(entry.entryName);
    if (!safe) {
      log.warn('zip', `skipped unsafe entry "${entry.entryName}" in ${path.basename(zipPath)}`);
      continue;
    }
    const relative = strip > 0 ? safe.split('/').slice(strip).join('/') : safe;
    if (!relative) continue;

    const target = path.join(destDir, relative);
    // Belt and braces: even after sanitising, prove the final path is inside.
    if (!isInside(destDir, target)) {
      log.warn('zip', `skipped entry escaping the destination: ${entry.entryName}`);
      continue;
    }

    if (entry.isDirectory) {
      await fsp.mkdir(target, { recursive: true });
      continue;
    }

    // Check the declared uncompressed size BEFORE inflating: getData()
    // allocates the whole entry in one Buffer, so a zip-bomb entry would OOM
    // the main process before the running-total check below ever ran.
    const declared = entry.header?.size ?? 0;
    if (declared > MAX_TOTAL_BYTES || total + declared > MAX_TOTAL_BYTES) {
      throw new Error('archive unpacks to more data than this app will accept');
    }

    const data = entry.getData();
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('archive unpacks to more data than this app will accept');

    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
    written.push(relative);
  }

  return written;
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Find the folder inside an extracted mod archive that actually holds the mod
 * (the one with mod.json, or failing that the one with a .dll). Mod authors
 * zip up their folder in every shape imaginable; this makes all of them work.
 */
function findModRoot(dir, depth = 0) {
  if (depth > 3) return null;
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  if (names.some((e) => e.isFile() && e.name.toLowerCase() === 'mod.json')) return dir;

  const subdirs = names.filter((e) => e.isDirectory() && !e.name.startsWith('__MACOSX'));
  for (const sub of subdirs) {
    const found = findModRoot(path.join(dir, sub.name), depth + 1);
    if (found) return found;
  }
  // No manifest anywhere: fall back to wherever the first DLL lives, so a
  // bare-DLL release still installs (the caller writes the manifest).
  if (names.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.dll'))) return dir;
  for (const sub of subdirs) {
    const found = findModRoot(path.join(dir, sub.name), depth + 1);
    if (found) return found;
  }
  return null;
}

module.exports = { extract, findModRoot, sanitizeEntryName, isInside };
