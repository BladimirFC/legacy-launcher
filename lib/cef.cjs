'use strict';

const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');

const releaseUrl = 'https://github.com/aurora-mp/omp-cef/releases/download/v1.4.1/';
const release = {
  client: {
    name: 'client-files-v1.4.1.zip',
    size: 176360755,
    sha256: 'a30f2a86c6873cc5ed2ca46694c6c1e5a7b76d79f310b6f097a424f042be0452',
  },
  loader: {
    name: 'cef.asi',
    size: 104960,
    sha256: '057f9e267ad1bb492ab23e04c1869075b1edef482a7d2b2823ad6ff8b66359e7',
  },
  core: {
    'client.dll': { size: 2801152, sha256: '1ded701ba19e5b820d99b538f4ffa7e588e1e3d988e5ee280998831696ccd809' },
    'renderer.exe': { size: 621056, sha256: '4f45c0ee044073153ffcd2da1716398770523dcbad2e92d98d5313bf13577789' },
  },
};
const markerName = '.legacy-cef-package.json';
// Required files in the pinned official 1.4.1 archive. Older ANGLE DLLs are absent.
const runtimeFiles = [
  'client.dll', 'renderer.exe', 'libcef.dll', 'chrome_elf.dll',
  'd3dcompiler_47.dll', 'icudtl.dat',
  'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
  'v8_context_snapshot.bin', 'locales/en-US.pak',
];

async function readEntry(filename) {
  try {
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) throw new Error('La instalación de CEF contiene un enlace. Selecciona una carpeta del juego con archivos locales.');
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function hasFile(stat) {
  return Boolean(stat?.isFile() && stat.size > 0);
}

async function inspectCef(directory) {
  const runtime = path.join(directory, 'cef');
  const [loader, runtimeDirectory] = await Promise.all([
    readEntry(path.join(directory, 'cef.asi')),
    readEntry(runtime),
  ]);
  if (!runtimeDirectory?.isDirectory()) return { loader, runtime: runtimeDirectory, complete: false };
  const locales = await readEntry(path.join(runtime, 'locales'));
  if (!locales?.isDirectory()) return { loader, runtime: runtimeDirectory, complete: false };
  const stats = await Promise.all(runtimeFiles.map((name) => readEntry(path.join(runtime, name))));
  return { loader, runtime: runtimeDirectory, complete: stats.every(hasFile) };
}

async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function matchesAsset(filename, asset) {
  const stat = await readEntry(filename);
  return hasFile(stat) && stat.size === asset.size && await fileHash(filename) === asset.sha256;
}

async function matchesCore(directory, assets) {
  if (!await matchesAsset(path.join(directory, 'cef.asi'), assets.loader)) return false;
  for (const [name, asset] of Object.entries(assets.core)) {
    if (!await matchesAsset(path.join(directory, 'cef', name), asset)) return false;
  }
  return true;
}

async function matchesPackage(directory, assets) {
  const markerPath = path.join(directory, 'cef', markerName);
  const stat = await readEntry(markerPath);
  if (!hasFile(stat) || stat.size > 1024) return false;
  let marker;
  try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); }
  catch { return false; }
  return marker?.archive === assets.client.sha256 &&
    /^[a-f0-9]{64}$/.test(marker.libcef) &&
    await matchesCore(directory, assets) &&
    await fileHash(path.join(directory, 'cef', 'libcef.dll')) === marker.libcef;
}

async function download(asset, destination, fetchAsset, onProgress) {
  let response;
  try {
    response = await fetchAsset(`${releaseUrl}${asset.name}`, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  } catch (error) {
    throw new Error('No se pudo descargar CEF desde GitHub. Comprueba tu conexión y vuelve a pulsar Jugar.', { cause: error });
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`GitHub no pudo entregar CEF (HTTP ${response.status}). Vuelve a pulsar Jugar para reintentar.`);
  }
  const hash = createHash('sha256');
  let received = 0;
  let lastPercent = 0;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      if (received > asset.size) return done(new Error('La descarga de CEF supera el tamaño esperado.'));
      hash.update(chunk);
      const percent = Math.floor(received * 100 / asset.size);
      if (percent >= lastPercent + 2 || percent === 100) {
        lastPercent = percent;
        onProgress({ phase: 'download', percent });
      }
      done(null, chunk);
    },
  });
  onProgress({ phase: 'download', percent: 0 });
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination, { flags: 'wx' }));
  } catch (error) {
    if (error.code === 'ENOSPC' || error.code === 'EACCES' || error.code === 'EPERM') throw error;
    throw new Error('La descarga de CEF se interrumpió o llegó incompleta. Vuelve a pulsar Jugar para reintentar.', { cause: error });
  }
  if (received !== asset.size || hash.digest('hex') !== asset.sha256) {
    throw new Error('El archivo descargado de CEF no pasó la verificación. Vuelve a pulsar Jugar para reintentar.');
  }
}

async function extractClient(archive, directory) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  try {
    await promisify(execFile)(tar, ['-xf', archive, '-C', directory], { windowsHide: true, timeout: 120000 });
  } catch (error) {
    throw new Error('Windows no pudo descomprimir CEF. Comprueba el espacio disponible y que Windows esté actualizado.', { cause: error });
  }
}

async function installFiles(gamePath, staged, current) {
  const names = ['cef', 'cef.asi'];
  const existing = names.filter((name) => name === 'cef' ? current.runtime : current.loader);
  const backupPath = existing.length ? await fs.mkdtemp(path.join(gamePath, '.legacy-cef-respaldo-')) : null;
  const backedUp = [];
  const installed = [];
  try {
    for (const name of existing) {
      await fs.rename(path.join(gamePath, name), path.join(backupPath, name));
      backedUp.push(name);
    }
    for (const name of names) {
      const target = path.join(gamePath, name);
      await fs.rename(path.join(staged, name), target);
      installed.push(name);
    }
  } catch (error) {
    try {
      for (const name of installed.reverse()) {
        await fs.rename(path.join(gamePath, name), path.join(staged, `failed-${name}`));
      }
      for (const name of backedUp.reverse()) {
        await fs.rename(path.join(backupPath, name), path.join(gamePath, name));
      }
      if (backupPath) await fs.rmdir(backupPath);
    } catch {
      const recovery = backupPath ? ` Los archivos anteriores están en ${backupPath}.` : '';
      throw new Error(`No se pudo terminar la instalación de CEF.${recovery} Cierra GTA y vuelve a pulsar Jugar.`, { cause: error });
    }
    throw error;
  }
  return backupPath;
}

async function ensureCef(gamePath, {
  onProgress = () => {},
  fetchAsset = globalThis.fetch,
  extract = extractClient,
  assets = release,
} = {}) {
  onProgress({ phase: 'check' });
  let staged;
  try {
    const directory = await fs.realpath(gamePath);
    const current = await inspectCef(directory);
    if (current.complete && hasFile(current.loader) && await matchesPackage(directory, assets)) return { installed: false };

    staged = await fs.mkdtemp(path.join(directory, '.legacy-cef-descarga-'));
    const unpacked = path.join(staged, 'cliente');
    await fs.mkdir(unpacked);
    // Always replace the complete runtime when its version is unknown or mismatched.
    // Chromium binaries from different releases must not be mixed.
    const archive = path.join(staged, 'client.zip');
    await download(assets.client, archive, fetchAsset, onProgress);
    onProgress({ phase: 'extract' });
    await extract(archive, unpacked);
    const extracted = await inspectCef(unpacked);
    if (!extracted.complete || !hasFile(extracted.loader) || !await matchesCore(unpacked, assets)) {
      const missing = [];
      for (const name of runtimeFiles) {
        if (!hasFile(await readEntry(path.join(unpacked, 'cef', name)))) missing.push(name);
      }
      const mismatched = [];
      if (!await matchesAsset(path.join(unpacked, 'cef.asi'), assets.loader)) mismatched.push('cef.asi');
      for (const [name, asset] of Object.entries(assets.core)) {
        if (!await matchesAsset(path.join(unpacked, 'cef', name), asset)) mismatched.push(name);
      }
      throw new Error('El paquete de CEF no incluye todos los archivos necesarios de la versión requerida. '
        + 'Archivos ausentes: ' + (missing.join(', ') || 'ninguno')
        + '; binarios incompatibles: ' + (mismatched.join(', ') || 'ninguno') + '.');
    }
    await fs.writeFile(path.join(unpacked, 'cef', markerName), JSON.stringify({
      archive: assets.client.sha256,
      libcef: await fileHash(path.join(unpacked, 'cef', 'libcef.dll')),
    }), { flag: 'wx' });

    onProgress({ phase: 'install' });
    const backupPath = await installFiles(directory, unpacked, current);
    return { installed: true, backupPath };
  } catch (error) {
    if (error.code === 'ENOSPC') throw new Error('Libera espacio en el disco donde está GTA para instalar CEF.', { cause: error });
    if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) {
      throw new Error('No se pudo escribir CEF en la carpeta de GTA. Cierra GTA y SA-MP y comprueba los permisos de esa carpeta.', { cause: error });
    }
    throw error;
  } finally {
    if (staged) await fs.rm(staged, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

// Cache only successful verification in memory; file metadata changes invalidate it.
async function snapshot(directory) {
  const entries = ['cef', 'cef/locales', 'cef.asi', 'cef/' + markerName, ...runtimeFiles.map(name => 'cef/' + name)];
  const values = await Promise.all(entries.map(async name => {
    const stat = await readEntry(path.join(directory, name));
    const folder = name === 'cef' || name === 'cef/locales';
    if (!stat || (folder ? !stat.isDirectory() : !hasFile(stat))) return null;
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  }));
  return values.some(value => value === null) ? null : JSON.stringify(values);
}

function createCefVerifier({ assets = release, verify = matchesPackage, install = ensureCef } = {}) {
  let cached = null;
  let pending = null;
  async function check(gamePath) {
    const directory = await fs.realpath(gamePath);
    if (pending?.directory === directory) return pending.promise;
    const promise = (async () => {
      const before = await snapshot(directory);
      if (before && cached?.directory === directory && cached.signature === before) return { ready: true, cached: true };
      if (cached?.directory === directory) cached = null;
      if (!before || !await verify(directory, assets)) return { ready: false, cached: false };
      const after = await snapshot(directory);
      if (after !== before) return { ready: false, cached: false };
      cached = { directory, signature: after };
      return { ready: true, cached: false };
    })();
    pending = { directory, promise };
    try { return await promise; }
    finally { if (pending?.promise === promise) pending = null; }
  }

  async function prepare(gamePath, options = {}) {
    if ((await check(gamePath)).ready) return { installed: false };
    const result = await install(gamePath, { ...options, assets });
    if (!(await check(gamePath)).ready) throw new Error('No se pudo verificar CEF después de prepararlo.');
    return result;
  }

  return { check, prepare };
}

module.exports = { ensureCef, createCefVerifier };
