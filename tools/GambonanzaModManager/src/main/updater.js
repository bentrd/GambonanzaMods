'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const config = require('./config');
const paths = require('./paths');
const net = require('./net');
const log = require('./log');

const execFileAsync = promisify(execFile);

// Self-update: download the new build, verify it against the checksum GitHub
// publishes for the release asset, swap ourselves out, restart. No installer
// wizard, no browser download - and on macOS, crucially, NO Gatekeeper:
// the "damaged app" quarantine flag is something *browsers* stamp onto files
// they download. We download with our own network stack, so the replacement
// app carries no quarantine attribute and launches like nothing happened.
// (First installs still come from a browser - that one keeps the xattr
// ritual until the app is notarised.)
//
// Per platform:
//   macOS   download the -mac.zip, unpack with Apple's own `ditto` (preserves
//           signatures/symlinks/exec bits), park the old bundle, move the new
//           one in, relaunch. The swap runs in a detached shell that waits
//           for this process to exit.
//   Windows download the NSIS installer and run it silently (/S). The
//           one-click installer replaces the app and relaunches it.
//   Linux   download the new AppImage over the current one (kept executable)
//           and relaunch.

/** Pick this machine's asset from a manager release. Pure; unit-tested. */
function chooseManagerAsset(assets, platform = process.platform, arch = process.arch) {
  const list = assets || [];
  const find = (fn) => list.find((a) => fn(a.name.toLowerCase()));
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? (find((n) => n.endsWith('-arm64-mac.zip')) || find((n) => n.endsWith('-mac.zip')))
      : (find((n) => n.endsWith('-mac.zip') && !n.endsWith('-arm64-mac.zip')) || find((n) => n.endsWith('-mac.zip')));
  }
  if (platform === 'win32') return find((n) => n.endsWith('.exe'));
  if (platform === 'linux') return find((n) => n.endsWith('.appimage'));
  return null;
}

/** The absolute path of the running .app bundle on macOS, or null. */
function currentMacBundle(exePath) {
  const marker = '.app/Contents/';
  const i = exePath.indexOf(marker);
  return i === -1 ? null : exePath.slice(0, i + 4);
}

async function applyManagerUpdate({ release, onProgress = () => {}, signal }) {
  // `app` is only touched here so unit tests can require this module bare.
  // eslint-disable-next-line global-require
  const { app } = require('electron');

  if (!app.isPackaged) throw new Error('self-update only works in the packaged app (this is a dev run)');

  const asset = chooseManagerAsset(release.assets);
  if (!asset) throw new Error(`release ${release.tag} has no build for this platform yet`);
  if (!asset.sha256) throw new Error('GitHub has not published a checksum for this build yet - try again in a minute');

  const workDir = path.join(paths.tempDir(), `self-update-${Date.now()}`);
  const downloadPath = path.join(workDir, asset.name);

  onProgress({ step: 'download', message: `Downloading Mod Manager ${release.version}`, percent: 0 });
  await net.download(asset.url, downloadPath, {
    expectedSha256: asset.sha256,
    requireRepo: config.HOME_REPO,
    signal,
    onProgress: ({ received, total }) => onProgress({
      step: 'download',
      message: `Downloading Mod Manager ${release.version}`,
      percent: total ? Math.round((received / total) * 100) : null,
    }),
  });

  onProgress({ step: 'apply', message: 'Installing - the app will restart itself', percent: null });

  if (process.platform === 'darwin') await applyMac(app, workDir, downloadPath);
  else if (process.platform === 'win32') await applyWindows(app, downloadPath);
  else if (process.platform === 'linux') await applyLinux(app, downloadPath);
  else throw new Error(`self-update is not supported on ${process.platform}`);

  // The handlers above schedule the swap and call app.quit(); nothing to do.
  return { applied: true, version: release.version };
}

async function applyMac(app, workDir, zipPath) {
  const bundle = currentMacBundle(app.getPath('exe'));
  if (!bundle) throw new Error('could not locate the running app bundle');
  if (bundle.includes('/AppTranslocation/')) {
    throw new Error('the app is running straight from its download. Drag it into Applications first, then update.');
  }

  const unpackDir = path.join(workDir, 'unpacked');
  await fsp.mkdir(unpackDir, { recursive: true });
  // Apple's ditto preserves signatures, symlinks and executable bits - the
  // things a generic zip extractor silently destroys in an .app bundle.
  await execFileAsync('/usr/bin/ditto', ['-xk', zipPath, unpackDir], { timeout: 120000 });

  const entries = await fsp.readdir(unpackDir);
  const newApp = entries.find((e) => e.endsWith('.app'));
  if (!newApp) throw new Error('the downloaded update does not contain an app bundle');
  const newAppPath = path.join(unpackDir, newApp);

  // Sanity: the new bundle must actually contain an executable.
  await fsp.access(path.join(newAppPath, 'Contents', 'MacOS')).catch(() => {
    throw new Error('the downloaded update looks incomplete - not installing it');
  });

  const parked = path.join(os.tmpdir(), `gmm-previous-${Date.now()}.app`);
  const script = path.join(workDir, 'swap.sh');
  await fsp.writeFile(script, [
    '#!/bin/bash',
    // Wait for the current process to fully exit before touching the bundle.
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`,
    `mv ${shq(bundle)} ${shq(parked)}`,
    `if mv ${shq(newAppPath)} ${shq(bundle)}; then`,
    // Should be quarantine-free already (we downloaded it, not a browser),
    // but clearing costs nothing and saves a support thread.
    `  xattr -cr ${shq(bundle)} 2>/dev/null || true`,
    `  rm -rf ${shq(parked)}`,
    'else',
    // Roll back - better the old version than no app at all.
    `  mv ${shq(parked)} ${shq(bundle)}`,
    'fi',
    `open ${shq(bundle)}`,
    `rm -rf ${shq(workDir)}`,
    '',
  ].join('\n'));
  await fsp.chmod(script, 0o755);

  log.info('updater', `mac self-update staged: ${path.basename(zipPath)} -> ${bundle}`);
  spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 400);
}

async function applyWindows(app, setupPath) {
  log.info('updater', `windows self-update: running installer silently`);
  // NSIS one-click installer: /S = silent; it replaces the install and
  // relaunches the app when done (runAfterFinish is the builder default).
  spawn(setupPath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 400);
}

async function applyLinux(app, imagePath) {
  const target = process.env.APPIMAGE;
  if (!target) throw new Error('self-update needs the AppImage build (running from an unpacked directory?)');

  await fsp.chmod(imagePath, 0o755);
  const script = path.join(path.dirname(imagePath), 'swap.sh');
  await fsp.writeFile(script, [
    '#!/bin/bash',
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`,
    `mv ${shq(imagePath)} ${shq(target)}`,
    `chmod +x ${shq(target)}`,
    `${shq(target)} & disown`,
    '',
  ].join('\n'));
  await fsp.chmod(script, 0o755);

  log.info('updater', `linux self-update staged over ${target}`);
  spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 400);
}

/** Single-quote a path for the generated shell scripts. */
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = { applyManagerUpdate, chooseManagerAsset, currentMacBundle, shq };
