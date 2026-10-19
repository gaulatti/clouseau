'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {engineDigest} = require('./local-version.cjs');

test('reviewer identity binds executable content, modes, skill and policy independently of Git commit metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-engine-version-'));
  try {
    for (const directory of ['src', 'policy', 'bin', 'skills', 'scripts']) fs.mkdirSync(path.join(root, directory));
    fs.writeFileSync(path.join(root, 'action.yml'), 'name: Fictional fixture\n');
    fs.writeFileSync(path.join(root, 'src/engine.cjs'), 'module.exports = 1;\n');
    const first = engineDigest(root);
    assert.equal(first.length, 64); assert.equal(first, engineDigest(root));
    fs.mkdirSync(path.join(root, 'src/__pycache__')); fs.writeFileSync(path.join(root, 'src/__pycache__/cache.pyc'), 'cache');
    fs.writeFileSync(path.join(root, 'src/engine.test.cjs'), 'test fixture');
    fs.writeFileSync(path.join(root, 'src/test_fixture.py'), 'test fixture');
    assert.equal(engineDigest(root), first);
    fs.writeFileSync(path.join(root, 'policy/change.md'), 'New accepted policy.\n');
    assert.notEqual(engineDigest(root), first);
    const policy = engineDigest(root);
    fs.chmodSync(path.join(root, 'src/engine.cjs'), 0o755);
    assert.notEqual(engineDigest(root), policy);
    fs.symlinkSync('engine.cjs', path.join(root, 'src/untrusted.cjs'));
    assert.throws(() => engineDigest(root), /symbolic links/);
    assert.equal(engineDigest().length, 64);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});
