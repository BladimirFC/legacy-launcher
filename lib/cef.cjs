'use strict';

const fs = require('node:fs/promises');
const { createWriteStream, constants } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');

const releaseUrl = 'https://github.com/aurora-mp/omp-cef/releases/download/v1.3.0/';
const release = {
  client: {
    name: 'client-files-v1.3.0.zip',
    size: 153526869,
    sha256: '8ae91a82e625d97d957617db6fd63ba9837c95a804a272a9d680005231700f08',
  },
  loader: {
    name: 'cef.asi',
    size: 105472,
    sha256: 'd5b876638b8ba9dbca423533ad3d05bd470f04cfdf3f79b3fd2701b8b42fd283',
  },
};
const runtimeFiles = [
  'client.dll', 'renderer.exe', 'libcef.dll', 'chrome_elf.dll',
  'd3dcompiler_47.dll', 'libEGL.dll', 'libGLESv2.dll', 'icudtl.dat',
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

async function installFiles(gamePath, staged, current, installRuntime) {
  const names = installRuntime ? ['cef', 'cef.asi'] : ['cef.asi'];
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
      if (name === 'cef.asi') await fs.copyFile(path.join(staged, name), target, constants.COPYFILE_EXCL);
      else await fs.rename(path.join(staged, name), target);
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
    if (current.complete && hasFile(current.loader)) return { installed: false };

    staged = await fs.mkdtemp(path.join(directory, '.legacy-cef-descarga-'));
    const unpacked = path.join(staged, 'cliente');
    await fs.mkdir(unpacked);
    if (current.complete) {
      await download(assets.loader, path.join(unpacked, 'cef.asi'), fetchAsset, onProgress);
    } else {
      const archive = path.join(staged, 'client.zip');
      await download(assets.client, archive, fetchAsset, onProgress);
      onProgress({ phase: 'extract' });
      await extract(archive, unpacked);
      const extracted = await inspectCef(unpacked);
      if (!extracted.complete || !hasFile(extracted.loader)) throw new Error('El paquete de CEF no incluye todos los archivos necesarios.');
    }

    onProgress({ phase: 'install' });
    const backupPath = await installFiles(directory, unpacked, current, !current.complete);
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

module.exports = { ensureCef };
