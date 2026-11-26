'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const yaml = require('js-yaml');
const version = require('../package.json').version;

async function run() {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const folder = path.resolve(__dirname, '../release');
  const installer = 'Legacy-Launcher-' + version + '-Setup.exe';
  const zip = 'Legacy-Launcher-' + version + '-Windows-x64.zip';
  const manifest = yaml.load(await fs.readFile(path.join(folder, 'latest.yml'), 'utf8'));
  assert.equal(manifest.version, version);
  const file = manifest.files.find(item => item.url === installer);
  assert.ok(file, 'Installer missing from update metadata');
  const stat = await fs.stat(path.join(folder, installer));
  assert.equal(stat.size, file.size);
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path.join(folder, installer))) hash.update(chunk);
  assert.equal(hash.digest('base64'), file.sha512);
  for (const name of [zip, installer + '.blockmap']) {
    assert.ok((await fs.stat(path.join(folder, name))).size > 0);
  }
  const config = yaml.load(await fs.readFile(path.join(folder, 'win-unpacked', 'resources', 'app-update.yml'), 'utf8'));
  assert.equal(config.provider, 'github');
  assert.equal(config.owner, 'BladimirFC');
  assert.equal(config.repo, 'legacy-launcher');
  console.log('Release manifest and updater feed verified for ' + version);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
