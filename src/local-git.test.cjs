'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {git, readLocalConfig, githubRepository, collectLocal, assertUnchanged} = require('./local-git.cjs');

const {repository} = require('../test/local-git-fixture.cjs');

test('local Git collection reads immutable base contracts, accounts for new files and preserves user index', () => repository(f => {
  const before = git(f.directory, ['status', '--porcelain']);
  const {snapshot, localConfig, addSources} = collectLocal({...f, request: 'Reject missing input.', technical: {exact: true}});
  assert.equal(snapshot.repository, 'example/local-fixture');
  assert.equal(snapshot.number, 0); assert.equal(localConfig.version, 1);
  assert.deepEqual(snapshot.paths, ['src/handler.js', 'src/new.js']);
  assert.equal(snapshot.files.find(file => file.path === 'src/new.js').base_source, undefined);
  assert.equal(snapshot.sources[`${f.base}:README.md`].authority, 'trusted');
  assert.equal(snapshot.sources['local-request'].authority, 'untrusted');
  assertUnchanged(f.directory, snapshot);
  assert.equal(git(f.directory, ['status', '--porcelain']), before);
  return addSources(['AGENTS.md']).then(async () => {
    await assert.rejects(addSources([]), /one to eight/);
    await assert.rejects(addSources(['../outside']), /Unsafe/);
    fs.writeFileSync(path.join(f.directory, 'src/new.js'), 'changed during review');
    assert.throws(() => assertUnchanged(f.directory, snapshot), /changed/);
    assert.throws(() => collectLocal({...f, request: 'a', technical: {}}), /Commit/);
  });
}));

test('local configuration is independent of CI and refuses missing commands or unsafe paths', () => {
  assert.throws(() => readLocalConfig(null), /Invalid local-only/);
  assert.throws(() => readLocalConfig({version: 1}), /Invalid local-only/);
});

test('local provenance covers renames and deletions and refuses substituted origins or unsupported source', () => repository(async f => {
  git(f.directory, ['mv', 'src/handler.js', 'src/renamed.js']);
  fs.writeFileSync(path.join(f.directory, 'src/renamed.js'), git(f.directory, ['show', `${f.base}:src/handler.js`]));
  git(f.directory, ['rm', 'src/new.js']);
  git(f.directory, ['add', 'src/renamed.js']);
  git(f.directory, ['commit', '-qm', 'refactor: move fixture handler']);
  const {snapshot, addSources} = collectLocal({...f, request: 'Preserve the handler.', technical: {}});
  assert.equal(snapshot.files[0].status, 'renamed');
  assert.match(snapshot.files[0].base_source, /:src\/handler.js$/);
  await addSources(['README.md']);
  await addSources(['README.md']);
  await assert.rejects(addSources(['README.md', 'README.md']), /distinct/);
  git(f.directory, ['remote', 'set-url', 'origin', 'git@github.com:example/local-fixture.git']);
  assert.deepEqual(githubRepository(f.directory), {owner: 'example', repo: 'local-fixture'});
  git(f.directory, ['remote', 'set-url', 'origin', 'https://attacker.invalid/example/local-fixture']);
  assert.throws(() => githubRepository(f.directory), /GitHub origin/);
  git(f.directory, ['remote', 'set-url', 'origin', 'https://github.com/example/local-fixture']);
  const head = git(f.directory, ['rev-parse', 'HEAD']).trim();
  assert.throws(() => collectLocal({...f, base: head, request: 'a', technical: {}}), /nonempty/);
  git(f.directory, ['rm', 'src/renamed.js']);
  git(f.directory, ['commit', '-qm', 'test: remove fixture handler']);
  const removed = collectLocal({...f, request: 'a', technical: {}}).snapshot.files[0];
  assert.equal(removed.status, 'removed'); assert.equal(removed.head_source, undefined);
  assert.throws(() => assertUnchanged(f.directory, snapshot), /changed/);
  fs.mkdirSync(path.join(f.directory, 'src'), {recursive: true});
  fs.writeFileSync(path.join(f.directory, 'src/binary.js'), Buffer.from([0, 1]));
  git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'test: binary fixture']);
  assert.throws(() => collectLocal({...f, request: 'a', technical: {}}), /Binary or oversized/);
}));

test('a changed source kind is rejected rather than followed as evidence', () => repository(f => {
  fs.unlinkSync(path.join(f.directory, 'src/handler.js'));
  fs.symlinkSync('../README.md', path.join(f.directory, 'src/handler.js'));
  git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'test: unsupported source kind']);
  assert.throws(() => collectLocal({...f, request: 'a', technical: {}}), /Unsupported or unsafe/);
}));

test('config command, report and policy boundaries fail before execution', () => repository(f => {
  const valid = JSON.parse(fs.readFileSync(path.join(f.directory, '.clouseau-local.json')));
  for (const value of [{...valid, verification: []}, {...valid, verification: [[]]},
    {...valid, verification: [['node', '']]}, {...valid, coverage: null},
    {...valid, coverage: {...valid.coverage, report: '../report.json'}},
    {...valid, coverage: {...valid.coverage, source_directory: '/outside'}},
    {...valid, readme: '../README.md'}, {...valid, repository_policy: '/policy'}]) {
    assert.throws(() => readLocalConfig(value), /Invalid local-only/);
  }
  fs.writeFileSync(path.join(f.directory, 'src/handler.js'), 'x'.repeat(300001));
  git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'test: oversized fixture']);
  assert.throws(() => collectLocal({...f, request: 'a', technical: {}}), /oversized/);
}));

module.exports = {repository};

test('local evidence can inspect the frozen public engine without a consumer CI checkout', t => repository(async f => {
  const collected = collectLocal({directory: f.directory, base: f.base, request: 'Inspect the shared action.', technical: {fixture_only: true}, reviewerSha: 'e'.repeat(40)});
  await collected.addSources(['.clouseau-ci/src/config.cjs']);
  const source = Object.values(collected.snapshot.sources).find(item => item.path === '.clouseau-ci/src/config.cjs');
  assert.equal(source.authority, 'untrusted'); assert.equal(source.kind, 'source');
  assert.equal(source.content, fs.readFileSync(path.join(__dirname, 'config.cjs'), 'utf8'));
  assert.equal(source.ref, 'e'.repeat(40));
  const missing = collectLocal({directory: f.directory, base: f.base, request: 'Inspect.', technical: {}});
  await assert.rejects(missing.addSources(['.clouseau-ci/src/config.cjs']), /Frozen reviewer identity/);
  const read = fs.readFileSync;
  for (const content of ['binary\0source', 'x'.repeat(300001)]) {
    t.mock.method(fs, 'readFileSync', (filename, ...args) => filename === path.join(__dirname, 'config.cjs') ? content : read(filename, ...args));
    await assert.rejects(collected.addSources(['.clouseau-ci/src/config.cjs']), /Binary or oversized engine/);
    t.mock.restoreAll();
  }
}));
