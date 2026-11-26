'use strict';

const RELEASE_URL = 'https://github.com/BladimirFC/legacy-launcher/releases/latest';

function createUpdateManager(updater, { enabled = true, canInstall = true, onState = () => {} } = {}) {
  let state = { phase: enabled ? 'idle' : 'portable', version: null, percent: 0 };
  let active = null;
  let checkResult = null;
  const canPlay = () => active === null && state.phase === 'current';
  const getState = () => ({ ...state });
  const publish = (phase, patch = {}) => {
    state = { ...state, phase, ...patch };
    onState(getState());
  };
  const fail = (error) => {
    console.error('Launcher update failed:', error);
    publish('error', { percent: 0 });
  };

  if (enabled) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.disableWebInstaller = true;
    updater.on('checking-for-update', () => {
      if (active === 'check') publish('checking');
    });
    updater.on('update-available', (info) => {
      if (active === 'check') checkResult = { phase: canInstall ? 'available' : 'portable-update', version: info.version };
    });
    updater.on('update-not-available', () => {
      if (active === 'check') checkResult = { phase: 'current', version: null };
    });
    updater.on('download-progress', (progress) => {
      if (active === 'download' && Number.isFinite(progress.percent)) {
        publish('downloading', { percent: Math.min(100, Math.max(0, Math.floor(progress.percent))) });
      }
    });
    updater.on('update-downloaded', (info) => {
      if (active === 'download' && info.version === state.version) publish('ready', { percent: 100 });
    });
    updater.on('error', (error) => {
      if ((active || state.phase === 'installing') && state.phase !== 'error') fail(error);
    });
  }

  async function check() {
    if (!enabled || active || !['idle', 'current', 'error'].includes(state.phase)) return getState();
    active = 'check';
    checkResult = null;
    publish('checking', { version: null, percent: 0 });
    try {
      await updater.checkForUpdates();
      if (state.phase !== 'error' && !checkResult) throw new Error('Update check did not return an explicit result');
    } catch (error) {
      if (state.phase !== 'error') fail(error);
    } finally { active = null; }
    if (state.phase !== 'error' && checkResult) {
      publish(checkResult.phase, { version: checkResult.version, percent: 0 });
    }
    return getState();
  }

  async function download() {
    if (!enabled || !canInstall || active || state.phase !== 'available') return getState();
    active = 'download';
    publish('downloading', { percent: 0 });
    try {
      await updater.downloadUpdate();
      if (state.phase === 'downloading') throw new Error('No verified installer was reported');
    } catch (error) {
      if (state.phase !== 'error') fail(error);
    } finally { active = null; }
    return getState();
  }

  function install() {
    if (!enabled || !canInstall || active || state.phase !== 'ready') return false;
    publish('installing');
    try {
      updater.quitAndInstall(false, true);
      return state.phase === 'installing';
    } catch (error) {
      fail(error);
      return false;
    }
  }

  // Recheck immediately before launching so a newly published release cannot be skipped.
  async function requireCurrent() {
    if (!canPlay()) throw new Error('Debes comprobar e instalar la última versión del launcher antes de jugar.');
    await check();
    if (!canPlay()) throw new Error('Actualiza el launcher o reintenta la comprobación antes de jugar.');
  }

  return { getState, canPlay, requireCurrent, check, download, install };
}

module.exports = { createUpdateManager, RELEASE_URL };
