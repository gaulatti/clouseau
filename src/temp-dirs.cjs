'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every temporary directory the engine creates under the system temp directory, and a run's own
// directories are removed on every exit path: the creator's `finally`, normal exit, and SIGINT,
// SIGTERM and SIGHUP. State that must survive a run lives under the repository's state directory.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The exact names the engine (and earlier releases of its coverage fixtures) gave these directories:
// a fixed prefix plus the six random characters mkdtemp appends.
const OWNED = /^clouseau-(?:v8|v8-empty|base|harness)-[A-Za-z0-9]{6}$/;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const live = new Set();
let installed = false;

function dispose(directory) {
  live.delete(directory);
  try {fs.rmSync(directory, {recursive: true, force: true});} catch { /* best effort: never mask the run's own result */ }
}

function disposeAll() {
  for (const directory of [...live]) dispose(directory);
}

function install() {
  if (installed) return;
  installed = true;
  process.on('exit', disposeAll);
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      disposeAll();
      process.exit(128 + os.constants.signals[signal]);
    });
  }
}

// A new private directory under the system temp directory, removed by `dispose` or when the process ends.
function create(prefix) {
  install();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  live.add(directory);
  return directory;
}

// Removes engine-created directories left by an earlier process that was killed before it could clean up.
// Matches the exact names only, never follows a symlink, skips this process's live directories, ignores errors.
function sweepStale({root = os.tmpdir(), now = Date.now(), maxAgeMs = MAX_AGE_MS} = {}) {
  let removed = 0;
  let names = [];
  try {names = fs.readdirSync(root);} catch { /* an unreadable temp directory has nothing to sweep */ }
  for (const name of names) {
    if (!OWNED.test(name)) continue;
    const directory = path.join(root, name);
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || live.has(directory) || now - stat.mtimeMs <= maxAgeMs) continue;
      fs.rmSync(directory, {recursive: true, force: true});
      removed++;
    } catch { /* gone, busy or not ours to remove */ }
  }
  return removed;
}

module.exports = {MAX_AGE_MS, OWNED, create, dispose, sweepStale};
