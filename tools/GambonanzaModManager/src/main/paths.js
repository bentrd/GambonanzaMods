'use strict';

const path = require('node:path');
const os = require('node:os');

// Where the manager keeps its own state. index.js points this at Electron's
// userData directory on startup; tests point it at a temp folder. Nothing else
// in the app is allowed to guess these locations.

let root = path.join(os.tmpdir(), 'gambonanza-mod-manager');

module.exports = {
  setRoot(dir) { root = dir; },
  root: () => root,

  /** Downloaded + unpacked framework bundles, one folder per release tag. */
  frameworkDir: (tag = '') => path.join(root, 'framework', tag),

  /** Timestamped copies of Assembly-CSharp.dll taken before we touch it. */
  backupsDir: () => path.join(root, 'backups'),

  /** Registry index cache, release metadata cache. */
  cacheDir: () => path.join(root, 'cache'),

  /** Scratch space for in-flight downloads. Cleared on startup. */
  tempDir: () => path.join(root, 'tmp'),

  /** Instance records + parked Mods folders of non-active instances. */
  instancesDir: () => path.join(root, 'instances'),

  /** manager.log lives here. */
  logsDir: () => path.join(root, 'logs'),

  settingsFile: () => path.join(root, 'settings.json'),
};
