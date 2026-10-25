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
    t.mock.method(fs, 'readFileSync', (filename, ...args) => filename === path.join(__dirname, 'config.cjs') ? Buffer.from(content) : read(filename, ...args));
    await assert.rejects(collected.addSources(['.clouseau-ci/src/config.cjs']), /Binary or oversized engine/);
    t.mock.restoreAll();
  }
}));

test('resolver installation preloads its actual pinned bootstrap and the current engine as separate untrusted source', () => repository(f => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bootstrap-context-'));
  try {
    for (const entry of ['src', 'test']) fs.cpSync(path.join(__dirname, '..', entry), path.join(root, entry), {recursive: true});
    for (const filename of ['action.yml', 'src/central-version.cjs', 'scripts/resolve/action.yml']) {
      fs.mkdirSync(path.dirname(path.join(root, filename)), {recursive: true}); fs.writeFileSync(path.join(root, filename), `old ${filename}`);
    }
    git(root, ['init', '-q']); git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'old bootstrap']);
    const old = git(root, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(root, 'src/central-version.cjs'), 'new runtime engine'); git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'new engine']);
    const current = git(root, ['rev-parse', 'HEAD']).trim();
    fs.mkdirSync(path.join(f.directory, '.github/workflows'), {recursive: true});
    fs.writeFileSync(path.join(f.directory, '.github/workflows/ci.yml'), `jobs:\n  resolve:\n    steps:\n      - uses: gaulatti/clouseau/scripts/resolve@${old}\n`);
    git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'ci: install automatic resolver']);
    const collected = collectLocal({...f, request: 'Install the reviewed bootstrap.', technical: {fixture_only: true}, reviewerSha: current, engineRoot: root});
    const sources = Object.values(collected.snapshot.sources).filter(source => source.path.startsWith('.clouseau-ci/'));
    assert.equal(sources.length, 24);
    assert.ok(sources.some(source => source.path === '.clouseau-ci/test/automatic-upgrade-contract.mjs'));
    assert.ok(sources.some(source => source.path === '.clouseau-ci/src/acceptance-controller.test.cjs'));
    assert.equal(sources.find(source => source.path === '.clouseau-ci/src/central-version.cjs').content, 'new runtime engine');
    assert.equal(sources.find(source => source.path === `.clouseau-ci/src/central-version.cjs@${old}`).content, 'old src/central-version.cjs');
    assert.equal(sources.filter(source => source.ref === old).length, 2);
    assert.ok(sources.every(source => source.kind === 'source' && source.authority === 'untrusted'));
    assert.ok(collected.snapshot.paths.includes('.github/workflows/ci.yml'));
    assert.ok(!collected.snapshot.paths.some(filename => filename.startsWith('.clouseau-ci/')));
    assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), current);
    assertUnchanged(f.directory, collected.snapshot);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
}));
