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

test('ZIP and development builds cannot invoke the updater', async () => {
  const manager = createUpdateManager(null, { enabled: false });
  assert.equal((await manager.check()).phase, 'portable');
  assert.equal((await manager.download()).phase, 'portable');
  assert.equal(manager.install(), false);
  assert.equal(RELEASE_URL, 'https://github.com/BladimirFC/legacy-launcher/releases/latest');
});
