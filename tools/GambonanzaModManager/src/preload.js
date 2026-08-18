'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The complete privilege boundary between the sandboxed UI and the main
// process. Everything is invoke/response plus three event streams; the
// renderer cannot name an arbitrary channel.

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

const EVENT_CHANNELS = new Set(['progress', 'updates', 'publish:signedIn', 'publish:signInFailed']);

contextBridge.exposeInMainWorld('gambonanza', {
  getState: invoke('state:get'),

  pickGameFolder: invoke('game:pick'),
  detectGame: invoke('game:detect'),
  launchGame: invoke('game:launch'),
  openGameFolder: invoke('game:openFolder'),

  patchGame: invoke('framework:patch'),
  restoreGame: invoke('framework:restore'),
  listBackups: invoke('framework:backups'),
  restoreBackup: invoke('framework:restoreBackup'),
  listReleases: invoke('framework:releases'),

  checkUpdates: invoke('updates:check'),
  dismissUpdate: invoke('updates:dismiss'),
  applyManagerUpdate: invoke('manager:applyUpdate'),

  installMod: invoke('mods:install'),
  uninstallMod: invoke('mods:uninstall'),
  setModEnabled: invoke('mods:setEnabled'),
  installModpack: invoke('modpacks:install'),
  cancelOperation: invoke('operation:cancel'),

  createInstance: invoke('instances:create'),
  renameInstance: invoke('instances:rename'),
  deleteInstance: invoke('instances:delete'),
  selectInstance: invoke('instances:select'),

  setSettings: invoke('settings:set'),
  getLogHistory: invoke('log:history'),
  openLogFile: invoke('log:openFile'),
  openExternal: invoke('shell:openExternal'),

  publishBegin: invoke('publish:begin'),
  publishSignOut: invoke('publish:signOut'),
  publishListRepos: invoke('publish:repos'),
  publishListReleases: invoke('publish:releases'),
  publishSubmit: invoke('publish:submit'),
  publishIssueUrl: invoke('publish:issueUrl'),
  publishSubmitModpack: invoke('publish:submitModpack'),
  publishModpackIssueUrl: invoke('publish:modpackIssueUrl'),

  /** Subscribe to an event stream; returns an unsubscribe function. */
  on(channel, handler) {
    if (!EVENT_CHANNELS.has(channel)) throw new Error(`unknown event channel: ${channel}`);
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
