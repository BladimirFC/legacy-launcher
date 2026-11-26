'use strict';

const $ = (id) => document.getElementById(id);
const api = window.legacy;
let settings = { nickname: '', gamePath: '', serverHost: '', serverPort: 7777, discordUrl: '' };
let gameValid = false;
let cefReady = null;
let inspectingGame = false;
let inspectionId = 0;
let busy = false;
let querying = false;
let queryAgain = false;
let messageTimer;
let saveQueue = Promise.resolve();
let updatePhase = 'idle';
let updateAction = null;
let updateBusy = false;
let playing = false;

function savePreferences(patch) {
  const task = saveQueue.then(async () => {
    settings = await api.saveSettings({ ...settings, ...patch });
    return settings;
  });
  saveQueue = task.catch(() => {});
  return task;
}

function notify(message, success = false) {
  clearTimeout(messageTimer);
  $('notification').textContent = message;
  $('notification').classList.toggle('success', success);
  $('notification').hidden = false;
  messageTimer = setTimeout(() => { $('notification').hidden = true; }, 10000);
}

function showView(name) {
  if (!['home', 'settings', 'community'].includes(name)) return;
  document.querySelectorAll('.view').forEach((view) => { view.hidden = view.id !== `view-${name}`; });
  document.querySelectorAll('.nav-item').forEach((button) => {
    const selected = button.dataset.view === name;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('page-label').textContent = { home: 'INICIO', settings: 'AJUSTES', community: 'COMUNIDAD' }[name];
  window.scrollTo(0, 0);
}

function fillForm() {
  $('nickname').value = settings.nickname;
  $('game-path').value = settings.gamePath;
  $('server-host').value = settings.serverHost;
  $('server-port').value = settings.serverPort;
  $('discord-url').value = settings.discordUrl;
  $('open-discord').disabled = !settings.discordUrl;
  $('discord-help').textContent = settings.discordUrl ? 'La comunidad de Legacy, a un clic.' : 'Añade la invitación de Legacy en Ajustes.';
}

async function inspectGame() {
  const id = ++inspectionId;
  inspectingGame = true;
  cefReady = null;
  syncPlayGate();
  let result;
  try { result = await api.inspectGame(settings.gamePath); }
  finally { if (id === inspectionId) { inspectingGame = false; syncPlayGate(); } }
  if (id !== inspectionId) return;
  gameValid = result.valid;
  cefReady = typeof result.cefReady === 'boolean' ? result.cefReady : null;
  $('game-state').textContent = result.valid ? (cefReady === false ? 'CEF requiere preparación' : 'GTA San Andreas y SA-MP listos') : settings.gamePath ? 'Revisa la carpeta del juego' : 'Selecciona tu GTA San Andreas';
  $('game-detail').textContent = settings.gamePath || 'Necesitas GTA: SA y el cliente SA-MP.';
  $('game-detail').title = settings.gamePath;
  $('folder-result').textContent = result.message;
  $('folder-result').className = `field-help${settings.gamePath ? result.valid ? ' valid' : ' invalid' : ''}`;
  updatePlayHint();
}

function updatePlayHint() {
  if (updatePhase !== 'current') {
    $('play-hint').textContent = ['idle', 'checking'].includes(updatePhase) ? 'Comprobando versión del launcher…' : 'Actualiza el launcher antes de jugar.';
    return;
  }
  if (inspectingGame) { $('play-hint').textContent = 'Comprobando archivos del aporte…'; return; }
  $('play-hint').textContent = !settings.serverHost ? 'Añade la IP del servidor en Ajustes' : !gameValid ? 'Selecciona tu carpeta de GTA San Andreas' : !settings.nickname ? 'Elige tu nombre para comenzar' : cefReady === false ? 'Se preparará CEF antes de entrar.' : 'Todo listo. La ciudad te espera.';
}

async function refreshStatus() {
  if (!api) return;
  if (querying) { queryAgain = true; return; }
  const destination = `${settings.serverHost}:${settings.serverPort}`;
  querying = true;
  $('refresh-status').disabled = true;
  $('server-state').textContent = settings.serverHost ? 'Consultando servidor…' : 'Sin configurar';
  $('server-address').textContent = settings.serverHost ? `${settings.serverHost}:${settings.serverPort}` : 'Añade la dirección de Legacy en Ajustes';
  $('players').textContent = '— / —';
  $('ping').textContent = '— ms';
  try {
    const status = await api.serverStatus();
    if (destination !== `${settings.serverHost}:${settings.serverPort}`) return;
    $('status-dot').className = `status-dot ${status.state}`;
    $('server-state').textContent = status.state === 'online' ? 'Servidor en línea' : status.state === 'offline' ? 'Servidor sin respuesta' : 'Sin configurar';
    $('server-state').title = status.message || status.name || '';
    if (status.state === 'online') {
      $('players').textContent = `${status.players} / ${status.maxPlayers}`;
      $('ping').textContent = `${status.ping} ms`;
    }
  } catch (error) {
    if (destination !== `${settings.serverHost}:${settings.serverPort}`) return;
    $('status-dot').className = 'status-dot offline';
    $('server-state').textContent = 'No se pudo consultar';
    $('server-state').title = error.message;
  } finally {
    querying = false;
    $('refresh-status').disabled = false;
    if (queryAgain) { queryAgain = false; void refreshStatus(); }
  }
}

async function chooseFolder() {
  if (busy || !api) return;
  busy = true;
  $('home-choose-folder').disabled = true;
  $('choose-folder').disabled = true;
  try {
    const result = await api.chooseGameFolder();
    if (!result) return;
    $('game-path').value = result.path;
    if (!result.valid) {
      $('folder-result').textContent = result.message;
      $('folder-result').className = 'field-help invalid';
      showView('settings');
      notify(result.message);
      return;
    }
    await savePreferences({ nickname: $('nickname').value.trim(), gamePath: result.path });
    await inspectGame();
    notify('Carpeta del juego guardada. GTA San Andreas y SA-MP detectados.', true);
  } catch (error) { notify(error.message); }
  finally {
    busy = false;
    $('home-choose-folder').disabled = false;
    $('choose-folder').disabled = false;
  }
}

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$('minimize').addEventListener('click', () => api?.minimize());
$('close').addEventListener('click', () => api?.close());
$('refresh-status').addEventListener('click', refreshStatus);
$('choose-folder').addEventListener('click', chooseFolder);
$('home-choose-folder').addEventListener('click', chooseFolder);

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !api) return;
  busy = true;
  $('save-settings').disabled = true;
  try {
    await savePreferences({
      nickname: $('nickname').value.trim(), gamePath: $('game-path').value,
      serverHost: $('server-host').value.trim(), serverPort: Number($('server-port').value),
      discordUrl: $('discord-url').value.trim(),
    });
    fillForm();
    await inspectGame();
    notify('Ajustes guardados.', true);
    void refreshStatus();
  } catch (error) { notify(error.message); }
  finally { busy = false; $('save-settings').disabled = false; }
});

$('nickname').addEventListener('change', async () => {
  if (busy || !api) return;
  try {
    await savePreferences({ nickname: $('nickname').value.trim() });
    $('nickname').value = settings.nickname;
    updatePlayHint();
  } catch (error) { notify(error.message); }
});

api?.onPlayProgress(({ phase, percent }) => {
  const labels = {
    check: 'COMPROBANDO CEF…',
    download: `DESCARGANDO CEF · ${percent}%`,
    extract: 'EXTRAYENDO CEF…',
    install: 'INSTALANDO CEF…',
    launch: 'ABRIENDO SA-MP…',
  };
  if (!busy || !Object.hasOwn(labels, phase)) return;
  $('play-text').textContent = labels[phase];
  $('play-hint').textContent = labels[phase];
  const progress = $('game-progress');
  progress.hidden = phase === 'launch';
  if (phase === 'download' && Number.isFinite(percent)) progress.value = Math.max(0, Math.min(100, percent));
  else progress.removeAttribute('value');
});

$('play').addEventListener('click', async () => {
  if (busy || inspectingGame || !api || updatePhase !== 'current') return;
  if (!settings.serverHost || !gameValid) {
    showView('settings');
    notify(!settings.serverHost ? 'Introduce la IP y el puerto de Legacy para conectar.' : 'Selecciona la carpeta que contiene GTA San Andreas y SA-MP.');
    (!settings.serverHost ? $('server-host') : $('choose-folder')).focus();
    return;
  }
  if (!$('nickname').value.trim()) {
    notify('Escribe tu nombre de jugador antes de entrar.');
    $('nickname').focus();
    return;
  }
  busy = true;
  playing = true;
  $('play').disabled = true;
  $('play-text').textContent = 'COMPROBANDO VERSIÓN…';
  $('game-progress').hidden = false;
  $('game-progress').removeAttribute('value');
  try {
    await savePreferences({ nickname: $('nickname').value.trim() });
    const result = await api.play();
    notify(result.message, result.ok);
    if (result.ok) { cefReady = true; $('game-state').textContent = 'GTA San Andreas y SA-MP listos'; }
    updatePlayHint();
  } catch (error) { notify(error.message); }
  finally { busy = false; playing = false; $('game-progress').hidden = true; syncPlayGate(); }
});

$('open-discord').addEventListener('click', async () => {
  try { await api?.openDiscord(); } catch (error) { notify(error.message); }
});

function syncPlayGate() {
  $('play').disabled = playing || inspectingGame || updatePhase !== 'current';
  if (!playing) {
    $('play-text').textContent = updatePhase === 'current' ? (inspectingGame ? 'COMPROBANDO APORTE…' : 'JUGAR A LEGACY')
      : ['idle', 'checking'].includes(updatePhase) ? 'COMPROBANDO VERSIÓN…'
      : 'ACTUALIZACIÓN REQUERIDA';
  }
  updatePlayHint();
}

function renderUpdate(state) {
  if (!state || typeof state.phase !== 'string') return;
  updatePhase = state.phase;
  syncPlayGate();
  if (['idle', 'checking', 'current'].includes(updatePhase)) {
    $('update-panel').hidden = true;
    $('update-action').hidden = true;
    updateAction = null;
    return;
  }
  const version = typeof state.version === 'string' ? state.version.slice(0, 64) : '';
  const percent = Number.isFinite(state.percent) ? Math.max(0, Math.min(100, state.percent)) : 0;
  const labels = {
    available: ['Nueva versión ' + version, 'Preparando la descarga de la actualización obligatoria.', 'Descargar actualización', 'downloadUpdate'],
    downloading: ['Descargando versión ' + version, percent + '% completado. Debes actualizar antes de jugar.'],
    ready: ['Actualización lista · ' + version, 'Aplica los cambios sin asistente de instalación. El launcher se abrirá de nuevo.', 'Actualizar y reiniciar', 'installUpdate'],
    installing: ['Instalando actualización…', 'El launcher se reiniciará automáticamente.'],
    error: ['No se pudo actualizar', 'No se pudo verificar la versión. Reintenta para poder jugar.', 'Reintentar', 'checkUpdate'],
    'portable-update': ['Nueva versión ' + version, 'Actualiza mediante el instalador oficial para poder jugar.', 'Descargar instalador', 'openReleases'],
    portable: ['Instalación no compatible', 'Utiliza el instalador oficial para verificar la versión y jugar.', 'Ver descargas', 'openReleases'],
  };
  const label = labels[updatePhase];
  if (!label) return;
  $('update-panel').hidden = false;
  $('update-title').textContent = label[0];
  $('update-detail').textContent = label[1];
  $('update-progress').hidden = updatePhase !== 'downloading';
  $('update-progress').value = percent;
  updateAction = label[3] || null;
  $('update-action').hidden = !updateAction;
  $('update-action').textContent = label[2] || '';
  $('update-action').disabled = updateBusy;
}

$('update-action').addEventListener('click', async () => {
  if (!api || !updateAction || updateBusy) return;
  if (busy) { notify('Termina la operación actual antes de actualizar el launcher.'); return; }
  updateBusy = true;
  $('update-action').disabled = true;
  try {
    if (updateAction === 'installUpdate') await saveQueue;
    await api[updateAction]();
  }
  catch (error) { notify(error.message); }
  finally { updateBusy = false; $('update-action').disabled = false; }
});

api?.onUpdateState?.(renderUpdate);

async function start() {
  syncPlayGate();
  if (!api) {
    notify('Abre esta interfaz desde Legacy Launcher para configurar el juego y conectar al servidor.');
    $('play').disabled = true;
    $('footer-mode').textContent = 'VISTA PREVIA DE LA INTERFAZ';
    return;
  }
  try {
    const data = await api.bootstrap();
    settings = data.settings;
    $('version').textContent = `v${data.version}`;
    if (api.updateState) {
      try { renderUpdate(await api.updateState()); }
      catch (error) { renderUpdate({ phase: 'error' }); notify(error.message); }
    }
    fillForm();
    await inspectGame();
    await refreshStatus();
    if (data.warning) notify(data.warning);
    setInterval(() => { if (!document.hidden) void refreshStatus(); }, 30000);
  } catch (error) { notify(`No se pudo iniciar el launcher: ${error.message}`); }
}
void start();
