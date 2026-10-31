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
    for (const entry of ['src', 'test', 'bin', 'skills', 'scripts']) fs.cpSync(path.join(__dirname, '..', entry), path.join(root, entry), {recursive: true});
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
    assert.equal(sources.length, 27);
    assert.ok(sources.some(source => source.path === '.clouseau-ci/test/automatic-upgrade-contract.mjs'));
    assert.ok(sources.some(source => source.path === '.clouseau-ci/src/local-harness.cjs'));
    assert.ok(sources.some(source => source.path === '.clouseau-ci/src/private-owner-merge.cjs'));
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

test('a seeded engine file that a pinned legacy revision never had is skipped, while other seed failures still stop the review', () => repository(f => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'legacy-context-'));
  try {
    for (const entry of ['src', 'test', 'bin', 'skills', 'scripts']) fs.cpSync(path.join(__dirname, '..', entry), path.join(root, entry), {recursive: true});
    git(root, ['init', '-q']);
    const commit = message => { git(root, ['add', '-A']); git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message]); return git(root, ['rev-parse', 'HEAD']).trim(); };
    for (const filename of ['src/config.cjs', 'src/policy.cjs', 'src/local-receipt.cjs']) fs.rmSync(path.join(root, filename));
    fs.writeFileSync(path.join(root, 'action.yml'), 'old action');
    fs.mkdirSync(path.join(root, 'scripts/resolve'), {recursive: true}); fs.writeFileSync(path.join(root, 'scripts/resolve/action.yml'), 'old bootstrap');
    const old = commit('legacy engine without receipt, config or policy sources');
    for (const filename of ['src/config.cjs', 'src/policy.cjs', 'src/local-receipt.cjs']) fs.cpSync(path.join(__dirname, '..', filename), path.join(root, filename));
    const current = commit('current engine');
    fs.mkdirSync(path.join(f.directory, '.github/workflows'), {recursive: true});
    fs.writeFileSync(path.join(f.directory, '.github/workflows/ci.yml'),
      `jobs:\n  resolve:\n    steps:\n      - uses: gaulatti/clouseau/scripts/resolve@${old}\n      - uses: gaulatti/clouseau@${old}\n`);
    git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'ci: migrate from the legacy pin']);
    const collected = collectLocal({...f, request: 'Migrate the legacy pin.', technical: {fixture_only: true}, reviewerSha: current, engineRoot: root});
    const paths = Object.values(collected.snapshot.sources).map(source => source.path);
    assert.ok(paths.includes(`.clouseau-ci/action.yml@${old}`), 'files the legacy revision had are still seeded');
    assert.ok(!paths.includes(`.clouseau-ci/src/local-receipt.cjs@${old}`), 'a file it never had is not evidence');
    fs.writeFileSync(path.join(root, 'src/policy.cjs'), 'binary\0source'); commit('corrupt current seed');
    assert.throws(() => collectLocal({...f, request: 'Migrate the legacy pin.', technical: {fixture_only: true}, reviewerSha: git(root, ['rev-parse', 'HEAD']).trim(), engineRoot: root}), /Binary or oversized/);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
}));

// ---- Dependency lockfiles (issue 65): the local review summarizes with the same code as the hosted review.

const lockfixture = require('../test/fixtures/lockfiles.cjs');
const {LOCKFILE_PATCH} = require('./lockfile-summary.cjs');

const commitLockfile = (f, name, text) => {
  fs.mkdirSync(path.dirname(path.join(f.directory, name)), {recursive: true});
  fs.writeFileSync(path.join(f.directory, name), text);
  git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', `chore: update ${name}`]);
};

test('local collection replaces a changed lockfile with its derived summary and keeps package.json as source', () => repository(f => {
  commitLockfile(f, 'package.json', '{"name":"fictional"}\n');
  commitLockfile(f, 'package-lock.json', lockfixture.npmHead());
  const {snapshot} = collectLocal({...f, request: 'Update dependencies.', technical: {}});
  const item = snapshot.files.find(file => file.path === 'package-lock.json');
  const [id, source] = Object.entries(snapshot.sources).find(([, candidate]) => candidate.kind === 'lockfile-summary');
  assert.deepEqual([item.lockfile, item.patch, item.head_source, item.base_source], [true, LOCKFILE_PATCH, id, undefined]);
  assert.equal(source.authority, 'derived'); assert.equal(source.ref, snapshot.head_sha);
  assert.match(source.content, /^base: absent$/m);
  assert.equal(Object.values(snapshot.sources).filter(candidate => candidate.path === 'package-lock.json').length, 1);
  assert.equal(snapshot.files.find(file => file.path === 'package.json').head_source.endsWith(':package.json'), true);
}, directory => fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"before"}\n')));

test('local collection summarizes modified, removed and renamed lockfiles from exact blob bytes', () => repository(f => {
  commitLockfile(f, 'package-lock.json', lockfixture.npmHead());
  fs.renameSync(path.join(f.directory, 'uv.lock'), path.join(f.directory, 'tools/uv.lock'));
  git(f.directory, ['rm', '-q', '--cached', 'uv.lock']); fs.rmSync(path.join(f.directory, 'go.sum'));
  git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'chore: move lockfiles']);
  const {snapshot} = collectLocal({...f, request: 'Move lockfiles.', technical: {}});
  const summaries = Object.values(snapshot.sources).filter(source => source.kind === 'lockfile-summary');
  assert.deepEqual(summaries.map(source => source.path).sort(), ['go.sum', 'package-lock.json', 'tools/uv.lock']);
  const removed = snapshot.files.find(file => file.path === 'go.sum');
  assert.deepEqual([removed.head_source, snapshot.sources[removed.base_source].ref], [undefined, snapshot.base_sha]);
  assert.equal(snapshot.files.find(file => file.path === 'tools/uv.lock').status, 'renamed');
  assert.match(summaries.find(source => source.path === 'package-lock.json').content, /RISK\[downgrade\] CHANGED semver/);
}, directory => {
  fs.mkdirSync(path.join(directory, 'tools'));
  fs.writeFileSync(path.join(directory, 'package-lock.json'), lockfixture.npmBase());
  fs.writeFileSync(path.join(directory, 'uv.lock'), lockfixture.uvBase());
  fs.writeFileSync(path.join(directory, 'go.sum'), 'example.com/mod v1.0.0 h1:abc=\n');
}));

test('a lockfile that cannot be summarized locally keeps raw evidence, and an unreadable one fails with the specific reason', () => repository(f => {
  commitLockfile(f, 'Cargo.lock', 'version = 2\n');
  const {snapshot} = collectLocal({...f, request: 'a', technical: {}});
  assert.deepEqual(snapshot.lockfile_failures, [{path: 'Cargo.lock', reason: 'unsupported_version'}]);
  assert.equal(snapshot.files.find(file => file.path === 'Cargo.lock').lockfile, undefined);
  assert.equal(snapshot.sources[`${snapshot.head_sha}:Cargo.lock`].content, 'version = 2\n');
  commitLockfile(f, 'Cargo.lock', `version = 2\n${'#'.repeat(310000)}\n`);
  assert.throws(() => collectLocal({...f, request: 'a', technical: {}}), error => error.lockfile?.reason === 'unsupported_version' && /Cargo\.lock/.test(error.message));
}, directory => fs.writeFileSync(path.join(directory, 'Cargo.lock'), 'version = 3\n')));

test('local lockfile bytes over the bound or not UTF-8 fail closed with specific reasons', () => repository(f => {
  commitLockfile(f, 'yarn.lock', `# yarn lockfile v1\n${'#'.repeat(1100000)}\n`);
  assert.throws(() => collectLocal({...f, request: 'a', technical: {}}), error => error.lockfile?.reason === 'too_large');
  commitLockfile(f, 'yarn.lock', Buffer.from([0x23, 0xff, 0xfe, 0x0a]));
  assert.deepEqual(collectLocal({...f, request: 'a', technical: {}}).snapshot.lockfile_failures, [{path: 'yarn.lock', reason: 'not_text'}]);
}, directory => fs.writeFileSync(path.join(directory, 'yarn.lock'), '# yarn lockfile v1\n')));

test('a git failure while reading a lockfile blob is not mistaken for a lockfile problem', () => repository(f => {
  commitLockfile(f, 'go.sum', 'example.com/mod v1.0.0 h1:abc=\n');
  const real = require('node:child_process').execFileSync;
  const cp = require('node:child_process');
  cp.execFileSync = (command, args, options) => {
    if (args.includes('show') && String(args.at(-1)).endsWith(':go.sum')) throw Object.assign(new Error('git exploded'), {code: 'EIO'});
    return real(command, args, options);
  };
  try { assert.throws(() => collectLocal({...f, request: 'a', technical: {}}), /git exploded/); } finally { cp.execFileSync = real; }
}, directory => fs.writeFileSync(path.join(directory, 'go.sum'), '')));

// The shape of the Alcantara song-similarity change that stopped at "Complete review evidence exceeds the
// source budget": 30 files (17 added, 13 modified, one of them a workflow carrying a Clouseau pin), about
// 150 KB of diff, 48 KB of contracts and an 11 KB verification record. Source sizes follow the real files.
test('a large, mostly new change with a pinned workflow fits the evidence budget with every changed file complete', () => repository(f => {
  const {evidenceSize, BUDGET, refresh} = require('./acceptance-sources.cjs');
  const {patchOf} = require('./acceptance.cjs');
  const text = (size, seed) => {
    let out = ''; for (let i = 0; out.length < size; i++) out += `export const value${seed}_${i} = compute(${i}, '${seed}', { retries: ${i % 7}, label: "item-${i}" });\n`;
    return out.slice(0, size - 1) + '\n';
  };
  const pin = 'a'.repeat(40);
  const added = [2300, 19000, 24000, 9000, 10000, 12000, 7000, 4000, 5000, 2000, 8000, 2000, 250, 1900, 6000, 3000];
  const modified = [63000, 45000, 23000, 20000, 15000, 12000, 10000, 9000, 8000, 7000, 6000, 5000];
  const write = (name, content) => { fs.mkdirSync(path.dirname(path.join(f.directory, name)), {recursive: true}); fs.writeFileSync(path.join(f.directory, name), content); };
  const commit = message => { git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', message]); };
  modified.forEach((size, i) => write(`backend/m${i}.ts`, text(size, `m${i}`)));
  write('AGENTS.md', text(26000, 'agents')); write('README.md', text(22000, 'readme'));
  write('.github/workflows/ci.yml', `steps:\n  - uses: gaulatti/clouseau/scripts/resolve@${pin}\n    image: postgres:17\n`);
  commit('chore: base');
  const base = git(f.directory, ['rev-parse', 'HEAD']).trim();
  modified.forEach((size, i) => write(`backend/m${i}.ts`, text(size, `m${i}`).replace('value', 'changed')));
  write('.github/workflows/ci.yml', `steps:\n  - uses: gaulatti/clouseau/scripts/resolve@${pin}\n    image: pgvector\n`);
  added.forEach((size, i) => write(`backend/a${i}.ts`, text(size, `a${i}`)));
  write('backend/no-newline.ts', 'export const last = 1;');
  write('backend/empty.ts', '');
  commit('feat: add similarity');
  const files = git(f.directory, ['diff', '--name-only', base, 'HEAD']).trim().split('\n');
  assert.ok(files.length >= 30);
  const technical = {pad: 'x'.repeat(11000)};
  // The same change collected the way the engine did before: whole patches and an unbounded seed.
  const collected = collectLocal({directory: f.directory, base, request: 'Add song similarity.', technical, reviewerSha: pin});
  const snapshot = collected.snapshot;
  assert.ok(evidenceSize(snapshot) <= BUDGET);
  const elided = snapshot.files.filter(file => file.patch_body === 'head_source');
  assert.equal(elided.length, added.length + 1);
  const restored = elided.reduce((sum, file) => sum + patchOf(snapshot, file).length - file.patch.length, 0);
  assert.ok(evidenceSize(snapshot) + restored > BUDGET - 150000, 'without the compact patches this change leaves no room for the seed');
  // Every changed file keeps its patch, head source and base source: nothing a reviewer judges is dropped.
  for (const file of snapshot.files) {
    assert.ok(file.patch.length > 0);
    if (file.status !== 'removed') assert.ok(snapshot.sources[file.head_source].content.length >= 0);
    if (file.status !== 'added') assert.ok(snapshot.sources[file.base_source].content.length > 0);
  }
  const empty = snapshot.files.find(file => file.path === 'backend/empty.ts');
  assert.equal(empty.patch_body, undefined);
  const lone = snapshot.files.find(file => file.path === 'backend/no-newline.ts');
  assert.equal(lone.patch_body, 'head_source');
  assert.equal(patchOf(snapshot, lone), git(f.directory, ['diff', '--no-ext-diff', '--no-textconv', base, 'HEAD', '--', 'backend/no-newline.ts']));
  const whole = snapshot.files.find(file => file.path === 'backend/a0.ts');
  assert.equal(patchOf(snapshot, whole), git(f.directory, ['diff', '--no-ext-diff', '--no-textconv', base, 'HEAD', '--', 'backend/a0.ts']));
  const modifiedFile = snapshot.files.find(file => file.path === 'backend/m0.ts');
  assert.equal(patchOf(snapshot, modifiedFile), modifiedFile.patch);
  // The optional engine seed beyond the reserve is stated as omitted instead of failing the review.
  assert.ok(snapshot.omitted_sources.length > 0);
  assert.ok(snapshot.omitted_sources.every(item => item.path.startsWith('.clouseau-ci/') && /evidence budget/.test(item.reason)));
  // A reviewer's later request still fits the room that was kept.
  return collected.addSources(['backend/a1.ts']).then(() => refresh(snapshot));
}));
