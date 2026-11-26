'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('legacy', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('legacy:bootstrap'),
  saveSettings: (settings) => ipcRenderer.invoke('legacy:save-settings', settings),
  chooseGameFolder: () => ipcRenderer.invoke('legacy:choose-game-folder'),
  inspectGame: (gamePath) => ipcRenderer.invoke('legacy:inspect-game', gamePath),
  serverStatus: () => ipcRenderer.invoke('legacy:server-status'),
  play: () => ipcRenderer.invoke('legacy:play'),
  onPlayProgress: (callback) => {
    ipcRenderer.on('legacy:play-progress', (_event, progress) => callback(progress));
  },
  updateState: () => ipcRenderer.invoke('legacy:update-state'),
  checkUpdate: () => ipcRenderer.invoke('legacy:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('legacy:update-download'),
  installUpdate: () => ipcRenderer.invoke('legacy:update-install'),
  openReleases: () => ipcRenderer.invoke('legacy:update-releases'),
  onUpdateState: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback');
    ipcRenderer.on('legacy:update-state', (_event, state) => callback(state));
  },
  openDiscord: () => ipcRenderer.invoke('legacy:open-discord'),
  minimize: () => ipcRenderer.invoke('legacy:minimize'),
  close: () => ipcRenderer.invoke('legacy:close'),
}));
