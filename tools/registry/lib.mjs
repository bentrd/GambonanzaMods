// Shared helpers for the registry tooling (validate.mjs, build-index.mjs).
//
// Deliberately dependency-free: these run in CI on a bare `node` with no
// `npm install` step, and the registry is the one thing that absolutely must
// keep working even if the toolchain rots.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const REGISTRY_DIR = path.join(REPO_ROOT, 'registry');
export const MODS_DIR = path.join(REGISTRY_DIR, 'mods');
export const MODPACKS_DIR = path.join(REGISTRY_DIR, 'modpacks');
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
  'addedAt', 'gambits',
]);

/** The game's Rarity enum, lowercased - the manager maps these to colors. */
const KNOWN_RARITIES = ['common', 'rare', 'epic', 'legendary', 'strain'];

/** Per-gambit fields a "gambits" array item may carry. */
const KNOWN_GAMBIT_FIELDS = new Set(['id', 'name', 'description', 'rarity', 'price', 'sprite']);

/**
 * Sprites must live on raw.githubusercontent.com specifically - it is the
 * only ICON_RE host the manager's renderer CSP allows for <img>, so anything
 * else would validate here and then silently fail to load in the app.
 */
const SPRITE_RE = /^https:\/\/raw\.githubusercontent\.com\//;

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

  const id = str('id', { required: true, re: ID_RE, reHint: 'use lowercase letters, digits and dashes, e.g. "my-cool-mod"' });
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
        fail('"manifest.entry" must be the fully-qualified IMod type, e.g. "MyMod.Namespace.MyModMain"');
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

  if (entry.gambits !== undefined) {
    if (!Array.isArray(entry.gambits)) fail('"gambits" must be an array');
    else {
      if (entry.gambits.length > 24) fail('"gambits" allows at most 24 entries');
      entry.gambits.forEach((g, i) => {
        const where = `gambits[${i}]`;
        if (typeof g !== 'object' || g === null || Array.isArray(g)) {
          fail(`${where} must be an object`);
          return;
        }
        for (const key of Object.keys(g)) {
          if (!KNOWN_GAMBIT_FIELDS.has(key)) fail(`${where}: unknown field "${key}"`);
        }
        const gstr = (field, { required = false, max = 300, re = null, reHint = '' } = {}) => {
          const v = g[field];
          if (v === undefined || v === null || v === '') {
            if (required) fail(`${where}: "${field}" is required`);
            return;
          }
          if (typeof v !== 'string') { fail(`${where}: "${field}" must be a string`); return; }
          if (v.length > max) fail(`${where}: "${field}" is too long (max ${max} characters)`);
          if (re && !re.test(v)) fail(`${where}: "${field}" is malformed${reHint ? ` - ${reHint}` : ''}`);
        };
        gstr('id', { max: 40 });
        gstr('name', { required: true, max: 48 });
        gstr('description', { max: 300 });
        gstr('sprite', {
          required: true,
          max: 300,
          re: SPRITE_RE,
          reHint: 'gambit sprites must be raw.githubusercontent.com URLs (the app\'s CSP only allows images from there)',
        });
        if (g.rarity !== undefined && !KNOWN_RARITIES.includes(g.rarity)) {
          fail(`${where}: unknown rarity "${g.rarity}" (pick from: ${KNOWN_RARITIES.join(', ')})`);
        }
        if (g.price !== undefined && (!Number.isInteger(g.price) || g.price < 0 || g.price > 99)) {
          fail(`${where}: "price" must be a whole number between 0 and 99`);
        }
      });
    }
  }

  return errors;
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

const KNOWN_MODPACK_FIELDS = new Set([
  'id', 'name', 'author', 'summary', 'description', 'mods', 'tags',
  'homepage', 'submittedBy', 'addedAt',
]);

/**
 * Validate one modpack entry (registry/modpacks/<id>.json). A modpack is
 * pure metadata: a name and a list of registry mod ids. It has no repo, no
 * asset and no binary of its own - installing one just installs its members,
 * so the pack itself never needs a checksum or a review pass beyond "are
 * these ids real". `knownModIds` are the ids of the REVIEWED registry files;
 * packs may only reference those, never unreviewed issue submissions.
 */
export function validateModpackEntry(entry, fileName, knownModIds = null) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return ['file must contain a single JSON object'];
  }

  for (const key of Object.keys(entry)) {
    if (!KNOWN_MODPACK_FIELDS.has(key)) fail(`unknown field "${key}" (typo? see registry/modpack-schema.json)`);
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

  const id = str('id', { required: true, re: ID_RE, reHint: 'use lowercase letters, digits and dashes, e.g. "my-first-pack"' });
  str('name', { required: true, min: 2, max: 48 });
  str('author', { required: true, max: 48 });
  str('summary', { required: true, min: 8, max: 140 });
  str('description', { max: 4000 });
  str('homepage', { max: 200, re: /^https:\/\//, reHint: 'must start with https://' });
  str('submittedBy', { max: 48 });
  str('addedAt', { re: DATE_RE, reHint: 'expected YYYY-MM-DD' });

  if (id && fileName && `${id}.json` !== fileName) {
    fail(`file name must match the id: expected ${id}.json, got ${fileName}`);
  }

  if (!isStringArray(entry.mods)) {
    fail('"mods" must be an array of registry mod ids');
  } else {
    if (entry.mods.length < 2) fail('a modpack needs at least 2 mods (a single mod is just... a mod)');
    if (entry.mods.length > 24) fail('"mods" allows at most 24 entries');
    const seen = new Set();
    for (const modId of entry.mods) {
      if (!ID_RE.test(modId)) fail(`mod id "${modId}" is malformed`);
      else if (seen.has(modId)) fail(`mod id "${modId}" is listed twice`);
      else if (knownModIds && !knownModIds.has(modId)) fail(`mod "${modId}" is not in the registry (packs can only include reviewed mods)`);
      seen.add(modId);
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

  return errors;
}

/** Read every registry/mods/*.json, sorted by id. Throws on malformed JSON. */
export async function loadEntries(dir = MODS_DIR) {
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort();
  const out = [];
  for (const fileName of names) {
    const raw = await readFile(path.join(dir, fileName), 'utf8');
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${path.relative(REPO_ROOT, path.join(dir, fileName))}: not valid JSON - ${err.message}`);
    }
    out.push({ fileName, entry });
  }
  return out;
}

/** Convert a shell-style glob ('MyMod-*.zip') into an anchored RegExp. */
export function globToRegExp(glob) {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '\u0000' : `\\${c}`));
  return new RegExp(`^${escaped.split('\u0000').join('.*')}$`, 'i');
}

/**
 * Best-effort semantic version pulled out of a release tag.
 * "v1.2.3" -> "1.2.3", "mymod-v0.4" -> "0.4", "2026.08.01" -> "2026.08.01".
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
 * Parse a "Submit a mod" issue-form body (ISSUE_TEMPLATE/mod-submission.yml)
 * into a registry-shaped entry. Returns null when the body isn't that form.
 *
 * Detection is by the form's headings, NOT by the issue label: labels from a
 * template are silently dropped when they don't exist in the repo (real
 * submissions have arrived label-less), so the body is the reliable signal.
 *
 * The body is untrusted input: values are extracted, never executed, and the
 * result means nothing until it passes validateEntry().
 */
export function parseSubmissionIssue(body, { author = '', createdAt = '' } = {}) {
  // Issue forms render as "### <label>\n\n<value>" blocks. Capture up to the
  // next heading (not the next '#') so values containing a hash survive.
  const fields = {};
  for (const match of String(body || '').matchAll(/###\s+([^\n]+)\n+([\s\S]*?)(?=\n###\s|$)/g)) {
    const value = match[2].trim();
    fields[match[1].trim().toLowerCase()] = value === '_No response_' ? '' : value;
  }
  if (!fields['mod name'] || !fields['github repository']) return null;

  const name = fields['mod name'];
  const id = (fields['registry id'] || name)
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const tags = (fields.tags || '')
    .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 5);
  // People paste clone URLs; neither the https prefix nor a trailing ".git"
  // is ever part of the owner/name the API wants.
  const repo = fields['github repository']
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');

  return {
    id,
    name,
    author,
    summary: fields['one-line summary'] || '',
    repo,
    asset: fields['release asset'] || '',
    folder: fields['install folder'] || '',
    ...(tags.length ? { tags } : {}),
    ...(fields['entry type (bare-dll releases only)']
      ? { manifest: { entry: fields['entry type (bare-dll releases only)'] } }
      : {}),
    submittedBy: author,
    ...(createdAt ? { addedAt: String(createdAt).slice(0, 10) } : {}),
  };
}

/**
 * The parsed mod.json from inside a mod zip, or null.
 *
 * A mod's own manifest is the honest source for what it calls itself: bundled
 * sample mods all ship as assets on the framework release, so deriving the
 * version from the tag made every one of them read as the framework's version
 * instead of their own.
 *
 * Hand-rolled rather than pulling in a zip dependency - this file runs in CI on
 * a bare `node` with no `npm install`, and mod.json is a few hundred bytes.
 * Anything unexpected returns null so the caller falls back; a malformed
 * archive must never take the whole registry down.
 */
export function manifestFromZip(buffer) {
  try {
    // End of Central Directory: scan back from the end, past any trailing comment.
    const maxComment = 0xffff;
    let eocd = -1;
    for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - maxComment; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;

    const entryCount = buffer.readUInt16LE(eocd + 10);
    let pos = buffer.readUInt32LE(eocd + 16); // central directory offset

    // Prefer the shallowest mod.json: "Mod/mod.json" is the real manifest,
    // anything deeper would be a bundled asset that happens to share the name.
    let best = null;
    for (let i = 0; i < entryCount; i++) {
      if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) break;
      const nameLen = buffer.readUInt16LE(pos + 28);
      const extraLen = buffer.readUInt16LE(pos + 30);
      const commentLen = buffer.readUInt16LE(pos + 32);
      const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);
      if (path.posix.basename(name) === 'mod.json') {
        const depth = name.split('/').length;
        if (!best || depth < best.depth) {
          best = {
            depth,
            method: buffer.readUInt16LE(pos + 10),
            // Central-directory sizes are authoritative; the local header may
            // carry zeros when a data descriptor was used.
            compressedSize: buffer.readUInt32LE(pos + 20),
            localOffset: buffer.readUInt32LE(pos + 42),
          };
        }
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
    if (!best) return null;

    const lo = best.localOffset;
    if (buffer.readUInt32LE(lo) !== 0x04034b50) return null;
    const dataStart = lo + 30 + buffer.readUInt16LE(lo + 26) + buffer.readUInt16LE(lo + 28);
    const raw = buffer.subarray(dataStart, dataStart + best.compressedSize);
    const json = best.method === 0 ? raw : inflateRawSync(raw);

    return JSON.parse(json.toString('utf8')) ?? null;
  } catch {
    return null;
  }
}

/** The "version" declared in the mod.json inside a mod zip, or null. */
export function manifestVersionFromZip(buffer) {
  return trimmedString(manifestFromZip(buffer)?.version);
}

/**
 * The "author" declared in the mod.json inside a mod zip, or null.
 *
 * Worth having because the only other source for an unreviewed submission is
 * the GitHub login of whoever opened the issue, which is an account name, not
 * a byline - "ben-gambo" where every reviewed entry by the same person says
 * "Ben". The mod's own manifest is what the game itself credits, so it is the
 * honest answer.
 *
 * This is untrusted zip content, so it gets the same length cap validateEntry
 * puts on the field; anything else is dropped rather than trusted.
 */
export function manifestAuthorFromZip(buffer) {
  return trimmedString(manifestFromZip(buffer)?.author, 48);
}

function trimmedString(value, max = Infinity) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
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
 *
 * The returned release also carries `downloads`: the mod's LIFETIME download
 * total, summed over every matching asset in every release we can see (not
 * just the newest). GitHub counts asset downloads for free - that is the
 * entire "analytics stack" behind the download numbers in the mod manager;
 * no third-party service, no tracking, refreshed whenever CI rebuilds the
 * index. The total is best-effort: it only sees the releases on this page
 * (per_page=30), and deleted releases take their counts with them.
 */
export async function resolveLatestRelease(entry, { token } = {}) {
  const assetRe = globToRegExp(entry.asset);
  const tagRe = entry.tagPattern ? globToRegExp(entry.tagPattern) : null;

  const res = await githubFetch(`/repos/${entry.repo}/releases?per_page=30`, { token });
  if (res.status === 404) throw new Error(`repository ${entry.repo} not found (is it public?)`);
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${entry.repo} releases`);
  const releases = await res.json();

  const eligible = releases.filter((rel) => {
    if (rel.draft) return false;
    if (rel.prerelease && !entry.prerelease) return false;
    if (tagRe && !tagRe.test(rel.tag_name)) return false;
    return true;
  });

  let downloads = 0;
  for (const rel of eligible) {
    for (const a of rel.assets || []) {
      if (assetRe.test(a.name)) downloads += Number(a.download_count) || 0;
    }
  }

  for (const rel of eligible) {
    const asset = (rel.assets || []).find((a) => assetRe.test(a.name));
    if (!asset) continue;
    return {
      tag: rel.tag_name,
      version: versionFromTag(rel.tag_name),
      publishedAt: rel.published_at,
      notes: rel.body || '',
      releaseUrl: rel.html_url,
      downloads,
      asset: {
        name: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
      },
    };
  }
  return null;
}
