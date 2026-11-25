'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const dns = require('node:dns/promises');
const dgram = require('node:dgram');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validateSettings, validateNickname, validateHost } = require('./settings.cjs');
const { ensureCef } = require('./cef.cjs');
const execFileAsync = promisify(execFile);

async function inspectGame(gamePath) {
  if (typeof gamePath !== 'string' || !gamePath.trim()) return { valid: false, message: 'Selecciona la carpeta donde tienes GTA San Andreas y SA-MP.' };
  if (!path.isAbsolute(gamePath) || /[\0\r\n]/.test(gamePath)) return { valid: false, message: 'Selecciona una carpeta válida del equipo.' };
  const missing = [];
  for (const filename of ['gta_sa.exe', 'samp.exe']) {
    try {
      const stat = await fs.stat(path.join(gamePath, filename));
      if (!stat.isFile()) missing.push(filename);
    } catch { missing.push(filename); }
  }
  return missing.length
    ? { valid: false, message: `No se encontró ${missing.join(' y ')} en esta carpeta.` }
    : { valid: true, message: 'GTA San Andreas y SA-MP encontrados.' };
}

function buildQueryPacket(ip, port) {
  if (!require('node:net').isIPv4(ip) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Destino SA-MP inválido.');
  const packet = Buffer.alloc(11);
  packet.write('SAMP', 0, 'ascii');
  ip.split('.').forEach((part, index) => { packet[index + 4] = Number(part); });
  packet.writeUInt16LE(port, 8);
  packet[10] = 0x69;
  return packet;
}

function parseInfoResponse(buffer, expectedHeader) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20 || !buffer.subarray(0, 11).equals(expectedHeader)) throw new Error('Respuesta SA-MP no válida.');
  const players = buffer.readUInt16LE(12);
  const maxPlayers = buffer.readUInt16LE(14);
  if (players > maxPlayers) throw new Error('Recuento de jugadores no válido.');
  let offset = 16;
  const fields = [];
  for (let index = 0; index < 3; index++) {
    if (offset + 4 > buffer.length) throw new Error('Respuesta SA-MP incompleta.');
    const length = buffer.readUInt32LE(offset);
    offset += 4;
    if (length > 4096 || offset + length > buffer.length) throw new Error('Texto SA-MP incompleto.');
    // The legacy SA-MP query protocol has no charset marker; Windows-1252 is
    // the common encoding for Spanish servers, unlike open.mp's newer UTF-8.
    fields.push(new TextDecoder('windows-1252').decode(buffer.subarray(offset, offset + length)).replace(/[\x00-\x1f\x7f]/g, ' ').trim());
    offset += length;
  }
  return { name: fields[0], players, maxPlayers, gamemode: fields[1], language: fields[2], passworded: buffer[11] !== 0 };
}

async function queryServer(host, port, { timeout = 3000, lookup = dns.lookup } = {}) {
  validateHost(host, true);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('El puerto no es válido.');
  const start = Date.now();
  let dnsTimer;
  let resolved;
  try {
    resolved = await Promise.race([
      lookup(host, { family: 4 }),
      new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('El dominio tardó demasiado en responder.')), timeout); }),
    ]);
  } finally { clearTimeout(dnsTimer); }
  const remaining = timeout - (Date.now() - start);
  if (remaining <= 0) throw new Error('El servidor tardó demasiado en responder.');
  const packet = buildQueryPacket(resolved.address, port);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('El servidor no respondió a la consulta SA-MP.')), remaining);
    socket.on('error', () => finish(new Error('No se pudo consultar el servidor SA-MP.')));
    socket.on('message', (response) => {
      try {
        const info = parseInfoResponse(response, packet);
        finish(null, { ...info, ping: Math.max(1, Date.now() - start) });
      } catch { /* Ignore unrelated/malformed datagrams and keep the deadline. */ }
    });
    socket.connect(port, resolved.address, () => {
      socket.send(packet, (error) => { if (error) finish(new Error('No se pudo enviar la consulta SA-MP.')); });
    });
  });
}

function buildLaunchSpec(input) {
  const settings = validateSettings(input);
  validateNickname(settings.nickname, true);
  validateHost(settings.serverHost, true);
  if (!settings.gamePath || !path.isAbsolute(settings.gamePath)) throw new Error('Selecciona primero la carpeta de GTA San Andreas.');
  return {
    file: path.join(settings.gamePath, 'samp.exe'),
    args: [`${settings.serverHost}:${settings.serverPort}`],
    options: { cwd: settings.gamePath, shell: false, detached: true, stdio: 'ignore', windowsHide: false },
    registry: {
      file: 'reg.exe',
      args: ['ADD', 'HKCU\\Software\\SAMP', '/v', 'PlayerName', '/t', 'REG_SZ', '/d', settings.nickname, '/f'],
    },
  };
}

async function launchGame(input, {
  platform = process.platform,
  execute = execFileAsync,
  start = spawn,
  prepare = ensureCef,
  onProgress = () => {},
} = {}) {
  const spec = buildLaunchSpec(input);
  if (platform !== 'win32') throw new Error('Para jugar necesitas abrir Legacy Launcher en un PC con Windows.');
  const installed = await inspectGame(input.gamePath);
  if (!installed.valid) throw new Error(installed.message);
  await prepare(spec.options.cwd, { onProgress });
  onProgress({ phase: 'launch' });
  try {
    await execute(spec.registry.file, spec.registry.args, { windowsHide: true, timeout: 5000, shell: false });
  } catch {
    throw new Error('No se pudo guardar el nombre del jugador en SA-MP. Revisa los permisos de tu usuario de Windows.');
  }
  await new Promise((resolve, reject) => {
    let child;
    try { child = start(spec.file, spec.args, spec.options); }
    catch { reject(new Error('No se pudo abrir SA-MP. Comprueba la instalación del juego.')); return; }
    child.once('error', () => reject(new Error('No se pudo abrir SA-MP. Comprueba la instalación del juego.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { ok: true, message: 'SA-MP se está abriendo para conectar a Legacy.' };
}

module.exports = { inspectGame, buildQueryPacket, parseInfoResponse, queryServer, buildLaunchSpec, launchGame };
