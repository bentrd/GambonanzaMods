// Shared helpers for the registry tooling (validate.mjs, build-index.mjs).
//
// Deliberately dependency-free: these run in CI on a bare `node` with no
// `npm install` step, and the registry is the one thing that absolutely must
// keep working even if the toolchain rots.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const REGISTRY_DIR = path.join(REPO_ROOT, 'registry');
export const MODS_DIR = path.join(REGISTRY_DIR, 'mods');
export const INDEX_PATH = path.join(REGISTRY_DIR, 'index.json');

/** The registry's own repo. Used for the "official mods" badge. */
export const HOME_REPO = 'bentrd/GambonanzaMods';

const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ICON_RE = /^https:\/\/(raw\.githubusercontent\.com|github\.com|user-images\.githubusercontent\.com)\//;

const KNOWN_TAGS = [
  'gameplay', 'gambits', 'quality-of-life', 'ui',
  'visual', 'audio', 'cheats', 'library', 'tools',
];

const KNOWN_FIELDS = new Set([
  'id', 'name', 'author', 'summary', 'description', 'repo', 'asset', 'folder',
  'tagPattern', 'prerelease', 'manifest', 'tags', 'homepage', 'icon',
  'gameVersion', 'frameworkVersion', 'dependencies', 'pending', 'submittedBy',
  'addedAt',
]);

/**
 * Validate one registry entry. Returns an array of human-readable problems;
 * empty means the entry is good. Written as plain checks rather than a JSON
 * Schema runtime so the error messages read like a person wrote them - the
 * audience is a mod author reading a failed CI check, not a machine.
 */
export function validateEntry(entry, fileName) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return ['file must contain a single JSON object'];
  }

  for (const key of Object.keys(entry)) {
    if (!KNOWN_FIELDS.has(key)) fail(`unknown field "${key}" (typo? see registry/schema.json)`);
  }

  const str = (field, { required = false, min = 1, max = 4000, re = null, reHint = '' } = {}) => {
    const v = entry[field];
    if (v === undefined || v === null || v === '') {
      if (required) fail(`"${field}" is required`);
      return null;
    }
    if (typeof v !== 'string') { fail(`"${field}" must be a string`); return null; }
    if (v.length < min) fail(`"${field}" is too short (min ${min} characters)`);
    if (v.length > max) fail(`"${field}" is too long (max ${max} characters)`);
    if (re && !re.test(v)) fail(`"${field}" is malformed${reHint ? ` - ${reHint}` : ''}`);
    return v;
  };

  const id = str('id', { required: true, re: ID_RE, reHint: 'use lowercase letters, digits and dashes, e.g. "speed-mod"' });
  str('name', { required: true, min: 2, max: 48 });
  str('author', { required: true, max: 48 });
  str('summary', { required: true, min: 8, max: 140 });
  str('description', { max: 4000 });
  str('repo', { required: true, re: REPO_RE, reHint: 'expected owner/name, e.g. "bentrd/GambonanzaMods"' });
  str('asset', { required: true, min: 3, max: 120 });
  str('folder', { required: true, re: FOLDER_RE, reHint: 'a plain folder name, no slashes' });
  str('tagPattern', { max: 60 });
  str('homepage', { max: 200, re: /^https:\/\//, reHint: 'must start with https://' });
  str('icon', { max: 300, re: ICON_RE, reHint: 'icons must be hosted on GitHub (raw.githubusercontent.com)' });
  str('gameVersion', { max: 40 });
  str('frameworkVersion', { max: 40 });
  str('submittedBy', { max: 48 });
  str('addedAt', { re: DATE_RE, reHint: 'expected YYYY-MM-DD' });

  if (id && fileName && `${id}.json` !== fileName) {
    fail(`file name must match the id: expected ${id}.json, got ${fileName}`);
  }

  const asset = entry.asset;
  if (typeof asset === 'string') {
    if (asset.includes('/')) fail('"asset" is a release asset file name, not a path');
    if (!/\.(zip|dll)$/i.test(asset)) fail('"asset" must end in .zip or .dll');
    if (/\.dll$/i.test(asset) && !entry.manifest) {
      fail('a bare .dll asset needs a "manifest" block with the mod entry type (or ship a .zip containing mod.json)');
    }
  }

  if (entry.manifest !== undefined) {
    const m = entry.manifest;
    if (typeof m !== 'object' || m === null || Array.isArray(m)) fail('"manifest" must be an object');
    else {
      for (const key of Object.keys(m)) {
        if (key !== 'entry' && key !== 'dependencies') fail(`unknown manifest field "${key}"`);
      }
      if (typeof m.entry !== 'string' || !m.entry.includes('.')) {
        fail('"manifest.entry" must be the fully-qualified IMod type, e.g. "Gambonanza.SpeedMod.SpeedModMain"');
      }
      if (m.dependencies !== undefined && !isStringArray(m.dependencies)) {
        fail('"manifest.dependencies" must be an array of strings');
      }
    }
  }

  if (entry.tags !== undefined) {
    if (!isStringArray(entry.tags)) fail('"tags" must be an array of strings');
    else {
      if (entry.tags.length > 5) fail('"tags" allows at most 5 entries');
      for (const t of entry.tags) {
        if (!KNOWN_TAGS.includes(t)) fail(`unknown tag "${t}" (pick from: ${KNOWN_TAGS.join(', ')})`);
      }
    }
  }

  if (entry.dependencies !== undefined) {
    if (!isStringArray(entry.dependencies)) fail('"dependencies" must be an array of registry ids');
    else {
      if (entry.dependencies.length > 8) fail('"dependencies" allows at most 8 entries');
      if (entry.dependencies.includes(entry.id)) fail('a mod cannot depend on itself');
    }
  }

  for (const boolField of ['prerelease', 'pending']) {
    if (entry[boolField] !== undefined && typeof entry[boolField] !== 'boolean') {
      fail(`"${boolField}" must be true or false`);
    }
  }

  return errors;
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Read every registry/mods/*.json, sorted by id. Throws on malformed JSON. */
export async function loadEntries(dir = MODS_DIR) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const out = [];
  for (const fileName of names) {
    const raw = await readFile(path.join(dir, fileName), 'utf8');
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch (err) {
      throw new Error(`registry/mods/${fileName}: not valid JSON - ${err.message}`);
    }
    out.push({ fileName, entry });
  }
  return out;
}

/** Convert a shell-style glob ('SpeedMod-*.zip') into an anchored RegExp. */
export function globToRegExp(glob) {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '\u0000' : `\\${c}`));
  return new RegExp(`^${escaped.split('\u0000').join('.*')}$`, 'i');
}

/**
 * Best-effort semantic version pulled out of a release tag.
 * "v1.2.3" -> "1.2.3", "speedmod-v0.4" -> "0.4", "2026.08.01" -> "2026.08.01".
 * Falls back to the raw tag, which is fine: it is only ever compared to the
 * previously installed value of the same field.
 */
export function versionFromTag(tag) {
  if (!tag) return '';
  const m = /(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(tag);
  return m ? m[1] : tag;
}

/**
 * Compare two dotted versions. Returns >0 if a is newer, <0 if older, 0 if equal.
 * Numeric segments compare numerically; anything non-numeric compares as a
 * string so date-ish and hash-ish tags at least sort deterministically. A
 * version with a pre-release suffix loses to the same version without one.
 */
export function compareVersions(a, b) {
  const split = (v) => String(v ?? '').trim().replace(/^v/i, '').split(/[-+]/);
  const [aCore, ...aRest] = split(a);
  const [bCore, ...bRest] = split(b);
  const an = aCore.split('.');
  const bn = bCore.split('.');
  for (let i = 0; i < Math.max(an.length, bn.length); i++) {
    const x = an[i] ?? '0';
    const y = bn[i] ?? '0';
    const xi = Number(x);
    const yi = Number(y);
    if (Number.isInteger(xi) && Number.isInteger(yi)) {
      if (xi !== yi) return xi - yi;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  const aPre = aRest.join('-');
  const bPre = bRest.join('-');
  if (aPre === bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  return aPre < bPre ? -1 : 1;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Minimal GitHub REST client. Uses GITHUB_TOKEN when present (CI) and falls
 * back to unauthenticated requests (60/hour) for local runs.
 */
export function githubFetch(pathOrUrl, { token = process.env.GITHUB_TOKEN, accept = 'application/vnd.github+json' } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.github.com${pathOrUrl}`;
  const headers = {
    accept,
    'user-agent': 'gambonanza-registry',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(url, { headers });
}

/**
 * Find the newest release of `repo` that carries an asset matching the entry's
 * glob. Returns null when the repo has no such release yet.
 */
export async function resolveLatestRelease(entry, { token } = {}) {
  const assetRe = globToRegExp(entry.asset);
  const tagRe = entry.tagPattern ? globToRegExp(entry.tagPattern) : null;

  const res = await githubFetch(`/repos/${entry.repo}/releases?per_page=30`, { token });
  if (res.status === 404) throw new Error(`repository ${entry.repo} not found (is it public?)`);
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${entry.repo} releases`);
  const releases = await res.json();

  for (const rel of releases) {
    if (rel.draft) continue;
    if (rel.prerelease && !entry.prerelease) continue;
    if (tagRe && !tagRe.test(rel.tag_name)) continue;
    const asset = (rel.assets || []).find((a) => assetRe.test(a.name));
    if (!asset) continue;
    return {
      tag: rel.tag_name,
      version: versionFromTag(rel.tag_name),
      publishedAt: rel.published_at,
      notes: rel.body || '',
      releaseUrl: rel.html_url,
      asset: {
        name: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
      },
    };
  }
  return null;
}
