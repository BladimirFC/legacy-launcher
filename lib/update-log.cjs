'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createUpdateLogger(filename) {
  function write(level, message) {
    try {
      const value = String(message).replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']+/gi, '$1?[redacted]').slice(0, 12000);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      if (fs.existsSync(filename) && fs.statSync(filename).size > 1024 * 1024) {
        fs.renameSync(filename, filename + '.previous');
      }
      fs.appendFileSync(filename, new Date().toISOString() + ' [' + level + '] ' + value + '\n', 'utf8');
    } catch { /* Logging must not interrupt update operations. */ }
  }
  return { info: message => write('INFO', message), warn: message => write('WARN', message), error: message => write('ERROR', message) };
}

module.exports = { createUpdateLogger };
