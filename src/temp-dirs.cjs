'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every temporary directory the engine creates, under the system temp directory or under the work
// directory, and a run's own directories are removed on every exit path: the creator's `finally`,
// normal exit, and SIGINT, SIGTERM and SIGHUP. State that must survive a run lives under the state directory.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The exact names the engine (and earlier releases of its coverage fixtures) gave these directories:
// a fixed prefix plus the six random characters mkdtemp appends.
const OWNED = /^clouseau-(?:v8|v8-empty|base|harness)-[A-Za-z0-9]{6}$/;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// The CLI's own per-user state directory, and the work directory inside it for run-scoped trees that a
// container must reach (a base checkout whose recipe bind-mounts it with Docker Compose). It sits under the
// home directory because that is what Docker VMs such as Colima share by default; the system temp
// directory (`/var/folders/...` on macOS) is not.
const stateDirectory = () => path.join(os.homedir(), '.local/share/clouseau');
const workDirectory = (state = stateDirectory()) => path.join(state, 'work');

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

// A new private directory under `root` (the system temp directory unless stated), removed by `dispose` or when the process ends.
function create(prefix, root = os.tmpdir()) {
  install();
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  const directory = fs.mkdtempSync(path.join(root, prefix));
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

module.exports = {MAX_AGE_MS, OWNED, stateDirectory, workDirectory, create, dispose, sweepStale};
