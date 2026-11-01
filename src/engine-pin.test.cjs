'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {git} = require('./local-git.cjs');
const pinning = require('./engine-pin.cjs');

const {write, installedCache} = require('../test/engine-cache-fixture.cjs');

test('a pin is private, validated and removable', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-pin-'));
  try {
    const key = pinning.pinKey({head: 'a'});
    assert.equal(pinning.readPin(state, key), null);
    pinning.writePin(state, key, {sha: 'a'.repeat(40), digest: 'b'.repeat(64)});
    assert.deepEqual(pinning.readPin(state, key), {reviewer_sha: 'a'.repeat(40), reviewer_digest: 'b'.repeat(64)});
    assert.equal(fs.statSync(path.join(state, 'pins', `${key}.json`)).mode & 0o077, 0);
    pinning.clearPin(state, key); assert.equal(pinning.readPin(state, key), null);
    write(path.join(state, 'pins', `${key}.json`), JSON.stringify({reviewer_sha: 'x', reviewer_digest: 'y'}));
    assert.throws(() => pinning.readPin(state, key), /Invalid engine pin.*--engine latest/);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});

test('only an unmodified checkout the installer made from its own source, with the recorded bytes, is runnable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-pin-cache-'));
  try {
    const {cache, checkout, pin, origin} = installedCache(root);
    assert.equal(pinning.verifiedRevision(cache, pin), checkout);
    assert.throws(() => pinning.verifiedRevision(cache, {...pin, reviewer_sha: 'c'.repeat(40)}), /not in the local cache.*--engine latest/);
    assert.throws(() => pinning.verifiedRevision(cache, {...pin, reviewer_digest: 'd'.repeat(64)}), /different from the verified engine bytes/);
    // A checkout that is not a worktree of the cached source is refused even if it is clean and the right revision.
    const sha = pin.reviewer_sha;
    fs.rmSync(checkout, {recursive: true}); git(root, ['clone', '-q', origin, checkout]);
    assert.throws(() => pinning.verifiedRevision(cache, pin), /not an unmodified installation/);
    // A modified or wrong-revision checkout is refused.
    fs.rmSync(checkout, {recursive: true}); git(cache, ['--git-dir', path.join(cache, 'source.git'), 'worktree', 'prune']);
    git(cache, ['--git-dir', path.join(cache, 'source.git'), 'worktree', 'add', '-q', '--detach', checkout, sha]);
    assert.equal(pinning.verifiedRevision(cache, pin), checkout);
    write(path.join(checkout, 'src/a.cjs'), 'tampered');
    assert.throws(() => pinning.verifiedRevision(cache, pin), /not an unmodified installation/);
    git(checkout, ['checkout', '-q', '--', '.']);
    git(checkout, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'moved']);
    assert.throws(() => pinning.verifiedRevision(cache, pin), /not an unmodified installation/);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('a continuation is re-executed verbatim on the pinned engine, without the escape flag', () => {
  assert.deepEqual(pinning.argvFor({command: 'review', directory: '/r', engine: 'latest', agent: 'claude'}), ['review', '--directory', '/r', '--agent', 'claude']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-pin-exec-'));
  try {
    for (const [status, ok] of [[0, true], [2, true], [3, true], [1, false]]) {
      write(path.join(root, 'bin/clouseau.cjs'), `process.stdout.write(JSON.stringify({argv: process.argv.slice(2)}));process.exitCode=${status};`);
      if (ok) assert.deepEqual(pinning.execute(root, ['review', '--agent', 'claude']), {argv: ['review', '--agent', 'claude']});
      else assert.throws(() => pinning.execute(root, ['review']), /Pinned Clouseau engine failed \(status 1\)/);
    }
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('a pinned engine that cannot even start is a failure, not a result', () => {
  assert.throws(() => pinning.execute('/nonexistent-clouseau-engine', ['review'], () => ({status: null})), /status null/);
});
