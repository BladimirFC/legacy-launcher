'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const { DEFAULT_SETTINGS, validateNickname, validateHost, validateDiscord, validateSettings, SettingsStore } = require('../lib/settings.cjs');
const { inspectGame, buildQueryPacket, parseInfoResponse, queryServer, buildLaunchSpec, launchGame } = require('../lib/samp.cjs');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function infoPacket(header, { players = 7, maxPlayers = 100, name = 'Legacy', gamemode = 'Roleplay', language = 'Español' } = {}) {
  const counts = Buffer.alloc(5);
  counts[0] = 0;
  counts.writeUInt16LE(players, 1);
  counts.writeUInt16LE(maxPlayers, 3);
  const fields = [name, gamemode, language].flatMap((text) => {
    const content = Buffer.from(text, 'latin1');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(content.length);
    return [length, content];
  });
  return Buffer.concat([header, counts, ...fields]);
}

test('settings reject invalid nicknames, destinations, ports and arbitrary external links', () => {
  assert.equal(validateNickname('  Nombre_Apellido  '), 'Nombre_Apellido');
  assert.equal(validateNickname('[Legacy]Player'), '[Legacy]Player');
  for (const value of ['ab', 'Bad Player', 'Player;cmd', 'a'.repeat(25), '<script>']) assert.throws(() => validateNickname(value));
  assert.equal(validateHost('  PLAY.LEGACY.TEST '), 'play.legacy.test');
  assert.equal(validateHost('127.0.0.1'), '127.0.0.1');
  for (const value of ['256.0.0.1', '127.0.0.1:7777', 'https://example.com', '-x', 'a..b', '::1', 'a;calc']) assert.throws(() => validateHost(value));
  for (const serverPort of [0, 65536, 1.5, '7777;cmd', null]) assert.throws(() => validateSettings({ serverPort }));
  assert.equal(validateSettings({ serverPort: '7777' }).serverPort, 7777);
  assert.equal(validateDiscord('https://discord.gg/Legacy'), 'https://discord.gg/Legacy');
  assert.equal(validateDiscord('https://discord.com/invite/Legacy'), 'https://discord.com/invite/Legacy');
  for (const value of ['file:///etc/passwd', 'http://discord.gg/Legacy', 'https://discord.gg.evil.test/Legacy', 'https://evil.test', 'https://discord.com/channels/123', 'https://user@discord.gg/Legacy', 'https://discord.gg/Legacy?x=1']) assert.throws(() => validateDiscord(value));
});

test('settings persist atomically, survive relaunch and recover corrupt JSON with a warning', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new SettingsStore(directory, { serverHost: '127.0.0.1' });
  assert.equal((await store.load()).serverHost, '127.0.0.1');
  await store.save({ ...store.get(), nickname: 'Legacy_Player', gamePath: directory });
  const second = new SettingsStore(directory);
  assert.equal((await second.load()).nickname, 'Legacy_Player');
  await Promise.all([
    second.save({ ...second.get(), nickname: 'First_Player' }),
    second.save({ ...second.get(), nickname: 'Second_Player' }),
  ]);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')).nickname, 'Second_Player');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['settings.json']);
  await fs.writeFile(path.join(directory, 'settings.json'), '{broken');
  const recovered = new SettingsStore(directory, { serverHost: 'legacy.test' });
  assert.equal((await recovered.load()).serverHost, 'legacy.test');
  assert.match(recovered.warning, /No se pudo leer/);
  await recovered.save({ ...recovered.get(), nickname: 'Recovered_Player' });
  assert.equal(recovered.warning, '');
});

test('game installation requires both executable files and an absolute folder', async (t) => {
  const directory = await temporaryDirectory(t);
  assert.equal((await inspectGame('relative')).valid, false);
  assert.equal((await inspectGame(directory)).valid, false);
  await fs.writeFile(path.join(directory, 'gta_sa.exe'), '');
  assert.match((await inspectGame(directory)).message, /samp\.exe/);
  await fs.mkdir(path.join(directory, 'samp.exe'));
  assert.equal((await inspectGame(directory)).valid, false);
  await fs.rmdir(path.join(directory, 'samp.exe'));
  await fs.writeFile(path.join(directory, 'samp.exe'), '');
  assert.equal((await inspectGame(directory)).valid, true);
});

test('SA-MP packets encode little-endian port and reject truncated or hostile replies', () => {
  const query = buildQueryPacket('127.0.0.1', 7777);
  assert.equal(query.toString('hex'), '53414d507f000001611e69');
  const info = parseInfoResponse(infoPacket(query), query);
  assert.equal(info.name, 'Legacy');
  assert.equal(info.players, 7);
  assert.equal(info.maxPlayers, 100);
  assert.equal(info.language, 'Español');
  assert.throws(() => parseInfoResponse(Buffer.alloc(6), query));
  assert.throws(() => parseInfoResponse(infoPacket(buildQueryPacket('127.0.0.2', 7777)), query));
  assert.throws(() => parseInfoResponse(infoPacket(query).subarray(0, 22), query));
  assert.throws(() => parseInfoResponse(infoPacket(query, { players: 101 }), query));
  const overflow = infoPacket(query);
  overflow.writeUInt32LE(0xffffffff, 16);
  assert.throws(() => parseInfoResponse(overflow, query));
});

test('real local UDP query retrieves live player counts and ignores malformed packets', async (t) => {
  const server = dgram.createSocket('udp4');
  t.after(() => server.close());
  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let received;
  server.on('message', (packet, remote) => {
    received = packet;
    server.send(Buffer.from('malformed'), remote.port, remote.address);
    server.send(infoPacket(packet, { name: 'Legacy Test', players: 23, maxPlayers: 150 }), remote.port, remote.address);
  });
  const info = await queryServer('127.0.0.1', port);
  assert.equal(info.name, 'Legacy Test');
  assert.equal(info.players, 23);
  assert.equal(info.maxPlayers, 150);
  assert.ok(info.ping > 0);
  assert.deepEqual(received, buildQueryPacket('127.0.0.1', port));
});

test('non-responsive SA-MP and DNS queries have finite deadlines', async (t) => {
  const silent = dgram.createSocket('udp4');
  t.after(() => silent.close());
  await new Promise((resolve) => silent.bind(0, '127.0.0.1', resolve));
  await assert.rejects(queryServer('127.0.0.1', silent.address().port, { timeout: 40 }), /no respondió/);
  await assert.rejects(queryServer('legacy.test', 7777, { timeout: 40, lookup: () => new Promise(() => {}) }), /dominio tardó/);
});

test('Windows launch sets SA-MP nickname and starts installed samp.exe without a shell', async (t) => {
  const directory = await temporaryDirectory(t);
  await Promise.all(['gta_sa.exe', 'samp.exe'].map((name) => fs.writeFile(path.join(directory, name), '')));
  const settings = { ...DEFAULT_SETTINGS, nickname: 'Legacy_Player', serverHost: 'play.legacy.test', serverPort: 7788, gamePath: directory };
  const spec = buildLaunchSpec(settings);
  assert.deepEqual(spec.args, ['play.legacy.test:7788']);
  assert.equal(spec.options.shell, false);
  assert.equal(spec.file, path.join(directory, 'samp.exe'));
  assert.equal(spec.registry.args.at(-2), 'Legacy_Player');
  let prepared = false;
  let registryCalled = false;
  let spawned = false;
  const result = await launchGame(settings, {
    platform: 'win32',
    prepare: async (gamePath) => {
      assert.equal(gamePath, directory);
      await new Promise(setImmediate);
      prepared = true;
    },
    execute: async (file, args, options) => {
      assert.equal(prepared, true);
      assert.equal(file, 'reg.exe');
      assert.deepEqual(args, spec.registry.args);
      assert.equal(options.shell, false);
      registryCalled = true;
    },
    start: (file, args, options) => {
      assert.equal(registryCalled, true);
      assert.equal(file, spec.file);
      assert.deepEqual(args, spec.args);
      assert.equal(options.cwd, directory);
      const child = new EventEmitter();
      child.unref = () => { spawned = true; };
      process.nextTick(() => child.emit('spawn'));
      return child;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(spawned, true);
  await assert.rejects(launchGame(settings, { platform: 'linux' }), /Windows/);
  await assert.rejects(launchGame({ ...settings, serverHost: '' }, { platform: 'win32' }));
  await assert.rejects(launchGame(settings, { platform: 'win32', prepare: async () => {}, execute: async () => { throw new Error('denied'); } }), /permisos/);
});
