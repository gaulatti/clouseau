'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {git} = require('./local-git.cjs');
const {digest} = require('./acceptance.cjs');
const {repository} = require('../test/local-git-fixture.cjs');
const {initializeIdentity, runReview, main} = require('./local-cli.cjs');
const {verifyReceipt, validateTrust} = require('./local-receipt.cjs');
const {problem, settings, verifierOptions, DEFAULT_SETTINGS} = require('./chunked-wiring.cjs');
const {isRoot} = require('./receipt-parts.cjs');
const {scaledTable, withLargeFile} = require('../test/chunked-measure.cjs');
const {writeBase, commitHead} = require('../test/chunked-repo.cjs');
const table = require('../test/fixtures/alcantara-02618a9.json');

const REVIEWER = 'e'.repeat(40);

// A harness that answers every kind of chunked task honestly: unit reports from the template, every seam checked.
let instances = 0;
function harness({failAfter = Infinity, delay = 0} = {}) {
  const instance = ++instances;
  const stats = {calls: 0, phases: {}};
  const ask = async task => {
    if (stats.calls >= failAfter) throw new Error('fictional harness outage');
    stats.calls++; stats.phases[task.phase] = (stats.phases[task.phase] ?? 0) + 1;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
    let value;
    if (task.phase === 'investigation') {
      const report = packet.template;
      report.gates.forEach(gate => {gate.state = 'satisfied';});
      value = {kind: 'report', report, request_sources: []};
    } else {
      assert.equal(task.phase, 'integration', 'a finding-free review is never graded');
      value = {dispositions: packet.seams.map(seam => ({seam: seam.id, state: 'checked', reason: 'Both ends were examined.'}))};
    }
    return {value, provenance: {harness: 'codex', role: task.role, phase: task.phase, session: `fictional-session-${instance}-${stats.calls}`,
      request_digest: digest(task.prompt), response_digest: digest(value), transport_digest: digest({fixture_only: value})}};
  };
  return {ask, stats};
}

async function withChange({rows, chunked, force}, run) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-chunked-state-'));
  try {
    const identity = initializeIdentity(state, 'fixture-author');
    const config = {...require('../test/fixtures/config.json'), version: 2, repository_policy: 'AGENTS.md', readme: 'README.md',
      acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash', repair_attempts: 2},
      local_review: {mode: 'required', reviewer_digest: 'e'.repeat(64), max_age_seconds: 3600, keys: [identity.public_identity],
        ...(chunked || force ? {chunked: {...chunked, ...(force ? {force: true} : {})}} : {})}};
    await repository(async f => {
      commitHead(f.directory, rows);
      const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Add the fictional change.');
      const args = {directory: f.directory, base: f.base, 'request-file': request, identity: identity.identity_file};
      const deps = {state, verify: () => ({fixture_execution_only: true}), installed: () => ({sha: REVIEWER, digest: 'e'.repeat(64), clean: true})};
      await run({f, args, deps, state, config, identity});
    }, directory => {
      writeBase(directory, rows);
      fs.mkdirSync(path.join(directory, '.github'), {recursive: true});
      fs.writeFileSync(path.join(directory, '.github/clouseau.json'), JSON.stringify(config));
    });
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}

// review -> publish -> what CI does: load the committed files, rebuild the bundle, verify it against the protected config.
async function reviewPublishVerify({f, args, deps, state, config}, {expectParts}) {
  const fake = harness();
  const result = await runReview(args, {...deps, ask: fake.ask});
  assert.equal(result.decision, 'auto_approve'); assert.ok(result.receipt);
  assert.equal(result.harness_invocations, fake.stats.calls);
  const bundle = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(isRoot(bundle.payload.record), expectParts, 'multi-part exactly when the record exceeds one receipt');
  const record = JSON.parse(fs.readFileSync(result.record));
  assert.equal(record.version, 3); assert.equal(record.partition.scheme, 'clouseau-partition/1');
  assert.ok(record.partition.units.length > 1);
  assert.equal(fake.stats.calls, record.partition.units.length * 2 + 2);
  const bare = path.join(state, 'artifacts.git'); git(state, ['init', '-q', '--bare', bare]);
  git(f.directory, ['config', 'url.' + bare + '.insteadOf', 'https://github.com/example/local-fixture.git']);
  const published = await main(['publish', '--directory', f.directory, '--receipt', result.receipt]);
  const names = git(bare, ['ls-tree', '--name-only', published.artifact_commit]).trim().split('\n');
  assert.equal(names.length, 1 + (bundle.parts?.length ?? 0));
  const envelope = JSON.parse(git(bare, ['show', `${published.artifact_commit}:clouseau-review.json`], undefined, Infinity));
  const parts = names.filter(name => name !== 'clouseau-review.json').sort()
    .map(name => Buffer.from(git(bare, ['show', `${published.artifact_commit}:${name}`], undefined, Infinity), 'latin1').toString('base64'));
  const rebuilt = parts.length ? {...envelope, parts: bundle.parts} : envelope;
  const common = {trust: config.local_review, repository: record.snapshot.repository, author: 'fixture-author', headSha: record.snapshot.head_sha,
    baseSha: record.snapshot.base_sha, reviewerSha: REVIEWER, reviewerDigest: 'e'.repeat(64), configDigest: record.snapshot.config_digest,
    policyDigest: record.snapshot.policy_digest};
  const verified = verifyReceipt(rebuilt, common);
  assert.equal(verified.decision, 'auto_approve');
  // CI derives its parameters from the protected configuration; a different one never verifies the same receipt.
  const other = {...config.local_review, chunked: {params: {C: 400000, S: 100000}}};
  assert.throws(() => verifyReceipt(rebuilt, {...common, trust: other}), /partition parameters differ/);
  assert.throws(() => verifyReceipt(rebuilt, {...common, trust: {...config.local_review, chunked: {enabled: false}}}), /not enabled for chunked records/);
  git(f.directory, ['config', '--unset', 'url.' + bare + '.insteadOf']);
  return {result, record};
}

test('protected chunked configuration can only tighten the defaults; invalid values are rejected', () => {
  assert.equal(problem(undefined), null);
  assert.equal(settings(undefined).force, false);
  assert.equal(settings({}).params.C, 450000);
  assert.equal(settings({chunked: {enabled: false}}), null);
  const tight = settings({chunked: {force: true, params: {C: 100000, S: 50000}, concurrency: 1, unit_deadline_ms: 1000, integration_cap: 5000}});
  assert.deepEqual(tight, {params: {C: 100000, S: 50000}, concurrency: 1, unit_deadline_ms: 1000, integration_cap: 5000, force: true});
  assert.deepEqual(DEFAULT_SETTINGS.params, {C: 450000, S: 100000});
  assert.equal(verifierOptions({chunked: {enabled: false}}), null);
  assert.deepEqual(verifierOptions(undefined).params, {C: 450000, S: 100000});
  for (const bad of [null, [], 'x', {unknown: 1}, {enabled: 'yes'}, {force: 1}, {enabled: false, force: true}, {params: null}, {params: {C: 1}},
    {params: {C: 450001, S: 1}}, {params: {C: 1, S: 100001}}, {params: {C: 0, S: 1}}, {params: {C: 1.5, S: 1}, },
    {concurrency: 3}, {concurrency: 0}, {unit_deadline_ms: 300001}, {integration_cap: 250001}, {integration_cap: '1'}]) {
    assert.ok(problem(bad), JSON.stringify(bad));
    assert.throws(() => settings({chunked: bad}), /Invalid protected chunked review configuration/);
  }
  const trust = {mode: 'required', reviewer_digest: 'e'.repeat(64), max_age_seconds: 3600,
    keys: [initializeIdentity(fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-trust-')), 'fixture-author').public_identity]};
  assert.equal(validateTrust({...trust, chunked: {params: {C: 300000, S: 100000}}}).chunked.params.C, 300000);
  assert.throws(() => validateTrust({...trust, chunked: {concurrency: 9}}), /invalid protected chunked review configuration/);
});

test('an alcantara-shaped change (85 files, 2.3 MB) is reviewed in units, signed as one receipt and verified by CI', () =>
  withChange({rows: table}, async context => {
    const {record} = await reviewPublishVerify(context, {expectParts: false});
    assert.equal(record.snapshot.files.length, 87, "85 table files plus the two fixture files");
    assert.ok(record.partition.units.length >= 4);
    assert.ok(Array.isArray(record.seams));
  }));

test('a change of more than 170 files is reviewed and signed as a multi-part receipt that CI verifies', () =>
  withChange({rows: scaledTable(table, 2)}, async context => {
    const {record} = await reviewPublishVerify(context, {expectParts: true});
    assert.ok(record.snapshot.files.length > 170);
  }));

test('a single file of three million characters is reviewed in segments and never refused for its size', () =>
  withChange({rows: withLargeFile({files: table.files.slice(0, 3)}, 3000000)}, async context => {
    const {record} = await reviewPublishVerify(context, {expectParts: true});
    const owners = record.partition.units.filter(unit => unit.parts?.['generated/large-module.ts']);
    assert.ok(owners.length > 1, 'the oversized file is owned by one unit per segment');
  }));

test('protected configuration can disable chunked review: an oversized change then fails as it always did', () =>
  withChange({rows: withLargeFile({files: table.files.slice(0, 2)}, 1000000), chunked: {enabled: false}}, async ({args, deps}) => {
    await assert.rejects(runReview(args, {...deps, ask: harness().ask}), /oversized|source budget/);
  }));

test('a change that fits one snapshot is reviewed exactly as before: one snapshot, no partition', () =>
  withChange({rows: {files: table.files.slice(0, 2)}}, async ({args, deps}) => {
    const plain = harness();
    const result = await runReview(args, {...deps, ask: plain.ask});
    assert.equal(result.decision, 'auto_approve');
    assert.equal(plain.stats.calls, 2);
    const record = JSON.parse(fs.readFileSync(result.record));
    assert.equal(record.version, 2); assert.equal(Object.hasOwn(record, 'partition'), false);
  }));

test('forcing chunking on a small change resumes after an outage without sampling a finished call again', () =>
  withChange({rows: {files: table.files.slice(0, 6)}, force: true, chunked: {params: {C: 20000, S: 10000}}}, async ({args, deps, state}) => {
    const broken = harness({failAfter: 3});
    await assert.rejects(runReview(args, {...deps, ask: broken.ask}), /fictional harness outage/);
    const cache = fs.readdirSync(path.join(state, 'reviews'))[0];
    assert.ok(fs.existsSync(path.join(state, 'reviews', cache, 'failure.json')));
    const resumed = harness();
    const result = await runReview(args, {...deps, ask: resumed.ask});
    assert.equal(result.decision, 'auto_approve');
    const record = JSON.parse(fs.readFileSync(result.record));
    assert.equal(resumed.stats.calls, record.partition.units.length * 2 + 2 - 3, 'the three finished calls were replayed from the journal');
    assert.ok(record.partition.units.length > 1);
  }));

test('a unit that exceeds the protected deadline stops the review with the stable refusal and no receipt', () =>
  withChange({rows: {files: table.files.slice(0, 3)}, force: true, chunked: {params: {C: 20000, S: 10000}, unit_deadline_ms: 5}}, async ({args, deps, state}) => {
    await assert.rejects(runReview(args, {...deps, ask: harness({delay: 200}).ask}), /unit_deadline/);
    const cache = path.join(state, 'reviews', fs.readdirSync(path.join(state, 'reviews'))[0]);
    assert.equal(fs.existsSync(path.join(cache, 'receipt.json')), false);
  }));

test('an agent-driven chunked review asks for one session at a time and records nothing as reviewed until it is answered', () =>
  withChange({rows: {files: table.files.slice(0, 3)}, force: true, chunked: {params: {C: 20000, S: 10000}}}, async ({args, deps}) => {
    const first = await runReview({...args, identity: undefined, agent: 'claude'}, {...deps, ask: harness().ask});
    assert.equal(first.status, 'awaiting_agent');
    assert.equal(first.sequence, 1);
    const again = await runReview({...args, identity: undefined, agent: 'claude'}, {...deps, ask: harness().ask});
    assert.equal(again.status, 'awaiting_agent');
    assert.equal(again.sequence, 1);
  }));
