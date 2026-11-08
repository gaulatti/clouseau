'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The entry point is run for real, in a child process whose temp directory is private, so the test
// proves the startup sweep is wired in without touching the machine's own temp directory.
// The child loads the entry exactly as the launcher does; its working directory is this directory so the
// specifier below resolves the same way it does here. `--help` returns the usage without network, git or a harness.
const CHILD = `
require('../bin/clouseau.cjs');
`;

test('the entry point removes stale engine temp directories and nothing else at startup', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bin-sweep-')));
  try {
    const stale = path.join(tmp, 'clouseau-v8-abc123');
    const fresh = path.join(tmp, 'clouseau-base-def456');
    const unrelated = path.join(tmp, 'other-abc123');
    const target = path.join(tmp, 'target');
    const link = path.join(tmp, 'clouseau-harness-ghi789');
    for (const directory of [stale, fresh, unrelated, target]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(stale, 'file'), 'x');
    fs.writeFileSync(path.join(target, 'keep'), 'x');
    fs.symlinkSync(target, link);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(target, old, old);

    const run = cp.spawnSync(process.execPath, ['-e', CHILD, 'entry', '--help'], {
      cwd: __dirname, encoding: 'utf8', env: {...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp}, timeout: 20000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /clouseau/i);

    assert.equal(fs.existsSync(stale), false, 'the stale engine directory is removed');
    assert.equal(fs.existsSync(fresh), true, 'a fresh engine directory stays');
    assert.equal(fs.existsSync(unrelated), true, 'an unrelated directory stays');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the symlink stays');
    assert.equal(fs.existsSync(path.join(target, 'keep')), true, 'the symlink target is untouched');
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});
