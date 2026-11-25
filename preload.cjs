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
  openDiscord: () => ipcRenderer.invoke('legacy:open-discord'),
  minimize: () => ipcRenderer.invoke('legacy:minimize'),
  close: () => ipcRenderer.invoke('legacy:close'),
}));
