'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ensureCef } = require('../lib/cef.cjs');
const { launchGame } = require('../lib/samp.cjs');

const archiveBytes = Buffer.from('archive fixture');
const loaderBytes = Buffer.from('loader fixture');
const client = {
  name: 'client.zip', size: archiveBytes.length, sha256: createHash('sha256').update(archiveBytes).digest('hex'),
};
const loader = {
  name: 'cef.asi', size: loaderBytes.length, sha256: createHash('sha256').update(loaderBytes).digest('hex'),
};
const assets = { client, loader };

async function gameFolder(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy aporte '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function makeRuntime(directory) {
  const runtime = path.join(directory, 'cef');
  await fs.mkdir(path.join(runtime, 'locales'), { recursive: true });
  const names = [
    'client.dll', 'renderer.exe', 'libcef.dll', 'chrome_elf.dll',
    'd3dcompiler_47.dll', 'libEGL.dll', 'libGLESv2.dll', 'icudtl.dat',
    'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
    'v8_context_snapshot.bin', 'locales/en-US.pak',
  ];
  await Promise.all(names.map((name) => fs.writeFile(path.join(runtime, name), name)));
}

async function extractFixture(archive, directory) {
  assert.deepEqual(await fs.readFile(archive), archiveBytes);
  await makeRuntime(directory);
  await fs.writeFile(path.join(directory, 'cef.asi'), loaderBytes);
}

test('missing CEF is installed before reuse, with progress and unrelated mods preserved', async (t) => {
  const directory = await gameFolder(t);
  await fs.writeFile(path.join(directory, 'other.asi'), 'existing');
  const events = [];
  const result = await ensureCef(directory, {
    assets, extract: extractFixture,
    fetchAsset: async (url) => {
      assert.equal(new URL(url).hostname, 'github.com');
      assert.ok(url.endsWith('/v1.3.0/client.zip'));
      return new Response(archiveBytes);
    },
    onProgress: (event) => events.push(event),
  });
  assert.equal(result.installed, true);
  assert.equal(result.backupPath, null);
  assert.deepEqual(events.map((event) => event.phase), ['check', 'download', 'download', 'extract', 'install']);
  assert.equal(events[2].percent, 100);
  assert.deepEqual(await fs.readFile(path.join(directory, 'cef.asi')), loaderBytes);
  assert.equal(await fs.readFile(path.join(directory, 'other.asi'), 'utf8'), 'existing');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['cef', 'cef.asi', 'other.asi']);
  assert.deepEqual(await ensureCef(directory, { fetchAsset: () => assert.fail('No download needed') }), { installed: false });
});

test('a complete runtime only downloads the missing ASI file', async (t) => {
  const directory = await gameFolder(t);
  await makeRuntime(directory);
  await fs.writeFile(path.join(directory, 'cef', 'local-settings.json'), '{}');
  await ensureCef(directory, {
    assets, extract: () => assert.fail('No extraction needed'),
    fetchAsset: async (url) => {
      assert.ok(url.endsWith('/cef.asi'));
      return new Response(loaderBytes);
    },
  });
  assert.deepEqual(await fs.readFile(path.join(directory, 'cef.asi')), loaderBytes);
  assert.equal(await fs.readFile(path.join(directory, 'cef', 'local-settings.json'), 'utf8'), '{}');
});

test('repair backs up incomplete CEF, including the previous loader', async (t) => {
  const directory = await gameFolder(t);
  await fs.mkdir(path.join(directory, 'cef'));
  await fs.writeFile(path.join(directory, 'cef', 'client.dll'), 'old client');
  await fs.writeFile(path.join(directory, 'cef.asi'), 'old loader');
  const { backupPath } = await ensureCef(directory, {
    assets, extract: extractFixture, fetchAsset: async () => new Response(archiveBytes),
  });
  assert.equal(await fs.readFile(path.join(backupPath, 'cef.asi'), 'utf8'), 'old loader');
  assert.equal(await fs.readFile(path.join(backupPath, 'cef', 'client.dll'), 'utf8'), 'old client');
  assert.deepEqual(await fs.readFile(path.join(directory, 'cef.asi')), loaderBytes);
});

test('bad downloads and missing archive contents leave the previous files intact', async (t) => {
  const directory = await gameFolder(t);
  await fs.writeFile(path.join(directory, 'cef.asi'), 'old loader');
  for (const response of [new Response(archiveBytes.subarray(1)), new Response(Buffer.alloc(archiveBytes.length))]) {
    await assert.rejects(ensureCef(directory, {
      assets, fetchAsset: async () => response, extract: () => assert.fail('Archive must be verified first'),
    }), /no pasó la verificación/);
  }
  await assert.rejects(ensureCef(directory, {
    assets, fetchAsset: async () => new Response(archiveBytes), extract: async () => {},
  }), /no incluye/);
  await assert.rejects(ensureCef(directory, {
    assets, fetchAsset: async () => { throw new Error('offline'); },
  }), /Comprueba tu conexión/);
  assert.deepEqual(await fs.readdir(directory), ['cef.asi']);
  assert.equal(await fs.readFile(path.join(directory, 'cef.asi'), 'utf8'), 'old loader');
});

test('launch stops before touching SA-MP when CEF preparation fails', async (t) => {
  const directory = await gameFolder(t);
  await Promise.all(['gta_sa.exe', 'samp.exe'].map((name) => fs.writeFile(path.join(directory, name), '')));
  await assert.rejects(launchGame({ gamePath: directory, nickname: 'Legacy_Player', serverHost: 'localhost', serverPort: 7777 }, {
    platform: 'win32',
    prepare: async () => { throw new Error('CEF no disponible'); },
    execute: () => assert.fail('Registry must not be touched'),
    start: () => assert.fail('SA-MP must not open'),
  }), /CEF no disponible/);
});
