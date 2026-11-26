'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateManager, RELEASE_URL } = require('../lib/updater.cjs');

function fixture() {
  const updater = new EventEmitter();
  let installs = 0;
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '0.1.5' });
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { percent: 42.8 });
    updater.emit('update-downloaded', { version: '0.1.5' });
  };
  updater.quitAndInstall = (silent, restart) => {
    assert.equal(silent, false);
    assert.equal(restart, true);
    installs++;
  };
  const states = [];
  const manager = createUpdateManager(updater, { onState: state => states.push(state) });
  return { updater, manager, states, installs: () => installs };
}

test('stable update is checked, downloaded, and installed only by explicit action', async () => {
  const { updater, manager, states, installs } = fixture();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.disableWebInstaller, true);
  assert.equal(manager.install(), false);
  assert.equal((await manager.check()).phase, 'available');
  assert.equal(manager.install(), false);
  assert.equal((await manager.download()).phase, 'ready');
  assert.ok(states.some(state => state.phase === 'downloading' && state.percent === 42));
  assert.equal(installs(), 0);
  assert.equal(manager.install(), true);
  assert.equal(manager.install(), false);
  assert.equal(installs(), 1);
});

test('an unavailable update leaves the launcher current', async () => {
  const { updater, manager } = fixture();
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  assert.equal((await manager.check()).phase, 'current');
  assert.equal((await manager.download()).phase, 'current');
  assert.equal(manager.install(), false);
});

test('failed checks and downloads are retryable and never install', async () => {
  const { updater, manager, installs } = fixture();
  const check = updater.checkForUpdates;
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  assert.equal((await manager.check()).phase, 'error');
  updater.checkForUpdates = check;
  assert.equal((await manager.check()).phase, 'available');
  updater.downloadUpdate = async () => { throw new Error('checksum mismatch'); };
  assert.equal((await manager.download()).phase, 'error');
  assert.equal(manager.install(), false);
  assert.equal(installs(), 0);
  assert.equal((await manager.check()).phase, 'available');
});

test('parallel operations and unexpected download events cannot start an install', async () => {
  const { updater, manager } = fixture();
  let finish;
  let checks = 0;
  updater.checkForUpdates = () => { checks++; return new Promise(resolve => { finish = resolve; }); };
  const first = manager.check();
  assert.equal((await manager.check()).phase, 'checking');
  assert.equal(checks, 1);
  updater.emit('update-downloaded', { version: '0.1.5' });
  assert.equal(manager.install(), false);
  updater.emit('update-available', { version: '0.1.5' });
  finish();
  await first;
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '0.1.6' });
  assert.equal((await manager.download()).phase, 'error');
  assert.equal(manager.install(), false);
});

test('unsupported development builds cannot invoke the updater', async () => {
  const manager = createUpdateManager(null, { enabled: false });
  assert.equal((await manager.check()).phase, 'portable');
  assert.equal((await manager.download()).phase, 'portable');
  assert.equal(manager.install(), false);
  assert.equal(RELEASE_URL, 'https://github.com/BladimirFC/legacy-launcher/releases/latest');
});

test('installer start errors return to a retryable state', async () => {
  const { updater, manager } = fixture();
  await manager.check();
  await manager.download();
  updater.quitAndInstall = () => updater.emit('error', new Error('installer could not start'));
  assert.equal(manager.install(), false);
  assert.equal(manager.getState().phase, 'error');
  assert.equal((await manager.check()).phase, 'available');
});

test('game launch is blocked until a successful check explicitly confirms current version', async () => {
  const { updater, manager } = fixture();
  assert.equal(manager.canPlay(), false);
  await assert.rejects(manager.requireCurrent(), /última versión/);
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  await manager.check();
  assert.equal(manager.canPlay(), true);
  await manager.requireCurrent();
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '0.1.6' });
  await assert.rejects(manager.requireCurrent(), /Actualiza/);
  assert.equal(manager.canPlay(), false);
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '0.1.6' });
  assert.equal((await manager.download()).phase, 'ready');
  assert.equal(manager.canPlay(), false);
  assert.equal(manager.install(), true);
  assert.equal(manager.canPlay(), false);
});

test('network and inconclusive checks fail closed, even after a successful check', async () => {
  const { updater, manager } = fixture();
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  await manager.check();
  updater.checkForUpdates = async () => {};
  await assert.rejects(manager.requireCurrent(), /Actualiza/);
  assert.equal(manager.getState().phase, 'error');
  assert.equal(manager.canPlay(), false);
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  await manager.check();
  assert.equal(manager.canPlay(), false);
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  await manager.check();
  assert.equal(manager.canPlay(), true);
});

test('portable Windows builds check versions but cannot install in place', async () => {
  const { updater } = fixture();
  const manager = createUpdateManager(updater, { canInstall: false });
  assert.equal((await manager.check()).phase, 'portable-update');
  assert.equal(manager.canPlay(), false);
  assert.equal((await manager.download()).phase, 'portable-update');
  assert.equal(manager.install(), false);
  const other = new EventEmitter();
  other.checkForUpdates = async () => other.emit('update-not-available');
  const current = createUpdateManager(other, { canInstall: false });
  await current.check();
  assert.equal(current.canPlay(), true);
});

test('in-progress check cannot be bypassed by launching early', async () => {
  const { updater, manager } = fixture();
  let done;
  updater.checkForUpdates = () => new Promise(resolve => { done = resolve; });
  const pending = manager.check();
  updater.emit('update-not-available');
  assert.equal(manager.canPlay(), false);
  await assert.rejects(manager.requireCurrent());
  done();
  await pending;
  assert.equal(manager.canPlay(), true);
});

test('SA-MP launch is rejected if a release appears during CEF preparation', async (t) => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { launchGame } = require('../lib/samp.cjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-update-gate-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await Promise.all(['gta_sa.exe', 'samp.exe'].map(name => fs.writeFile(path.join(directory, name), '')));
  const { updater, manager } = fixture();
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  await manager.check();
  await manager.requireCurrent();
  await assert.rejects(launchGame({ gamePath: directory, nickname: 'Legacy_Player', serverHost: 'localhost', serverPort: 7777 }, {
    platform: 'win32',
    prepare: async () => { updater.checkForUpdates = async () => updater.emit('update-available', { version: '0.1.6' }); },
    beforeLaunch: () => manager.requireCurrent(),
    execute: () => assert.fail('Registry must not be modified'),
    start: () => assert.fail('Game must not launch'),
  }), /Actualiza/);
  assert.equal(manager.canPlay(), false);
});
