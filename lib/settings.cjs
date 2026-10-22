'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const net = require('node:net');

const DEFAULT_SETTINGS = Object.freeze({
  nickname: '',
  gamePath: '',
  serverHost: '',
  serverPort: 7777,
  discordUrl: '',
});

function validateNickname(value, required = false) {
  if (typeof value !== 'string') throw new Error('El nombre del jugador no es válido.');
  const nickname = value.trim();
  if (!nickname && !required) return '';
  if (!/^[A-Za-z0-9_\[\]()$=@.]{3,24}$/.test(nickname)) {
    throw new Error('El nombre debe tener de 3 a 24 caracteres: letras, números o _ [ ] ( ) $ = @ .');
  }
  return nickname;
}

function validateHost(value, required = false) {
  if (typeof value !== 'string') throw new Error('La dirección del servidor no es válida.');
  const host = value.trim().toLowerCase();
  if (!host && !required) return '';
  if (net.isIPv4(host)) return host;
  if (/^[0-9.]+$/.test(host)) throw new Error('La dirección IPv4 del servidor no es válida.');
  if (host.length > 253 || !host || !host.split('.').every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('Introduce una IP IPv4 o un dominio, sin protocolo ni puerto.');
  }
  return host;
}

function validateDiscord(value) {
  if (typeof value !== 'string') throw new Error('El enlace de Discord no es válido.');
  const raw = value.trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { throw new Error('Introduce un enlace de invitación HTTPS de Discord.'); }
  const validHost = url.hostname === 'discord.gg' || url.hostname === 'discord.com';
  const validPath = url.hostname === 'discord.gg'
    ? /^\/[A-Za-z0-9-]+\/?$/.test(url.pathname)
    : /^\/invite\/[A-Za-z0-9-]+\/?$/.test(url.pathname);
  if (url.protocol !== 'https:' || !validHost || !validPath || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Usa un enlace como https://discord.gg/tu-invitacion.');
  }
  return url.href;
}

function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('La configuración no es válida.');
  const { nickname, gamePath, serverHost, serverPort, discordUrl } = { ...DEFAULT_SETTINGS, ...input };
  if (typeof gamePath !== 'string' || gamePath.length > 4096 || /[\0\r\n]/.test(gamePath)) {
    throw new Error('La ruta del juego no es válida.');
  }
  const port = typeof serverPort === 'number' ? serverPort : (/^\d{1,5}$/.test(String(serverPort)) ? Number(serverPort) : NaN);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('El puerto debe estar entre 1 y 65535.');
  return {
    nickname: validateNickname(nickname),
    gamePath: gamePath.trim(),
    serverHost: validateHost(serverHost),
    serverPort: port,
    discordUrl: validateDiscord(discordUrl),
  };
}

class SettingsStore {
  constructor(directory, defaults = {}) {
    this.directory = directory;
    this.filename = path.join(directory, 'settings.json');
    this.settings = validateSettings({ ...DEFAULT_SETTINGS, ...defaults });
    this.warning = '';
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      const stat = await fs.stat(this.filename);
      if (stat.size > 16384) throw new Error('Configuración demasiado grande.');
      const saved = JSON.parse(await fs.readFile(this.filename, 'utf8'));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Configuración inválida.');
      this.settings = validateSettings({ ...this.settings, ...saved });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.warning = 'No se pudo leer la configuración guardada. Revisa tus datos y vuelve a guardarlos.';
      }
    }
    return { ...this.settings };
  }

  get() { return { ...this.settings }; }

  async save(input) {
    const next = validateSettings(input);
    const task = this.writing.then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const temp = path.join(this.directory, `settings-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temp, this.filename);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw new Error('No se pudo guardar la configuración en este equipo. Comprueba los permisos de tu usuario.');
      }
      this.settings = next;
      this.warning = '';
      return this.get();
    });
    this.writing = task.catch(() => {});
    return task;
  }
}

module.exports = { DEFAULT_SETTINGS, validateNickname, validateHost, validateDiscord, validateSettings, SettingsStore };
