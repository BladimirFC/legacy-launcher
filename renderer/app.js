'use strict';

const $ = (id) => document.getElementById(id);
const api = window.legacy;
let settings = { nickname: '', gamePath: '', serverHost: '', serverPort: 7777, discordUrl: '' };
let gameValid = false;
let busy = false;
let querying = false;
let queryAgain = false;
let messageTimer;
let saveQueue = Promise.resolve();

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
  const result = await api.inspectGame(settings.gamePath);
  gameValid = result.valid;
  $('game-state').textContent = result.valid ? 'GTA San Andreas y SA-MP listos' : settings.gamePath ? 'Revisa la carpeta del juego' : 'Selecciona tu GTA San Andreas';
  $('game-detail').textContent = settings.gamePath || 'Necesitas GTA: SA y el cliente SA-MP.';
  $('game-detail').title = settings.gamePath;
  $('folder-result').textContent = result.message;
  $('folder-result').className = `field-help${settings.gamePath ? result.valid ? ' valid' : ' invalid' : ''}`;
  updatePlayHint();
}

function updatePlayHint() {
  $('play-hint').textContent = !settings.serverHost ? 'Añade la IP del servidor en Ajustes' : !gameValid ? 'Selecciona tu carpeta de GTA San Andreas' : !settings.nickname ? 'Elige tu nombre para comenzar' : 'Todo listo. La ciudad te espera.';
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

$('play').addEventListener('click', async () => {
  if (busy || !api) return;
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
  $('play').disabled = true;
  $('play-text').textContent = 'ABRIENDO SA-MP…';
  try {
    await savePreferences({ nickname: $('nickname').value.trim() });
    const result = await api.play();
    notify(result.message, result.ok);
    updatePlayHint();
  } catch (error) { notify(error.message); }
  finally { busy = false; $('play').disabled = false; $('play-text').textContent = 'JUGAR A LEGACY'; }
});

$('open-discord').addEventListener('click', async () => {
  try { await api?.openDiscord(); } catch (error) { notify(error.message); }
});

async function start() {
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
    fillForm();
    await inspectGame();
    await refreshStatus();
    if (data.warning) notify(data.warning);
    setInterval(() => { if (!document.hidden) void refreshStatus(); }, 30000);
  } catch (error) { notify(`No se pudo iniciar el launcher: ${error.message}`); }
}
void start();
