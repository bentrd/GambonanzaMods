'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Settings live in one small JSON file in the OS's app-data directory. Written
// atomically (temp file + rename) so a crash mid-write can never leave a
// half-written settings file that stops the app from starting.

const DEFAULTS = {
  /** User-picked game folder. Empty = auto-detect on every launch. */
  gamePath: '',
  /** Skip the welcome screen once the user has been through it. */
  onboarded: false,
  /** Check GitHub for framework/app updates on launch. */
  autoCheckUpdates: true,
  /** Offer to update installed mods when a newer release appears. */
  autoCheckModUpdates: true,
  /** Framework release the user chose to stop being nagged about. */
  dismissedFrameworkVersion: '',
  /** Manager release the user chose to stop being nagged about. */
  dismissedManagerVersion: '',
  /** Close the manager when the game is launched from it. */
  quitOnPlay: false,
  /** GitHub token from the device-flow login, for publishing mods. */
  githubToken: '',
  githubLogin: '',
  /** Last view the user was on, restored on next launch. */
  lastView: 'home',
  windowBounds: null,
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        // Only take keys we know about: a settings file from a newer version
        // should not be able to inject arbitrary state into an older one.
        for (const key of Object.keys(DEFAULTS)) {
          if (parsed[key] !== undefined) this.data[key] = parsed[key];
        }
      }
    } catch { /* first run, or unreadable - defaults are fine */ }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`unknown setting: ${key}`);
    this.data[key] = value;
    this.save();
    return value;
  }

  patch(values) {
    for (const [key, value] of Object.entries(values)) {
      if (key in DEFAULTS) this.data[key] = value;
    }
    this.save();
    return this.data;
  }

  /** Everything except secrets - this is what the renderer is allowed to see. */
  publicView() {
    const { githubToken, ...rest } = this.data;
    return { ...rest, githubSignedIn: !!githubToken };
  }
}

module.exports = { Store, DEFAULTS };
