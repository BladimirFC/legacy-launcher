'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SettingsStore, validateSettings, validateDiscord } = require('./lib/settings.cjs');
const { inspectGame, queryServer, launchGame } = require('./lib/samp.cjs');

app.setName('Legacy Launcher');

let mainWindow;
let store;
let statusPromise;
let statusDestination;
let launching = false;
const rendererPath = path.join(__dirname, 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererPath).href;

function trustedHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== rendererUrl) {
      throw new Error('Solicitud no autorizada.');
    }
    return handler(...args);
  });
}

function registerHandlers() {
  trustedHandler('legacy:bootstrap', () => ({ settings: store.get(), version: app.getVersion(), platform: process.platform, warning: store.warning }));
  trustedHandler('legacy:save-settings', (settings) => store.save(settings));
  trustedHandler('legacy:choose-game-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Selecciona la carpeta de GTA San Andreas',
      buttonLabel: 'Usar esta carpeta',
      defaultPath: store.get().gamePath || undefined,
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const gamePath = result.filePaths[0];
    return { path: gamePath, ...await inspectGame(gamePath) };
  });
  trustedHandler('legacy:inspect-game', async (gamePath) => {
    if (typeof gamePath !== 'string' || gamePath.length > 4096) throw new Error('La ruta del juego no es válida.');
    return inspectGame(gamePath);
  });
  trustedHandler('legacy:server-status', async () => {
    const settings = store.get();
    if (!settings.serverHost) return { state: 'unconfigured', name: 'Legacy', players: null, maxPlayers: null, ping: null, message: 'Configura la dirección del servidor para consultar su estado.' };
    // Share one pending query across rapid clicks instead of opening extra sockets.
    const destination = `${settings.serverHost}:${settings.serverPort}`;
    if (!statusPromise || statusDestination !== destination) {
      statusDestination = destination;
      const query = queryServer(settings.serverHost, settings.serverPort)
        .then((info) => ({ state: 'online', ...info, message: 'Servidor disponible.' }))
        .catch(() => ({ state: 'offline', name: 'Legacy', players: null, maxPlayers: null, ping: null, message: 'Sin respuesta. El servidor puede estar desconectado o tener las consultas desactivadas.' }))
        .finally(() => { if (statusPromise === query) statusPromise = null; });
      statusPromise = query;
    }
    return statusPromise;
  });
  trustedHandler('legacy:play', async () => {
    if (launching) throw new Error('SA-MP ya se está abriendo. Espera un momento.');
    launching = true;
    try { return await launchGame(store.get()); }
    finally { launching = false; }
  });
  trustedHandler('legacy:open-discord', async () => {
    const url = validateDiscord(store.get().discordUrl);
    if (!url) throw new Error('Configura primero el enlace de invitación a Discord.');
    await shell.openExternal(url);
  });
  trustedHandler('legacy:minimize', () => mainWindow?.minimize());
  trustedHandler('legacy:close', () => mainWindow?.close());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Legacy Launcher',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 700,
    frame: false,
    backgroundColor: '#050208',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(rendererPath);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(async () => {
    let defaults = {};
    let configWarning = '';
    try {
      const config = JSON.parse(await fs.readFile(path.join(__dirname, 'launcher-config.json'), 'utf8'));
      defaults = validateSettings({ serverHost: config.serverHost, serverPort: config.serverPort, discordUrl: config.discordUrl });
    } catch (error) {
      if (error.code !== 'ENOENT') configWarning = 'La configuración inicial no es válida. Introduce los datos del servidor en Ajustes.';
    }
    store = new SettingsStore(app.getPath('userData'), defaults);
    await store.load();
    if (configWarning && !store.warning) store.warning = configWarning;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    registerHandlers();
    createWindow();
    app.on('activate', () => { if (!mainWindow) createWindow(); });
  }).catch((error) => {
    dialog.showErrorBox('Legacy Launcher', `No se pudo iniciar el launcher: ${error.message}`);
    app.quit();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
