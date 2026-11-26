'use strict';

// Development-only renderer checks. The desktop API is mocked only in this file.
// Install Playwright locally or set PLAYWRIGHT_MODULE to its package path.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(process.env.PLAYWRIGHT_MODULE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }

const project = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const validPath = 'C:\\Games\\GTA San Andreas';

async function serveProject() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      const filename = path.resolve(project, `.${pathname}`);
      if (!filename.startsWith(`${project}${path.sep}`)) { response.writeHead(403); response.end(); return; }
      const content = await fs.readFile(filename);
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(content);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/renderer/index.html` };
}

async function mockDesktop(page) {
  await page.addInitScript(({ validPath, version }) => {
    const state = {
      settings: { nickname: '', gamePath: '', serverHost: '', serverPort: 7777, discordUrl: '' },
      saves: [], plays: 0, discords: 0, nextFolder: null,
    };
    let reportPlayProgress;
    let reportUpdateState;
    window.__mockDesktop = state;
    window.legacy = {
      async bootstrap() { return { settings: { ...state.settings }, version, platform: 'win32' }; },
      async inspectGame(gamePath) { return { valid: gamePath === validPath, message: gamePath === validPath ? 'GTA San Andreas y SA-MP encontrados.' : 'Selecciona una carpeta con gta_sa.exe y samp.exe.' }; },
      async saveSettings(settings) {
        if (/\s/.test(settings.nickname)) throw new Error('El nombre no puede contener espacios.');
        if (settings.serverHost.includes('/')) throw new Error('Introduce una IP o dominio, sin protocolo ni rutas.');
        if (settings.discordUrl && !settings.discordUrl.startsWith('https://discord.gg/')) throw new Error('Utiliza una invitación de Discord válida.');
        state.settings = { ...settings };
        state.saves.push({ ...settings });
        return { ...settings };
      },
      async chooseGameFolder() { return state.nextFolder; },
      async serverStatus() {
        return state.settings.serverHost
          ? { state: 'online', name: 'Servidor local de pruebas', players: 3, maxPlayers: 100, ping: 18 }
          : { state: 'unconfigured', message: 'Sin IP configurada.' };
      },
      onPlayProgress(callback) { reportPlayProgress = callback; },
      onUpdateState(callback) { reportUpdateState = callback; },
      async updateState() { return { phase: 'idle' }; },
      async checkUpdate() { reportUpdateState({ phase: 'available', version: '0.1.5' }); },
      async downloadUpdate() {
        reportUpdateState({ phase: 'downloading', version: '0.1.5', percent: 62 });
        await new Promise(resolve => { state.finishUpdate = resolve; });
        reportUpdateState({ phase: 'ready', version: '0.1.5', percent: 100 });
      },
      async installUpdate() { state.updateInstalls = (state.updateInstalls || 0) + 1; reportUpdateState({ phase: 'installing' }); },
      async openReleases() {},
      async play() {
        state.plays++;
        reportPlayProgress({ phase: 'download', percent: 42 });
        await new Promise(resolve => { state.finishDownload = resolve; });
        reportPlayProgress({ phase: 'launch' });
        return { ok: true, message: 'SA-MP abierto para conectar a Legacy.' };
      },
      async openDiscord() { state.discords++; },
      minimize() {}, close() {},
    };
  }, { validPath, version });
}

async function waitText(page, id, content) {
  await page.waitForFunction(({ id, content }) => document.getElementById(id)?.textContent.includes(content), { id, content });
}

async function run() {
  const { server, url } = await serveProject();
  let browser;
  const errors = [];
  try {
    browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1180, height: 790 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await mockDesktop(page);
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById('players')?.textContent === '— / —' && !document.getElementById('refresh-status')?.disabled);
    await waitText(page, 'server-state', 'Sin configurar');
    assert.equal(await page.locator('#view-home').isVisible(), true);
    assert.equal(await page.locator('#notification').isVisible(), false);
    assert.equal(await page.locator('#players').textContent(), '— / —');
    assert.equal(await page.locator('#play').isEnabled(), true);
    console.log('PASS initial state: no invented server statistics');
    await waitText(page, 'update-title', 'Nueva versión 0.1.5');
    await page.locator('#update-action').click();
    await waitText(page, 'update-detail', '62%');
    assert.equal(await page.locator('#update-progress').isVisible(), true);
    await page.evaluate(() => window.__mockDesktop.finishUpdate());
    await waitText(page, 'update-title', 'Actualización lista');
    await page.locator('#update-action').click();
    await waitText(page, 'update-title', 'Instalando');
    assert.equal(await page.evaluate(() => window.__mockDesktop.updateInstalls), 1);
    console.log('PASS updater progress and explicit install action');

    await fs.mkdir(path.join(project, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(project, 'artifacts/legacy-home.png'), fullPage: true, animations: 'disabled' });
    await page.locator('.nav-item[data-view="settings"]').click();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(project, 'artifacts/legacy-settings.png'), fullPage: true, animations: 'disabled' });
    await page.locator('.nav-item[data-view="community"]').click();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(project, 'artifacts/legacy-community.png'), fullPage: true, animations: 'disabled' });
    await page.locator('.nav-item[data-view="home"]').click();

    for (const width of [1180, 1000]) {
      await page.setViewportSize({ width, height: 790 });
      const measure = await page.evaluate(() => ({ width: innerWidth, doc: document.documentElement.scrollWidth, play: document.getElementById('play').getBoundingClientRect().toJSON() }));
      assert.ok(measure.doc <= measure.width, `Horizontal overflow at ${width}px: ${measure.doc}`);
      assert.ok(measure.play.right <= width && measure.play.left >= 0, `Play button outside viewport at ${width}px`);
    }
    console.log('PASS home layout: 1000px and 1180px widths');
    await page.setViewportSize({ width: 1180, height: 790 });

    await page.locator('#play').click();
    assert.equal(await page.locator('#view-settings').isVisible(), true);
    await waitText(page, 'notification', 'Introduce la IP');
    assert.equal(await page.locator('#server-host').evaluate(el => el === document.activeElement), true);
    console.log('PASS unconfigured Play action opens relevant settings');

    await page.locator('#server-host').fill('127.0.0.1');
    await page.locator('#server-port').fill('7788');
    await page.locator('#discord-url').fill('https://discord.gg/legacy-test');
    await page.locator('#save-settings').click();
    await waitText(page, 'notification', 'Ajustes guardados');
    await page.locator('.nav-item[data-view="home"]').click();
    await waitText(page, 'server-state', 'Servidor en línea');
    assert.equal(await page.locator('#server-address').textContent(), '127.0.0.1:7788');
    assert.equal(await page.locator('#players').textContent(), '3 / 100');
    console.log('PASS settings save updates server status from API result');

    await page.locator('.nav-item[data-view="settings"]').click();
    await page.locator('#server-host').fill('https://invalid.test/path');
    await page.locator('#save-settings').click();
    await waitText(page, 'notification', 'sin protocolo');
    assert.equal(await page.evaluate(() => window.__mockDesktop.settings.serverHost), '127.0.0.1');
    await page.locator('#server-host').fill('127.0.0.1');
    console.log('PASS invalid settings surface an error and retain saved values');

    await page.evaluate(() => { window.__mockDesktop.nextFolder = { path: 'C:\\Wrong', valid: false, message: 'Falta samp.exe.' }; });
    await page.locator('#choose-folder').click();
    await waitText(page, 'notification', 'Falta samp.exe');
    assert.equal(await page.evaluate(() => window.__mockDesktop.settings.gamePath), '');
    await page.evaluate(validPath => { window.__mockDesktop.nextFolder = { path: validPath, valid: true, message: 'Juego encontrado.' }; }, validPath);
    await page.locator('#choose-folder').click();
    await waitText(page, 'notification', 'Carpeta del juego guardada');
    assert.equal(await page.evaluate(() => window.__mockDesktop.settings.gamePath), validPath);
    console.log('PASS folder picker rejects incomplete installations and persists a valid one');

    await page.locator('.nav-item[data-view="home"]').click();
    await page.locator('#nickname').fill('Legacy_Player');
    await page.locator('#nickname').press('Tab');
    await page.waitForFunction(() => window.__mockDesktop.settings.nickname === 'Legacy_Player');
    await page.locator('#play').click();
    await waitText(page, 'play-text', 'DESCARGANDO CEF · 42%');
    assert.equal(await page.locator('#play').isDisabled(), true);
    await page.evaluate(() => { window.__mockDesktop.finishDownload(); });
    await waitText(page, 'notification', 'SA-MP abierto');
    assert.equal(await page.evaluate(() => window.__mockDesktop.plays), 1);
    assert.equal(await page.locator('#play').isEnabled(), true);
    console.log('PASS saved nickname, CEF download progress and Play action');

    await page.locator('.nav-item[data-view="community"]').click();
    assert.equal(await page.locator('#view-community').isVisible(), true);
    assert.equal(await page.locator('#open-discord').isEnabled(), true);
    await page.locator('#open-discord').click();
    assert.equal(await page.evaluate(() => window.__mockDesktop.discords), 1);
    console.log('PASS configured Discord action');

    for (const width of [1180, 1000]) {
      await page.setViewportSize({ width, height: 790 });
      for (const view of ['settings', 'community']) {
        await page.locator(`.nav-item[data-view="${view}"]`).click();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false, `${view} horizontal overflow at ${width}px`);
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS no renderer console errors or settings overflow');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
