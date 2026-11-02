'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('../test/local-review-fixture.cjs');
const {issueReceipt, verifyReceipt, validateTrust, reviewDecision, marker, loadReceipt, verifySources,
  screenReceipt, screenSources, attestable} = require('./local-receipt.cjs');
const {ChunkedRecordError} = require('./chunked-record.cjs');
const {digest} = require('./acceptance.cjs');
const {hostedFiles} = require('../test/hosted-files.cjs');
const crypto = require('node:crypto');

test('signed passing local receipt is verified and graded without a provider', async () => {
  const f = await fixture();
  const bundle = issueReceipt(f.issue);
  assert.equal(verifyReceipt(bundle, f.expected).decision, 'auto_approve');
  assert.equal(bundle.payload.record_digest, digest(f.record));
  assert.equal(new Set(f.result.usage.map(item => item.session)).size, 2);
  assert.equal(f.result.usage.every(item => item.session.startsWith('fictional-session-')), true);
  assert.equal(marker(`description\n<!-- clouseau-local-review:v1 ${'a'.repeat(40)} -->`), 'a'.repeat(40));
  assert.equal(marker(), null);
  assert.throws(() => marker(`<!-- clouseau-local-review:v1 ${'a'.repeat(40)} -->\n<!-- clouseau-local-review:v1 ${'b'.repeat(40)} -->`), /multiple/);
});

test('a complete signed receipt above the Contents inline limit loads from its exact immutable Git blob', async () => {
  const f = await fixture();
  for (const name of ['a', 'b', 'c']) f.snapshot.sources[`fixture-${name}`] = {
    path: `test/large-${name}.txt`, ref: f.snapshot.head_sha, authority: 'untrusted', kind: 'source',
    content: `Fictional immutable transport fixture ${name}: ${name.repeat(250000)}`,
  };
  require('./acceptance-sources.cjs').refresh(f.snapshot);
  f.record.result = await require('./local-review.cjs').localReview({...f, ask: f.ask});
  const bundle = issueReceipt(f.issue);
  const bytes = Buffer.from(JSON.stringify(bundle));
  assert.ok(bytes.length > 2000000 && bytes.length <= 3000000);
  const blobSha = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const metadata = {type: 'file', encoding: 'none', size: bytes.length, sha: blobSha};
  const blob = {encoding: 'base64', content: bytes.toString('base64'), size: bytes.length, sha: blobSha};
  const repo = {owner: 'fixture', repo: 'consumer'}; const ref = 'c'.repeat(40); let reads = 0;
  const github = {rest: {repos: {getContent: async args => {
    assert.deepEqual(args, {...repo, ref, path: 'clouseau-review.json'}); return {data: metadata};
  }}, git: {getBlob: async args => {
    reads++; assert.deepEqual(args, {...repo, file_sha: blobSha}); return {data: blob};
  }}}};
  const loaded = await loadReceipt({github, repo, ref});
  assert.deepEqual(loaded, bundle); assert.equal(reads, 1);
  assert.equal(verifyReceipt(loaded, f.expected).decision, 'auto_approve');
  const oversized = structuredClone(bundle); oversized.payload.record.extra = 'é'.repeat(1500001);
  assert.throws(() => verifyReceipt(oversized, f.expected), /malformed signature envelope/);
  loaded.signature = '!';
  assert.throws(() => verifyReceipt(loaded, f.expected), /envelope/);
});

test('unavailable, oversized, truncated and substituted receipt blobs fail closed within the bounded receipt limit', async () => {
  const bytes = Buffer.from('{"fixture_only":true}');
  const sha = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const validMetadata = {type: 'file', encoding: 'none', size: bytes.length, sha};
  const validBlob = {encoding: 'base64', content: bytes.toString('base64'), size: bytes.length, sha};
  let metadata; let blob; let reads = 0;
  const github = {rest: {repos: {getContent: async () => ({data: metadata})},
    git: {getBlob: async () => {reads++; return {data: blob};}}}};
  const options = {github, repo: {owner: 'fixture', repo: 'consumer'}, ref: 'c'.repeat(40)};
  for (const invalid of [{type: 'dir'}, {sha: 'main'}, {size: 0.5}, {size: -1}, {size: 3000001}]) {
    metadata = {...validMetadata, ...invalid}; reads = 0;
    await assert.rejects(loadReceipt(options), /artifact unavailable/); assert.equal(reads, 0);
  }
  metadata = validMetadata;
  for (const invalid of [{sha: 'd'.repeat(40)}, {size: bytes.length + 1}, {encoding: 'none'},
    {content: null}, {content: Buffer.from('short').toString('base64')},
    {content: Buffer.from('{"fixture_only":null}').toString('base64')}]) {
    blob = {...validBlob, ...invalid};
    await assert.rejects(loadReceipt(options), /receipt blob/);
  }
  github.rest.git.getBlob = async () => {throw new Error('GitHub blob unavailable');};
  await assert.rejects(loadReceipt(options), /GitHub blob unavailable/);
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
    baseSha: '0'.repeat(40), configDigest: '0'.repeat(64), policyDigest: '0'.repeat(64)})) {
    assert.throws(() => verifyReceipt(bundle, {...f.expected, [name]: value}), /changed/);
  }
  assert.throws(() => verifyReceipt(bundle, {...f.expected, reviewerSha: '0'.repeat(40)}), /engine mismatch/);
  assert.throws(() => verifyReceipt(bundle, {...f.expected, now: 9999000}), /future/);
  assert.throws(() => verifyReceipt(bundle, {...f.expected, author: 'unregistered-contributor'}), /PR author/);
  assert.throws(() => verifyReceipt(bundle, {...f.expected, now: 182800000}), /expired/);
  const revoked = structuredClone(f.trust); revoked.keys[0].revoked = true;
  assert.throws(() => verifyReceipt(bundle, {...f.expected, trust: revoked}), /signature/);
});

test('receipts default to a 48 hour life and the trust cap accepts exactly 172800 seconds', async () => {
  const f = await fixture();
  const bundle = issueReceipt(f.issue);
  assert.equal(bundle.payload.expires_at - bundle.payload.issued_at, 172800);
  assert.equal(verifyReceipt(bundle, {...f.expected, now: 10000000 + 172799000}).decision, 'auto_approve');
  assert.throws(() => verifyReceipt(bundle, {...f.expected, now: 10000000 + 172800000}), /expired/);
  assert.doesNotThrow(() => validateTrust({...f.trust, max_age_seconds: 172800}));
  assert.throws(() => validateTrust({...f.trust, max_age_seconds: 172801}), /receipt/);
  assert.equal(issueReceipt({...f.issue, lifetime: 172800}).payload.expires_at - 10000, 172800);
  assert.throws(() => issueReceipt({...f.issue, lifetime: 172801}), /lifetime/);
});

test('trust, decision and authority validation rejects forged passing flags', async () => {
  const f = await fixture();
  for (const trust of [null, {...f.trust, keys: []}, {...f.trust, max_age_seconds: 172801},
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
  const files = hostedFiles(f.snapshot);
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
  renamed.files[0].patch = `rename from ${files[0].filename}\nrename to ${files[0].filename}\n${renamed.files[0].patch}`;
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
  const link = structuredClone(f.snapshot); const linkIds = Object.keys(link.sources).filter(id => id.endsWith(':src/upload.test.js'));
  for (const id of linkIds) link.sources[id].content = '../elsewhere/node_modules';
  const linked = {...f.github, rest: {...f.github.rest, repos: {...f.github.rest.repos, getContent: async args => args.path === 'src/upload.test.js' ?
    {data: {type: 'symlink', target: '../elsewhere/node_modules', path: args.path}} : f.github.rest.repos.getContent(args)}}};
  await verifySources({...options, github: linked, snapshot: link});
  link.sources[linkIds[0]].content = '../fabricated';
  await assert.rejects(verifySources({...options, github: linked, snapshot: link}), /differs from/);
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
  assert.throws(() => verifyReceipt(reSign(p => {p.expires_at = p.issued_at + 172801;}), f.expected), /expired/);
  assert.throws(() => verifyReceipt(reSign(p => {p.nonce = 'weak';}), f.expected), /challenge/);
  assert.throws(() => verifyReceipt(reSign(p => {p.record.result.decision = 'owner_decision'; p.record_digest = digest(p.record);}), f.expected), /calculated/);
});

test('signed engine source requests are checked against accepted engine bytes and never promoted into repository authority', async () => {
  const f = await fixture();
  const snapshot = structuredClone(f.snapshot);
  const source = {path: '.clouseau-ci/src/config.cjs', ref: f.issue.reviewerSha, authority: 'untrusted', kind: 'source',
    content: require('node:fs').readFileSync(require('node:path').join(__dirname, 'config.cjs'), 'utf8')};
  snapshot.sources.engine = source;
  const files = hostedFiles(snapshot);
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

test('historical bootstrap evidence is verified from the fixed public repository without changing the accepted engine', async () => {
  const f = await fixture(); const snapshot = structuredClone(f.snapshot); const old = 'f'.repeat(40);
  const content = 'Historical bootstrap text, not executable review logic.';
  const source = {path: `.clouseau-ci/scripts/resolve/action.yml@${old}`, ref: old, authority: 'untrusted', kind: 'source', content};
  snapshot.sources.bootstrap = source;
  const original = f.github.rest.repos.getContent; let response = {encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content)};
  f.github.rest.repos.getContent = async args => {
    if (args.owner !== 'gaulatti') return original(args);
    assert.deepEqual(args, {owner: 'gaulatti', repo: 'clouseau', ref: old, path: 'scripts/resolve/action.yml'});
    return {data: response};
  };
  const options = {github: f.github, repo: f.repo, pr: {changed_files: 1, base: {sha: snapshot.base_sha}, head: {sha: snapshot.head_sha,
    repo: {owner: {login: f.repo.owner}, name: f.repo.repo}}}, snapshot, config: {readme: 'README.md', repository_policy: '.github/clouseau.md'},
    files: hostedFiles(snapshot), reviewerSha: f.issue.reviewerSha};
  await verifySources(options);
  assert.equal(options.reviewerSha, f.issue.reviewerSha);
  snapshot.sources.bootstrap = {...source, ref: 'd'.repeat(40)};
  await assert.rejects(verifySources(options), /invalid frozen engine/);
  snapshot.sources.bootstrap = {...source, content: 'substituted'};
  await assert.rejects(verifySources(options), /differs from the accepted engine/);
  snapshot.sources.bootstrap = source;
  response = {...response, size: 300001}; await assert.rejects(verifySources(options), /historical engine evidence unavailable/);
  response = {encoding: 'base64', content: Buffer.from('binary\0').toString('base64'), size: 7};
  await assert.rejects(verifySources(options), /binary historical engine/);
});

// ---- Derived lockfile evidence is recomputed by CI from the repository's own lockfile bytes (issue 65).

test('CI recomputes the derived lockfile summary from the exact base and head bytes; any substitution is rejected', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const {repository} = require('../test/local-git-fixture.cjs');
  const {git, collectLocal} = require('./local-git.cjs');
  const lockfixture = require('../test/fixtures/lockfiles.cjs');
  await repository(async f => {
    fs.writeFileSync(path.join(f.directory, 'package-lock.json'), lockfixture.npmHead());
    fs.rmSync(path.join(f.directory, 'go.sum'));
    fs.writeFileSync(path.join(f.directory, 'Pipfile.lock'), '{"_meta":{},"default":{"tool":{"version":"==1.0.0","hashes":["sha256:a"]}}}\n');
    git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'chore: dependencies']);
    const {snapshot} = collectLocal({...f, request: 'Update dependencies.', technical: {}});
    const live = {};
    const serve = async args => {
      const key = `${args.ref}:${args.path}`;
      if (live[key] !== undefined) return live[key];
      let text;
      try { text = git(f.directory, ['show', key]); } catch { throw Object.assign(new Error('Not Found'), {status: 404}); }
      return {data: {encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text)}};
    };
    const github = {rest: {repos: {getContent: serve}}};
    const repo = {owner: 'example', repo: 'local-fixture'};
    const pr = {changed_files: snapshot.files.length, base: {sha: snapshot.base_sha},
      head: {sha: snapshot.head_sha, repo: {owner: {login: 'example'}, name: 'local-fixture'}}};
    const files = require('../test/hosted-files.cjs').hostedFiles(snapshot).map(file => /(?:package-lock\.json|Pipfile\.lock|go\.sum)$/.test(file.filename) ? {...file, patch: undefined} : file);
    const options = {github, repo, pr, files, snapshot, config: {readme: 'README.md', repository_policy: 'AGENTS.md'}};
    await verifySources(options);
    const [id, source] = Object.entries(snapshot.sources).find(([, item]) => item.kind === 'lockfile-summary' && item.path === 'package-lock.json');
    const removedId = Object.entries(snapshot.sources).find(([, item]) => item.kind === 'lockfile-summary' && item.path === 'go.sum')[0];
    assert.ok(removedId);
    const mutate = change => { const copy = structuredClone(snapshot); change(copy, copy.sources[id]); return copy; };
    // A fabricated summary that hides a dependency swap is not the summary of the repository's bytes.
    await assert.rejects(verifySources({...options, snapshot: mutate((copy, item) => { item.content = item.content.replaceAll('RISK[', 'info['); })}), /differs from the repository lockfiles/);
    await assert.rejects(verifySources({...options, snapshot: mutate((copy, item) => { item.derived.head_sha256 = 'f'.repeat(64); })}), /differs from the repository lockfiles/);
    const retargeted = mutate((copy, item) => { item.authority = 'trusted'; });
    await assert.rejects(verifySources({...options, snapshot: retargeted}), /not bound to a changed lockfile/);
    await assert.rejects(verifySources({...options, snapshot: mutate((copy, item) => { item.path = 'src/handler.js'; })}), /not bound/);
    await assert.rejects(verifySources({...options, snapshot: mutate((copy, item) => { item.path = 'elsewhere/package-lock.json'; })}), /not bound/);
    await assert.rejects(verifySources({...options, snapshot: mutate(copy => { copy.files.find(file => file.path === 'package-lock.json').lockfile = false; })}), /not bound|incomplete/);
    // The live repository changed under the signed evidence.
    live[`${snapshot.head_sha}:package-lock.json`] = {data: {encoding: 'base64', content: Buffer.from(lockfixture.npmBase()).toString('base64'), size: 10}};
    await assert.rejects(verifySources(options), /differs from the repository lockfiles/);
    live[`${snapshot.head_sha}:package-lock.json`] = {data: {encoding: 'none', content: '', size: 2000000}};
    await assert.rejects(verifySources(options), /cannot be recomputed/);
    live[`${snapshot.head_sha}:package-lock.json`] = {data: {encoding: 'base64', content: Buffer.from('{broken').toString('base64'), size: 7}};
    await assert.rejects(verifySources(options), /cannot be recomputed/);
    live[`${snapshot.head_sha}:package-lock.json`] = undefined;
    const failing = {rest: {repos: {getContent: async args => { if (args.path === 'package-lock.json') throw Object.assign(new Error('upstream failure'), {status: 502}); return serve(args); }}}};
    await assert.rejects(verifySources({...options, github: failing}), /upstream failure/);
    // File-level binding: a lockfile item must reference exactly its own derived summary.
    const rebind = change => { const copy = structuredClone(snapshot); change(copy.files.find(file => file.path === 'package-lock.json'), copy); return copy; };
    await assert.rejects(verifySources({...options, snapshot: rebind(item => { item.head_source = 'unknown'; })}), /omitted or substituted/);
    await assert.rejects(verifySources({...options, snapshot: rebind(item => { item.head_source = Object.keys(snapshot.sources).find(key => key.endsWith(':README.md')); })}), /omitted or substituted/);
    await assert.rejects(verifySources({...options, snapshot: rebind(item => { delete item.base_source; })}), /omitted or substituted/);
    const removedFile = copy => copy.files.find(file => file.path === 'go.sum');
    const doubled = structuredClone(snapshot); removedFile(doubled).head_source = removedId;
    await assert.rejects(verifySources({...options, snapshot: doubled}), /omitted or substituted/);
    const addedFile = copy => copy.files.find(file => file.path === 'Pipfile.lock');
    assert.equal(addedFile(snapshot).status, 'added');
    const swapped = structuredClone(snapshot); addedFile(swapped).base_source = addedFile(swapped).head_source; delete addedFile(swapped).head_source;
    await assert.rejects(verifySources({...options, snapshot: swapped}), /omitted or substituted/);
    const gone = structuredClone(snapshot); removedFile(gone).base_source = 'unknown'; 
    await assert.rejects(verifySources({...options, snapshot: gone}), /omitted or substituted/);
    await assert.rejects(verifySources({...options, snapshot: rebind(item => { item.head_source = undefined; })}), /omitted or substituted/);
    await assert.rejects(verifySources({...options, snapshot: rebind(item => { item.path = 'src/handler.js'; })}), /omitted or substituted|inventory|status/);
    await assert.rejects(verifySources({...options, snapshot: rebind((item, copy) => { copy.files.find(file => file.path === 'src/handler.js').lockfile = true; })}), /omitted or substituted|not bound|receipt_patch_mismatch/);
  }, directory => {
    fs.writeFileSync(path.join(directory, 'package-lock.json'), lockfixture.npmBase());
    fs.writeFileSync(path.join(directory, 'go.sum'), 'example.com/mod v1.0.0 h1:abc=\n');
  });
});

test('screening classifies every receipt failure with a fixed class and propagates only failures that are not the receipt\'s', async () => {
  const f = await fixture();
  const bundle = issueReceipt({...f.issue, now: Date.now()});
  const ref = 'c'.repeat(40);
  const pr = {body: `<!-- clouseau-local-review:v1 ${ref} -->`, user: {login: f.expected.author},
    head: {sha: f.expected.headSha}, base: {sha: f.expected.baseSha}};
  const repo = {owner: 'example', repo: f.expected.repository.split('/')[1]};
  const github = served => ({rest: {repos: {getContent: async () => served()}}});
  const content = value => () => ({data: {encoding: 'base64', size: 10, content: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64')}});
  const options = {repo, engine: null, trust: f.expected.trust, configDigest: f.expected.configDigest, policyDigest: f.expected.policyDigest};
  const screen = (served, change = {}) => screenReceipt({github: github(served), pr: {...pr, ...change}, ...options,
    repo: {owner: f.expected.repository.split('/')[0], repo: f.expected.repository.split('/')[1]}});
  const accepted = await screen(content(bundle));
  assert.equal(accepted.ref, ref); assert.equal(accepted.rejected, null); assert.equal(accepted.verified.decision, 'auto_approve');
  assert.deepEqual(await screen(content(bundle), {body: 'no claim'}), {ref: null, rejected: null});
  assert.deepEqual(await screen(content(bundle), {body: `<!-- clouseau-local-review:v1 ${ref} -->\n<!-- clouseau-local-review:v1 ${'d'.repeat(40)} -->`}), {ref: null, rejected: 'malformed'});
  assert.deepEqual(await screen(content('not json')), {ref: null, rejected: 'malformed'});
  assert.deepEqual(await screen(content({unexpected: true})), {ref: null, rejected: 'malformed'});
  assert.deepEqual(await screen(content(bundle), {user: {login: 'someone-else'}}), {ref: null, rejected: 'author'});
  // A bundle that is not even an object cannot be verified; the receipt is ignored, not a crash.
  assert.deepEqual(await screen(content(null)), {ref: null, rejected: 'malformed'});
  assert.deepEqual(await screen(() => {throw Object.assign(new Error('Not Found'), {status: 404});}), {ref: null, rejected: 'unavailable'});
  assert.deepEqual(await screen(() => ({data: {encoding: 'none', type: 'dir'}})), {ref: null, rejected: 'unavailable'});
  for (const status of [500, 403, 429]) {
    await assert.rejects(screen(() => {throw Object.assign(new Error('GitHub failed'), {status});}), error => error.status === status);
  }
  assert.deepEqual(await screen(content(bundle), {head: {sha: 'd'.repeat(40)}}), {ref: null, rejected: 'revision'});
  // An invalid protected chunked configuration cannot check any receipt, so the receipt is ignored, never a crash.
  const badSettings = await screenReceipt({github: github(content(bundle)), pr, ...options, trust: {...options.trust, chunked: {unknown: 1}},
    repo: {owner: f.expected.repository.split('/')[0], repo: f.expected.repository.split('/')[1]}});
  assert.deepEqual(badSettings, {ref: null, rejected: 'settings'});
  // A chunked record that does not verify is the receipt's own failure too.
  const chunked = structuredClone(f.record); chunked.partition = {scheme: 'unknown'};
  const payload = {...bundle.payload, record: chunked, record_digest: digest(chunked)};
  const signed = {payload, signature: crypto.sign(null, Buffer.from(`clouseau.local-review.v1\0${digest(payload)}`),
    crypto.createPrivateKey(f.privateKey)).toString('base64url')};
  assert.deepEqual(await screen(content(signed)), {ref: null, rejected: 'record'});
  // A signed payload whose record is not an object throws inside the verifier itself; that is still only an ignored receipt.
  const hollow = {...bundle.payload, record: null, record_digest: digest(null)};
  const hollowSigned = {payload: hollow, signature: crypto.sign(null, Buffer.from(`clouseau.local-review.v1\0${digest(hollow)}`),
    crypto.createPrivateKey(f.privateKey)).toString('base64url')};
  assert.deepEqual(await screen(content(hollowSigned)), {ref: null, rejected: 'malformed'});
});

test('source screening ignores a receipt whose signed sources, diff or inventory differ and propagates every other failure', async () => {
  const f = await fixture();
  const files = hostedFiles(f.snapshot);
  const pr = {changed_files: 1, base: {sha: f.snapshot.base_sha}, head: {sha: f.snapshot.head_sha,
    repo: {owner: {login: f.repo.owner}, name: f.repo.repo}}};
  const options = {github: f.github, repo: f.repo, pr, files, snapshot: f.snapshot,
    config: {readme: 'README.md', repository_policy: '.github/clouseau.md'}};
  assert.equal(await screenSources(options), null);
  assert.equal(await screenSources({...options, files: []}), 'source');
  assert.equal(await screenSources({...options, files: files.map(file => ({...file, patch: `${file.patch}\n+tampered`}))}), 'source');
  const tickets = structuredClone(f.snapshot); tickets.tickets = [{}];
  assert.equal(await screenSources({...options, snapshot: tickets}), 'record');
  const missing = {rest: {repos: {getContent: async () => {throw Object.assign(new Error('Not Found'), {status: 404});}}}};
  assert.equal(await screenSources({...options, github: missing}), 'source');
  const outage = {rest: {repos: {getContent: async () => {throw Object.assign(new Error('Server Error'), {status: 502});}}}};
  await assert.rejects(screenSources({...options, github: outage}), error => error.status === 502);
  await assert.rejects(screenSources({...options, files: files.map(({patch, ...file}) => file)}), /Changed-file evidence is incomplete/);
});

test('a receipt may carry a signed review-semantics claim; a different engine is accepted only when the running engine vouches for it', async () => {
  const {SOURCE} = require('./central-version.cjs');
  const f = await fixture();
  const claim = 'c'.repeat(64);
  const bundle = issueReceipt({...f.issue, reviewerSemantics: claim});
  assert.equal(bundle.payload.reviewer_semantics, claim);
  assert.equal(Object.hasOwn(issueReceipt(f.issue).payload, 'reviewer_semantics'), false);
  assert.throws(() => issueReceipt({...f.issue, reviewerSemantics: 'abc'}), /invalid runner/);
  // The same engine still verifies exactly as before, with or without the claim and with or without a hook.
  assert.equal(verifyReceipt(bundle, f.expected).decision, 'auto_approve');
  // A malformed claim is a malformed receipt (resigned so only the field is wrong).
  const forge = payload => {
    const key = crypto.createPrivateKey(f.issue.privateKey);
    return {payload, signature: crypto.sign(null, Buffer.from(`clouseau.local-review.v1\0${digest(payload)}`), key).toString('base64url')};
  };
  assert.throws(() => verifyReceipt(forge({...bundle.payload, reviewer_semantics: 'abc'}), f.expected), /unknown receipt type or fields/);

  // Engine Y is a different protected revision than the one that issued the receipt.
  const trust = {...f.trust, central_source: {...SOURCE}};
  delete trust.reviewer_digest;
  const other = {...SOURCE, sha: 'd'.repeat(40), digest: 'e'.repeat(64)};
  const options = {...f.expected, trust, engine: other, reviewerSha: undefined, reviewerDigest: other.digest};
  const seen = [];
  const vouch = answer => value => {seen.push(value); return answer;};
  const refused = (b, o) => assert.throws(() => verifyReceipt(b, o), error => error.reason === 'engine' && /engine mismatch/.test(error.message));
  assert.equal(verifyReceipt(bundle, {...options, compatible: vouch(true)}).decision, 'auto_approve');
  assert.deepEqual(seen, [claim]);
  // Every doubt keeps today's refusal.
  refused(bundle, options);
  refused(bundle, {...options, compatible: null});
  refused(bundle, {...options, compatible: vouch(false)});
  refused(bundle, {...options, compatible: vouch('yes')});
  refused(bundle, {...options, compatible: vouch(true), reviewerSha: 'f'.repeat(40)});
  refused(bundle, {...options, compatible: vouch(true), reviewerDigest: 'f'.repeat(64)});
  refused(bundle, {...options, compatible: vouch(true), engine: null});
  refused(bundle, {...options, compatible: vouch(true), engine: {...other, repository: 'other/repo'}});
  refused(bundle, {...options, compatible: vouch(true), trust: f.trust});
  refused(issueReceipt(f.issue), {...options, compatible: vouch(true)});
  refused(bundle, {...options, compatible: vouch(true), engine: {...other, digest: 'invalid'}});
  refused(forge({...bundle.payload, reviewer_digest: 'abc'}), {...options, compatible: vouch(true)});
  assert.equal(verifyReceipt(bundle, {...options, compatible: vouch(true), reviewerSha: f.issue.reviewerSha}).decision, 'auto_approve');
  // A different engine never excuses any other check.
  assert.throws(() => verifyReceipt(bundle, {...options, compatible: vouch(true), headSha: '0'.repeat(40)}), /changed/);
  assert.throws(() => verifyReceipt(bundle, {...options, compatible: vouch(true), author: 'unregistered-contributor'}), /PR author/);
});

test('by default the running protected engine statement decides whether a receipt of another revision is accepted', async () => {
  const {SOURCE} = require('./central-version.cjs');
  const semantics = require('./review-semantics.cjs');
  const f = await fixture();
  const trust = {...f.trust, central_source: {...SOURCE}};
  delete trust.reviewer_digest;
  const other = {...SOURCE, sha: 'd'.repeat(40), digest: 'e'.repeat(64)};
  const options = {...f.expected, trust, engine: other, reviewerSha: undefined, reviewerDigest: other.digest};
  const statement = semantics.readStatement();
  const earlier = statement.compatible[0] ?? 'a'.repeat(64);
  const issue = reviewerSemantics => issueReceipt({...f.issue, reviewerSemantics});
  // Semantics of this very engine: accepted although the revision and exact digest differ.
  assert.equal(verifyReceipt(issue(semantics.semanticsDigest()), options).decision, 'auto_approve');
  // Semantics the statement lists are accepted; unlisted or absent claims are ignored as before.
  if (statement.compatible.length) assert.equal(verifyReceipt(issue(earlier), options).decision, 'auto_approve');
  assert.throws(() => verifyReceipt(issue('0'.repeat(64)), options), /engine mismatch/);
  assert.throws(() => verifyReceipt(issueReceipt(f.issue), options), /engine mismatch/);
  // Fixed-digest trust never takes this path.
  assert.throws(() => verifyReceipt(issue(semantics.semanticsDigest()), {...options, trust: f.trust}), /engine mismatch/);
});

test('maintainer attestation configuration is protected, explicit and default off', async () => {
  const f = await fixture();
  const {validateConfig} = require('./config.cjs');
  const withAttest = attest => ({...f.trust, attest});
  for (const attest of [{authors: ['dependabot[bot]', 'a-contributor']}, {authors: 'any'}, {authors: ['x']}]) assert.doesNotThrow(() => validateTrust(withAttest(attest)));
  assert.doesNotThrow(() => validateTrust(f.trust), 'unset stays valid and unchanged');
  // An empty allowlist, a missing or wrongly spelled "any", wildcards, duplicates, bad logins and extra fields are all invalid.
  for (const attest of [null, 'any', true, {}, {authors: []}, {authors: 'ANY'}, {authors: '*'}, {authors: ['*']}, {authors: ['']}, {authors: [7]},
    {authors: ['a', 'a']}, {authors: ['bad/login']}, {authors: ['bot[bot]x']}, {authors: ['-leading']}, {authors: 'any', extra: true}, {authors: {a: 1}}]) {
    assert.throws(() => validateTrust(withAttest(attest)), /maintainer attestation/, JSON.stringify(attest));
  }
  assert.equal(attestable(withAttest({authors: ['dependabot[bot]']}), 'dependabot[bot]'), true);
  assert.equal(attestable(withAttest({authors: ['dependabot[bot]']}), 'Dependabot[bot]'), false, 'matching is exact');
  assert.equal(attestable(withAttest({authors: 'any'}), 'anyone'), true);
  assert.equal(attestable(f.trust, 'dependabot[bot]'), false);
  const base = {version: 2, base_branch: 'main', workflow: 'ci.yml', verification: {job: 'verify', steps: ['Enforce 100% line and branch coverage']},
    manual_reviewer: 'owner', repository_policy: 'AGENTS.md', readme: 'README.md', sensitive_paths: [], deployment: null,
    acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash', repair_attempts: 2}};
  assert.deepEqual(validateConfig({...base, local_review: withAttest({authors: ['dependabot[bot]']})}).local_review.attest, {authors: ['dependabot[bot]']});
  assert.throws(() => validateConfig({...base, local_review: withAttest({authors: []})}), /maintainer attestation/);
});

test('an attested receipt binds signer, author and pull request and is refused everywhere the opt-in or any binding is missing', async () => {
  const f = await fixture();
  const signed = {author: 'dependabot[bot]', number: 12, signer: 'fixture-author'};
  const trust = {...f.trust, attest: {authors: ['dependabot[bot]']}};
  const expected = {...f.expected, trust, author: 'dependabot[bot]', pullNumber: 12};
  const bundle = issueReceipt({...f.issue, attestation: signed});
  const verified = verifyReceipt(bundle, expected);
  assert.deepEqual(verified.attestation, signed); assert.equal(verified.decision, 'auto_approve');
  assert.equal(verifyReceipt(issueReceipt(f.issue), f.expected).attestation, null, 'an ordinary receipt is unchanged');
  // The receipt does not authorize anything beyond an ordinary one.
  const authority = structuredClone(f.record); authority.controls = true;
  assert.throws(() => verifyReceipt(issueReceipt({...f.issue, record: authority, attestation: signed}), expected), /owner authority/);
  const attacks = {
    'no opt-in': {trust: f.trust}, 'allowlist names another author': {trust: {...f.trust, attest: {authors: ['someone-else']}}},
    'replayed for another author': {author: 'other-contributor', trust: {...f.trust, attest: {authors: 'any'}}},
    'replayed for another pull request': {pullNumber: 13}, 'no pull request number supplied': {pullNumber: undefined},
  };
  for (const [name, change] of Object.entries(attacks)) {
    assert.throws(() => verifyReceipt(bundle, {...expected, ...change}), error => error.reason === 'attestation', name);
  }
  // Forged or malformed claims: signer that is not the key's enrolled login, and claims that are not exactly the three fields.
  const resign = payload => ({payload, signature: crypto.sign(null, Buffer.from(`clouseau.local-review.v1\0${digest(payload)}`),
    crypto.createPrivateKey(f.privateKey)).toString('base64url')});
  for (const claim of [{...signed, signer: 'someone-else'}, {...signed, number: '12'}, {...signed, extra: 1}, {author: signed.author, number: 12},
    null, 'dependabot[bot]', [], {...signed, number: 0}]) {
    assert.throws(() => verifyReceipt(resign({...bundle.payload, attestation: claim}), expected), error => error.reason === 'attestation', JSON.stringify(claim));
  }
  // A claim added to a signed ordinary receipt breaks its signature, and an unenrolled key is never trusted.
  const injected = structuredClone(issueReceipt(f.issue)); injected.payload.attestation = signed;
  assert.throws(() => verifyReceipt(injected, expected), error => error.reason === 'signature');
  const outsider = crypto.generateKeyPairSync('ed25519').privateKey.export({type: 'pkcs8', format: 'pem'});
  assert.throws(() => verifyReceipt(issueReceipt({...f.issue, privateKey: outsider, attestation: signed}), expected), error => error.reason === 'signature');
  // A revoked maintainer key stops attesting too.
  const revoked = structuredClone(trust); revoked.keys[0].revoked = true;
  assert.throws(() => verifyReceipt(bundle, {...expected, trust: revoked}), error => error.reason === 'signature');
  // The signer may not claim another login than its enrolled one, and issuance validates the claim's shape.
  for (const attestation of [null, {...signed, number: 0}, {...signed, number: 1.5}, {...signed, author: 'bad/author'}, {...signed, signer: 'bad/signer'},
    {...signed, extra: 1}, {author: 'a', number: 1}]) assert.throws(() => issueReceipt({...f.issue, attestation}), /invalid maintainer attestation/);
  // Screening classifies a refusal with the fixed class and the screened pull request carries its number.
  const ref = 'c'.repeat(40);
  const pr = {body: `<!-- clouseau-local-review:v1 ${ref} -->`, user: {login: 'dependabot[bot]'}, number: 12, head: {sha: f.expected.headSha}, base: {sha: f.expected.baseSha}};
  const [owner, name] = f.expected.repository.split('/');
  const served = {rest: {repos: {getContent: async () => ({data: {encoding: 'base64', size: 10, content: Buffer.from(JSON.stringify(issueReceipt({...f.issue, now: Date.now(), attestation: signed}))).toString('base64')}})}}};
  const screen = change => screenReceipt({github: served, pr: {...pr, ...change}, repo: {owner, repo: name}, engine: null,
    trust, configDigest: f.expected.configDigest, policyDigest: f.expected.policyDigest});
  const accepted = await screen({});
  assert.equal(accepted.ref, ref); assert.deepEqual(accepted.verified.attestation, signed);
  assert.deepEqual(await screen({number: 13}), {ref: null, rejected: 'attestation'});
  assert.deepEqual(await screen({user: {login: 'other-contributor'}}), {ref: null, rejected: 'attestation'});
});
