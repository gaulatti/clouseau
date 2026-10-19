'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {digest} = require('./acceptance.cjs');

function engineDigest(root = path.join(__dirname, '..')) {
  const entries = [];
  function visit(relative) {
    const filename = path.join(root, relative);
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error('Review engine source cannot contain symbolic links');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(filename).sort()) {
        if (name === '__pycache__' || /\.(test|spec)\.[cm]?js$/.test(name) || /^test_.*\.py$/.test(name)) continue;
        visit(path.join(relative, name));
      }
    } else {
      entries.push([relative.split(path.sep).join('/'), stat.mode & 0o111,
        crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')]);
    }
  }
  for (const relative of ['action.yml', 'src', 'policy', 'bin', 'skills', 'scripts']) visit(relative);
  return digest(entries);
}
module.exports = {engineDigest};
