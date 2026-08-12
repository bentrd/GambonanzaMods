'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const { STEAM_APP_ID, MODS_DIR_NAME } = require('./config');
const log = require('./log');

// Finding the game is the single most common thing a mod manager gets wrong,
// so it is worth doing properly: default Steam paths for each OS, then every
// extra Steam library the user has configured, then whatever folder they pick
// by hand. Everything here is pure enough to unit-test - the filesystem calls
// are all "does this path exist", which the tests point at fixtures.

/** Marker type name the patcher writes into Assembly-CSharp.dll. */
const PATCH_MARKER = '__GambonanzaModHostPatched';

/** Written by the manager (and by build.sh) next to the framework DLLs. */
const INSTALL_FILE = 'Gambonanza.ModHost.install.json';

/** Sub-paths under the game folder where Unity keeps the managed assemblies. */
const MANAGED_CANDIDATES = [
  path.join('Gambonanza.app', 'Contents', 'Resources', 'Data', 'Managed'),
  path.join('Gambonanza_Data', 'Managed'),
  path.join('Gambonanza', 'Gambonanza_Data', 'Managed'),
];

const FRAMEWORK_DLLS = [
  'Gambonanza.ModSdk.dll',
  'Gambonanza.ModHost.dll',
  'Gambonanza.GameUI.dll',
];

/** Steam install roots to probe, most likely first. */
function steamRoots(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'Steam')];
  }
  if (platform === 'win32') {
    const roots = [];
    for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files']) {
      if (base) roots.push(path.join(base, 'Steam'));
    }
    roots.push('C:\\Steam', path.join(home, 'Steam'));
    return dedupe(roots);
  }
  return dedupe([
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.steam', 'steam'),
    path.join(home, '.steam', 'root'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
  ]);
}

/**
 * Pull library paths out of steamapps/libraryfolders.vdf. Valve has changed
 * this file's shape twice; both the flat ("1" "D:\\Games") and nested
 * ("path" "D:\\Games") forms are handled by just taking every quoted path-ish
 * value, which survives the next reshuffle too.
 */
function parseLibraryFolders(vdfText) {
  const paths = [];
  // Line-by-line on purpose: a global key-value regex can pair a numeric
  // *value* on one line with a key on the next and silently skip libraries.
  const re = /^\s*"(?:path|\d+)"\s+"(.+)"\s*$/;
  for (const line of String(vdfText).split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const value = m[1].replace(/\\\\/g, '\\');
    if (value.includes('/') || value.includes('\\')) paths.push(value);
  }
  return dedupe(paths);
}

/** Every folder that might hold a Gambonanza install, in preference order. */
function gameCandidates({ platform = process.platform, env = process.env, home = os.homedir(), exists = defaultExists } = {}) {
  const candidates = [];
  const libraries = [];

  for (const root of steamRoots(platform, env, home)) {
    libraries.push(root);
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (exists(vdf)) {
      try {
        for (const lib of parseLibraryFolders(fs.readFileSync(vdf, 'utf8'))) libraries.push(lib);
      } catch (err) {
        log.warn('game', `could not read ${vdf}`, err.message);
      }
    }
  }

  for (const lib of dedupe(libraries)) {
    candidates.push(path.join(lib, 'steamapps', 'common', 'Gambonanza'));
  }

  // Non-Steam / manual copies people actually make.
  if (platform === 'darwin') candidates.push('/Applications/Gambonanza');
  candidates.push(path.join(home, 'Gambonanza'));
  candidates.push(path.join(home, 'Games', 'Gambonanza'));

  return dedupe(candidates);
}

function defaultExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

/** Locate Managed/ inside a game folder, or null if this is not one. */
function findManagedDir(gameDir, exists = defaultExists) {
  if (!gameDir) return null;
  for (const sub of MANAGED_CANDIDATES) {
    const full = path.join(gameDir, sub);
    if (exists(path.join(full, 'Assembly-CSharp.dll'))) return full;
  }
  return null;
}

/**
 * Where the game looks for mods. Mirrors build.sh: next to the executable on
 * Windows/Linux, next to the .app bundle on macOS.
 */
function deriveModsDir(gameDir, managedDir) {
  const dataDir = path.dirname(managedDir);
  if (path.basename(dataDir) === 'Gambonanza_Data') {
    return path.join(path.dirname(dataDir), MODS_DIR_NAME);
  }
  return path.join(gameDir, MODS_DIR_NAME);
}

/** True if the on-disk assembly carries the patcher's marker type. */
async function hasPatchMarker(file) {
  const marker = Buffer.from(PATCH_MARKER, 'ascii');
  const chunkSize = 1 << 20;
  const overlap = marker.length - 1;
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const buf = Buffer.alloc(chunkSize + overlap);
    let position = 0;
    let carry = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, carry, chunkSize, position);
      if (bytesRead === 0) return false;
      const view = buf.subarray(0, carry + bytesRead);
      if (view.includes(marker)) return true;
      carry = Math.min(overlap, view.length);
      view.subarray(view.length - carry).copy(buf, 0);
      position += bytesRead;
    }
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function sha256File(file) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', () => resolve(null));
  });
}

/**
 * Steam records the installed build id in appmanifest_<appid>.acf, two levels
 * above steamapps/common/<game>. Missing for non-Steam copies, which is fine.
 */
async function readSteamBuildId(gameDir) {
  const acf = path.join(path.dirname(path.dirname(gameDir)), `appmanifest_${STEAM_APP_ID}.acf`);
  try {
    const text = await fsp.readFile(acf, 'utf8');
    const m = /"buildid"\s*"(\d+)"/.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Everything the UI needs to know about one game folder. Never throws - an
 * unreadable or wrong folder comes back as { valid: false, reason }.
 */
async function inspect(gameDir) {
  if (!gameDir) return { valid: false, reason: 'no folder selected' };

  const resolved = path.resolve(gameDir);
  const managedDir = findManagedDir(resolved);
  if (!managedDir) {
    return {
      valid: false,
      gameDir: resolved,
      reason: 'that folder does not look like a Gambonanza install (no Gambonanza_Data/Managed inside it)',
    };
  }

  const assemblyPath = path.join(managedDir, 'Assembly-CSharp.dll');
  const backupPath = `${assemblyPath}.orig`;
  const modsDir = deriveModsDir(resolved, managedDir);

  const [patched, hasBackup, install, steamBuildId] = await Promise.all([
    hasPatchMarker(assemblyPath),
    fsp.access(backupPath).then(() => true, () => false),
    readJsonIfPresent(path.join(managedDir, INSTALL_FILE)),
    readSteamBuildId(resolved),
  ]);

  // Hash the *vanilla* assembly: when patched, that is the .orig backup. This
  // is what tells us whether Steam shipped a game update under our feet.
  const vanillaPath = patched && hasBackup ? backupPath : assemblyPath;
  const vanillaSha256 = await sha256File(vanillaPath);

  const frameworkFiles = {};
  for (const dll of FRAMEWORK_DLLS) {
    frameworkFiles[dll] = await fsp.access(path.join(managedDir, dll)).then(() => true, () => false);
  }
  const frameworkComplete = Object.values(frameworkFiles).every(Boolean);

  // Steam-update detection, two shapes:
  //
  //   a) The usual one: Steam replaced Assembly-CSharp.dll with a new vanilla
  //      build, wiping the patch marker. Our install record and framework
  //      DLLs survive (Steam only touches its own files), so "record present
  //      but marker gone" means exactly this - NOT requiring patched=true is
  //      the whole point, a Steam update always clears the marker.
  //   b) The rare one: still patched, but the vanilla snapshot's hash no
  //      longer matches what we recorded (e.g. the .orig was lost or swapped).
  //
  // Both mean the same thing to the user: re-patch to get mods back.
  const steamReplacedPatch = !!(!patched && install);
  const hashMismatch = !!(patched && install?.gameAssemblySha256 && vanillaSha256
    && install.gameAssemblySha256 !== vanillaSha256);
  const gameUpdated = steamReplacedPatch || hashMismatch;

  let state = 'unpatched';
  if (patched && frameworkComplete && !gameUpdated) state = 'patched';
  else if (patched && !frameworkComplete) state = 'broken';
  else if (gameUpdated) state = 'stale';

  return {
    valid: true,
    gameDir: resolved,
    managedDir,
    modsDir,
    assemblyPath,
    backupPath,
    hasBackup,
    patched,
    frameworkComplete,
    frameworkFiles,
    gameUpdated,
    state,
    frameworkVersion: install?.version || null,
    installedAt: install?.installedAt || null,
    installedBy: install?.installedBy || null,
    patchedGameSha256: install?.gameAssemblySha256 || null,
    vanillaSha256,
    steamBuildId,
    isSteam: /steamapps/i.test(resolved),
  };
}

/** Probe the usual places; returns the first folder that inspects as valid. */
async function autoDetect(options = {}) {
  for (const candidate of gameCandidates(options)) {
    const info = await inspect(candidate);
    if (info.valid) {
      log.info('game', `auto-detected install at ${candidate}`);
      return info;
    }
  }
  log.info('game', 'auto-detection found no Gambonanza install');
  return null;
}

/**
 * Some people point the folder picker at the .app bundle or at Managed/
 * itself. Walk up/down a little so the obvious mistakes just work.
 */
function normalizePickedPath(picked) {
  if (!picked) return picked;
  let dir = path.resolve(picked);
  const base = path.basename(dir);
  if (base === 'Managed') dir = path.dirname(dir);
  if (path.basename(dir) === 'Data' || path.basename(dir).endsWith('_Data')) dir = path.dirname(dir);
  if (path.basename(dir) === 'Resources') dir = path.dirname(dir);
  if (path.basename(dir) === 'Contents') dir = path.dirname(dir);
  if (dir.endsWith('.app')) dir = path.dirname(dir);
  return dir;
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}

module.exports = {
  PATCH_MARKER,
  INSTALL_FILE,
  FRAMEWORK_DLLS,
  MANAGED_CANDIDATES,
  steamRoots,
  parseLibraryFolders,
  gameCandidates,
  findManagedDir,
  deriveModsDir,
  hasPatchMarker,
  sha256File,
  readSteamBuildId,
  inspect,
  autoDetect,
  normalizePickedPath,
};
