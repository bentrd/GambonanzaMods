'use strict';

// Every "where does this come from" decision in one place.
//
// The manager talks to exactly three hosts and nothing else:
//   - bentrd.github.io       the mod registry index (CDN-cached, no rate limit)
//   - api.github.com         release metadata for the framework + the manager
//   - github.com             release asset downloads (redirects to *.githubusercontent.com)
//
// net.js enforces that list; adding a host here is not enough to widen it.

const HOME_REPO = 'bentrd/GambonanzaMods';

function readBakedClientId() {
  try {
    // eslint-disable-next-line global-require
    return require('../../assets/github-oauth.json').clientId || '';
  } catch {
    return '';
  }
}

module.exports = {
  /** The repo that owns the framework, the registry and this app. */
  HOME_REPO,

  /** Steam app id, used for the "Play" button (steam://rungameid/...). */
  STEAM_APP_ID: '3509230',

  /** Folder name the game reads mods from, relative to the game runtime dir. */
  MODS_DIR_NAME: 'Mods',

  /** Registry index: GitHub Pages first, raw.githubusercontent as a fallback. */
  REGISTRY_URLS: [
    'https://bentrd.github.io/GambonanzaMods/registry/index.json',
    `https://raw.githubusercontent.com/${HOME_REPO}/main/registry/index.json`,
  ],

  /** Release tags that publish this app. Framework releases use plain v*. */
  MANAGER_TAG_PREFIX: 'manager-v',

  /** Asset name pattern for the per-platform framework bundle. */
  frameworkAssetName(rid) {
    return `gambonanza-framework-${rid}.zip`;
  },

  /**
   * .NET runtime identifier for the current machine. The framework bundle
   * ships one patcher binary per RID; we only ever download our own.
   */
  currentRid(platform = process.platform, arch = process.arch) {
    if (platform === 'darwin') return arch === 'arm64' ? 'osx-arm64' : 'osx-x64';
    if (platform === 'win32') return arch === 'arm64' ? 'win-arm64' : 'win-x64';
    if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
    return null;
  },

  /** How often to look for framework / app updates, in milliseconds. */
  UPDATE_CHECK_INTERVAL_MS: 6 * 60 * 60 * 1000,

  /** Registry cache lifetime before we go back to the network. */
  REGISTRY_TTL_MS: 30 * 60 * 1000,

  /** Refuse downloads bigger than this. Mods are KBs; bundles are ~10 MB. */
  MAX_DOWNLOAD_BYTES: 256 * 1024 * 1024,

  /** GitHub OAuth app client id for "Sign in with GitHub" (device flow).
   *  Device flow needs no client secret, so shipping this in the app is fine -
   *  it is a public identifier, not a credential. Empty = the Publish screen
   *  falls back to opening a pre-filled issue in the browser, which needs no
   *  sign-in at all. See docs/MOD_PUBLISHING.md to set one up.
   *
   *  Resolution order: env var (development) → assets/github-oauth.json
   *  (baked in by the release workflow from the GAMBONANZA_GITHUB_CLIENT_ID
   *  repository secret) → disabled. */
  GITHUB_CLIENT_ID: process.env.GAMBONANZA_GITHUB_CLIENT_ID || readBakedClientId(),
};
