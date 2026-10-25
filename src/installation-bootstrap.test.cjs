'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {fixture} = require('../test/bootstrap-fixture.cjs');
const {git, collectLocal} = require('./local-git.cjs');
const {digest} = require('./acceptance.cjs');
const {initializeIdentity} = require('./local-cli.cjs');
const {verifyReceipt, verifySignedRecord, marker, verifySources, DOMAIN} = require('./local-receipt.cjs');
const bootstrap = require('./installation-bootstrap.cjs');

test('first-install manifest freezes real committed controls without pretending proposed policy is accepted base', () => fixture(f => {
  assert.equal(git(f.directory, ['ls-tree', f.base, '--', '.clouseau-local.json', '.github/clouseau.json']), '');
  assert.deepEqual(bootstrap.prepareManifest({directory: f.directory, request: f.request, enrollment: f.enrolled.public_identity, reviewer: f.reviewer, now: f.now}), f.manifest);
  assert.deepEqual(f.manifest.files.map(file => file.path), ['.clouseau-local.json', '.github/CODEOWNERS', '.github/clouseau.json', '.github/clouseau.md', '.github/workflows/ci.yml', '.github/workflows/metadata.yaml', 'AGENTS.md', 'CLAUDE.md', 'CODEOWNERS', 'README.md', 'docs/CODEOWNERS']);
  for (const file of f.manifest.files) assert.equal(file.sha256, crypto.createHash('sha256').update(git(f.directory, ['show', `${f.head}:${file.path}`])).digest('hex'));
  assert.equal(f.manifest.identity.github_actor, 'fixture-owner');
  assert.ok(!JSON.stringify(f.manifest).includes('PRIVATE KEY'));
  assert.equal(f.manifest.request, f.request);
  bootstrap.assertManifestLocal(f.directory, f.manifest, f.reviewer, f.now);
}));

test('central-source installation configuration freezes one released engine without creating ordinary approval authority', () => fixture(async f => {
  assert.deepEqual(f.config.local_review.central_source, {repository: 'gaulatti/clouseau', ref: 'refs/heads/main'});
  assert.equal(f.config.local_review.reviewer_digest, undefined);
  assert.equal(f.manifest.reviewer_sha, f.reviewer.sha);
  assert.equal(f.manifest.reviewer_digest, f.reviewer.digest);
  assert.equal(f.manifest.config_digest, digest(f.config));
  bootstrap.assertManifestLocal(f.directory, f.manifest, f.reviewer, f.now);
  for (const central_source of [{repository: 'attacker/clouseau', ref: 'refs/heads/main'},
    {repository: 'gaulatti/clouseau', ref: 'refs/heads/feature'}, {...f.config.local_review.central_source, extra: true}]) {
    assert.throws(() => bootstrap.bindConfiguration(f.local,
      {...f.config, local_review: {...f.config.local_review, central_source}}, f.manifest.identity, f.reviewer.digest), /frozen engine must agree/);
  }
  const record = await f.record(); const bundle = f.sign(record);
  assert.equal((await bootstrap.verifyInstallationReceipt(bundle, f.options())).decision, 'auto_approve');
  for (const changed of [{reviewerSha: 'f'.repeat(40)}, {reviewerDigest: '0'.repeat(64)}]) {
    await assert.rejects(bootstrap.verifyInstallationReceipt(bundle, {...f.options(), ...changed}), /frozen shared engine/);
  }
  const engine = {...f.config.local_review.central_source, sha: f.reviewer.sha, digest: f.reviewer.digest};
  const options = {trust: f.config.local_review, engine, repository: f.manifest.repository, author: 'fixture-owner',
    headSha: f.head, baseSha: f.base, reviewerSha: f.reviewer.sha, reviewerDigest: f.reviewer.digest,
    configDigest: f.manifest.config_digest, policyDigest: f.manifest.policy_digest, now: f.now};
  assert.throws(() => verifyReceipt(bundle, options), /owner authority/);
  assert.throws(() => verifyReceipt(bundle, {...options, engine: {...engine, sha: 'f'.repeat(40)}}), /engine mismatch/);
  assert.throws(() => verifyReceipt(bundle, {...options, engine: {...engine, digest: '0'.repeat(64)}}), /engine mismatch/);
}, {centralSource: true}));

test('existing identity export selects explicitly and never exports private material', () => fixture(f => {
  const exported = bootstrap.exportIdentity({state: f.state});
  assert.equal(exported.identity_file, f.enrolled.identity_file);
  assert.deepEqual(exported.public_identity, f.enrolled.public_identity);
  assert.ok(!JSON.stringify(exported).includes('PRIVATE KEY'));
  initializeIdentity(f.state, 'another-owner');
  assert.throws(() => bootstrap.exportIdentity({state: f.state}), /select one/);
  assert.deepEqual(bootstrap.exportIdentity({identity: f.enrolled.identity_file, state: f.state}).public_identity, f.enrolled.public_identity);
  const empty = path.join(f.temporary, 'empty'); fs.mkdirSync(empty);
  assert.throws(() => bootstrap.exportIdentity({state: empty}), /select one/);
  assert.throws(() => bootstrap.exportIdentity({state: path.join(f.temporary, 'missing')}), /select one/);
}));

test('identity export resolves project and identity aliases before reading any in-project private material', t => fixture(f => {
  assert.deepEqual(bootstrap.exportIdentity({identity: f.enrolled.identity_file, state: f.state, directory: f.directory}).public_identity, f.enrolled.public_identity);
  const inside = path.join(f.directory, '.git', 'inside-identities'); fs.mkdirSync(inside);
  const privateFile = path.join(inside, path.basename(f.enrolled.identity_file));
  fs.copyFileSync(f.enrolled.identity_file, privateFile); fs.chmodSync(privateFile, 0o600);
  const alias = path.join(f.temporary, 'outside-state-alias'); fs.symlinkSync(inside, alias);
  const projectAlias = path.join(f.temporary, 'project-alias'); fs.symlinkSync(f.directory, projectAlias);
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (filename, ...args) => {
    if (typeof filename === 'string' && fs.realpathSync(filename) === fs.realpathSync(privateFile)) {reads++; throw new Error('Private material was read before source containment was checked');}
    return read(filename, ...args);
  });
  for (const directory of [f.directory, projectAlias]) {
    assert.throws(() => bootstrap.exportIdentity({identity: privateFile, state: f.state, directory}), /outside project source/);
    assert.throws(() => bootstrap.exportIdentity({identity: path.join(alias, path.basename(privateFile)), state: f.state, directory}), /outside project source/);
    assert.throws(() => bootstrap.exportIdentity({state: alias, directory}), /outside project source/);
  }
  assert.throws(() => bootstrap.exportIdentity({identity: f.enrolled.identity_file, state: f.state, directory: f.enrolled.identity_file}), /outside project source/);
  assert.equal(reads, 0);
}));

test('public enrollment and private identity readers reject unsafe key material and filesystem substitutions', () => fixture(f => {
  for (const mutate of [value => {value.revoked = true;}, value => {value.public_key = 'PRIVATE KEY';},
    value => {value.public_key = undefined;}, value => {value.public_key = '-----BEGIN PUBLIC KEY-----PRIVATE KEY';},
    value => {value.github_actor = 'invalid/user';}, value => {value.id = '';}, value => {value.issuer = '';},
    value => {value.public_key = crypto.generateKeyPairSync('rsa', {modulusLength: 1024}).publicKey.export({type: 'spki', format: 'pem'});},
  ]) { const value = structuredClone(f.enrolled.public_identity); mutate(value); assert.throws(() => bootstrap.publicIdentity(value)); }
  fs.chmodSync(f.enrolled.identity_file, 0o644);
  assert.throws(() => bootstrap.readIdentity(f.enrolled.identity_file), /private regular file/);
  fs.chmodSync(f.enrolled.identity_file, 0o600);
  const link = path.join(f.state, 'alias.json'); fs.symlinkSync(f.enrolled.identity_file, link);
  assert.throws(() => bootstrap.readIdentity(link), /private regular file/);
  assert.throws(() => bootstrap.readIdentity(f.state), /private regular file/);
  const value = JSON.parse(fs.readFileSync(f.enrolled.identity_file));
  value.public_key = initializeIdentity(path.join(f.temporary, 'other'), 'fixture-owner').public_identity.public_key;
  fs.writeFileSync(f.enrolled.identity_file, JSON.stringify(value));
  assert.throws(() => bootstrap.readIdentity(f.enrolled.identity_file), /do not match/);
  fs.writeFileSync(f.enrolled.identity_file, 'x'.repeat(10001));
  assert.throws(() => bootstrap.readIdentity(f.enrolled.identity_file), /private regular file/);
  fs.writeFileSync(f.enrolled.identity_file, 'PRIVATE-IDENTITY-MUST-NOT-APPEAR-IN-PARSE-ERRORS');
  assert.throws(() => bootstrap.readIdentity(f.enrolled.identity_file), error =>
    /identity metadata is malformed/.test(error.message) && !error.message.includes('PRIVATE-IDENTITY'));
}));

test('manifest schema rejects altered fields, incomplete source inventories and invalid authorization lifetimes', () => fixture(f => {
  assert.equal(bootstrap.validateManifest(f.manifest, f.now), f.manifest);
  const invalid = [
    null, {...f.manifest, extra: true}, {...f.manifest, version: 2}, {...f.manifest, repository: 'not a repository'},
    {...f.manifest, base_branch: 'unsafe branch'}, {...f.manifest, head_sha: f.base},
    {...f.manifest, request: ''}, {...f.manifest, request: ' '.repeat(2)}, {...f.manifest, request: 'x'.repeat(20001)},
    {...f.manifest, identity: {...f.manifest.identity, private_key: 'never accepted'}},
    {...f.manifest, issued_at: f.manifest.issued_at + 1}, {...f.manifest, issued_at: 1.5},
    {...f.manifest, expires_at: f.manifest.issued_at}, {...f.manifest, expires_at: f.manifest.expires_at + 1},
    {...f.manifest, files: null}, {...f.manifest, files: []}, {...f.manifest, files: Array(101).fill(f.manifest.files[0])},
    {...f.manifest, files: [...f.manifest.files].reverse()}, {...f.manifest, files: [f.manifest.files[0], f.manifest.files[0]]},
    {...f.manifest, files: f.manifest.files.filter(file => file.path !== '.clouseau-local.json')},
    {...f.manifest, files: f.manifest.files.filter(file => file.path !== '.github/clouseau.json')},
    {...f.manifest, files: f.manifest.files.map((file, index) => index ? file : {...file, path: '../outside'})},
    {...f.manifest, files: f.manifest.files.map((file, index) => index ? file : {...file, extra: true})},
    {...f.manifest, files: f.manifest.files.map((file, index) => index ? file : {...file, sha256: 'invalid'})},
  ];
  for (const name of ['base_sha', 'head_sha', 'reviewer_sha', 'reviewer_digest', 'policy_digest', 'local_config_digest', 'config_digest']) invalid.push({...f.manifest, [name]: 'invalid'});
  for (const value of invalid) assert.throws(() => bootstrap.validateManifest(value, f.now), /initial installation/);
  assert.throws(() => bootstrap.validateManifest(f.manifest, f.manifest.expires_at * 1000), /expired/);
  assert.throws(() => bootstrap.validateManifest({...f.manifest, request: 123}, f.now), /requirement/);
}));

test('installation authorization has a distinct canonical grant and an installation-only artifact marker', () => fixture(f => {
  const body = bootstrap.grantBody(f.manifest);
  assert.deepEqual(bootstrap.parseGrant(body, f.now), f.manifest);
  for (const invalid of [null, `/approve-intent ${f.head}`, body + '\n', bootstrap.HEADER + ' '.repeat(60000), bootstrap.HEADER + '{']) {
    assert.throws(() => bootstrap.parseGrant(invalid, f.now));
  }
  const stamp = `<!-- clouseau-installation-review:v1 ${'a'.repeat(40)} -->`;
  assert.equal(bootstrap.installationMarker(`Installation evidence\n${stamp}`), 'a'.repeat(40));
  for (const invalid of [null, '', stamp + stamp, stamp + `<!-- clouseau-local-review:v1 ${'b'.repeat(40)} -->`,
    stamp + '<!-- clouseau-installation-review:v2 invalid -->', stamp + '<!-- clouseau-installation-review:v1 invalid -->']) assert.throws(() => bootstrap.installationMarker(invalid), /installation-only/);
  assert.throws(() => marker(stamp), /ordinary PR/);
}));

test('candidate qualification rejects dirty state, accepted recipes, mismatched enrollment and non-v2 CI controls', () => fixture(f => {
  const prepare = () => bootstrap.prepareManifest({directory: f.directory, base: f.base, request: f.request, enrollment: f.enrolled.public_identity, reviewer: f.reviewer, now: f.now});
  assert.throws(() => bootstrap.prepareManifest({directory: f.directory, base: f.base, request: f.request, enrollment: f.enrolled.public_identity, reviewer: {...f.reviewer, clean: false}, now: f.now}), /unmodified/);
  fs.writeFileSync(path.join(f.directory, 'uncommitted'), 'preserve'); assert.throws(prepare, /commit the complete/); fs.unlinkSync(path.join(f.directory, 'uncommitted'));
  const commitConfig = config => { fs.writeFileSync(path.join(f.directory, '.github/clouseau.json'), JSON.stringify(config)); git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'test: alter proposed fixture policy']); };
  for (const config of [
    {...f.config, local_review: undefined}, {...f.config, version: 1, local_review: undefined},
    {...f.config, base_branch: 'release'}, {...f.config, manual_reviewer: 'other-owner'},
    {...f.config, local_review: {...f.config.local_review, reviewer_digest: '0'.repeat(64)}},
    {...f.config, local_review: {...f.config.local_review, keys: [{...f.config.local_review.keys[0], issuer: 'another-runner'}]}},
    {...f.config, local_review: {...f.config.local_review, keys: [f.config.local_review.keys[0], {...f.config.local_review.keys[0], id: 'second'}]}},
  ]) { commitConfig(config); assert.throws(prepare, /initial installation/); }
  commitConfig(f.config);
  const withRecipe = git(f.directory, ['rev-parse', 'HEAD']).trim();
  assert.throws(() => bootstrap.prepareManifest({directory: f.directory, base: withRecipe, request: f.request, enrollment: f.enrolled.public_identity, reviewer: f.reviewer, now: f.now}), /already exists/);
  assert.throws(() => bootstrap.assertManifestLocal(f.directory, f.manifest, f.reviewer, f.now), /changed/);
}));

test('committed control source refuses symlinks, directories, binary or oversized inputs', () => fixture(f => {
  assert.equal(bootstrap.frozenSource(f.directory, f.head, 'README.md'), git(f.directory, ['show', `${f.head}:README.md`]));
  assert.throws(() => bootstrap.frozenSource(f.directory, f.head, '.github'), /regular file/);
  for (const [name, content] of [['binary-control', Buffer.from([0, 1])], ['oversized-control', 'x'.repeat(300001)]]) fs.writeFileSync(path.join(f.directory, name), content);
  fs.symlinkSync('README.md', path.join(f.directory, 'linked-control'));
  git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'test: unsafe controls']);
  const head = git(f.directory, ['rev-parse', 'HEAD']).trim();
  assert.throws(() => bootstrap.frozenSource(f.directory, head, 'linked-control'), /regular file/);
  assert.throws(() => bootstrap.frozenSource(f.directory, head, 'binary-control'), /textual/);
  assert.throws(() => bootstrap.frozenSource(f.directory, head, 'oversized-control'), /textual/);
}));

test('native owner authorization authenticates current admin, public released engine, exact base and commit comment', () => fixture(async f => {
  f.calls.length = 0;
  const grant = await bootstrap.authorizeManifest({api: f.api, manifest: f.manifest, now: f.now});
  assert.deepEqual(grant, f.grant);
  const writes = f.calls.filter(call => call.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].endpoint, `repos/${f.manifest.repository}/commits/${f.head}/comments`);
  assert.equal(writes[0].body.body, bootstrap.grantBody(f.manifest));
  assert.ok(!JSON.stringify(writes).includes('PRIVATE KEY'));
  f.live.comparison.status = 'ahead';
  await bootstrap.qualify({api: f.api, manifest: f.manifest, now: f.now});
  assert.ok(f.calls.some(call => call.endpoint === `repos/gaulatti/clouseau/compare/${f.reviewer.sha}...${f.reviewer.sha}`));
}));

test('write permission, bot/admin impersonation, changed base and unprotected or unreleased engine never enroll', () => fixture(async f => {
  const original = structuredClone(f.live);
  const mutations = [
    live => {live.actor.type = 'Bot';}, live => {live.actor.login = 'different-actor';},
    live => {live.repository.full_name = 'other/repo';}, live => {live.repository.default_branch = 'release';},
    live => {live.permission.permission = 'write';}, live => {live.permission.user.login = 'other';},
    live => {live.permission.user.type = 'Bot';}, live => {delete live.permission.user;},
    live => {live.base.commit.sha = 'f'.repeat(40);}, live => {delete live.base.commit;},
    live => {live.engine.protected = false;}, live => {live.engine.commit.sha = 'mutable-main';}, live => {delete live.engine.commit;},
    live => {live.comparison.status = 'diverged';}, live => {live.comparison.status = 'behind';},
  ];
  for (const mutate of mutations) {
    Object.assign(f.live, structuredClone(original)); f.calls.length = 0; mutate(f.live);
    await assert.rejects(bootstrap.authorizeManifest({api: f.api, manifest: f.manifest, now: f.now}));
    assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
  }
  await assert.rejects(bootstrap.qualify({api: f.api, manifest: f.manifest, actor: 'invalid/user', now: f.now}), /actor/);
}));

test('fresh grant lookup rejects deleted, altered, expired, foreign and bot-owned authorization', () => fixture(async f => {
  const original = structuredClone(f.live.comment);
  const mutations = [
    comment => {comment.body = `/approve-intent ${f.head}`;}, comment => {comment.body += '\n';},
    comment => {comment.commit_id = f.base;}, comment => {comment.user.login = 'other-owner';},
    comment => {comment.user.type = 'Bot';},
    comment => {const value = structuredClone(f.manifest); value.request = 'Different accepted purpose'; comment.body = bootstrap.grantBody(value);},
  ];
  for (const mutate of mutations) {f.live.comment = structuredClone(original); mutate(f.live.comment); await assert.rejects(bootstrap.verifyGrant({api: f.api, manifest: f.manifest, commentId: original.id, now: f.now}));}
  f.live.comment = original;
  for (const commentId of [0, -1, 1.5, undefined]) await assert.rejects(bootstrap.verifyGrant({api: f.api, manifest: f.manifest, commentId, now: f.now}), /commit-comment/);
  await assert.rejects(bootstrap.verifyGrant({api: async () => {throw new Error('404 deleted');}, manifest: f.manifest, commentId: original.id, now: f.now}), /deleted/);
  await assert.rejects(bootstrap.verifyGrant({api: f.api, manifest: f.manifest, commentId: original.id, now: f.manifest.expires_at * 1000}), /expired/);
}));

test('bootstrap local collection retains actual source and qualified authority without promoting an ordinary request', () => fixture(async f => {
  const record = await f.record();
  assert.equal(record.result.decision, 'auto_approve');
  assert.equal(record.snapshot.sources['local-request'].authority, 'untrusted');
  assert.equal(record.snapshot.sources['installation-authorization'].authority, 'trusted');
  assert.equal(record.snapshot.sources[`${f.head}:.github/clouseau.md`].kind, 'contract');
  const before = git(f.directory, ['status', '--porcelain']);
  assert.throws(() => collectLocal({directory: f.directory, base: f.base, request: f.request, technical: {}}), /not in|does not exist/);
  assert.equal(git(f.directory, ['status', '--porcelain']), before);
  const files = record.snapshot.files.map(file => ({filename: file.path, status: file.status}));
  const pr = {changed_files: files.length, base: {sha: f.base}, head: {sha: f.head, repo: {owner: {login: 'fixture-owner'}, name: 'bootstrap-fixture'}}};
  const github = {rest: {repos: {getContent: async ({path: filename, ref}) => {
    const bytes = Buffer.from(git(f.directory, ['show', `${ref}:${filename}`]));
    return {data: {encoding: 'base64', content: bytes.toString('base64'), size: bytes.length}};
  }}}};
  const options = {github, repo: {owner: 'fixture-owner', repo: 'bootstrap-fixture'}, pr, snapshot: record.snapshot, config: f.config, files, installation: f.grant};
  await verifySources(options);
  await assert.rejects(verifySources({...options, installation: null}), /purpose|authority/);
  const substituted = structuredClone(record.snapshot); substituted.sources['installation-authorization'].content = '{}';
  await assert.rejects(verifySources({...options, snapshot: substituted}), /substituted/);
}));

test('an installation-only passing signature cannot authorize an ordinary pull request or changed enrollment', () => fixture(async f => {
  const record = await f.record(); const bundle = f.sign(record);
  assert.equal((await bootstrap.verifyInstallationReceipt(bundle, f.options())).decision, 'auto_approve');
  const ordinary = {trust: f.config.local_review, repository: f.manifest.repository, author: 'fixture-owner',
    headSha: f.head, baseSha: f.base, reviewerSha: f.reviewer.sha, reviewerDigest: f.reviewer.digest,
    configDigest: f.manifest.config_digest, policyDigest: f.manifest.policy_digest, now: f.now};
  assert.throws(() => verifyReceipt(bundle, ordinary), /owner authority/);
  const disguised = structuredClone(record); disguised.controls = false;
  assert.throws(() => verifyReceipt(f.sign(disguised), ordinary), /owner authority/,
    'an installation field cannot be repackaged as an ordinary receipt by changing only controls');
  for (const mutate of [options => {options.author = 'contributor';}, options => {options.reviewerSha = 'f'.repeat(40);},
    options => {options.reviewerDigest = '0'.repeat(64);}, options => {options.grant.version = 2;},
    options => {options.grant.comment_id = 0;}, options => {options.grant.body_digest = 'invalid';},
  ]) { const options = {...f.options(), grant: structuredClone(f.grant)}; mutate(options); await assert.rejects(async () => bootstrap.verifyInstallationReceipt(bundle, options), /initial installation|receipt/); }
  const altered = structuredClone(bundle); altered.payload.record.installation.actor = 'other';
  await assert.rejects(async () => bootstrap.verifyInstallationReceipt(altered, f.options()), /signature/);
  const revoked = structuredClone(f.grant); revoked.manifest.identity.revoked = true;
  await assert.rejects(async () => bootstrap.verifyInstallationReceipt(bundle, {...f.options(), grant: revoked}), /public enrollment/);
}));

test('even a legitimately re-signed receipt cannot substitute installation authority, contexts or expiry', () => fixture(async f => {
  const record = await f.record();
  const sign = mutate => {const changed = structuredClone(record); mutate(changed); return f.sign(changed);};
  const refreshBinding = value => {require('./acceptance-sources.cjs').refresh(value.snapshot); value.result.snapshot = value.snapshot.digest; value.result.reviews.forEach(review => {review.report.snapshot = value.snapshot.digest;});};
  for (const mutate of [value => {value.controls = false;}, value => {value.installation.actor = 'other';},
    value => {value.snapshot.local_config_digest = '0'.repeat(64); require('./acceptance-sources.cjs').refresh(value.snapshot); value.result.snapshot = value.snapshot.digest; value.result.reviews.forEach(review => {review.report.snapshot = value.snapshot.digest;});},
    value => {value.snapshot.number = 1; refreshBinding(value);},
    value => {value.snapshot.intent_confirmation = {actor: 'fixture-owner'}; refreshBinding(value);},
  ]) await assert.rejects(async () => bootstrap.verifyInstallationReceipt(sign(mutate), f.options()), /initial trust/);
  for (const mutateSnapshot of [snapshot => {snapshot.sources['installation-authorization'].content = '{}';},
    snapshot => {delete snapshot.sources['installation-authorization'];},
  ]) await assert.rejects(bootstrap.verifyInstallationReceipt(f.sign(await f.record(mutateSnapshot)), f.options()), /initial trust/);
  const key = bootstrap.readIdentity(f.enrolled.identity_file).identity.private_key;
  const long = require('./local-receipt.cjs').issueReceipt({record, privateKey: key, keyId: f.enrolled.public_identity.id,
    issuer: f.enrolled.public_identity.issuer, reviewerSha: f.reviewer.sha, reviewerDigest: f.reviewer.digest, now: f.now + 1000});
  await assert.rejects(async () => bootstrap.verifyInstallationReceipt(long, {...f.options(), now: f.now + 1000}), /initial trust/);
  const unknown = f.sign(record); unknown.payload.type = 'unknown';
  unknown.signature = crypto.sign(null, Buffer.from(`${DOMAIN}\0${digest(unknown.payload)}`), key).toString('base64url');
  await assert.rejects(async () => bootstrap.verifyInstallationReceipt(unknown, f.options()), /unknown receipt/);
}));

test('receipt consumption always re-fetches native authority and refuses a deleted or revoked grant', () => fixture(async f => {
  const bundle = f.sign(await f.record());
  f.calls.length = 0;
  await bootstrap.verifyInstallationReceipt(bundle, f.options());
  assert.equal(f.calls[0].endpoint, `repos/${f.manifest.repository}/comments/${f.live.comment.id}`);
  assert.ok(f.calls.some(call => call.endpoint.includes('/collaborators/fixture-owner/permission')));
  f.live.permission.permission = 'write';
  await assert.rejects(bootstrap.verifyInstallationReceipt(bundle, f.options()), /administrator/);
  f.live.permission.permission = 'admin';
  const body = f.live.comment.body;
  f.live.comment.body = body + '\n';
  await assert.rejects(bootstrap.verifyInstallationReceipt(bundle, f.options()), /changed/);
  f.live.comment.body = body;
  await assert.rejects(bootstrap.verifyInstallationReceipt(bundle, {...f.options(), api: async () => {throw new Error('404 deleted grant');}}), /deleted/);
}));

test('a fresh native grant and valid signature cannot replace the frozen shared engine policy', () => fixture(async f => {
  const policy = '0'.repeat(64);
  const manifest = {...f.manifest, policy_digest: policy};
  f.live.comment.body = bootstrap.grantBody(manifest);
  f.grant = await bootstrap.verifyGrant({api: f.api, manifest, commentId: f.live.comment.id, now: f.now});
  const record = await f.record(snapshot => {snapshot.policy_digest = policy;});
  const bundle = f.sign(record);
  assert.equal(verifySignedRecord(bundle, {trust: f.config.local_review, repository: manifest.repository,
    author: 'fixture-owner', headSha: f.head, baseSha: f.base, reviewerSha: f.reviewer.sha,
    reviewerDigest: f.reviewer.digest, configDigest: manifest.config_digest, policyDigest: policy, now: f.now}).decision, 'auto_approve');
  await assert.rejects(bootstrap.verifyInstallationReceipt(bundle, f.options()), /shared engine policy identity/);
}));

test('even a validly re-signed semantic record must retain every unchanged authorized control and its exact content', () => fixture(async f => {
  const key = `${f.head}:README.md`;
  assert.equal((await f.record()).snapshot.files.some(file => file.path === 'README.md'), false, 'the frozen README is unchanged against base');
  for (const mutateSnapshot of [snapshot => {delete snapshot.sources[key];},
    snapshot => {snapshot.sources[key].content = 'Different product purpose.\n';},
  ]) {
    const bundle = f.sign(await f.record(mutateSnapshot));
    await assert.rejects(bootstrap.verifyInstallationReceipt(bundle, f.options()), /complete authorized controls/);
  }
}));

test('default time and actor parameters use the current authenticated installation boundary', t => fixture(async f => {
  t.mock.method(Date, 'now', () => f.now);
  assert.equal(bootstrap.validateManifest(f.manifest), f.manifest);
  assert.deepEqual(bootstrap.parseGrant(bootstrap.grantBody(f.manifest)), f.manifest);
  assert.deepEqual(bootstrap.prepareManifest({directory: f.directory, enrollment: f.enrolled.public_identity, reviewer: f.reviewer, request: f.request}), f.manifest);
  await bootstrap.qualify({api: f.api, manifest: f.manifest});
  assert.deepEqual(await bootstrap.verifyGrant({api: f.api, manifest: f.manifest, commentId: f.live.comment.id}), f.grant);
  assert.deepEqual(await bootstrap.authorizeManifest({api: f.api, manifest: f.manifest}), f.grant);
  bootstrap.assertManifestLocal(f.directory, f.manifest, f.reviewer);
  const options = f.options(); delete options.now;
  assert.equal((await bootstrap.verifyInstallationReceipt(f.sign(await f.record()), options)).decision, 'auto_approve');
}));
