'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {SOURCE, centralSource, resolveCentral, identifyEngine, verifyEngine, environmentEngine, acceptsEngine, engineEvidence, readEngineEvidence, engineContext} = require('./central-version.cjs');
const {engineDigest} = require('./local-version.cjs');
const {fixture} = require('../test/local-review-fixture.cjs');
const {issueReceipt, verifyReceipt, validateTrust} = require('./local-receipt.cjs');
const {createPolicy} = require('./policy.cjs');
const {verifyRecord} = require('./acceptance-controller.cjs');
const {digest} = require('./acceptance.cjs');

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
    assert.equal(verifyEngine(engine, root).sha, first);
    for (const changed of [null, {...engine, repository: 'attacker/clouseau'}, {...engine, ref: 'refs/heads/proposal'},
      {...engine, sha: 'main'}, {...engine, digest: 'bad'}]) assert.throws(() => verifyEngine(changed, root), /differs/);
    fs.writeFileSync(path.join(root, 'src/injected.cjs'), 'substituted source');
    assert.throws(() => verifyEngine(engine, root), /differs/);
    fs.rmSync(path.join(root, 'src/injected.cjs'));
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
    const frozen = identifyEngine(actual, root);
    assert.equal(verifyEngine(frozen, root).sha, actual);
    assert.throws(() => verifyEngine({...frozen, sha: first}, root), /source differs/);
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


test('central authorization is exclusive and engine identity cannot come from a receipt or proposed configuration', async () => {
  const f = await fixture();
  const engine = {...SOURCE, sha: f.issue.reviewerSha, digest: f.trust.reviewer_digest};
  const trust = {...f.trust, central_source: {...SOURCE}};
  delete trust.reviewer_digest;
  assert.equal(centralSource(SOURCE), true);
  for (const source of [null, {...SOURCE, extra: true}, {...SOURCE, repository: 'attacker/clouseau'}, {...SOURCE, ref: 'main'}]) {
    assert.equal(centralSource(source), false);
    assert.throws(() => validateTrust({...trust, central_source: source}), /trust policy/);
  }
  assert.throws(() => validateTrust({...trust, reviewer_digest: engine.digest}), /trust policy/);
  assert.equal(acceptsEngine(trust, engine), true);
  for (const changed of [null, {...engine, sha: 'main'}, {...engine, digest: 'invalid'},
    {...engine, repository: 'other/repo'}, {...engine, ref: 'refs/heads/pr'}]) assert.ok(!acceptsEngine(trust, changed));
  assert.ok(!acceptsEngine({...trust, central_source: {...SOURCE, ref: 'other'}}, engine));
  assert.ok(!acceptsEngine(f.trust, null));
  assert.equal(acceptsEngine(f.trust, engine), true);
  const bundle = issueReceipt(f.issue);
  assert.equal(verifyReceipt(bundle, {...f.expected, trust, engine}).decision, 'auto_approve');
  for (const selected of [null, {...engine, sha: second}, {...engine, digest: '0'.repeat(64)}]) {
    assert.throws(() => verifyReceipt(bundle, {...f.expected, trust, engine: selected}), /engine mismatch.*refresh.*No paid fallback/);
  }
  assert.throws(() => verifyReceipt(bundle, {...f.expected, trust, engine, reviewerDigest: '0'.repeat(64)}), /engine mismatch/);
  const config = {...require('./config.cjs').loadConfig('.github/clouseau.json'), local_review: trust};
  // A central-source config without trusted run outputs grants no authority.
  assert.throws(() => createPolicy(config), /frozen engine/);
  const assessment = {engine};
  assert.throws(() => verifyRecord({engine: {...engine, sha: second}}, assessment, config, engine), /different frozen engine/);
  assert.throws(() => verifyRecord({engine}, {engine: {...engine, digest: '0'.repeat(64)}}, config, engine), /different frozen engine/);
  const policy = createPolicy(config, {engine});
  await assert.rejects(policy.finalize({assessment: {engine: {...engine, sha: second}}}), /different frozen engine/);
});

test('run environment is verified against actual engine source; local-only mode needs no CI environment', () => {
  const saved = [process.env.CLOUSEAU_ENGINE_SHA, process.env.CLOUSEAU_ENGINE_DIGEST];
  try {
    delete process.env.CLOUSEAU_ENGINE_SHA; delete process.env.CLOUSEAU_ENGINE_DIGEST;
    assert.equal(environmentEngine(), null);
    process.env.CLOUSEAU_ENGINE_DIGEST = engineDigest();
    assert.throws(() => environmentEngine(), /differs/);
    const root = path.join(__dirname, '..');
    const revision = fs.existsSync(path.join(root, '.git')) ? cp.execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim() : first;
    process.env.CLOUSEAU_ENGINE_SHA = revision;
    assert.equal(environmentEngine().sha, revision);
    process.env.CLOUSEAU_ENGINE_DIGEST = '0'.repeat(64);
    assert.throws(() => environmentEngine(), /differs/);
  } finally {
    for (const [index, name] of ['CLOUSEAU_ENGINE_SHA', 'CLOUSEAU_ENGINE_DIGEST'].entries()) {
      if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index];
    }
  }
});

test('a trusted frozen workflow can migrate legacy digest enrollment without accepting receipt-provided identity', async () => {
  const f = await fixture();
  const engine = {...SOURCE, sha: f.issue.reviewerSha, digest: f.trust.reviewer_digest};
  const oldTrust = {...f.trust, reviewer_digest: '0'.repeat(64)};
  const bundle = issueReceipt(f.issue);
  assert.throws(() => verifyReceipt(bundle, {...f.expected, trust: oldTrust}), /changed/);
  assert.equal(verifyReceipt(bundle, {...f.expected, trust: oldTrust, engine}).decision, 'auto_approve');
  assert.throws(() => verifyReceipt(bundle, {...f.expected, trust: oldTrust, engine: {...engine, sha: second}}), /engine mismatch/);
  assert.throws(() => verifyReceipt(bundle, {...f.expected, trust: oldTrust, engine: {...engine, repository: 'attacker/reviewer'}}), /engine mismatch/);
});



test('immutable historical engine evidence is text, never an executed or selected engine', () => {
  assert.deepEqual(engineEvidence('.clouseau-ci/src/policy.cjs', second), {relative: 'src/policy.cjs', ref: second});
  assert.deepEqual(engineEvidence(`.clouseau-ci/src/policy.cjs@${first}`, second), {relative: 'src/policy.cjs', ref: first});
  for (const [filename, revision] of [['src/policy.cjs', second], ['.clouseau-ci/src/policy.cjs', null],
    ['.clouseau-ci/../outside', second], ['.clouseau-ci/src/policy.cjs@main', second]]) assert.throws(() => engineEvidence(filename, revision));
  assert.match(readEngineEvidence('.clouseau-ci/src/local-version.cjs', second), /function engineDigest/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-history-'));
  const git = args => cp.execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'}).trim();
  try {
    fs.mkdirSync(path.join(root, 'scripts')); fs.writeFileSync(path.join(root, 'scripts/bootstrap.cjs'), 'throw Error("old text must never execute");');
    git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'old bootstrap']);
    const old = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(root, 'scripts/bootstrap.cjs'), 'current source');
    git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'new engine']);
    const current = git(['rev-parse', 'HEAD']);
    assert.equal(readEngineEvidence('.clouseau-ci/scripts/bootstrap.cjs', current, root), 'current source');
    assert.equal(readEngineEvidence(`.clouseau-ci/scripts/bootstrap.cjs@${old}`, current, root), 'throw Error("old text must never execute");');
    assert.equal(git(['rev-parse', 'HEAD']), current);
    assert.throws(() => readEngineEvidence(`.clouseau-ci/scripts@${old}`, current, root), /must be a file/);
    for (const bytes of [Buffer.from([255]), Buffer.from('binary\0source'), Buffer.alloc(300001, 'x')]) {
      fs.writeFileSync(path.join(root, 'invalid'), bytes);
      assert.throws(() => readEngineEvidence('.clouseau-ci/invalid', current, root), /encoded data|Binary or oversized/);
    }
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('uncached historical source fetch is bounded to the fixed public repository and never falls back to current bytes', t => {
  const calls = []; let offline = false;
  t.mock.method(cp, 'execFileSync', (program, args, options) => {
    assert.equal(program, 'git'); calls.push(args);
    if (args.includes('-e')) throw new Error('Object absent');
    if (args.includes('fetch')) {
      assert.deepEqual(args, ['-C', '/fixture', 'fetch', '--quiet', '--no-write-fetch-head', '--no-tags', '--depth=1', 'https://github.com/gaulatti/clouseau.git', first]);
      assert.equal(options.timeout, 30000); if (offline) throw new Error('Public source unavailable'); return Buffer.alloc(0);
    }
    if (args.includes('-t')) return 'blob\n';
    assert.equal(args.at(-1), `${first}:scripts/resolve/action.yml`); return Buffer.from('actual immutable bootstrap');
  });
  assert.equal(readEngineEvidence(`.clouseau-ci/scripts/resolve/action.yml@${first}`, second, '/fixture'), 'actual immutable bootstrap');
  assert.equal(calls.filter(args => args.includes('fetch')).length, 1);
  offline = true;
  assert.throws(() => readEngineEvidence(`.clouseau-ci/scripts/resolve/action.yml@${first}`, second, '/fixture'), /Public source unavailable/);
});

test('changed resolver wiring gets at most eight immediate shared source files without removing any changed source', () => {
  const workflow = '.github/workflows/ci.yml';
  const snapshot = {files: [{path: 'README.md', head_source: 'readme'}, {path: '.github/workflows/removed.yml'}, {path: workflow, head_source: 'ci'}],
    sources: {ci: {content: `      - uses: gaulatti/clouseau/scripts/resolve@${first}\n        uses: 'gaulatti/clouseau/scripts/resolve@${first}'\n        uses: gaulatti/clouseau/scripts/resolve@${second}\n`}}};
  const before = structuredClone(snapshot); const paths = engineContext(snapshot);
  assert.equal(paths.length, 8); assert.equal(new Set(paths).size, 8);
  assert.ok(paths.includes(`.clouseau-ci/scripts/resolve/action.yml@${first}`));
  assert.ok(paths.includes('.clouseau-ci/src/acceptance-controller.cjs'));
  assert.deepEqual(snapshot, before);
  snapshot.sources.ci.content = `# uses: gaulatti/clouseau/scripts/resolve@${first}\n  uses: other/repo/scripts/resolve@${first}`;
  assert.deepEqual(engineContext(snapshot), []);
});
