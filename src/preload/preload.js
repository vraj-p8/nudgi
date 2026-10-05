'use strict';

// Single preload shared by the overlay and settings windows.
// Exposes a narrow, promise-based bridge as window.nudge (contextIsolation + sandbox).
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('nudge', {
  // ---- shared state ----
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => subscribe('state:changed', cb),

  // ---- settings window ----
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  saveReminder: (reminder) => ipcRenderer.invoke('reminder:save', reminder),
  deleteReminder: (id) => ipcRenderer.invoke('reminder:delete', id),
  testReminder: (reminder) => ipcRenderer.invoke('reminder:test', reminder),
  pickAvatarImage: () => ipcRenderer.invoke('avatar:pick'),
  pickAvatarModel: () => ipcRenderer.invoke('avatar:model'),
  openAvatarGuide: () => ipcRenderer.invoke('avatar:guide'),
  clearAvatarImage: () => ipcRenderer.invoke('avatar:clear'),
  setPause: (untilMs) => ipcRenderer.invoke('pause:set', untilMs),
  resetStats: () => ipcRenderer.invoke('stats:reset'),
  openSettings: () => ipcRenderer.send('window:openSettings'),

  // ---- overlay window ----
  onRun: (cb) => subscribe('overlay:run', cb),
  overlayReady: () => ipcRenderer.send('overlay:ready'),
  respond: (runId, outcome) => ipcRenderer.send('overlay:respond', { runId, outcome }),
  runDone: (runId) => ipcRenderer.send('overlay:done', { runId }),
  setInteractive: (interactive) => ipcRenderer.send('overlay:interactive', !!interactive),
});
