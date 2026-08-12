'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const config = require('./config');
const paths = require('./paths');
const net = require('./net');
const zip = require('./zip');
const game = require('./game');
const registry = require('./registry');
const log = require('./log');

const execFileAsync = promisify(execFile);

// Patching the game, and putting it back the way it was.
//
// The manager never compiles anything. GambonanzaMods publishes a release with
// one small bundle per platform:
//
//     gambonanza-framework-<rid>.zip
//       manifest.json            version, commit, checksums
//       framework/*.dll          ModSdk + ModHost + GameUI, dropped into Managed/
//       patcher/GambonanzaPatcher[.exe]   self-contained, no .NET install needed
//
// so a player needs neither the .NET SDK nor a git checkout - which is the
// entire reason this app exists.

const MAX_BACKUPS = 8;

/** All releases of the home repo, split into framework and manager streams. */
async function listReleases({ token } = {}) {
  const res = await net.getJson(`https://api.github.com/repos/${config.HOME_REPO}/releases?per_page=30`, { token });
  if (!res.ok) return { ok: false, error: res.error };

  const framework = [];
  const manager = [];
  for (const rel of res.data) {
    if (rel.draft) continue;
    const record = {
      tag: rel.tag_name,
      name: rel.name || rel.tag_name,
      version: stripTagPrefix(rel.tag_name),
      publishedAt: rel.published_at,
      prerelease: rel.prerelease,
      notes: rel.body || '',
      url: rel.html_url,
      assets: (rel.assets || []).map((a) => ({
        name: a.name,
        url: a.browser_download_url,
        size: a.size,
        // GitHub publishes a digest per asset; the self-updater verifies
        // downloads against it before swapping the app.
        sha256: typeof a.digest === 'string' && a.digest.startsWith('sha256:') ? a.digest.slice(7) : null,
      })),
    };
    if (rel.tag_name.startsWith(config.MANAGER_TAG_PREFIX)) manager.push(record);
    else framework.push(record);
  }
  return { ok: true, framework, manager };
}

function stripTagPrefix(tag) {
  return String(tag || '').replace(new RegExp(`^${config.MANAGER_TAG_PREFIX}`), '').replace(/^v/, '');
}

/**
 * Latest release info as recorded in the registry index. The index is served
 * from GitHub Pages, which has NO rate limit - unlike api.github.com's 60
 * unauthenticated requests/hour, which heavy use (or a shared office IP) can
 * exhaust. CI resolves the release data with a token and embeds it, so for
 * the app this path is both free and always available.
 */
async function latestFromIndex(kind) {
  try {
    const { index } = await registry.getIndex({});
    const rel = index?.releases?.[kind];
    if (!rel?.tag || !Array.isArray(rel.assets)) return null;
    return { ...rel, name: rel.tag, prerelease: false };
  } catch {
    return null;
  }
}

/** Newest framework release that ships a bundle for this machine. */
async function latestFrameworkRelease({ token } = {}) {
  const rid = config.currentRid();
  if (!rid) return { ok: false, error: `unsupported platform: ${process.platform}/${process.arch}` };
  const assetName = config.frameworkAssetName(rid);

  const fromIndex = await latestFromIndex('framework');
  if (fromIndex) {
    const asset = fromIndex.assets.find((a) => a.name === assetName);
    if (asset) return { ok: true, release: { ...fromIndex, asset } };
  }

  const releases = await listReleases({ token });
  if (!releases.ok) return releases;
  const match = releases.framework.find((rel) => !rel.prerelease && rel.assets.some((a) => a.name === assetName));
  if (!match) {
    return {
      ok: false,
      error: `no published framework build for ${rid} yet`,
      releases: releases.framework.slice(0, 5),
    };
  }
  return { ok: true, release: { ...match, asset: match.assets.find((a) => a.name === assetName) } };
}

/** Newest release of the manager app itself (tagged manager-v*). */
async function latestManagerRelease({ token } = {}) {
  const fromIndex = await latestFromIndex('manager');
  if (fromIndex) return { ok: true, release: fromIndex };

  const releases = await listReleases({ token });
  if (!releases.ok) return releases;
  const match = releases.manager.find((rel) => !rel.prerelease);
  return match ? { ok: true, release: match } : { ok: false, error: 'no manager releases published yet' };
}

/**
 * Make sure the framework bundle for `release` is downloaded and unpacked.
 * Cached per release tag, so re-patching after the first time is instant.
 */
async function ensureBundle(release, { onProgress = () => {}, signal } = {}) {
  const rid = config.currentRid();
  if (!rid) throw new Error(`unsupported platform: ${process.platform}/${process.arch}`);

  const dir = paths.frameworkDir(release.tag);
  const marker = path.join(dir, '.complete');
  const asset = release.asset || release.assets?.find((a) => a.name === config.frameworkAssetName(rid));
  if (!asset) throw new Error(`release ${release.tag} has no ${config.frameworkAssetName(rid)} attached`);

  const cached = await fsp.readFile(marker, 'utf8').then(JSON.parse).catch(() => null);
  if (!cached) {
    await fsp.rm(dir, { recursive: true, force: true });
    const zipPath = path.join(paths.tempDir(), asset.name);
    onProgress({ step: 'download', message: `Downloading the mod framework (${formatMb(asset.size)})`, percent: 0 });
    await net.download(asset.url, zipPath, {
      requireRepo: config.HOME_REPO,
      signal,
      onProgress: ({ received, total }) => onProgress({
        step: 'download',
        message: `Downloading the mod framework (${formatMb(asset.size)})`,
        percent: total ? Math.round((received / total) * 100) : null,
      }),
    });
    onProgress({ step: 'unpack', message: 'Unpacking', percent: 100 });
    await zip.extract(zipPath, dir);
    await fsp.rm(zipPath, { force: true });
    await fsp.writeFile(marker, JSON.stringify({ tag: release.tag, rid, at: new Date().toISOString() }));
  }

  const manifest = await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => ({ version: stripTagPrefix(release.tag) }));

  const patcher = path.join(dir, 'patcher', process.platform === 'win32' ? 'GambonanzaPatcher.exe' : 'GambonanzaPatcher');
  await fsp.access(patcher).catch(() => {
    throw new Error(`the ${release.tag} bundle is missing its patcher - the release may be incomplete`);
  });
  if (process.platform !== 'win32') await fsp.chmod(patcher, 0o755).catch(() => {});

  const dlls = [];
  for (const name of game.FRAMEWORK_DLLS) {
    const file = path.join(dir, 'framework', name);
    await fsp.access(file).catch(() => { throw new Error(`the ${release.tag} bundle is missing ${name}`); });
    dlls.push(file);
  }

  return { dir, patcher, dlls, manifest, version: manifest.version || stripTagPrefix(release.tag) };
}

/** Copy the current vanilla assembly somewhere safe before touching anything. */
async function createBackup(info, reason) {
  // No vanilla copy exists in this state - the live dll is patched and the
  // .orig snapshot is gone. Backing up the patched dll as "vanilla" would
  // poison the rotation: a later restore() would put modded code back while
  // deleting the framework it depends on, killing the game at startup.
  if (info.patched && !info.hasBackup) {
    throw new Error('the game is patched but its original backup file is missing, so there is no safe copy to work from. In Steam: right-click Gambonanza → Properties → Installed Files → Verify integrity of game files, then try again.');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(paths.backupsDir(), stamp);
  await fsp.mkdir(dir, { recursive: true });

  // Back up whatever is currently vanilla: the .orig snapshot if the game is
  // already patched, otherwise the live DLL.
  const source = info.patched && info.hasBackup ? info.backupPath : info.assemblyPath;
  const dest = path.join(dir, 'Assembly-CSharp.dll');
  await fsp.copyFile(source, dest);

  // Belt and braces: never store a marked dll as a vanilla snapshot, whatever
  // path it arrived by.
  if (await game.hasPatchMarker(dest)) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new Error('refusing to back up modified game files as the original. Steam-verify the game and try again.');
  }

  const meta = {
    createdAt: new Date().toISOString(),
    reason,
    gameDir: info.gameDir,
    managedDir: info.managedDir,
    source,
    sha256: await game.sha256File(dest),
    steamBuildId: info.steamBuildId,
    frameworkVersion: info.frameworkVersion,
  };
  await fsp.writeFile(path.join(dir, 'backup.json'), `${JSON.stringify(meta, null, 2)}\n`);
  log.info('framework', `backed up Assembly-CSharp.dll (${reason})`, dir);

  await pruneBackups();
  return { id: stamp, ...meta };
}

async function listBackups() {
  const dir = paths.backupsDir();
  const names = await fsp.readdir(dir).catch(() => []);
  const out = [];
  for (const name of names.sort().reverse()) {
    const meta = await fsp.readFile(path.join(dir, name, 'backup.json'), 'utf8').then(JSON.parse).catch(() => null);
    const file = path.join(dir, name, 'Assembly-CSharp.dll');
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) continue;
    out.push({ id: name, file, bytes: stat.size, ...(meta || { createdAt: stat.mtime.toISOString() }) });
  }
  return out;
}

async function pruneBackups() {
  const backups = await listBackups();
  for (const old of backups.slice(MAX_BACKUPS)) {
    await fsp.rm(path.join(paths.backupsDir(), old.id), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Patch the game. Idempotent: the patcher always works from the vanilla
 * backup, so running this twice is the same as running it once.
 */
async function patch({ gameDir, release, onProgress = () => {}, signal, token }) {
  const info = await game.inspect(gameDir);
  if (!info.valid) throw new Error(info.reason || 'that folder is not a Gambonanza install');

  let target = release;
  if (!target) {
    onProgress({ step: 'check', message: 'Looking up the latest framework release', percent: null });
    const latest = await latestFrameworkRelease({ token });
    if (!latest.ok) throw new Error(latest.error);
    target = latest.release;
  }

  const bundle = await ensureBundle(target, { onProgress, signal });

  onProgress({ step: 'backup', message: 'Backing up your game files', percent: null });
  const backup = await createBackup(info, `before installing framework ${bundle.version}`);

  onProgress({ step: 'patch', message: 'Patching Gambonanza', percent: null });
  const args = [info.managedDir, ...bundle.dlls];
  let stdout = '';
  try {
    const result = await execFileAsync(bundle.patcher, args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    stdout = `${result.stdout || ''}${result.stderr || ''}`;
  } catch (err) {
    const detail = `${err.stdout || ''}${err.stderr || ''}`.trim();
    log.error('framework', 'patcher failed', detail || err.message);
    throw new Error(explainPatcherFailure(err, detail, info));
  }
  log.info('framework', `patched ${info.managedDir}`, stdout.trim());

  onProgress({ step: 'finish', message: 'Finishing up', percent: null });
  await fsp.mkdir(info.modsDir, { recursive: true });
  await writeInstallRecord(info, bundle, target);

  const after = await game.inspect(info.gameDir);
  if (!after.patched || !after.frameworkComplete) {
    throw new Error('the patch did not take effect. Your original game file is safe - try "Restore game files" and then patch again.');
  }

  return { game: after, backup, version: bundle.version, tag: target.tag, output: stdout.trim() };
}

function explainPatcherFailure(err, detail, info) {
  if (/EACCES|EPERM|denied/i.test(`${err.code} ${detail}`)) {
    return `the manager is not allowed to change files in ${info.managedDir}. Close the game, then try again (on Windows, right-click the app and Run as administrator).`;
  }
  if (err.code === 'ETIMEDOUT') return 'the patcher took too long and was stopped. Your game files were not changed.';
  if (/no .orig backup and on-disk dll is patched/i.test(detail)) {
    return 'the game files are patched but the original backup is missing. In Steam, right-click Gambonanza → Properties → Installed Files → Verify integrity, then patch again.';
  }
  if (detail) return `the patcher reported: ${firstLine(detail)}`;
  return `the patcher could not run (${err.message}).`;
}

function firstLine(text) {
  return String(text).split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ');
}

/**
 * Write the metadata file the in-game framework reads. Mirrors what build.sh
 * writes, plus `managedBy` so the in-game updater knows to point players back
 * at this app instead of trying to `git pull` a checkout that isn't there.
 */
async function writeInstallRecord(info, bundle, release) {
  const record = {
    version: bundle.version,
    commit: bundle.manifest.commit || release.tag,
    repoDir: '',
    gameDir: info.gameDir,
    modsDir: info.modsDir,
    gameDirNative: info.gameDir,
    modsDirNative: info.modsDir,
    appId: config.STEAM_APP_ID,
    gameAssemblySha256: info.vanillaSha256 || '',
    steamBuildId: info.steamBuildId || 'unknown',
    managedBy: 'GambonanzaModManager',
    installedAt: new Date().toISOString(),
    installedBy: `GambonanzaModManager ${require('../../package.json').version}`,
    frameworkTag: release.tag,
  };
  await fsp.writeFile(
    path.join(info.managedDir, game.INSTALL_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

/**
 * Put the game back exactly as Steam shipped it. Mods stay on disk (they are
 * inert without the framework) unless the caller asks for them to go too.
 */
async function restore({ gameDir, removeMods = false }) {
  const info = await game.inspect(gameDir);
  if (!info.valid) throw new Error(info.reason || 'that folder is not a Gambonanza install');

  let restoredFrom = null;
  if (info.hasBackup && !(await game.hasPatchMarker(info.backupPath))) {
    await fsp.copyFile(info.backupPath, info.assemblyPath);
    restoredFrom = 'the backup the patcher keeps next to the game file';
  } else {
    // Only ever restore a snapshot we can prove is vanilla - putting a
    // patched dll back while deleting the framework would break the game.
    const backups = (await listBackups()).filter((b) => b.managedDir === info.managedDir);
    let usable = null;
    for (const b of backups) {
      if (!(await game.hasPatchMarker(b.file))) { usable = b; break; }
    }
    if (!usable) {
      throw new Error('there is no clean backup to restore from. In Steam, right-click Gambonanza → Properties → Installed Files → Verify integrity to get the original files back.');
    }
    await fsp.copyFile(usable.file, info.assemblyPath);
    restoredFrom = `a backup this app made on ${new Date(usable.createdAt).toLocaleString()}`;
  }

  for (const name of [...game.FRAMEWORK_DLLS, game.INSTALL_FILE]) {
    await fsp.rm(path.join(info.managedDir, name), { force: true }).catch(() => {});
  }
  await fsp.rm(info.backupPath, { force: true }).catch(() => {});
  await fsp.rm(`${info.backupPath}.stamp`, { force: true }).catch(() => {});

  if (removeMods) {
    await fsp.rm(info.modsDir, { recursive: true, force: true }).catch(() => {});
  }

  log.info('framework', `restored vanilla game files from ${restoredFrom}`);
  return { game: await game.inspect(info.gameDir), restoredFrom };
}

/** Copy a specific backup back over the game's assembly. */
async function restoreBackup({ gameDir, id }) {
  const backups = await listBackups();
  const backup = backups.find((b) => b.id === id);
  if (!backup) throw new Error('that backup is no longer on disk');
  if (await game.hasPatchMarker(backup.file)) {
    throw new Error('that snapshot contains modified game files, not the original - refusing to restore it. Use Steam’s Verify integrity instead.');
  }

  const info = await game.inspect(gameDir);
  if (!info.valid) throw new Error(info.reason || 'that folder is not a Gambonanza install');

  await fsp.copyFile(backup.file, info.assemblyPath);
  for (const name of [...game.FRAMEWORK_DLLS, game.INSTALL_FILE]) {
    await fsp.rm(path.join(info.managedDir, name), { force: true }).catch(() => {});
  }
  await fsp.rm(info.backupPath, { force: true }).catch(() => {});
  await fsp.rm(`${info.backupPath}.stamp`, { force: true }).catch(() => {});

  log.info('framework', `restored backup ${id} into ${info.managedDir}`);
  return { game: await game.inspect(info.gameDir), backup };
}

function formatMb(bytes) {
  if (!bytes) return 'unknown size';
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

module.exports = {
  listReleases,
  latestFrameworkRelease,
  latestManagerRelease,
  ensureBundle,
  patch,
  restore,
  restoreBackup,
  listBackups,
  createBackup,
  stripTagPrefix,
};
