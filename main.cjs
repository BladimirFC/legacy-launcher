'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SettingsStore, validateSettings, validateDiscord } = require('./lib/settings.cjs');
const { inspectGame, queryServer, launchGame } = require('./lib/samp.cjs');
const { createUpdateManager, RELEASE_URL } = require('./lib/updater.cjs');
const { createCefVerifier } = require('./lib/cef.cjs');
const cefVerifier = createCefVerifier();
const UPDATE_FRESHNESS_MS = 60_000;

app.setName('Legacy Launcher');

let mainWindow;
let store;
let statusPromise;
let statusDestination;
let launching = false;
let updates;
let confirmingUpdate = false;
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
  trustedHandler('legacy:update-state', () => updates.getState());
  trustedHandler('legacy:update-check', () => launching ? updates.getState() : updates.check());
  trustedHandler('legacy:update-download', () => launching ? updates.getState() : updates.download());
  trustedHandler('legacy:update-releases', () => shell.openExternal(RELEASE_URL));
  trustedHandler('legacy:update-install', async () => {
    if (launching || confirmingUpdate || updates.getState().phase !== 'ready') return false;
    confirmingUpdate = true;
    try {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Actualizar Legacy Launcher',
        message: '¿Aplicar la actualización y reiniciar el launcher?',
        detail: 'La actualización se aplicará silenciosamente y conservará tus preferencias. La descarga se verificó con el manifiesto de GitHub, pero todavía no dispone de firma Authenticode. Continúa solo si confías en las publicaciones oficiales de Legacy.',
        buttons: ['Actualizar y reiniciar', 'Ahora no'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      return result.response === 0 && !launching && updates.install();
    } finally { confirmingUpdate = false; }
  });
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
    const game = await inspectGame(gamePath);
    if (!game.valid) return game;
    try {
      const cef = await cefVerifier.check(gamePath);
      return { ...game, cefReady: cef.ready };
    } catch { return { ...game, cefReady: false }; }
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
    if (launching || confirmingUpdate) throw new Error('Hay otra operación en curso.');
    launching = true;
    try {
      await updates.requireCurrent({ maxAgeMs: UPDATE_FRESHNESS_MS });
      const contents = mainWindow.webContents;
      return await launchGame(store.get(), {
        prepare: cefVerifier.prepare,
        beforeLaunch: () => updates.requireCurrent({ maxAgeMs: UPDATE_FRESHNESS_MS }),
        onProgress: (progress) => {
          if (!contents.isDestroyed()) contents.send('legacy:play-progress', progress);
        },
      });
    }
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
    // All packaged Windows builds check for updates; only NSIS installs can apply them.
    const supported = app.isPackaged && process.platform === 'win32';
    const installed = supported &&
      await fs.access(path.join(path.dirname(process.execPath), '.legacy-installed')).then(() => true, () => false);
    const updater = supported ? require('electron-updater').autoUpdater : null;
    updates = createUpdateManager(updater, {
      enabled: supported,
      canInstall: installed,
      autoFetch: true,
      onState: (state) => {
        if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('legacy:update-state', state);
      },
    });
    registerHandlers();
    createWindow();
    void updates.check();
    app.on('activate', () => { if (!mainWindow) createWindow(); });
  }).catch((error) => {
    dialog.showErrorBox('Legacy Launcher', `No se pudo iniciar el launcher: ${error.message}`);
    app.quit();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
