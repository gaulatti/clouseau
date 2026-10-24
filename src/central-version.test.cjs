'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {SOURCE, centralSource, resolveCentral, identifyEngine, verifyEngine, environmentEngine, acceptsEngine} = require('./central-version.cjs');
const {engineDigest} = require('./local-version.cjs');
const {fixture} = require('../test/local-review-fixture.cjs');
const {issueReceipt, verifyReceipt, validateTrust} = require('./local-receipt.cjs');
const {createPolicy} = require('./policy.cjs');
const {verifyRecord} = require('./acceptance-controller.cjs');
const {digest} = require('./acceptance.cjs');

const first = 'a'.repeat(40);
const second = 'b'.repeat(40);
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
    const engine = identifyEngine(output, root);
    assert.equal(engine.sha, first);
    assert.equal(engine.digest, engineDigest(root));
    for (const stage of ['receipt', 'assessment', 'score', 'gate', 'merge']) {
      assert.equal(verifyEngine(engine, root).sha, first, stage);
    }
    assert.equal(calls, 1);
    assert.equal(await resolveCentral(github), second);
    assert.throws(() => identifyEngine('main', root), /immutable/);
    for (const changed of [null, {...engine, repository: 'attacker/clouseau'}, {...engine, ref: 'refs/heads/proposal'},
      {...engine, sha: 'main'}, {...engine, digest: 'bad'}]) {
      assert.throws(() => verifyEngine(changed, root), /differs/);
    }
    fs.writeFileSync(path.join(root, 'src/injected.cjs'), 'substituted source');
    assert.throws(() => verifyEngine(engine, root), /differs/);
    cp.execFileSync('git', ['init', '-q', root]);
    cp.execFileSync('git', ['-C', root, 'add', '.']);
    cp.execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    assert.throws(() => identifyEngine(first, root), /source differs/);
    const actual = cp.execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    assert.equal(verifyEngine(identifyEngine(actual, root), root).sha, actual);
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
