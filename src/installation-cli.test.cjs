'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {fixture, harness} = require('../test/bootstrap-cli-fixture.cjs');
const {git} = require('./local-git.cjs');
const {digest} = require('./acceptance.cjs');
const normal = require('./local-cli.cjs');
const cli = require('./installation-cli.cjs');
const bootstrap = require('./installation-bootstrap.cjs');

test('installation command parsing rejects unknown commands, ambiguous flags and missing native identifiers', () => {
  assert.deepEqual(cli.options(['public-identity']), {command: 'public-identity'});
  assert.deepEqual(cli.options(['installation-check', '--repository', 'fixture/project', '--pull-request', '7']),
    {command: 'installation-check', repository: 'fixture/project', 'pull-request': '7'});
  for (const args of [[], ['review'], ['installation-unknown'], ['public-identity', '--directory', '/tmp'],
    ['installation-review', '--identity'], ['installation-review', 'identity', 'path'],
    ['installation-review', '--identity', 'first', '--identity', 'second']]) assert.throws(() => cli.options(args), /Initial installation/);
  assert.equal(cli.positive('7'), 7); assert.equal(cli.positive(7), 7);
  for (const value of [undefined, null, '', '01', '0', '-1', '1.5', '1e3', '9007199254740992']) assert.throws(() => cli.positive(value), /positive native/);
});

test('manifest and receipt metadata stay complete, private, regular, and outside source', () => fixture(f => {
  assert.deepEqual(cli.readJson(f.manifestFile, 60000), f.manifest);
  const output = path.join(f.temporary, 'evidence', 'record.json');
  assert.equal(cli.writeJson(output, {fixture: true}, f.directory), output);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), {fixture: true});
  assert.throws(() => cli.writeJson(output, {overwrite: true}, f.directory), /exist/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), {fixture: true}, 'existing diagnostics must not be overwritten');
  for (const value of [f.directory, path.join(f.directory, 'evidence.json')]) assert.throws(() => cli.writeJson(value, {}, f.directory), /outside/);
  assert.throws(() => cli.readJson(undefined, 10), /explicit/);
  assert.throws(() => cli.readJson(f.temporary, 10), /regular/);
  assert.throws(() => cli.readJson(f.manifestFile, 10), /size budget/);
  const link = path.join(f.temporary, 'alias.json'); fs.symlinkSync(f.manifestFile, link);
  assert.throws(() => cli.readJson(link, 60000), /regular/);
  assert.throws(() => cli.writeJson(link, {overwrite: true}, f.directory), /exist/i);
  fs.writeFileSync(output, '{'); assert.throws(() => cli.readJson(output, 100), SyntaxError);
}));

test('default CLI runtime exports only public identity and uses the explicit current checkout', t => fixture(async f => {
  t.mock.method(normal, 'stateDirectory', () => f.state);
  assert.deepEqual(await cli.main(['public-identity']), bootstrap.exportIdentity({state: f.state}));
  t.mock.method(process, 'cwd', () => f.directory);
  const output = path.join(f.temporary, 'default-prepare.json');
  const result = await normal.main(['installation-prepare', '--request-file', f.requestFile, '--output', output], f.reviewRuntime);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.manifest)), f.manifest);
  assert.equal((await cli.runReview({...f.reviewArgs, directory: undefined}, f.reviewRuntime)).decision, 'auto_approve');
}));

test('engine enrollment metadata is public, read-only and explicit about a modified installation', () => fixture(async f => {
  const forbidden = () => {throw new Error('Engine metadata must not use GitHub, a harness or a signing identity');};
  assert.deepEqual(await normal.main(['installation-engine'], {installed: () => f.reviewer, api: forbidden}),
    {reviewer_sha: f.reviewer.sha, reviewer_digest: f.reviewer.digest, unmodified: true});
  assert.equal((await cli.main(['installation-engine'], {installed: () => ({...f.reviewer, clean: false}), api: forbidden})).unmodified, false);
  assert.throws(() => cli.options(['installation-engine', '--identity', f.enrolled.identity_file]), /invalid command/);
}));

test('verification strips provider/write credential variables while preserving ordinary command settings', t => fixture(f => {
  const names = ['CLOUSEAU_FIXTURE_TOKEN', 'CLOUSEAU_FIXTURE_SECRET', 'CLOUSEAU_FIXTURE_SIGNAL'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.CLOUSEAU_FIXTURE_TOKEN = 'fixture-only'; process.env.CLOUSEAU_FIXTURE_SECRET = 'fixture-only'; process.env.CLOUSEAU_FIXTURE_SIGNAL = 'ordinary';
    let calls = 0;
    t.mock.method(cp, 'spawnSync', (program, args, settings) => {
      calls++; assert.equal(program, 'fixture-command'); assert.deepEqual(args, ['--fixture']);
      assert.equal(settings.cwd, f.directory); assert.equal(settings.timeout, 500);
      assert.equal(settings.env.CLOUSEAU_FIXTURE_SIGNAL, 'ordinary');
      assert.deepEqual(Object.keys(settings.env).filter(name => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)), []);
      return {status: 0, stdout: 'fixture', stderr: ''};
    });
    t.mock.method(normal, 'executeVerification', ({directory, config, run}) => {
      assert.equal(directory, f.directory); assert.deepEqual(config, f.local);
      return run('fixture-command', ['--fixture'], {cwd: directory, timeout: 500});
    });
    assert.equal(cli.verification({directory: f.directory, config: f.local}).status, 0);
    assert.equal(calls, 1);
  } finally {
    for (const name of names) {if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];}
  }
}));

test('normal CLI routes new commands while ordinary unknown or empty invocations remain explicit', () => fixture(async f => {
  assert.deepEqual(await normal.main(['public-identity'], {state: f.state}), bootstrap.exportIdentity({state: f.state}));
  assert.deepEqual(await cli.main(['public-identity', '--identity', f.enrolled.identity_file], {state: f.state}), bootstrap.exportIdentity({state: f.state}));
  await assert.rejects(normal.main([]), /Usage/);
  await assert.rejects(normal.main(['ordinary-unknown']), /Usage/);
  await assert.rejects(normal.main(['installation-unknown']), /unknown installation/);
}));

test('prepare and native authorize commands produce a distinct owner grant without running candidate setup', () => fixture(async f => {
  const output = path.join(f.temporary, 'prepared.json'); let verifications = 0;
  const runtime = {...f.reviewRuntime, verify: () => {verifications++; throw new Error('Preparation cannot execute setup');}};
  const prepared = await cli.main(['installation-prepare', '--directory', f.directory, '--base', f.base,
    '--request-file', f.requestFile, '--identity', f.enrolled.identity_file, '--output', output], runtime);
  assert.deepEqual(JSON.parse(fs.readFileSync(prepared.manifest)), f.manifest);
  assert.equal(prepared.pending_owner_authorization, true);
  assert.equal(prepared.manifest_digest, digest(f.manifest));
  assert.equal(prepared.authorization_body, bootstrap.grantBody(f.manifest));
  const grant = await cli.main(['installation-authorize', '--manifest', output], runtime);
  assert.deepEqual(grant, f.grant);
  assert.equal(verifications, 0); assert.equal(runtime.ask.calls(), 0);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  await assert.rejects(cli.main(['installation-prepare'], runtime), /request-file/);
}));

test('installation review executes qualified verification, actual shared scoring, then issues an installation-only signature', () => fixture(async f => {
  const observed = [];
  const ask = harness();
  const runtime = {...f.reviewRuntime, ask: async task => {observed.push(task); return ask(task);}, verify: ({directory, config}) => {
    assert.equal(directory, f.directory); assert.deepEqual(config, f.local);
    return {fixture_only: true, exact_coverage: {lines: [1, 1], branches: [2, 2]}};
  }};
  const result = await cli.main(['installation-review', '--directory', f.directory, '--manifest', f.manifestFile,
    '--grant-comment', String(f.grant.comment_id), '--harness', 'codex'], runtime);
  assert.equal(result.decision, 'auto_approve'); assert.equal(result.installation_only, true);
  assert.equal(result.manual_owner_acceptance_required, true); assert.equal(result.ordinary_pr_approval, false);
  assert.equal(result.provider_api_calls, 0); assert.equal(result.harness_invocations, 4);
  assert.ok(result.receipt); assert.equal(observed.length, 4);
  assert.ok(observed.every(task => !task.prompt.includes('PRIVATE KEY')));
  const bundle = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal((await bootstrap.verifyInstallationReceipt(bundle, f.options())).decision, 'auto_approve');
  const history = JSON.parse(fs.readFileSync(path.join(f.state, 'installation-ledgers', `${digest({repository: f.manifest.repository, branch: 'main'})}.json`)));
  assert.equal(history.has_receipt, true); assert.equal(history.installation_attempts, 1);
  const journal = fs.readFileSync(path.join(path.dirname(result.receipt), 'observations.jsonl'), 'utf8');
  assert.equal(journal.trim().split('\n').length, 8);
  assert.ok(!journal.includes('PRIVATE KEY'));
  await assert.rejects(cli.runReview(f.reviewArgs, runtime), /already ran/);
}));

test('central-source first installation prepares, reviews requested frozen engine bytes and checks only the same engine', () => fixture(async f => {
  const output = path.join(f.temporary, 'central-prepared.json');
  const prepared = await cli.main(['installation-prepare', '--directory', f.directory, '--base', f.base,
    '--request-file', f.requestFile, '--output', output], f.reviewRuntime);
  assert.deepEqual(JSON.parse(fs.readFileSync(prepared.manifest)), f.manifest);
  const review = await cli.runReview(f.reviewArgs, f.reviewRuntime);
  assert.equal(review.decision, 'auto_approve'); assert.equal(review.provider_api_calls, 0);
  assert.equal(review.harness_invocations, 5, 'one real source-request round precedes the four semantic fixture responses');
  const bundle = JSON.parse(fs.readFileSync(review.receipt));
  const sourceId = `engine:${f.reviewer.sha}:src/config.cjs`;
  const source = bundle.payload.record.snapshot.sources[sourceId];
  assert.deepEqual(source, {path: '.clouseau-ci/src/config.cjs', ref: f.reviewer.sha, authority: 'untrusted', kind: 'source',
    content: fs.readFileSync(path.join(__dirname, 'config.cjs'), 'utf8')});
  assert.ok(bundle.payload.record.result.reviews.every(item => item.report.coverage.sources.some(entry => entry.source === sourceId && entry.state === 'inspected')));
  const remote = await f.remote(); remote.state.bundle = bundle;
  const forbidden = () => {throw new Error('Read-only installation checking must not run setup, signing or AI');};
  const checked = await cli.check(remote.args, {...remote.runtime, ask: forbidden, verify: forbidden, state: '/unavailable-identities'});
  assert.equal(checked.installation_verified, true); assert.equal(checked.ordinary_pr_approval, false);
  assert.equal(checked.auto_merge_authorized, false); assert.equal(checked.provider_api_calls, 0);
  assert.ok(remote.state.calls.every(call => call.method === 'GET'));
  assert.ok(!remote.state.calls.some(call => call.endpoint.includes('.clouseau-ci')), 'the checker compares the trusted engine checkout, never contributor bytes');
  for (const changed of [{sha: 'f'.repeat(40)}, {digest: '0'.repeat(64)}]) {
    await assert.rejects(cli.check(remote.args, {...remote.runtime, installed: () => ({...f.reviewer, ...changed})}), /frozen shared engine/);
  }
  remote.state.bundle = f.sign(await f.record(undefined, snapshot => {snapshot.sources[sourceId].content += '\n// altered engine evidence\n';}));
  await assert.rejects(cli.check(remote.args, remote.runtime), /differs from the accepted engine/);
  remote.state.bundle = f.sign(await f.record(undefined, snapshot => {snapshot.sources[sourceId].ref = 'f'.repeat(40);}));
  await assert.rejects(cli.check(remote.args, remote.runtime), /invalid frozen engine/);
}, {centralSource: true, engineSource: true}));

test('a negative review remains recorded, unsigned and ineligible for unchanged resampling', () => fixture(async f => {
  const ask = harness(true);
  const output = path.join(f.temporary, 'negative-record.json');
  const result = await cli.runReview({...f.reviewArgs, output}, {...f.reviewRuntime, ask});
  assert.equal(result.receipt, null); assert.notEqual(result.decision, 'auto_approve');
  assert.ok(fs.existsSync(output)); assert.equal(ask.calls(), 4);
  const record = JSON.parse(fs.readFileSync(output));
  assert.equal(record.controls, true); assert.equal(record.result.decision, result.decision);
  await assert.rejects(cli.runReview(f.reviewArgs, {...f.reviewRuntime, ask}), /unchanged revision/);
  assert.equal(ask.calls(), 4, 'the negative result must not cause another model sample');
}));

test('an unresolved preserved finding cannot disappear behind new passing fixture grades', () => fixture(async f => {
  await cli.runReview(f.reviewArgs, f.reviewRuntime);
  const filename = path.join(f.state, 'installation-ledgers', `${digest({repository: f.manifest.repository, branch: 'main'})}.json`);
  const previous = JSON.parse(fs.readFileSync(filename));
  const concern = {id: 'a'.repeat(64), blocking: true, path: 'src/handler.js', title: 'Missing input guard',
    cause: 'Input is not verified', obligation: 'Reject missing input'};
  fs.writeFileSync(filename, JSON.stringify({...previous, findings: [concern]}));
  await f.revise('preserved-finding');
  const result = await cli.runReview(f.reviewArgs, {...f.reviewRuntime, ask: harness()});
  assert.equal(result.decision, 'review_incomplete'); assert.equal(result.receipt, null);
  const record = JSON.parse(fs.readFileSync(result.record));
  assert.deepEqual(record.local_previous.findings, [concern]);
  assert.equal(require('./local-receipt.cjs').reviewDecision(record).decision, 'review_incomplete');
}));

test('installation review bounds changed-candidate repairs and refuses malformed preserved attempt counts', () => fixture(async f => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await f.revise(attempt);
    const result = await cli.runReview(f.reviewArgs, {...f.reviewRuntime, ask: harness(true)});
    assert.equal(result.receipt, null);
  }
  await f.revise(4);
  await assert.rejects(cli.runReview(f.reviewArgs, f.reviewRuntime), /two repair cycles/);
  const filename = path.join(f.state, 'installation-ledgers', `${digest({repository: f.manifest.repository, branch: 'main'})}.json`);
  const history = JSON.parse(fs.readFileSync(filename));
  for (const value of [undefined, 0, 1.5, 4]) {
    fs.writeFileSync(filename, JSON.stringify({...history, installation_attempts: value}));
    await assert.rejects(cli.runReview(f.reviewArgs, f.reviewRuntime), /attempt history/);
  }
}));

test('revoked authorization and unsafe identity/output stop before executing verification or a harness', () => fixture(async f => {
  let calls = 0; const runtime = {...f.reviewRuntime, verify: () => {calls++; throw new Error('must not execute');}};
  f.live.permission.permission = 'write';
  await assert.rejects(cli.runReview(f.reviewArgs, runtime), /administrator/);
  f.live.permission.permission = 'admin';
  for (const output of [f.directory, path.join(f.directory, 'report.json')]) await assert.rejects(cli.runReview({...f.reviewArgs, output}, runtime), /outside/);
  const existing = path.join(f.temporary, 'preserved-report.json'); fs.writeFileSync(existing, 'preserve diagnostics');
  await assert.rejects(cli.runReview({...f.reviewArgs, output: existing}, runtime), /existing report/);
  const other = normal.initializeIdentity(path.join(f.temporary, 'other-signer'), 'fixture-owner');
  await assert.rejects(cli.runReview({...f.reviewArgs, identity: other.identity_file}, runtime), /identity differs/);
  const privateInside = path.join(f.directory, '.git', 'private-fixture-identity.json');
  fs.copyFileSync(f.enrolled.identity_file, privateInside); fs.chmodSync(privateInside, 0o600);
  await assert.rejects(cli.runReview({...f.reviewArgs, identity: privateInside}, runtime), /outside project/);
  assert.equal(calls, 0); assert.equal(runtime.ask.calls(), 0);
}));

test('prepare and review reject an external directory alias into source before reading private material or executing work', t => fixture(async f => {
  const inside = path.join(f.directory, '.git', 'inside-identities'); fs.mkdirSync(inside);
  const filename = path.join(inside, path.basename(f.enrolled.identity_file));
  fs.copyFileSync(f.enrolled.identity_file, filename); fs.chmodSync(filename, 0o600);
  const alias = path.join(f.temporary, 'external-identity-directory'); fs.symlinkSync(inside, alias);
  const selected = path.join(alias, path.basename(filename));
  let reads = 0; let verifications = 0;
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (name, ...args) => {
    if (typeof name === 'string' && fs.realpathSync(name) === fs.realpathSync(filename)) {reads++; throw new Error('Private identity read before source containment');}
    return read(name, ...args);
  });
  const runtime = {...f.reviewRuntime, verify: () => {verifications++; throw new Error('Unexpected candidate execution');}};
  await assert.rejects(cli.main(['installation-prepare', '--directory', f.directory, '--request-file', f.requestFile,
    '--identity', selected, '--output', path.join(f.temporary, 'manifest-with-source-key.json')], runtime), /outside project source/);
  await assert.rejects(cli.runReview({...f.reviewArgs, identity: selected}, runtime), /outside project source/);
  assert.equal(reads, 0); assert.equal(verifications, 0); assert.equal(runtime.ask.calls(), 0);
}));

test('failed verification, failed harness transport and changed source never produce approval receipts', () => fixture(async f => {
  await assert.rejects(cli.runReview(f.reviewArgs, {...f.reviewRuntime, verify: () => {throw new Error('Real verification failed');}}), /verification failed/);
  let calls = 0;
  await assert.rejects(cli.runReview(f.reviewArgs, {...f.reviewRuntime, ask: async () => {calls++; throw new Error('Fixture harness unavailable');}}), /harness unavailable/);
  assert.equal(calls, 1);
  await assert.rejects(cli.runReview(f.reviewArgs, f.reviewRuntime), /already ran|unchanged revision/);
  await f.revise('source-mutation');
  const ask = harness();
  await assert.rejects(cli.runReview(f.reviewArgs, {...f.reviewRuntime, ask: async task => {
    const response = await ask(task);
    if (ask.calls() === 4) fs.appendFileSync(path.join(f.directory, 'README.md'), 'Changed during review.\n');
    return response;
  }}), /source changed/);
}));

test('renewing owner-grant timestamps cannot resample an unchanged transport failure', () => fixture(async f => {
  let calls = 0;
  const failed = {...f.reviewRuntime, ask: async () => {calls++; throw new Error('Fixture transport unavailable');}};
  await assert.rejects(cli.runReview(f.reviewArgs, failed), /transport unavailable/);
  f.now += 1000;
  f.manifest = {...f.manifest, issued_at: f.manifest.issued_at + 1, expires_at: f.manifest.expires_at + 1};
  f.live.comment.body = bootstrap.grantBody(f.manifest);
  fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
  await assert.rejects(cli.runReview(f.reviewArgs, failed), /unchanged revision/);
  assert.equal(calls, 1);
}));

test('default verifier and harness references still stop unsafe signing-material output before assessment', () => fixture(async f => {
  f.local.verification = [[process.execPath, '-e', 'console.log("-----BEGIN PRIVATE KEY-----fixture-only")']];
  fs.writeFileSync(path.join(f.directory, '.clouseau-local.json'), JSON.stringify(f.local));
  git(f.directory, ['add', '.clouseau-local.json']); git(f.directory, ['commit', '-qm', 'test: preserve private output boundary']);
  await f.refresh();
  await assert.rejects(cli.runReview(f.reviewArgs, {...f.reviewRuntime, verify: undefined, ask: undefined}), /Private signing material/);
}));

test('installation local quality assessment runs with unavailable real coverage and retains manual-only trust authority', () => fixture(async f => {
  const ask = harness();
  const result = await cli.runReview(f.reviewArgs, {...f.reviewRuntime, verify: undefined, ask});
  const record = JSON.parse(fs.readFileSync(result.record));
  assert.equal(ask.calls(), 4);
  assert.equal(record.technical.coverage.status, 'unavailable');
  assert.equal(record.technical.exact_coverage, null);
  assert.equal(result.decision_scope, 'review_reuse_only');
  assert.equal(result.independent_ci_required, true);
  assert.equal(result.merge_authority, false);
  assert.equal(result.ordinary_pr_approval, false);
  assert.equal(result.manual_owner_acceptance_required, true);
  assert.ok(result.receipt, 'a signature authenticates fixture AI quality, not a passing technical gate');
}));

test('changing the installed shared engine after investigation never produces a signature', () => fixture(async f => {
  let installs = 0;
  const runtime = {...f.reviewRuntime, installed: () => ++installs === 1 ? f.reviewer : {...f.reviewer, sha: 'f'.repeat(40)}};
  await assert.rejects(cli.runReview(f.reviewArgs, runtime), /shared engine changed/);
  const files = fs.readdirSync(path.join(f.state, 'installation-reviews'), {recursive: true});
  assert.equal(files.some(name => name.endsWith('receipt.json')), false);
}));

test('installation publication validates authority before delegating the source-preserving artifact publisher', () => fixture(async f => {
  const result = await cli.runReview(f.reviewArgs, f.reviewRuntime);
  const writes = [];
  const published = await cli.main(['installation-publish', '--directory', f.directory, '--receipt', result.receipt],
    {...f.reviewRuntime, publish: args => {writes.push(args); return {artifact_commit: 'a'.repeat(40)};}});
  assert.equal(published.marker, `<!-- clouseau-installation-review:v1 ${'a'.repeat(40)} -->`);
  assert.equal(published.installation_only, true);
  assert.deepEqual(writes, [{directory: f.directory, receipt: result.receipt}]);
  f.live.comment.body += '\n';
  await assert.rejects(cli.main(['installation-publish', '--directory', f.directory, '--receipt', result.receipt],
    {...f.reviewRuntime, publish: () => {throw new Error('Untrusted publication');}}), /changed/);
  const invalid = path.join(f.temporary, 'invalid-receipt.json'); fs.writeFileSync(invalid, '{}');
  await assert.rejects(cli.main(['installation-publish', '--receipt', invalid], f.reviewRuntime), /signed installation/);
}));

test('default artifact publication writes a separate local bare-repository tag without changing the reviewed source', () => fixture(async f => {
  const result = await cli.runReview(f.reviewArgs, f.reviewRuntime);
  const bare = path.join(f.temporary, 'artifacts.git');
  git(f.temporary, ['init', '-q', '--bare', bare]);
  git(f.directory, ['remote', 'set-url', '--push', 'origin', bare]);
  const published = await cli.main(['installation-publish', '--directory', f.directory, '--receipt', result.receipt], f.reviewRuntime);
  assert.match(published.artifact_commit, /^[a-f0-9]{40}$/);
  assert.equal(JSON.parse(git(bare, ['show', `${published.artifact_commit}:clouseau-review.json`])).payload.record.snapshot.head_sha, f.head);
  assert.equal(git(f.directory, ['rev-parse', 'HEAD']).trim(), f.head);
  assert.equal(git(f.directory, ['status', '--porcelain']), '');
}));

test('ready PR validation binds human author, internal source, exact head/base and disabled automatic merge', () => fixture(async f => {
  const {state} = await f.remote(); const original = structuredClone(state.pr);
  cli.readyPull(original, f.manifest);
  for (const mutate of [pr => {pr.state = 'closed';}, pr => {pr.draft = true;}, pr => {pr.auto_merge = {};},
    pr => {pr.number = 0;}, pr => {delete pr.number;}, pr => {pr.number = '7';},
    pr => {pr.user.type = 'Bot';}, pr => {delete pr.user;}, pr => {pr.user.login = 'other';},
    pr => {pr.head.repo.full_name = 'attacker/fork';}, pr => {pr.head.repo.id = 0;}, pr => {delete pr.head.repo.id;},
    pr => {delete pr.head.repo;}, pr => {delete pr.head;},
    pr => {pr.base.ref = 'release';}, pr => {delete pr.base;}, pr => {pr.base.sha = 'b'.repeat(40);}, pr => {pr.head.sha = 'b'.repeat(40);},
  ]) {const pr = structuredClone(original); mutate(pr); assert.throws(() => cli.readyPull(pr, f.manifest), /ready owner-authored/);}
}));

test('read-only initial checker revalidates immutable source and actual candidate CI without loading a signer or executing setup', () => fixture(async f => {
  const remote = await f.remote();
  const forbidden = () => {throw new Error('A read-only checker cannot execute contributor setup, AI or signing');};
  const result = await cli.main(['installation-check', '--repository', f.manifest.repository, '--pull-request', '7'],
    {...remote.runtime, verify: forbidden, ask: forbidden, publish: forbidden, state: '/unavailable-private-identity-state'});
  assert.equal(result.installation_verified, true);
  assert.equal(result.manual_owner_acceptance_required, true); assert.equal(result.ordinary_pr_approval, false);
  assert.equal(result.auto_merge_authorized, false); assert.equal(result.provider_api_calls, 0);
  assert.equal(result.head_sha, f.head); assert.equal(result.base_sha, f.base);
  assert.equal(result.technical.run_id, 51);
  assert.ok(remote.state.calls.every(call => call.method === 'GET'));
  assert.equal(remote.state.calls.filter(call => call.endpoint.endsWith('/comments/31')).length, 2, 'native grant is re-fetched before and after CI');
}));

test('read-only initial checker rejects changed head, incomplete artifacts, wrong signer and an existing review ledger', () => fixture(async f => {
  const remote = await f.remote(); const original = structuredClone(remote.state.pr);
  await assert.rejects(cli.check({repository: 'invalid', 'pull-request': '7'}, remote.runtime), /explicit GitHub/);
  await assert.rejects(cli.check({'pull-request': '7'}, remote.runtime), /explicit GitHub/);
  await assert.rejects(cli.check({...remote.args, 'pull-request': '0'}, remote.runtime), /positive native/);
  remote.state.pr.number = 8; await assert.rejects(cli.check(remote.args, remote.runtime), /native PR identity/);
  remote.state.pr = structuredClone(original);
  remote.state.pr.head.sha = 'b'.repeat(40); await assert.rejects(cli.check(remote.args, remote.runtime), /exact-revision/);
  remote.state.pr = structuredClone(original);
  await assert.rejects(cli.check(remote.args, {...remote.runtime, installed: () => ({...f.reviewer, clean: false})}), /checker source/);
  const bundle = remote.state.bundle;
  for (const value of [null, {}, {payload: {}}, {payload: {record: {}}}, {payload: {record: {installation: {manifest: {repository: 'foreign/repo'}}}}}]) {
    remote.state.bundle = value; await assert.rejects(cli.check(remote.args, remote.runtime), /another repository|incomplete/);
  }
  remote.state.bundle = bundle;
  remote.state.comments = [{id: 9, user: {login: 'github-actions[bot]'}, body: `<!-- clouseau-acceptance:v2 -->\n<!-- clouseau-state:${Buffer.from(JSON.stringify({version: 2, repository: f.manifest.repository, number: 7, head_sha: f.head, findings: []})).toString('base64')} -->`}];
  await assert.rejects(cli.check(remote.args, remote.runtime), /existing review ledger/);
  remote.state.comments = [];
  remote.state.files = []; await assert.rejects(cli.check(remote.args, remote.runtime), /inventory/);
}));

test('remote configuration requires complete trees and regular exact immutable control bytes', () => fixture(async f => {
  const remote = await f.remote();
  assert.deepEqual(await cli.remoteConfiguration(remote.api, f.manifest), f.config);
  const oldTree = structuredClone(remote.state.headTree);
  for (const value of [{truncated: true, tree: []}, {truncated: false, tree: null}]) {
    remote.state.headTree = value; await assert.rejects(cli.remoteConfiguration(remote.api, f.manifest), /complete immutable/);
  }
  remote.state.headTree = structuredClone(oldTree);
  const first = f.manifest.files[0].path;
  for (const alter of [tree => {tree.tree = tree.tree.filter(file => file.path !== first);},
    tree => {tree.tree.find(file => file.path === first).type = 'tree';}, tree => {tree.tree.find(file => file.path === first).mode = '120000';}]) {
    remote.state.headTree = structuredClone(oldTree); alter(remote.state.headTree); await assert.rejects(cli.remoteConfiguration(remote.api, f.manifest), /regular immutable/);
  }
  remote.state.headTree = oldTree;
  remote.state.baseTree.tree.push({path: '.clouseau-local.json'});
  await assert.rejects(cli.remoteConfiguration(remote.api, f.manifest), /accepted configuration/);
  remote.state.baseTree.tree.pop();
  for (const value of [{encoding: 'none', content: '', size: 0}, {encoding: 'base64', content: null, size: 0},
    {encoding: 'base64', content: '', size: -1}, {encoding: 'base64', content: '', size: 300001},
    {encoding: 'base64', content: '', size: 0.5}, {encoding: 'base64', content: '', size: 1},
    {encoding: 'base64', content: Buffer.from('altered').toString('base64'), size: 7},
  ]) {remote.state.content.set(`${f.head}:${first}`, value); await assert.rejects(cli.remoteConfiguration(remote.api, f.manifest), /source|byte|size|control/);}
}));

test('remote configuration rejects altered recipe identities or an omitted control workflow', () => fixture(async f => {
  const remote = await f.remote();
  for (const name of ['local_config_digest', 'config_digest']) await assert.rejects(cli.remoteConfiguration(remote.api, {...f.manifest, [name]: '0'.repeat(64)}), /differs/);
  remote.state.headTree.tree.push({path: '.github/workflows/unaccounted.yml', type: 'blob', mode: '100644'});
  await assert.rejects(cli.remoteConfiguration(remote.api, f.manifest), /inventory differs/);
}));

test('independent CI must be current, complete, successful and from a PR event', () => fixture(async f => {
  const remote = await f.remote(); const original = structuredClone(remote.state);
  for (const mutate of [state => {state.runs = [];}, state => {state.runs[0].status = 'in_progress';},
    state => {state.runs[0].conclusion = 'failure';}, state => {state.runs[0].head_sha = 'b'.repeat(40);},
    state => {state.runs[0].event = 'workflow_dispatch';}, state => {state.runs[0].run_attempt = 0;},
    state => {state.runs[0].id = 0;}, state => {state.jobs = [];}, state => {state.jobs[0].id = 0;},
    state => {state.jobs[0].conclusion = 'skipped';}, state => {state.jobs[0].steps = [];},
    state => {state.jobs[0].steps[0].conclusion = 'failure';},
  ]) {
    Object.assign(remote.state, structuredClone(original)); mutate(remote.state);
    await assert.rejects(cli.check(remote.args, remote.runtime), /CI verification|fixture API/);
  }
  Object.assign(remote.state, structuredClone(original));
  await assert.rejects(cli.check(remote.args, {...remote.runtime, maxPolls: 0}), /CI verification/);
}));

test('pending CI is polled without AI calls and exact head is rechecked before final acceptance', () => fixture(async f => {
  const remote = await f.remote(); remote.state.runs[0].status = 'in_progress';
  let pauses = 0;
  const result = await cli.check(remote.args, {...remote.runtime, maxPolls: 2, pause: async milliseconds => {
    assert.equal(milliseconds, 15000); pauses++; remote.state.runs[0].status = 'completed';
  }});
  assert.equal(result.installation_verified, true); assert.equal(pauses, 1);
  remote.state.runs[0].status = 'in_progress';
  await assert.rejects(cli.check(remote.args, {...remote.runtime, maxPolls: 2, pause: async () => {remote.state.pr.head.sha = 'b'.repeat(40);}}), /exact-revision/);
}));

test('the default polling delay waits for complete independent CI using the same frozen candidate', t => fixture(async f => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const remote = await f.remote(); remote.state.runs[0].status = 'in_progress';
  let settled = false;
  const checking = cli.check(remote.args, {...remote.runtime, pause: undefined, maxPolls: 2});
  checking.then(() => {settled = true;}, () => {settled = true;});
  for (let round = 0; round < 1000 && !settled; round++) {
    await Promise.resolve();
    if (remote.state.calls.some(call => call.endpoint.includes('/workflows/ci.yml/runs?'))) {
      remote.state.runs[0].status = 'completed';
      t.mock.timers.tick(15000);
    }
  }
  assert.equal(settled, true);
  assert.equal((await checking).installation_verified, true);
}));

test('native authorization and base are freshly revalidated after independent CI settles', () => fixture(async f => {
  const remote = await f.remote();
  for (const mutate of [() => {f.live.comment.body += '\n';}, () => {f.live.permission.permission = 'write';},
    () => {f.live.base.commit.sha = 'b'.repeat(40);},
  ]) {
    f.live.comment.body = bootstrap.grantBody(f.manifest); f.live.permission.permission = 'admin'; f.live.base.commit.sha = f.base;
    remote.state.runs[0].status = 'in_progress';
    await assert.rejects(cli.check(remote.args, {...remote.runtime, maxPolls: 2, pause: async () => {
      mutate(); remote.state.runs[0].status = 'completed';
    }}), /changed|administrator/);
  }
}));

test('a private unprotected repository cannot silently opt into general automatic merge', () => fixture(async f => {
  const remote = await f.remote();
  f.live.repository.private = true; f.live.repository.allow_auto_merge = false; f.live.base.protected = false;
  await assert.rejects(cli.check(remote.args, remote.runtime), /explicit manual or strict owner automatic mode/);
  f.config.merge_mode = 'manual'; fs.writeFileSync(path.join(f.directory, '.github/clouseau.json'), JSON.stringify(f.config));
  git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'ci: require manual first-install acceptance']); await f.refresh();
  const manual = await f.remote();
  assert.equal((await cli.check(manual.args, manual.runtime)).auto_merge_authorized, false);
  f.live.repository.allow_auto_merge = true;
  await assert.rejects(cli.check(manual.args, manual.runtime), /disabled repository auto-merge/);
  f.live.repository.allow_auto_merge = false;
  f.config.merge_mode = 'automatic'; fs.writeFileSync(path.join(f.directory, '.github/clouseau.json'), JSON.stringify(f.config));
  git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'ci: explicitly require strict owner automatic mode']); await f.refresh();
  const automatic = await f.remote();
  const accepted = await cli.check(automatic.args, automatic.runtime);
  assert.equal(accepted.auto_merge_authorized, false);
  assert.equal(accepted.manual_owner_acceptance_required, true);
}));
