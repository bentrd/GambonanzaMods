'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const config = require('./config');
const paths = require('./paths');
const net = require('./net');
const zip = require('./zip');
const game = require('./game');
const log = require('./log');

// Installing, removing, enabling and updating mods inside the game's Mods/
// folder. The layout is the framework's own: Mods/<Folder>/mod.json + DLL.
//
// Every installed-by-us mod also gets a small `.manager.json` dropped into its
// folder recording which registry entry and release it came from. That file is
// what makes "update available" and "installed vX" possible without guessing;
// mods the user copied in by hand simply don't have one and show as "manual".

const RECEIPT = '.manager.json';

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Scan the game's Mods/ folder. Returns [] when it doesn't exist yet. */
async function listInstalled(modsDir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(modsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) {
      // Our own swap-holding folders self-clean; other dot-folders are none
      // of our business and never shown.
      if (/\.replaced-\d+$/.test(entry.name)) {
        fsp.rm(path.join(modsDir, entry.name), { recursive: true, force: true }).catch(() => {});
      }
      continue;
    }
    const dir = path.join(modsDir, entry.name);
    const manifest = await readJson(path.join(dir, 'mod.json'));
    const receipt = await readJson(path.join(dir, RECEIPT));

    let dlls = [];
    let bytes = 0;
    try {
      for (const f of await fsp.readdir(dir)) {
        if (f.toLowerCase().endsWith('.dll')) {
          dlls.push(f);
          bytes += (await fsp.stat(path.join(dir, f))).size;
        }
      }
    } catch { /* unreadable folder - report what we have */ }

    out.push({
      folder: entry.name,
      dir,
      manifest,
      hasManifest: !!manifest,
      enabled: manifest ? manifest.enabled !== false : true,
      dlls,
      bytes,
      registryId: receipt?.registryId || null,
      installedVersion: receipt?.version || manifest?.version || null,
      installedTag: receipt?.tag || null,
      installedAt: receipt?.installedAt || null,
      managed: !!receipt,
    });
  }

  return out.sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * Install (or update - same operation) a registry mod into modsDir.
 * The flow a non-technical user sees as "one click":
 *
 *   download → verify checksum → unpack to a staging folder → make sure a
 *   mod.json exists → swap the staging folder into place → write the receipt
 *
 * The swap is the only moment the live folder is touched, so a failed
 * download or a bad archive can never leave a half-installed mod behind.
 */
async function install({ mod, modsDir, onProgress = () => {}, signal }) {
  if (!mod?.latest?.asset?.url) {
    throw new Error(`${mod?.name || 'this mod'} has no downloadable release yet`);
  }
  const asset = mod.latest.asset;
  if (!asset.sha256) {
    throw new Error(`the registry has no checksum for ${mod.name} - refusing to install an unverified file`);
  }

  const workDir = path.join(paths.tempDir(), `mod-${mod.id}-${Date.now()}`);
  const downloadPath = path.join(workDir, asset.name);
  const stageDir = path.join(workDir, 'stage');

  try {
    onProgress({ step: 'download', message: `Downloading ${mod.name}`, percent: 0 });
    await net.download(asset.url, downloadPath, {
      expectedSha256: asset.sha256,
      requireRepo: mod.repo,
      signal,
      onProgress: ({ received, total }) => onProgress({
        step: 'download',
        message: `Downloading ${mod.name}`,
        percent: total ? Math.round((received / total) * 100) : null,
      }),
    });

    onProgress({ step: 'unpack', message: `Installing ${mod.name}`, percent: null });
    await fsp.mkdir(stageDir, { recursive: true });

    if (asset.name.toLowerCase().endsWith('.zip')) {
      await zip.extract(downloadPath, stageDir);
    } else {
      await fsp.copyFile(downloadPath, path.join(stageDir, asset.name));
    }

    const root = zip.findModRoot(stageDir);
    if (!root) throw new Error(`${asset.name} does not contain a mod (no mod.json or .dll inside)`);

    await ensureManifest(root, mod);

    // Preserve the user's enabled/disabled choice across updates.
    const liveDir = path.join(modsDir, mod.folder);
    const previous = await readJson(path.join(liveDir, 'mod.json'));
    if (previous && previous.enabled === false) {
      const manifest = await readJson(path.join(root, 'mod.json'));
      if (manifest) {
        manifest.enabled = false;
        await writeManifest(root, manifest);
      }
    }

    await fsp.writeFile(path.join(root, RECEIPT), `${JSON.stringify({
      registryId: mod.id,
      repo: mod.repo,
      version: mod.latest.version || mod.latest.tag,
      tag: mod.latest.tag,
      asset: asset.name,
      sha256: asset.sha256,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`);

    // The swap: move the old folder aside, move the staged one in, delete the
    // old one only after the new one is in place. The holding folder is
    // dot-prefixed so the game's mod discovery (and listInstalled) never
    // mistakes it for a real mod if we crash mid-swap.
    await fsp.mkdir(modsDir, { recursive: true });
    const graveyard = path.join(modsDir, `.${mod.folder}.replaced-${Date.now()}`);
    const hadPrevious = await fsp.rename(liveDir, graveyard).then(() => true, () => false);
    try {
      await moveDir(root, liveDir);
    } catch (err) {
      // A failed cross-device copy can leave liveDir half-populated; clear it
      // first so putting the original back cannot collide with the debris.
      await fsp.rm(liveDir, { recursive: true, force: true }).catch(() => {});
      if (hadPrevious) await fsp.rename(graveyard, liveDir).catch(() => {});
      throw err;
    }
    if (hadPrevious) await fsp.rm(graveyard, { recursive: true, force: true }).catch(() => {});

    log.info('mods', `installed ${mod.id} ${mod.latest.tag} into ${liveDir}`);
    onProgress({ step: 'done', message: `${mod.name} installed`, percent: 100 });
    return { folder: mod.folder, version: mod.latest.version || mod.latest.tag };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** rename() when possible, copy+delete when the temp dir is on another disk. */
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
 * Guarantee the staged mod has a mod.json the framework can load. Bare-DLL
 * releases rely on the registry entry's `manifest` block for the entry type.
 */
async function ensureManifest(root, mod) {
  const existing = await readJson(path.join(root, 'mod.json'));
  if (existing) return;

  if (!mod.manifest?.entry) {
    throw new Error(`${mod.name}'s release has no mod.json and its registry entry has no manifest block - one of the two must say where the mod's entry type is`);
  }
  const dlls = (await fsp.readdir(root)).filter((f) => f.toLowerCase().endsWith('.dll'));
  if (!dlls.length) throw new Error(`${mod.name}'s release contains no DLL`);

  await writeManifest(root, {
    id: mod.folder,
    name: mod.name,
    version: mod.latest.version || mod.latest.tag,
    author: mod.author,
    entry: mod.manifest.entry,
    enabled: true,
    dependencies: mod.manifest.dependencies || [],
  });
}

async function writeManifest(dir, manifest) {
  await fsp.writeFile(path.join(dir, 'mod.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Delete a mod's folder. That's genuinely all uninstalling is. */
async function uninstall({ modsDir, folder }) {
  const dir = safeChild(modsDir, folder);
  await fsp.rm(dir, { recursive: true, force: true });
  log.info('mods', `uninstalled ${folder}`);
  return { folder };
}

/** Flip the `enabled` flag in a mod's manifest (takes effect next launch). */
async function setEnabled({ modsDir, folder, enabled }) {
  const dir = safeChild(modsDir, folder);
  const manifestPath = path.join(dir, 'mod.json');
  const manifest = await readJson(manifestPath);
  if (!manifest) throw new Error(`${folder} has no mod.json to edit`);
  manifest.enabled = !!enabled;
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log.info('mods', `${enabled ? 'enabled' : 'disabled'} ${folder}`);
  return { folder, enabled: !!enabled };
}

/** Folder names come from the renderer; never let one climb out of Mods/. */
function safeChild(parent, name) {
  const dir = path.join(parent, name);
  if (!zip.isInside(parent, dir)) throw new Error(`invalid mod folder name: ${name}`);
  return dir;
}

/**
 * Merge "what's in the registry" with "what's on disk" into the single list
 * the UI renders. Also resolves dependencies into install order.
 */
function mergeState(registryMods, installed) {
  const byFolder = new Map(installed.map((m) => [m.folder.toLowerCase(), m]));
  const byRegistryId = new Map();
  for (const m of installed) {
    if (m.registryId) byRegistryId.set(m.registryId, m);
  }

  const rows = [];
  const seenFolders = new Set();

  for (const mod of registryMods) {
    const local = byRegistryId.get(mod.id) || byFolder.get(mod.folder.toLowerCase()) || null;
    if (local) seenFolders.add(local.folder.toLowerCase());

    const latestVersion = mod.latest?.version || mod.latest?.tag || null;
    const updateAvailable = !!(local && latestVersion && local.installedTag
      && mod.latest.tag !== local.installedTag);

    rows.push({
      kind: 'registry',
      ...mod,
      installed: !!local,
      local,
      updateAvailable,
      installable: !!mod.latest?.asset?.sha256,
    });
  }

  for (const local of installed) {
    if (seenFolders.has(local.folder.toLowerCase())) continue;
    rows.push({
      kind: 'manual',
      id: `local:${local.folder}`,
      name: local.manifest?.name || local.folder,
      author: local.manifest?.author || 'unknown',
      summary: local.manifest?.description || 'Installed by hand - not from the mod registry.',
      folder: local.folder,
      installed: true,
      local,
      updateAvailable: false,
      installable: false,
    });
  }

  return rows;
}

/**
 * Installed mods that depend on `folder` - directly (their manifest's
 * dependencies name its folder/id) or via the registry (their entry's
 * dependencies name its registry id). Removing a library out from under
 * its dependents would break them at load, so uninstall refuses while
 * this list is non-empty.
 */
function findDependents(folder, registryMods, installed) {
  const target = installed.find((m) => m.folder.toLowerCase() === String(folder).toLowerCase());
  if (!target) return [];
  const targetIds = new Set([target.folder.toLowerCase()]);
  if (target.manifest?.id) targetIds.add(String(target.manifest.id).toLowerCase());
  if (target.registryId) targetIds.add(target.registryId.toLowerCase());

  const byId = new Map(registryMods.map((m) => [m.id, m]));
  const dependents = [];
  for (const mod of installed) {
    if (mod.folder === target.folder) continue;
    const declared = [
      ...(mod.manifest?.dependencies || []),
      ...((mod.registryId && byId.get(mod.registryId)?.dependencies) || []),
    ];
    if (declared.some((d) => targetIds.has(String(d).toLowerCase()))) {
      dependents.push(mod.manifest?.name || mod.folder);
    }
  }
  return dependents;
}

/**
 * Install order for a mod and its not-yet-installed registry dependencies.
 * Returns registry entries, dependencies first. Cycles just get cut - the
 * validator refuses them upstream, this is only defence in depth.
 */
function resolveInstallPlan(mod, registryMods, installed) {
  const byId = new Map(registryMods.map((m) => [m.id, m]));
  const installedById = new Map(installed.filter((m) => m.registryId).map((m) => [m.registryId, m]));
  const installedByFolder = new Map(installed.map((m) => [m.folder.toLowerCase(), m]));

  const plan = [];
  const visiting = new Set();
  const visit = (entry) => {
    if (!entry || visiting.has(entry.id)) return;
    visiting.add(entry.id);
    for (const depId of entry.dependencies || []) {
      const dep = byId.get(depId);
      if (!dep) continue;
      const local = installedById.get(depId) || installedByFolder.get(dep.folder.toLowerCase()) || null;
      if (local) {
        // An installed dependency still gets refreshed when it's behind the
        // registry: a stale library (an old gambit-api, say) quietly breaks the
        // mods that depend on it, which players report against the mod, not the
        // library. Without a comparable tag pair, leave it alone.
        const behind = !!(dep.latest?.tag && local.installedTag && dep.latest.tag !== local.installedTag);
        if (!behind || !dep.latest?.asset?.sha256) continue;
      }
      visit(dep);
    }
    if (!plan.includes(entry)) plan.push(entry);
  };
  visit(mod);
  return plan;
}

/**
 * Install order for a whole modpack: every member that is missing or behind,
 * plus any not-yet-installed dependencies, dependencies first, deduplicated
 * across members. Members that are installed and current are skipped - a pack
 * install never re-downloads what the user already has.
 */
function resolveModpackPlan(pack, registryMods, installed) {
  const rows = mergeState(registryMods, installed).filter((r) => r.kind === 'registry');
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const plan = [];
  for (const id of pack?.mods || []) {
    const row = rowById.get(id);
    if (!row || !row.installable) continue;
    if (row.installed && !row.updateAvailable) continue;
    for (const entry of resolveInstallPlan(row, registryMods, installed)) {
      if (!plan.some((p) => p.id === entry.id)) plan.push(entry);
    }
  }
  return plan;
}

module.exports = {
  RECEIPT,
  listInstalled,
  install,
  uninstall,
  setEnabled,
  mergeState,
  resolveInstallPlan,
  resolveModpackPlan,
  findDependents,
};
