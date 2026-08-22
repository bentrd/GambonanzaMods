'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Notification,
} = require('electron');

const config = require('./config');
const paths = require('./paths');
const log = require('./log');
const { Store } = require('./store');
const game = require('./game');
const registry = require('./registry');
const modsApi = require('./mods');
const modpacks = require('./modpacks');
const framework = require('./framework');
const publish = require('./publish');
const updater = require('./updater');
const texturePacks = require('./texturepacks');
const assetCatalog = require('./assetcatalog');
const { compareTags } = require('./versions');

// Main process: owns the window, the settings store and every privileged
// operation. The renderer is sandboxed and talks to it over the small typed
// surface defined in ../preload.js - it can never touch the filesystem or the
// network on its own.

let win = null;
let store = null;
/** In-flight cancellable operations, keyed by an id the renderer chose. */
const operations = new Map();

const isDev = process.argv.includes('--dev');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  const bounds = store.get('windowBounds') || {};
  win = new BrowserWindow({
    width: bounds.width || 1180,
    height: bounds.height || 780,
    x: bounds.x,
    y: bounds.y,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#3a1521',
    title: 'Gambonanza Mod Manager',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  win.on('close', () => {
    store.set('windowBounds', win.getBounds());
  });
  win.on('closed', () => { win = null; });

  // Every external link opens in the user's real browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternalSafe(url);
  });
}

function openExternalSafe(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || (parsed.protocol === 'steam:' && /^rungameid\/\d+$/.test(`${parsed.hostname}${parsed.pathname}`.replace(/^\/+|\/+$/g, '')))) {
      shell.openExternal(url);
    } else {
      log.warn('shell', `blocked external open of ${url}`);
    }
  } catch {
    log.warn('shell', `blocked malformed external URL ${url}`);
  }
}

// ---------------------------------------------------------------------------
// Assembling the state object the renderer renders from
// ---------------------------------------------------------------------------

async function currentGameInfo() {
  const saved = store.get('gamePath');
  if (saved) {
    const info = await game.inspect(saved);
    if (info.valid) return info;
    // The saved path stopped being a game (moved install, deleted). Fall back
    // to detection rather than showing an error for a stale setting.
    log.warn('game', `saved game path is no longer valid: ${saved}`);
  }
  const detected = await game.autoDetect();
  if (detected && !saved) store.set('gamePath', detected.gameDir);
  return detected;
}

/**
 * Put a texture pack on (or take one off) without letting a missing pack
 * break the thing that asked. A modpack can name a pack the user has since
 * deleted from the library; that means "no pack", not "refuse to switch".
 */
async function wearTexturePack(texturePackId, modsDir) {
  try {
    return await texturePacks.setActive({ id: texturePackId || null, modsDir });
  } catch (err) {
    log.warn('texturepacks', `could not wear ${texturePackId}: ${err.message}`);
    if (texturePackId) await modpacks.forgetTexturePack(texturePackId).catch(() => {});
    return texturePacks.setActive({ id: null, modsDir }).catch(() => null);
  }
}

/**
 * The texture-pack half of installing a shared setup. Reuses a copy already
 * in the library at the same version rather than piling up duplicates every
 * time someone re-installs a pack, and never fails the whole install: the
 * mods are the part people came for, so a pack whose art will not download
 * is a note in the result, not an exception.
 */
async function installPackSkin(pack, { report, signal, modsDir }) {
  if (!pack.texturepack) return null;
  try {
    const reg = await registry.getIndex({});
    const entry = (reg.index.texturepacks || []).find((t) => t.id === pack.texturepack);
    if (!entry) throw new Error('it is no longer in the registry');

    const library = await texturePacks.summary();
    const have = library.packs.find((t) => t.registryId === entry.id
      && (!entry.latest?.version || t.version === entry.latest.version));

    let target = have;
    if (!target) {
      report({ step: 'skin', message: `Getting the ${entry.name} texture pack…`, percent: null });
      target = await texturePacks.installFromRegistry({
        entry,
        onProgress: report,
        signal,
      });
    }
    await wearTexturePack(target.id, modsDir);
    await modpacks.setTexturePack({ texturePackId: target.id });
    return { id: target.id, name: entry.name, reused: !!have };
  } catch (err) {
    log.warn('modpacks', `could not install the pack's texture pack: ${err.message}`);
    return { error: err.message };
  }
}

/** Undo the "switch to a fresh modpack" half of a pack install that failed. */
async function rollbackNewModpack(id, previousId, modsDir) {
  try {
    if (previousId && previousId !== id) {
      const back = await modpacks.select({ id: previousId, modsDir });
      await wearTexturePack(back.texturePackId, modsDir);
    }
    await modpacks.remove({ id });
  } catch (err) {
    log.warn('modpacks', `could not undo the half-made modpack: ${err.message}`);
  }
}

async function fullState({ forceRegistry = false } = {}) {
  const gameInfo = await currentGameInfo();
  const reg = await registry.getIndex({ force: forceRegistry });
  const installed = gameInfo?.valid ? await modsApi.listInstalled(gameInfo.modsDir) : [];
  const packs = await modpacks.summary({ modsDir: gameInfo?.valid ? gameInfo.modsDir : null });
  const skins = await texturePacks.summary().catch((err) => {
    log.warn('texturepacks', `could not list texture packs: ${err.message}`);
    return { activeId: null, packs: [] };
  });
  return {
    app: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      logFile: log.file(),
    },
    settings: store.publicView(),
    game: gameInfo,
    registry: {
      source: reg.source,
      stale: !!reg.stale,
      generatedAt: reg.index.generatedAt || null,
      mods: modsApi.mergeState(reg.index.mods || [], installed),
      // Older cached indexes predate modpacks entirely - an empty list just
      // renders the tab's "nothing here yet" note. Same for texture packs.
      modpacks: reg.index.modpacks || [],
      texturepacks: reg.index.texturepacks || [],
    },
    installed,
    modpacks: packs,
    texturePacks: skins,
    publish: { signInAvailable: publish.signInAvailable() },
  };
}

// ---------------------------------------------------------------------------
// Update checks (framework + manager releases)
// ---------------------------------------------------------------------------

let updateTimer = null;

async function checkForUpdates({ notify = true } = {}) {
  const result = { framework: null, manager: null };
  const gameInfo = await currentGameInfo();

  // An update check must not be answered from the registry cache - force a
  // revalidation first (cheap: ETag turns an unchanged index into a 304).
  // Without this, "Check again" could keep saying "nothing to do" for up to
  // 30 minutes after a release.
  try { await registry.getIndex({ force: true }); } catch { /* offline - the cached index still answers */ }

  const latest = await framework.latestFrameworkRelease({});
  if (latest.ok) {
    const installedVersion = gameInfo?.frameworkVersion || null;
    const behind = !!(gameInfo?.patched && installedVersion
      && compareTags(latest.release.version, installedVersion) > 0);
    // A skipped version stays skipped everywhere - banners, dots and
    // notifications alike - until a NEWER release ships or the user un-skips.
    const skipped = behind && latest.release.version === store.get('dismissedFrameworkVersion');
    const needsAttention = (behind && !skipped) || !!gameInfo?.gameUpdated;
    result.framework = {
      release: latest.release,
      installedVersion,
      updateAvailable: behind && !skipped,
      skippedVersion: skipped ? latest.release.version : null,
      gameUpdated: !!gameInfo?.gameUpdated,
      needsAttention,
    };

    if (notify && needsAttention) {
      showNotification(
        behind && !skipped
          ? `Mod framework ${latest.release.version} is out`
          : 'Gambonanza was updated by Steam',
        'Open the mod manager to re-patch your game with one click.',
      );
    }
  } else {
    result.framework = { error: latest.error };
  }

  const managerLatest = await framework.latestManagerRelease({});
  if (managerLatest.ok) {
    const newer = compareTags(managerLatest.release.version, app.getVersion()) > 0;
    const skipped = newer && managerLatest.release.version === store.get('dismissedManagerVersion');
    result.manager = {
      release: managerLatest.release,
      updateAvailable: newer && !skipped,
      skippedVersion: skipped ? managerLatest.release.version : null,
    };
    if (notify && newer && !skipped) {
      showNotification(
        `Mod Manager ${managerLatest.release.version} is available`,
        'Download the new version from the updates panel.',
      );
    }
  } else {
    result.manager = { error: managerLatest.error };
  }

  send('updates', result);
  return result;
}

function showNotification(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch { /* notifications are never worth crashing over */ }
}

function scheduleUpdateChecks() {
  if (updateTimer) clearInterval(updateTimer);
  if (!store.get('autoCheckUpdates')) return;
  updateTimer = setInterval(() => {
    checkForUpdates({ notify: true }).catch((err) => log.warn('updates', 'periodic check failed', err.message));
  }, config.UPDATE_CHECK_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------

/** handle() with uniform error mapping so the renderer gets friendly strings. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      log.error('ipc', `${channel} failed`, err);
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function progressReporter(operationId) {
  return (progress) => send('progress', { operationId, ...progress });
}

function beginOperation(operationId) {
  const controller = new AbortController();
  operations.set(operationId, controller);
  return controller;
}

function endOperation(operationId) {
  operations.delete(operationId);
}

function registerIpc() {
  handle('state:get', (options) => fullState(options || {}));

  handle('game:pick', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Pick your Gambonanza folder',
      message: 'Pick the Gambonanza folder inside steamapps/common',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const normalized = game.normalizePickedPath(result.filePaths[0]);
    const info = await game.inspect(normalized);
    if (!info.valid) throw new Error(info.reason);
    store.set('gamePath', info.gameDir);
    // A pack chosen before the game folder existed was bookkeeping only; now
    // there is somewhere to put it.
    await flushTexturePacks(info);
    return info;
  });

  handle('game:detect', async () => {
    const info = await game.autoDetect();
    if (info) {
      store.set('gamePath', info.gameDir);
      await flushTexturePacks(info);
    }
    return info;
  });

  handle('game:launch', async () => {
    openExternalSafe(`steam://rungameid/${config.STEAM_APP_ID}`);
    modpacks.touchPlayed().catch(() => { /* bookkeeping only */ });
    if (store.get('quitOnPlay')) setTimeout(() => app.quit(), 1500);
    return true;
  });

  // ---- Modpacks ----------------------------------------------------------
  //
  // A modpack owns both halves of a setup: the mods in its Mods/ folder and
  // the texture pack it wears. Selecting one therefore always moves both -
  // never the mods alone, or the tab would show a setup the game isn't in.

  handle('modpacks:create', ({ name, author, summary, description, texturePackId, registryId } = {}) =>
    modpacks.create({ name, author, summary, description, texturePackId, registryId }));
  handle('modpacks:rename', ({ id, name } = {}) => modpacks.rename({ id, name }));
  handle('modpacks:describe', (payload = {}) => modpacks.describe(payload));
  handle('modpacks:delete', ({ id } = {}) => modpacks.remove({ id }));
  handle('modpacks:select', async ({ id } = {}) => {
    const info = await currentGameInfo();
    const modsDir = info?.valid ? info.modsDir : null;
    const result = await modpacks.select({ id, modsDir });
    await wearTexturePack(result.texturePackId, modsDir);
    return result;
  });

  // ---- Texture packs -----------------------------------------------------
  //
  // Every edit re-applies the selected pack straight away: there is no Apply
  // button and no way to be looking at a pack the game is not wearing. The
  // game reads the folder at launch, so "takes effect next launch" is the
  // only latency there is.

  /** Push the selected pack into a game folder that just became usable. */
  const flushTexturePacks = async (info) => {
    if (!info?.valid) return;
    await texturePacks.reapply({ modsDir: info.modsDir })
      .catch((err) => log.warn('texturepacks', `could not apply the selected pack: ${err.message}`));
  };

  const modsDirOrNull = async () => {
    const info = await currentGameInfo();
    return info?.valid ? info.modsDir : null;
  };

  const afterPackEdit = async (id) => {
    const modsDir = await modsDirOrNull();
    const state = await texturePacks.summary();
    if (modsDir && state.activeId === id) await texturePacks.syncToGame({ id, modsDir });
    return texturePacks.detail(id);
  };

  handle('texturepacks:detail', ({ id }) => texturePacks.detail(id));
  handle('texturepacks:create', ({ name } = {}) => texturePacks.create({ name }));
  handle('texturepacks:rename', ({ id, name } = {}) => texturePacks.rename({ id, name }));
  handle('texturepacks:describe', (payload = {}) => texturePacks.describe(payload));
  handle('texturepacks:delete', async ({ id } = {}) => {
    const result = await texturePacks.remove({ id, modsDir: await modsDirOrNull() });
    // Nothing may keep pointing at art that no longer exists.
    await modpacks.forgetTexturePack(id);
    return result;
  });
  handle('texturepacks:select', async ({ id = null } = {}) => {
    // Wearing a pack is a property of the setup you are in, not a global
    // switch: switch modpacks and back, and you get your own look back.
    // Recorded only once the pack is actually on, so a rejected id cannot
    // leave the setup pointing at art the game never loaded.
    const result = await texturePacks.setActive({ id, modsDir: await modsDirOrNull() });
    await modpacks.setTexturePack({ texturePackId: id });
    return result;
  });

  handle('texturepacks:catalog', ({ force } = {}) => assetCatalog.browseCatalog({ force: !!force }));
  handle('texturepacks:texts', ({ force } = {}) => assetCatalog.browseTexts({ force: !!force }));
  handle('texturepacks:previews', ({ ids } = {}) => assetCatalog.imageDataUrls(ids));

  /** The user's own art for one override, for the tile hover preview. */
  handle('texturepacks:packPreview', async ({ id, assetId } = {}) => {
    const pack = await texturePacks.detail(id);
    const record = pack.images.find((i) => i.assetId === assetId);
    if (!record) return null;
    const file = path.join(paths.texturePacksDir(), texturePacks.safePackId(id), record.file);
    return `data:image/png;base64,${(await fsp.readFile(file)).toString('base64')}`;
  });

  handle('texturepacks:pickImage', async ({ id, assetId } = {}) => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose your replacement image',
      message: 'Pick a PNG to use instead of this asset',
      filters: [{ name: 'Images', extensions: ['png'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const bytes = await fsp.readFile(result.filePaths[0]);
    const outcome = await texturePacks.setImage({ id, assetId, bytes });
    return { ...outcome, pack: await afterPackEdit(id), from: path.basename(result.filePaths[0]) };
  });

  /** Drag-and-drop hands the bytes straight over; no file dialog involved. */
  handle('texturepacks:setImage', async ({ id, assetId, bytes } = {}) => {
    const buffer = Buffer.from(bytes || []);
    if (!buffer.length) throw new Error('that file was empty');
    const outcome = await texturePacks.setImage({ id, assetId, bytes: buffer });
    return { ...outcome, pack: await afterPackEdit(id) };
  });

  handle('texturepacks:removeImage', async ({ id, assetId } = {}) => {
    await texturePacks.removeImage({ id, assetId });
    return afterPackEdit(id);
  });

  handle('texturepacks:setText', async ({ id, section, key, lang, value, original } = {}) => {
    const outcome = await texturePacks.setText({ id, section, key, lang, value, original });
    return { ...outcome, pack: await afterPackEdit(id) };
  });

  handle('texturepacks:removeText', async ({ id, section, key, lang } = {}) => {
    await texturePacks.removeText({ id, section, key, lang });
    return afterPackEdit(id);
  });

  handle('texturepacks:downloadOriginal', async ({ assetId, name } = {}) => {
    const suggested = `${String(name || assetId).replace(/[^A-Za-z0-9._-]/g, '_')}.png`;
    const result = await dialog.showSaveDialog(win, {
      title: 'Save the original image',
      defaultPath: suggested,
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, await assetCatalog.imageBytes(assetId));
    return { path: result.filePath };
  });

  handle('texturepacks:export', async ({ id } = {}) => {
    const pack = await texturePacks.detail(id);
    const result = await dialog.showSaveDialog(win, {
      title: 'Export texture pack',
      defaultPath: `${String(pack.name).replace(/[^A-Za-z0-9._-]/g, '_') || 'texture-pack'}.zip`,
      filters: [{ name: 'Zip archive', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return texturePacks.exportPack({ id, destPath: result.filePath });
  });

  handle('texturepacks:import', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Import a texture pack',
      message: 'Pick a texture pack zip someone shared with you',
      filters: [{ name: 'Zip archive', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return texturePacks.importPack({ zipPath: result.filePaths[0] });
  });

  handle('texturepacks:install', async ({ id, operationId } = {}) => {
    const reg = await registry.getIndex({});
    const entry = (reg.index.texturepacks || []).find((p) => p.id === id);
    if (!entry) throw new Error('that texture pack is no longer in the registry');
    const controller = beginOperation(operationId);
    try {
      return await texturePacks.installFromRegistry({
        entry,
        onProgress: progressReporter(operationId),
        signal: controller.signal,
      });
    } finally {
      endOperation(operationId);
    }
  });

  handle('texturepacks:publish', async ({ entry } = {}) => {
    const token = store.get('githubToken');
    if (!token) throw new Error('sign in with GitHub first');
    return publish.submitTexturePack(token, sanitizeTexturePackEntry(entry), {
      onStep: (message) => send('progress', { operationId: 'publish', step: 'publish', message, percent: null }),
    });
  });

  handle('texturepacks:publishIssueUrl', ({ entry } = {}) => publish.texturePackIssueUrl(sanitizeTexturePackEntry(entry, { partial: true })));

  handle('texturepacks:openFolder', async ({ id } = {}) => {
    const dir = path.join(paths.texturePacksDir(), texturePacks.safePackId(id));
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    await shell.openPath(dir);
    return true;
  });

  handle('game:openFolder', async (which) => {
    const info = await currentGameInfo();
    if (!info?.valid) throw new Error('no game folder is configured');
    const dir = which === 'mods' ? info.modsDir : info.gameDir;
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    await shell.openPath(dir);
    return true;
  });

  handle('framework:patch', async ({ operationId, tag } = {}) => {
    const controller = beginOperation(operationId);
    try {
      let release = null;
      if (tag) {
        const releases = await framework.listReleases({});
        if (!releases.ok) throw new Error(releases.error);
        release = releases.framework.find((r) => r.tag === tag) || null;
        if (!release) throw new Error(`release ${tag} was not found`);
      }
      const result = await framework.patch({
        gameDir: (await currentGameInfo())?.gameDir || store.get('gamePath'),
        release,
        onProgress: progressReporter(operationId),
        signal: controller.signal,
      });
      store.set('dismissedFrameworkVersion', '');
      // Patching creates the Mods folder the pack sits next to.
      await flushTexturePacks(await currentGameInfo());
      return result;
    } finally {
      endOperation(operationId);
    }
  });

  handle('framework:restore', async ({ removeMods } = {}) => {
    const info = await currentGameInfo();
    if (!info?.valid) throw new Error('no game folder is configured');
    return framework.restore({ gameDir: info.gameDir, removeMods: !!removeMods });
  });

  handle('framework:backups', () => framework.listBackups());

  handle('framework:restoreBackup', async ({ id }) => {
    const info = await currentGameInfo();
    if (!info?.valid) throw new Error('no game folder is configured');
    return framework.restoreBackup({ gameDir: info.gameDir, id });
  });

  handle('framework:releases', async () => {
    const releases = await framework.listReleases({});
    if (!releases.ok) throw new Error(releases.error);
    return releases;
  });

  handle('updates:check', () => checkForUpdates({ notify: false }));

  handle('manager:applyUpdate', async ({ operationId } = {}) => {
    const latest = await framework.latestManagerRelease({});
    if (!latest.ok) throw new Error(latest.error);
    if (compareTags(latest.release.version, app.getVersion()) <= 0) {
      throw new Error('you are already on the newest version');
    }
    const controller = beginOperation(operationId);
    try {
      return await updater.applyManagerUpdate({
        release: latest.release,
        onProgress: progressReporter(operationId),
        signal: controller.signal,
      });
    } finally {
      endOperation(operationId);
    }
  });
  handle('updates:dismiss', ({ kind, version }) => {
    if (kind === 'framework') store.set('dismissedFrameworkVersion', version);
    if (kind === 'manager') store.set('dismissedManagerVersion', version);
    return true;
  });

  handle('mods:install', async ({ id, operationId }) => {
    const info = await currentGameInfo();
    if (!info?.valid) throw new Error('set up your game folder first');
    if (!info.patched) throw new Error('patch the game first - mods need the framework to load');

    const reg = await registry.getIndex({});
    const mod = (reg.index.mods || []).find((m) => m.id === id);
    if (!mod) throw new Error('that mod is no longer in the registry');

    const installed = await modsApi.listInstalled(info.modsDir);
    const plan = modsApi.resolveInstallPlan(mod, reg.index.mods, installed);

    const controller = beginOperation(operationId);
    const report = progressReporter(operationId);
    try {
      const results = [];
      for (const entry of plan) {
        results.push(await modsApi.install({
          mod: entry,
          modsDir: info.modsDir,
          onProgress: report,
          signal: controller.signal,
        }));
      }
      return { installed: results };
    } finally {
      endOperation(operationId);
    }
  });

  /**
   * Install a shared setup. `into: 'new'` (the default) builds it as its own
   * modpack and switches to it, which is what "get someone's setup" means -
   * you try theirs without losing yours. `into: 'active'` merges it into the
   * setup you are already in for people who just want the mods.
   *
   * The texture pack comes along: a setup is how the game plays AND how it
   * looks, and downloading half of one would be a strange thing to ship.
   */
  handle('modpacks:install', async ({ id, operationId, into = 'new' } = {}) => {
    const info = await currentGameInfo();
    if (!info?.valid) throw new Error('set up your game folder first');
    if (!info.patched) throw new Error('patch the game first - mods need the framework to load');

    const reg = await registry.getIndex({});
    const pack = (reg.index.modpacks || []).find((p) => p.id === id);
    if (!pack) throw new Error('that modpack is no longer in the registry');

    const controller = beginOperation(operationId);
    const report = progressReporter(operationId);
    const cameFrom = (await modpacks.active())?.id || null;
    let target = null;
    const results = [];
    try {
      if (into === 'new') {
        target = await modpacks.create({
          name: pack.name,
          author: pack.author || '',
          summary: pack.summary || '',
          description: pack.description || '',
          registryId: pack.id,
        });
        report({ step: 'pack', message: `Switching to "${target.name}"`, percent: null });
        await modpacks.select({ id: target.id, modsDir: info.modsDir });
        await wearTexturePack(null, info.modsDir);
      }

      // Read the destination AFTER the swap - "what is already here" is a
      // different answer in a brand new modpack than in the one we came from.
      const installed = await modsApi.listInstalled(info.modsDir);
      const plan = modsApi.resolveModpackPlan(pack, reg.index.mods || [], installed);

      for (let i = 0; i < plan.length; i++) {
        report({ step: 'pack', message: `${pack.name}: mod ${i + 1} of ${plan.length}`, percent: null });
        results.push(await modsApi.install({
          mod: plan[i],
          modsDir: info.modsDir,
          onProgress: report,
          signal: controller.signal,
        }));
      }

      const skin = await installPackSkin(pack, { report, signal: controller.signal, modsDir: info.modsDir });
      return { installed: results, modpackId: target?.id || null, texturePack: skin };
    } catch (err) {
      // Cancelling a download must not leave the player sitting in an empty
      // modpack they never asked for: put them back where they were and take
      // the husk away. A partial install is different - those mods are real
      // work, so the modpack stays and they keep looking at it.
      if (target && !results.length) {
        await rollbackNewModpack(target.id, cameFrom, info.modsDir);
      }
      throw err;
    } finally {
      endOperation(operationId);
    }
  });

  handle('mods:uninstall', async ({ folder }) => {
    const info = await currentGameInfo();
    if (!info?.valid) throw new Error('no game folder is configured');

    // A library other installed mods depend on cannot be pulled out from
    // under them - removing GambitApi would break every custom gambit.
    const reg = await registry.getIndex({});
    const installed = await modsApi.listInstalled(info.modsDir);
    const dependents = modsApi.findDependents(folder, reg.index.mods || [], installed);
    if (dependents.length) {
      throw new Error(`${dependents.join(' and ')} need${dependents.length === 1 ? 's' : ''} this mod to work - remove ${dependents.length === 1 ? 'it' : 'them'} first.`);
    }

    return modsApi.uninstall({ modsDir: info.modsDir, folder });
  });

  handle('mods:setEnabled', async ({ folder, enabled }) => {
    const info = await currentGameInfo();
    if (!info?.valid) throw new Error('no game folder is configured');
    return modsApi.setEnabled({ modsDir: info.modsDir, folder, enabled });
  });

  handle('operation:cancel', ({ operationId }) => {
    operations.get(operationId)?.abort();
    return true;
  });

  handle('settings:set', (values) => {
    store.patch(values || {});
    scheduleUpdateChecks();
    return store.publicView();
  });

  handle('log:history', () => log.history());
  handle('log:openFile', async () => {
    if (log.file()) await shell.showItemInFolder(log.file());
    return true;
  });

  handle('shell:openExternal', (url) => {
    openExternalSafe(String(url || ''));
    return true;
  });

  // ---- Publish tab -------------------------------------------------------

  handle('publish:begin', async () => {
    const flow = await publish.beginDeviceFlow();
    // Poll in the background; renderer listens for the outcome.
    (async () => {
      try {
        const { token, login } = await publish.pollDeviceFlow(flow);
        store.patch({ githubToken: token, githubLogin: login });
        send('publish:signedIn', { login });
      } catch (err) {
        send('publish:signInFailed', { error: err.message });
      }
    })();
    return { userCode: flow.userCode, verificationUri: flow.verificationUri, expiresIn: flow.expiresIn };
  });

  handle('publish:signOut', () => {
    store.patch({ githubToken: '', githubLogin: '' });
    return true;
  });

  handle('publish:repos', () => {
    const token = store.get('githubToken');
    if (!token) throw new Error('sign in with GitHub first');
    return publish.listRepos(token);
  });

  handle('publish:releases', ({ repo }) => {
    const token = store.get('githubToken');
    if (!token) throw new Error('sign in with GitHub first');
    return publish.listReleaseAssets(token, repo);
  });

  handle('publish:submit', async ({ entry }) => {
    const token = store.get('githubToken');
    if (!token) throw new Error('sign in with GitHub first');
    const clean = sanitizeEntry(entry);
    return publish.submitEntry(token, clean, {
      onStep: (message) => send('progress', { operationId: 'publish', step: 'publish', message, percent: null }),
    });
  });

  handle('publish:issueUrl', ({ entry }) => publish.submissionIssueUrl(sanitizeEntry(entry, { partial: true })));

  handle('publish:submitModpack', async ({ entry }) => {
    const token = store.get('githubToken');
    if (!token) throw new Error('sign in with GitHub first');
    const clean = sanitizeModpackEntry(entry);
    return publish.submitModpack(token, clean, {
      onStep: (message) => send('progress', { operationId: 'publish', step: 'publish', message, percent: null }),
    });
  });

  handle('publish:modpackIssueUrl', ({ entry }) => publish.modpackIssueUrl(sanitizeModpackEntry(entry, { partial: true })));
}

/** The renderer builds the entry object; re-validate everything here. */
function sanitizeEntry(raw, { partial = false } = {}) {
  const entry = {};
  const take = (key, max = 200) => {
    const v = raw?.[key];
    if (typeof v === 'string' && v.trim()) entry[key] = v.trim().slice(0, max);
  };
  take('id', 40);
  take('name', 48);
  take('author', 48);
  take('summary', 140);
  take('description', 4000);
  take('repo', 100);
  take('asset', 120);
  take('folder', 48);
  take('gameVersion', 40);
  if (Array.isArray(raw?.tags)) entry.tags = raw.tags.filter((t) => typeof t === 'string').slice(0, 5);
  if (raw?.manifest?.entry && typeof raw.manifest.entry === 'string') {
    entry.manifest = { entry: raw.manifest.entry.trim().slice(0, 200) };
  }
  if (!partial) {
    for (const field of ['id', 'name', 'author', 'summary', 'repo', 'asset', 'folder']) {
      if (!entry[field]) throw new Error(`the "${field}" field is required`);
    }
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(entry.id)) {
      throw new Error('the id must be lowercase letters, digits and dashes, like "my-cool-mod"');
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repo)) {
      throw new Error('the repository must look like owner/name');
    }
    entry.submittedBy = store.get('githubLogin') || undefined;
    entry.addedAt = new Date().toISOString().slice(0, 10);
  }
  return entry;
}

/** Same job as sanitizeEntry, for the much smaller modpack shape. */
function sanitizeModpackEntry(raw, { partial = false } = {}) {
  const entry = {};
  const take = (key, max = 200) => {
    const v = raw?.[key];
    if (typeof v === 'string' && v.trim()) entry[key] = v.trim().slice(0, max);
  };
  take('id', 40);
  take('name', 48);
  take('author', 48);
  take('summary', 140);
  take('description', 4000);
  take('texturepack', 40);
  if (Array.isArray(raw?.mods)) {
    entry.mods = [...new Set(raw.mods.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()))].slice(0, 24);
  }
  if (Array.isArray(raw?.tags)) entry.tags = raw.tags.filter((t) => typeof t === 'string').slice(0, 5);
  if (!partial) {
    for (const field of ['id', 'name', 'author', 'summary']) {
      if (!entry[field]) throw new Error(`the "${field}" field is required`);
    }
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(entry.id)) {
      throw new Error('the id must be lowercase letters, digits and dashes, like "my-first-pack"');
    }
    // A setup is worth sharing as soon as it changes something. One mod, or
    // no mods and a texture pack, are both real answers to "what is my game".
    if (!entry.mods?.length && !entry.texturepack) {
      throw new Error('a modpack needs at least one mod or a texture pack in it');
    }
    entry.submittedBy = store.get('githubLogin') || undefined;
    entry.addedAt = new Date().toISOString().slice(0, 10);
  }
  return entry;
}

/** Same job again, for the texture pack shape. */
function sanitizeTexturePackEntry(raw, { partial = false } = {}) {
  const entry = {};
  const take = (key, max = 200) => {
    const v = raw?.[key];
    if (typeof v === 'string' && v.trim()) entry[key] = v.trim().slice(0, max);
  };
  take('id', 40);
  take('name', 48);
  take('author', 48);
  take('summary', 140);
  take('description', 4000);
  take('repo', 100);
  take('asset', 120);
  take('tagPattern', 60);
  take('homepage', 200);
  take('preview', 300);
  take('gameVersion', 40);
  if (Array.isArray(raw?.tags)) entry.tags = raw.tags.filter((t) => typeof t === 'string').slice(0, 5);
  if (!partial) {
    for (const field of ['id', 'name', 'author', 'summary', 'repo', 'asset']) {
      if (!entry[field]) throw new Error(`the "${field}" field is required`);
    }
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(entry.id)) {
      throw new Error('the id must be lowercase letters, digits and dashes, like "midnight-chess"');
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repo)) {
      throw new Error('the repository must look like owner/name');
    }
    entry.submittedBy = store.get('githubLogin') || undefined;
    entry.addedAt = new Date().toISOString().slice(0, 10);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    paths.setRoot(app.getPath('userData'));
    log.init(paths.logsDir());
    store = new Store(paths.settingsFile());
    await fsp.rm(paths.tempDir(), { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(paths.tempDir(), { recursive: true });

    // Exactly once per upgrade: setups migrated from the old "instances" world
    // have no opinion about texture packs yet, so whatever the game is wearing
    // is credited to the active one. Without it, the first switch after
    // upgrading would quietly undress the game. Two small file reads, and it
    // happens before the window can ask for state - otherwise the first paint
    // could show "no texture pack" for a setup that is wearing one.
    await (async () => {
      const skin = await texturePacks.summary().catch(() => null);
      await modpacks.adoptTexturePack(skin?.activeId || null);
    })().catch((err) => log.warn('modpacks', `could not adopt the worn texture pack: ${err.message}`));

    registerIpc();
    createWindow();

    // Self-heal the applied texture pack: a game reinstall, a moved install or
    // a Steam "verify integrity" can take the folder with it, and the tab would
    // otherwise keep claiming a pack is on when the game has nothing to load.
    (async () => {
      const info = await currentGameInfo();
      if (info?.valid) await texturePacks.reapply({ modsDir: info.modsDir });
    })().catch((err) => log.warn('texturepacks', `startup re-apply failed: ${err.message}`));

    if (store.get('autoCheckUpdates')) {
      // Give the window a moment to paint before hitting the network.
      setTimeout(() => {
        checkForUpdates({ notify: true }).catch((err) => log.warn('updates', 'startup check failed', err.message));
      }, 2500);
    }
    scheduleUpdateChecks();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
