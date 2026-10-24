'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {resolveCentral, identifyEngine} = require('./central-version.cjs');
const {engineDigest} = require('./local-version.cjs');

const first = 'a'.repeat(40);
const second = 'b'.repeat(40);
test('a source mutation during digest calculation cannot be published with the frozen commit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'central-mutating-digest-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/local-version.cjs'), `module.exports = {engineDigest(root) {
      require('node:fs').writeFileSync(require('node:path').join(root, 'src/injected.cjs'), 'changed during hashing');
      return 'd'.repeat(64);
    }};`);
    cp.execFileSync('git', ['init', '-q', root]);
    cp.execFileSync('git', ['-C', root, 'add', '.']);
    cp.execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const revision = cp.execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    assert.throws(() => identifyEngine(revision, root), /Uncommitted or untracked/);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('protected central main resolves once; a branch advance cannot change frozen outputs and the next run advances', async () => {
  let branch = {name: 'main', protected: true, commit: {sha: first}};
  let calls = 0;
  const github = {rest: {repos: {getBranch: async args => {
    assert.deepEqual(args, {owner: 'gaulatti', repo: 'clouseau', branch: 'main'});
    calls++;
    return {data: branch};
  }}}};
  const output = await resolveCentral(github);
  branch = {...branch, commit: {sha: second}};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'central-version-'));
  try {
    for (const folder of ['src', 'scripts', 'skills', 'policy', 'bin']) fs.mkdirSync(path.join(root, folder));
    fs.writeFileSync(path.join(root, 'action.yml'), 'fixture');
    fs.writeFileSync(path.join(root, 'src/local-version.cjs'), `module.exports = require(${JSON.stringify(require.resolve('./local-version.cjs'))});`);
    const engine = identifyEngine(output, root);
    assert.equal(engine.sha, first);
    assert.equal(engine.digest, engineDigest(root));
    assert.equal(identifyEngine(output, root).sha, first);
    assert.equal(calls, 1);
    assert.equal(await resolveCentral(github), second);
    assert.throws(() => identifyEngine('main', root), /immutable/);
    cp.execFileSync('git', ['init', '-q', root]);
    cp.execFileSync('git', ['-C', root, 'add', '.']);
    cp.execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    assert.throws(() => identifyEngine(first, root), /source differs/);
    const actual = cp.execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    assert.equal(identifyEngine(actual, root).sha, actual);
    fs.writeFileSync(path.join(root, 'src/substituted.cjs'), 'unexpected source');
    assert.throws(() => identifyEngine(actual, root), /Uncommitted or untracked/);
    fs.rmSync(path.join(root, 'src/substituted.cjs'));
    fs.writeFileSync(path.join(root, 'src/local-version.cjs'), "module.exports = {engineDigest: () => 'f'.repeat(64)};");
    assert.throws(() => identifyEngine(actual, root), /Uncommitted or untracked/);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
  for (const data of [{name: 'other', protected: true, commit: {sha: first}}, {name: 'main', protected: false},
    {name: 'main', protected: true}, {name: 'main', protected: true, commit: {sha: 'main'}},
    {name: 'main', protected: true, commit: {sha: 'A'.repeat(40)}}]) {
    branch = data;
    await assert.rejects(resolveCentral(github), /Cannot resolve/);
  }
  github.rest.repos.getBranch = async () => {throw new Error('unavailable');};
  await assert.rejects(resolveCentral(github), /unavailable/);
});

test('the bootstrap uses the frozen release digest implementation so algorithm releases need no consumer pin update', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'central-new-algorithm-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    const filename = path.join(root, 'src/local-version.cjs');
    fs.writeFileSync(filename, "module.exports = {engineDigest: () => 'd'.repeat(64)};");
    assert.equal(identifyEngine(first, root).digest, 'd'.repeat(64));
    delete require.cache[require.resolve(filename)];
    fs.writeFileSync(filename, "module.exports = {engineDigest: () => 'invalid'};");
    assert.throws(() => identifyEngine(second, root), /invalid source digest/);
    const ownRoot = path.join(__dirname, '..');
    const actual = fs.existsSync(path.join(ownRoot, '.git')) ? cp.execFileSync('git', ['-C', ownRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim() : first;
    assert.equal(identifyEngine(actual).digest, engineDigest());
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

