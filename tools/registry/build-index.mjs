#!/usr/bin/env node
// Resolves every registry entry against GitHub and writes registry/index.json.
//
//     node tools/registry/build-index.mjs
//     node tools/registry/build-index.mjs --check   (fail if index.json is stale)
//
// Why a generated index instead of letting the app call GitHub itself:
//
//   1. Rate limits. Unauthenticated GitHub allows 60 requests/hour per IP.
//      A player browsing 30 mods would burn through that on one screen.
//   2. Integrity. CI downloads each asset once and records its SHA-256, so the
//      manager can verify every byte it installs on a player's machine. A repo
//      that silently swaps a release asset for something else no longer matches
//      the hash a human reviewed, and the install is refused.
//   3. Offline. The index ships inside the app as a fallback, so the mod list
//      still renders with no network.
//
// The workflow that runs this (.github/workflows/registry-refresh.yml) commits
// the result on a schedule, so "new version of a mod" needs no action from us.

import { writeFile, readFile } from 'node:fs/promises';
import {
  INDEX_PATH, HOME_REPO, loadEntries, validateEntry,
  resolveLatestRelease, githubFetch, sha256, versionFromTag,
} from './lib.mjs';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
// --offline rewrites the index from the registry files without touching the
// network, keeping whatever release info was resolved last time. Handy when
// editing entry metadata (summary, tags) from a machine with no GitHub access.
const offline = args.has('--offline');
const token = process.env.GITHUB_TOKEN;

/** Refuse to hash anything absurd - mods are a few hundred KB at most. */
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

const previous = await readJson(INDEX_PATH);
const previousById = new Map((previous?.mods || []).map((m) => [m.id, m]));

const entries = await loadEntries();
const mods = [];
let errors = 0;

// Declared before the resolution loop below on purpose: the loop's fallback
// paths call withRepoMeta(), and a `const` further down the file would still
// be in its temporal dead zone at that point.
const REPO_META_FIELDS = ['stars', 'repoPushedAt', 'license', 'archived'];

for (const { fileName, entry } of entries) {
  const problems = validateEntry(entry, fileName);
  if (problems.length) {
    errors++;
    console.error(`✗ ${fileName}: ${problems[0]}`);
    continue;
  }

  const cachedRecord = previousById.get(entry.id);
  const record = {
    ...entry,
    official: entry.repo === HOME_REPO,
    latest: null,
  };
  delete record.pending;

  if (offline) {
    record.latest = cachedRecord?.latest ?? null;
    if (!record.latest) record.pending = true;
    mods.push(withRepoMeta(record, cachedRecord));
    console.log(`· ${entry.id} → ${record.latest ? `${record.latest.tag} (kept)` : 'no release yet'}`);
    continue;
  }

  try {
    const release = await resolveLatestRelease(entry, { token });
    if (release) {
      const cached = cachedRecord?.latest;
      const reusable = cached
        && cached.tag === release.tag
        && cached.asset?.name === release.asset.name
        && cached.asset?.size === release.asset.size
        && cached.asset?.sha256;

      let hash = reusable ? cached.asset.sha256 : null;
      if (!hash) {
        if (release.asset.size > MAX_ASSET_BYTES) {
          throw new Error(`asset is ${(release.asset.size / 1e6).toFixed(1)} MB, over the ${MAX_ASSET_BYTES / 1e6} MB ceiling`);
        }
        hash = await hashAsset(release.asset.url);
      }
      release.asset.sha256 = hash;
      record.latest = release;
      console.log(`✓ ${entry.id} → ${release.tag} ${release.asset.name} (${hash.slice(0, 12)}…)${reusable ? ' [cached]' : ''}`);
    } else if (entry.pending) {
      record.pending = true;
      console.log(`· ${entry.id} → no release yet (pending)`);
    } else {
      record.pending = true;
      record.error = `No release of ${entry.repo} has an asset matching "${entry.asset}".`;
      console.warn(`! ${entry.id} → ${record.error}`);
    }
  } catch (err) {
    // A network blip, a rate limit, a GitHub outage - none of those are a
    // reason to yank a working mod out of every player's browse list. Keep the
    // last good resolution and flag it as stale instead.
    if (cachedRecord?.latest) {
      record.latest = cachedRecord.latest;
      record.stale = true;
      console.warn(`! ${entry.id} → ${err.message} (kept last known release ${cachedRecord.latest.tag})`);
    } else {
      record.pending = true;
      record.error = err.message;
      console.warn(`! ${entry.id} → ${err.message}`);
    }
  }

  mods.push(await withRepoMetaFetched(record, cachedRecord));
}

if (errors) {
  console.error(`\n${errors} entries failed validation - run tools/registry/validate.mjs for details.`);
  process.exit(1);
}

mods.sort((a, b) => a.name.localeCompare(b.name));

// Latest framework + manager releases ride inside the index so the app's
// update checks read Pages (no rate limit) instead of the GitHub API
// (60/hour unauthenticated). CI resolves this with a token; the app only
// falls back to the API when the index lacks it.
let releases = previous?.releases ?? null;
if (!offline) {
  const fresh = await resolveHomeReleases();
  if (fresh) releases = fresh;
}

const index = {
  schema: 1,
  // Version of the framework these mods are expected to run against. Bumped by
  // hand when a framework release breaks mod compatibility.
  frameworkRepo: HOME_REPO,
  generatedAt: new Date().toISOString(),
  count: mods.length,
  releases,
  mods,
};

const serialized = `${JSON.stringify(index, null, 2)}\n`;

if (checkOnly) {
  const current = await readFile(INDEX_PATH, 'utf8').catch(() => '');
  if (stripTimestamp(current) === stripTimestamp(serialized)) {
    console.log('\nindex.json is up to date.');
    process.exit(0);
  }
  console.error('\nindex.json is stale. Run: node tools/registry/build-index.mjs');
  process.exit(1);
}

await writeFile(INDEX_PATH, serialized);
console.log(`\nWrote ${INDEX_PATH} (${mods.length} mods, ${mods.filter((m) => m.latest).length} installable).`);

// ---------------------------------------------------------------------------

/** Newest stable framework (v*) and manager (manager-v*) releases. */
async function resolveHomeReleases() {
  try {
    const res = await githubFetch(`/repos/${HOME_REPO}/releases?per_page=30`, { token });
    if (!res.ok) {
      console.warn(`! could not resolve ${HOME_REPO} releases (HTTP ${res.status}) - keeping previous`);
      return null;
    }
    const rels = await res.json();
    const shape = (rel) => ({
      tag: rel.tag_name,
      version: versionFromTag(rel.tag_name),
      publishedAt: rel.published_at,
      notes: rel.body || '',
      url: rel.html_url,
      assets: (rel.assets || []).map((a) => ({
        name: a.name,
        url: a.browser_download_url,
        size: a.size,
        sha256: typeof a.digest === 'string' && a.digest.startsWith('sha256:') ? a.digest.slice(7) : null,
      })),
    });
    const framework = rels.find((r) => !r.draft && !r.prerelease && !r.tag_name.startsWith('manager-v'));
    const manager = rels.find((r) => !r.draft && !r.prerelease && r.tag_name.startsWith('manager-v'));
    console.log(`✓ releases → framework ${framework?.tag_name ?? 'none'}, manager ${manager?.tag_name ?? 'none'}`);
    return { framework: framework ? shape(framework) : null, manager: manager ? shape(manager) : null };
  } catch (err) {
    console.warn(`! could not resolve ${HOME_REPO} releases (${err.message}) - keeping previous`);
    return null;
  }
}

async function hashAsset(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'gambonanza-registry', accept: 'application/octet-stream' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ASSET_BYTES) throw new Error('asset exceeded the size ceiling mid-download');
  return sha256(buf);
}

/** Copy repo metadata forward from the previous index (offline path). */
function withRepoMeta(record, cached) {
  if (!cached) return record;
  for (const field of REPO_META_FIELDS) {
    if (cached[field] !== undefined) record[field] = cached[field];
  }
  return record;
}

/** Refresh repo metadata, falling back to whatever the last run recorded. */
async function withRepoMetaFetched(record, cached) {
  const meta = await fetchRepoMeta(record.repo);
  if (meta) return Object.assign(record, meta);
  return withRepoMeta(record, cached);
}

async function fetchRepoMeta(repo) {
  try {
    const res = await githubFetch(`/repos/${repo}`, { token });
    if (!res.ok) return null;
    const json = await res.json();
    return {
      stars: json.stargazers_count ?? 0,
      repoPushedAt: json.pushed_at ?? null,
      license: json.license?.spdx_id && json.license.spdx_id !== 'NOASSERTION' ? json.license.spdx_id : null,
      archived: !!json.archived,
    };
  } catch {
    return null;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** generatedAt always differs; --check compares everything else. */
function stripTimestamp(text) {
  return text.replace(/"generatedAt":\s*"[^"]*",?/g, '');
}
