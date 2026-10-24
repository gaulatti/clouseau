'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('../test/local-review-fixture.cjs');
const {issueReceipt, verifyReceipt, validateTrust, reviewDecision, marker, loadReceipt, verifySources} = require('./local-receipt.cjs');
const {digest} = require('./acceptance.cjs');
const crypto = require('node:crypto');

test('signed passing local receipt is verified and graded without a provider', async () => {
  const f = await fixture();
  const bundle = issueReceipt(f.issue);
  assert.equal(verifyReceipt(bundle, f.expected).decision, 'auto_approve');
  assert.equal(bundle.payload.record_digest, digest(f.record));
  assert.equal(new Set(f.result.usage.map(item => item.session)).size, 4);
  assert.equal(f.result.usage.every(item => item.session.startsWith('fictional-session-')), true);
  assert.equal(marker(`description\n<!-- clouseau-local-review:v1 ${'a'.repeat(40)} -->`), 'a'.repeat(40));
  assert.equal(marker(), null);
  assert.throws(() => marker(`<!-- clouseau-local-review:v1 ${'a'.repeat(40)} -->\n<!-- clouseau-local-review:v1 ${'b'.repeat(40)} -->`), /multiple/);
});

test('any local receipt claim must be one complete supported immutable marker', () => {
  const valid = `<!-- clouseau-local-review:v1 ${'a'.repeat(40)} -->`;
  const unknown = `<!-- clouseau-local-review:v2 ${'b'.repeat(40)} -->`;
  for (const body of ['clouseau-local-review:', `<!-- clouseau-local-review:v1 invalid -->`, unknown,
    `<!-- clouseau-local-review:v1 ${'a'.repeat(39)} -->`, valid.slice(0, -3), `${valid}\n${unknown}`]) {
    assert.throws(() => marker(body), /receipt|marker|claim/i);
  }
  assert.throws(() => marker(`${valid}\n${valid}`), /multiple receipt/);
  assert.throws(() => marker(`<!-- clouseau-installation-review:v2 invalid -->\n${valid}`), /installation-only/);
  assert.equal(marker('Ordinary PR with no receipt claim.'), null);
  assert.equal(marker(`Ready application change.\n${valid}`), 'a'.repeat(40));
});

test('tampered report, signature, key, repository, revision and policy never authorize reuse', async () => {
  const f = await fixture();
  const bundle = issueReceipt(f.issue);
  const altered = structuredClone(bundle); altered.payload.record.result.decision = 'owner_decision';
  assert.throws(() => verifyReceipt(altered, f.expected), /signature/);
  const signature = {...bundle, signature: '!'};
  assert.throws(() => verifyReceipt(signature, f.expected), /envelope/);
  assert.throws(() => verifyReceipt({...bundle, extra: true}, f.expected), /envelope/);
  const unknown = structuredClone(bundle); unknown.payload.key_id = 'other';
  assert.throws(() => verifyReceipt(unknown, f.expected), /signature/);
  for (const [name, value] of Object.entries({repository: 'example/other', headSha: '0'.repeat(40),
    baseSha: '0'.repeat(40), reviewerSha: '0'.repeat(40), configDigest: '0'.repeat(64), policyDigest: '0'.repeat(64)})) {
    assert.throws(() => verifyReceipt(bundle, {...f.expected, [name]: value}), /changed/);
  }
  assert.throws(() => verifyReceipt(bundle, {...f.expected, now: 9999000}), /future/);
  assert.throws(() => verifyReceipt(bundle, {...f.expected, author: 'unregistered-contributor'}), /PR author/);
  assert.throws(() => verifyReceipt(bundle, {...f.expected, now: 13600000}), /expired/);
  const revoked = structuredClone(f.trust); revoked.keys[0].revoked = true;
  assert.throws(() => verifyReceipt(bundle, {...f.expected, trust: revoked}), /signature/);
});

test('trust, decision and authority validation rejects forged passing flags', async () => {
  const f = await fixture();
  for (const trust of [null, {...f.trust, keys: []}, {...f.trust, max_age_seconds: 86401},
    {...f.trust, keys: [f.trust.keys[0], f.trust.keys[0]]}]) assert.throws(() => validateTrust(trust), /receipt/);
  const bad = structuredClone(f.record); bad.snapshot.claims.title = 'altered';
  assert.throws(() => reviewDecision(bad), /snapshot/);
  const negative = structuredClone(f.record); negative.result.reviews[0].report.gates[0].state = 'violated';
  assert.throws(() => issueReceipt({...f.issue, record: negative}), /calculated/);
  negative.result.decision = require('./acceptance.cjs').scoreReport(negative.result.reviews[0].report).decision;
  assert.throws(() => issueReceipt({...f.issue, record: negative}), /passing/);
  assert.throws(() => issueReceipt({...f.issue, nonce: 'weak'}), /challenge/);
  const authority = structuredClone(f.record); authority.controls = true;
  const signed = issueReceipt({...f.issue, record: authority});
  assert.throws(() => verifyReceipt(signed, f.expected), /owner authority/);
});

test('CI independently compares all signed sources and inventory against immutable GitHub content', async () => {
  const f = await fixture();
  const files = [{filename: 'src/upload.test.js', status: 'modified'}];
  const pr = {changed_files: 1, base: {sha: f.snapshot.base_sha}, head: {sha: f.snapshot.head_sha,
    repo: {owner: {login: f.repo.owner}, name: f.repo.repo}}};
  const options = {github: f.github, repo: f.repo, pr, files, snapshot: f.snapshot,
    config: {readme: 'README.md', repository_policy: '.github/clouseau.md'}};
  await verifySources(options);
  await assert.rejects(verifySources({...options, files: []}), /inventory/);
  const altered = structuredClone(f.snapshot); altered.sources[Object.keys(altered.sources).find(id => id.endsWith(':src/upload.test.js'))].content = 'fabricated';
  await assert.rejects(verifySources({...options, snapshot: altered}), /differs from/);
  const substituted = structuredClone(f.snapshot); substituted.files[0].head_source = substituted.files[0].base_source;
  await assert.rejects(verifySources({...options, snapshot: substituted}), /substituted/);
  const promoted = structuredClone(f.snapshot); promoted.sources.verification.kind = 'contract';
  await assert.rejects(verifySources({...options, snapshot: promoted}), /execution/);
  const ref = 'c'.repeat(40);
  const artifact = {payload: 'fictional-test'};
  const github = {rest: {repos: {getContent: async () => ({data: {encoding: 'base64', size: 24,
    content: Buffer.from(JSON.stringify(artifact)).toString('base64')}})}}};
  assert.deepEqual(await loadReceipt({github, repo: f.repo, ref}), artifact);
  await assert.rejects(loadReceipt({github, repo: f.repo, ref: 'main'}), /immutable/);
  github.rest.repos.getContent = async () => ({data: {encoding: 'none'}});
  await assert.rejects(loadReceipt({github, repo: f.repo, ref}), /unavailable/);
  const request = structuredClone(f.snapshot);
  request.sources['local-request'] = {path: 'local-request', kind: 'requirement', authority: 'untrusted',
    content: 'Protect the input boundary.', ref: digest('Protect the input boundary.')};
  await verifySources({...options, snapshot: request});
  request.sources['local-request'].authority = 'trusted';
  await assert.rejects(verifySources({...options, snapshot: request}), /untrusted/);
  const renamed = structuredClone(f.snapshot);
  renamed.files[0].status = 'renamed';
  await verifySources({...options, snapshot: renamed, files: [{...files[0], status: 'renamed', previous_filename: files[0].filename}]});
  for (const status of ['added', 'removed']) {
    const changed = structuredClone(f.snapshot); changed.files[0].status = status;
    await verifySources({...options, snapshot: changed, files: [{...files[0], status}]});
  }
  const foreign = structuredClone(f.snapshot); foreign.sources['untrusted-extra'] =
    {path: 'src/other.js', ref: 'f'.repeat(40), authority: 'untrusted', kind: 'source', content: ''};
  await assert.rejects(verifySources({...options, snapshot: foreign}), /outside exact/);
  const contracts = structuredClone(f.snapshot);
  delete contracts.sources[Object.keys(contracts.sources).find(id => id.endsWith(':README.md'))];
  await assert.rejects(verifySources({...options, snapshot: contracts}), /purpose evidence/);
  const promotedSource = structuredClone(f.snapshot);
  promotedSource.sources[Object.keys(promotedSource.sources).find(id => id.endsWith(':src/upload.test.js'))].authority = 'trusted';
  await assert.rejects(verifySources({...options, snapshot: promotedSource}), /promoted/);
});

test('even a trusted signer cannot submit incomplete execution, altered review binding or a non-Ed25519 key', async () => {
  const f = await fixture();
  const rsa = crypto.generateKeyPairSync('rsa', {modulusLength: 1024});
  assert.throws(() => validateTrust({...f.trust, keys: [{...f.trust.keys[0],
    public_key: rsa.publicKey.export({type: 'spki', format: 'pem'})}]}), /Ed25519/);
  assert.throws(() => issueReceipt({...f.issue, privateKey: rsa.privateKey.export({type: 'pkcs8', format: 'pem'})}), /Ed25519/);
  for (const mutate of [r => {r.result.config_digest = 'bad';}, r => {r.result.usage = [];},
    r => {r.result.usage[0].session = r.result.usage[1].session;}, r => {r.result.reviews = [];},
    r => {r.snapshot.prior_findings = [{id: 'invented'}]; require('./acceptance-sources.cjs').refresh(r.snapshot); r.result.snapshot = r.snapshot.digest;}]) {
    const record = structuredClone(f.record); mutate(record);
    assert.throws(() => reviewDecision(record), /evidence|execution|roles|history/);
  }
  const bundle = issueReceipt(f.issue);
  bundle.payload.type = 'unknown';
  assert.throws(() => verifyReceipt(bundle, f.expected), /unknown/);
  const reSign = mutate => {
    const copy = issueReceipt(f.issue); mutate(copy.payload);
    copy.signature = crypto.sign(null, Buffer.from(`clouseau.local-review.v1\0${digest(copy.payload)}`), f.privateKey).toString('base64url');
    return copy;
  };
  assert.throws(() => verifyReceipt(reSign(p => {p.expires_at = p.issued_at + 3601;}), f.expected), /expired/);
  assert.throws(() => verifyReceipt(reSign(p => {p.nonce = 'weak';}), f.expected), /challenge/);
  assert.throws(() => verifyReceipt(reSign(p => {p.record.result.decision = 'owner_decision'; p.record_digest = digest(p.record);}), f.expected), /calculated/);
});

test('signed engine source requests are checked against accepted engine bytes and never promoted into repository authority', async () => {
  const f = await fixture();
  const snapshot = structuredClone(f.snapshot);
  const source = {path: '.clouseau-ci/src/config.cjs', ref: f.issue.reviewerSha, authority: 'untrusted', kind: 'source',
    content: require('node:fs').readFileSync(require('node:path').join(__dirname, 'config.cjs'), 'utf8')};
  snapshot.sources.engine = source;
  const files = [{filename: 'src/upload.test.js', status: 'modified'}];
  const options = {github: f.github, repo: f.repo, pr: {changed_files: 1, base: {sha: snapshot.base_sha}, head: {sha: snapshot.head_sha,
    repo: {owner: {login: f.repo.owner}, name: f.repo.repo}}}, snapshot, config: {readme: 'README.md', repository_policy: '.github/clouseau.md'},
    files, reviewerSha: f.issue.reviewerSha};
  await verifySources(options);
  for (const changed of [{ref: 'f'.repeat(40)}, {path: '.clouseau-ci/../outside'}, {authority: 'trusted'}, {kind: 'contract'}]) {
    snapshot.sources.engine = {...source, ...changed};
    await assert.rejects(verifySources(options), /invalid frozen engine/);
  }
  snapshot.sources.engine = {...source, content: 'substituted'};
  await assert.rejects(verifySources(options), /differs from the accepted engine/);
  snapshot.sources.engine = source;
  await assert.rejects(verifySources({...options, reviewerSha: undefined}), /invalid frozen engine/);
});
