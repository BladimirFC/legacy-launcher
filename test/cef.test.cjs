'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ensureCef, createCefVerifier } = require('../lib/cef.cjs');
const { launchGame } = require('../lib/samp.cjs');

const archiveBytes = Buffer.from('archive fixture');
const loaderBytes = Buffer.from('loader fixture');
const client = {
  name: 'client.zip', size: archiveBytes.length, sha256: createHash('sha256').update(archiveBytes).digest('hex'),
};
const loader = {
  name: 'cef.asi', size: loaderBytes.length, sha256: createHash('sha256').update(loaderBytes).digest('hex'),
};
const core = Object.fromEntries(['client.dll', 'renderer.exe'].map(name => [
  name, { size: Buffer.byteLength(name), sha256: createHash('sha256').update(name).digest('hex') },
]));
const assets = { client, loader, core };

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
    'd3dcompiler_47.dll', 'icudtl.dat',
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
      assert.ok(url.endsWith('/v1.4.1/client.zip'));
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
  // The official 1.4.1 archive omits these legacy graphics libraries.
  for (const name of ['libEGL.dll', 'libGLESv2.dll']) {
    await assert.rejects(fs.access(path.join(directory, 'cef', name)), { code: 'ENOENT' });
  }
  assert.deepEqual((await fs.readdir(directory)).sort(), ['cef', 'cef.asi', 'other.asi']);
  assert.deepEqual(await ensureCef(directory, { assets, fetchAsset: () => assert.fail('No download needed') }), { installed: false });
});

test('a complete but unverified old runtime receives the entire new package', async (t) => {
  const directory = await gameFolder(t);
  await makeRuntime(directory);
  await fs.writeFile(path.join(directory, 'cef.asi'), 'old loader');
  await fs.writeFile(path.join(directory, 'cef', 'local-settings.json'), '{}');
  const result = await ensureCef(directory, {
    assets, extract: extractFixture,
    fetchAsset: async (url) => {
      assert.ok(url.endsWith('/client.zip'));
      return new Response(archiveBytes);
    },
  });
  assert.equal(result.installed, true);
  assert.deepEqual(await fs.readFile(path.join(directory, 'cef.asi')), loaderBytes);
  assert.equal(await fs.readFile(path.join(result.backupPath, 'cef', 'local-settings.json'), 'utf8'), '{}');
});

test('a damaged or mixed runtime is repaired even with a matching package marker', async (t) => {
  const directory = await gameFolder(t);
  const options = { assets, extract: extractFixture, fetchAsset: async () => new Response(archiveBytes) };
  await ensureCef(directory, options);
  for (const name of ['cef.asi', 'cef/client.dll', 'cef/renderer.exe', 'cef/libcef.dll']) {
    await fs.writeFile(path.join(directory, name), 'incorrect version');
    const result = await ensureCef(directory, options);
    assert.equal(result.installed, true);
    assert.equal(await fs.readFile(path.join(result.backupPath, name), 'utf8'), 'incorrect version');
    assert.deepEqual(await ensureCef(directory, { assets, fetchAsset: () => assert.fail('No download needed') }), { installed: false });
  }
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

test('rejects an archive missing an actual required runtime file', async (t) => {
  const directory = await gameFolder(t);
  await fs.writeFile(path.join(directory, 'cef.asi'), 'old loader');
  await assert.rejects(ensureCef(directory, {
    assets, fetchAsset: async () => new Response(archiveBytes),
    extract: async (archive, unpacked) => {
      await extractFixture(archive, unpacked);
      await fs.unlink(path.join(unpacked, 'cef', 'icudtl.dat'));
    },
  }), /Archivos ausentes: icudtl\.dat/);
  assert.equal(await fs.readFile(path.join(directory, 'cef.asi'), 'utf8'), 'old loader');
});

test('startup CEF check is read-only and missing files trigger no downloads', async t => {
  const directory = await gameFolder(t);
  const verifier = createCefVerifier({ assets, install: () => assert.fail('Startup check must not install') });
  assert.equal(await verifier.check(directory), false);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('successful CEF scans are reused only while all required metadata is unchanged', async t => {
  const directory = await gameFolder(t);
  const options = { assets, extract: extractFixture, fetchAsset: async () => new Response(archiveBytes) };
  await ensureCef(directory, options);
  let scans = 0;
  const verifier = createCefVerifier({ assets, verify: async () => { scans++; return true; } });
  assert.equal(await verifier.check(directory), true);
  assert.deepEqual(await verifier.ensure(directory), { installed: false });
  assert.equal(scans, 1);
  await fs.writeFile(path.join(directory, 'cef', 'libcef.dll'), 'different bytes');
  assert.equal(await verifier.check(directory), true);
  assert.equal(scans, 2);
  await fs.unlink(path.join(directory, 'cef', 'icudtl.dat'));
  assert.equal(await verifier.check(directory), false);
});

test('cached real integrity check detects corruption and repairs only on Play', async t => {
  const directory = await gameFolder(t);
  const options = { assets, extract: extractFixture, fetchAsset: async () => new Response(archiveBytes) };
  const verifier = createCefVerifier({ assets });
  assert.equal(await verifier.check(directory), false);
  assert.equal((await verifier.ensure(directory, options)).installed, true);
  assert.equal(await verifier.check(directory), true);
  await fs.writeFile(path.join(directory, 'cef', 'libcef.dll'), 'corrupt replacement');
  assert.equal(await verifier.check(directory), false);
  assert.equal((await verifier.ensure(directory, options)).installed, true);
  assert.equal(await verifier.check(directory), true);
});
