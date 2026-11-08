'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const attestation = require('./verification-attestation.cjs');
const gate = require('./coverage-gate.cjs');
const receipts = require('./local-receipt.cjs');
const {digest} = require('./acceptance.cjs');

const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const recipe = {version: 2, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md', verification: [['run', 'tests']],
  coverage: [{format: 'lcov', report: 'cov/lcov.info', source_directory: 'src', source_suffixes: ['.rs']}]};
const command = (extra = {}) => ({argv: ['run', 'tests'], exit_code: 0, ...extra});
const technical = (extra = {}) => ({commands: [command()], verification_status: 'passed', local_config_digest: digest(recipe),
  coverage: {status: 'exact', passed: true, artifact_freshness: 'observed_current_run'}, ...extra});
const attested = (mode = 'exact', extra = {}) => ({...technical(), attestation: {version: 1, recipe: digest(recipe), commands: 1, coverage_mode: mode, gate: 'passed', ...extra}});

test('a record attests only when it says so and its own facts agree', () => {
  assert.ok(attestation.attestationOf(attested()));
  assert.equal(attestation.attestationOf(null), null);
  assert.equal(attestation.attestationOf(technical()), null);
  for (const mutate of [
    t => {t.attestation.version = 2;}, t => {t.attestation.coverage_mode = 'other';}, t => {t.attestation.gate = 'failed';},
    t => {t.commands = [];}, t => {t.attestation.commands = 2;}, t => {t.verification_status = 'failed';},
    t => {t.commands[0].exit_code = 1;}, t => {t.commands[0].error = {code: 'ENOENT'};}, t => {t.commands[0].signal = 'SIGTERM';},
    t => {t.coverage.status = 'unavailable';}, t => {t.coverage.artifact_freshness = 'unverified';},
    t => {delete t.coverage;}, t => {t.attestation.recipe = 'y';},
  ]) {
    const value = attested(); mutate(value);
    assert.equal(attestation.attestationOf(value), null, JSON.stringify(mutate.toString()));
  }
});

const refused = (value, pattern, options = {}) => assert.throws(() => attestation.evaluate({directory: '/x', config: recipe, ciConfig: {}, baseSha: BASE, verify: () => {}, ...options, technical: value}),
  error => pattern.test(error.message) && /no receipt is signed/.test(error.message));

test('a signature is refused unless every declared command ran and passed', () => {
  refused(technical({commands: [command({exit_code: null, error: {code: 'ENOENT', message: 'spawn'}})]}), /run tests could not run \(ENOENT\); install the tool/);
  refused(technical({commands: [command({exit_code: null, error: {message: 'odd'}})]}), /could not run \(odd\)/);
  refused(technical({commands: [command({exit_code: null, signal: 'SIGTERM'})]}), /stopped by SIGTERM/);
  refused(technical({commands: [command({exit_code: null})]}), /did not exit/);
  refused(technical({commands: [command(), command({argv: ['x'.repeat(200)], exit_code: 2})]}), /x{117}\.\.\. exited 2/);
});

test('a signature is refused without observed native coverage', () => {
  refused(technical({coverage: {status: 'unavailable', error: 'ENOENT', artifact_freshness: 'unverified'}}), /coverage is unavailable \(ENOENT\)/);
  refused(technical({coverage: {status: 'unavailable', artifact_freshness: 'unverified'}}), /unavailable \(no report\)/);
  refused(technical({coverage: {status: 'exact', passed: true, artifact_freshness: 'unverified'}}), /not produced by this run/);
});

test('exact mode needs exactly full coverage', () => {
  const result = attestation.evaluate({directory: '/x', config: recipe, technical: technical(), ciConfig: null, baseSha: BASE});
  assert.deepEqual(result.attestation, {version: 1, recipe: digest(recipe), commands: 1, coverage_mode: 'exact', gate: 'passed'});
  assert.ok(attestation.attestationOf(result));
  refused(technical({coverage: {status: 'below_threshold', passed: false, artifact_freshness: 'observed_current_run'}}), /exact coverage gate fails: line and branch coverage is not exactly 100%/);
});

test('changed_lines measures the base revision in a clean worktree and removes it', t => {
  const calls = [];
  const exec = (name, args) => {calls.push(args.slice(2).join(' ').replace(/ \S+clouseau-base-\S+/, ' TREE'));};
  const verified = [];
  t.mock.method(gate, 'measurePlan', () => ({totals: {lines: [4, 4], branches: [2, 2]}}));
  let baseline;
  t.mock.method(gate, 'changedPlan', (parts, directory, base, file) => {baseline = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(base, BASE); assert.equal(directory, '/x');});
  const verify = options => {verified.push(options.directory); return {verification_status: 'passed', commands: []};};
  const result = attestation.evaluate({directory: '/x', config: recipe, technical: technical(), ciConfig: {coverage: {mode: 'changed_lines'}}, baseSha: BASE, verify, exec});
  assert.equal(result.attestation.coverage_mode, 'changed_lines');
  assert.deepEqual(baseline, {lines: [4, 4], branches: [2, 2]});
  assert.match(verified[0], /clouseau-base-.*tree$/);
  assert.deepEqual(calls.map(call => call.split(' ')[0]), ['worktree', 'worktree']);
  assert.ok(!fs.existsSync(verified[0]));
});

test('changed_lines refuses a changed line left uncovered, a failing base and a worktree that cannot be removed', t => {
  t.mock.method(gate, 'measurePlan', () => ({totals: {lines: [1, 1], branches: [0, 0]}}));
  t.mock.method(gate, 'changedPlan', () => {throw new Error('lines: 1 changed uncovered');});
  const ok = () => ({verification_status: 'passed', commands: []});
  const ciConfig = {coverage: {mode: 'changed_lines'}};
  refused(technical(), /changed_lines coverage gate fails: lines: 1 changed uncovered/, {ciConfig, verify: ok, exec: (name, args) => {if (args[3] === 'remove') throw new Error('cannot remove');}});
  refused(technical(), /base revision's own verification failed \(run tests exited 1; run tests could not run \(ENOENT\)/, {ciConfig, exec() {},
    verify: () => ({verification_status: 'failed', commands: [command({exit_code: 1}), command({exit_code: null, error: {code: 'ENOENT'}}), command()]})});
});

test('declared mode is held to the minimums at the base revision', t => {
  const seen = [];
  t.mock.method(gate, 'declaredPlan', (parts, directory, base) => {seen.push(base);});
  const result = attestation.evaluate({directory: '/x', config: recipe, technical: technical(), ciConfig: {coverage: {mode: 'declared'}}, baseSha: BASE});
  assert.equal(result.attestation.coverage_mode, 'declared');
  assert.deepEqual(seen, [BASE]);
  t.mock.method(gate, 'declaredPlan', () => {throw new Error('below declared');});
  refused(technical(), /declared coverage gate fails: below declared/, {ciConfig: {coverage: {mode: 'declared'}}});
});

// CI side.
const trust = {mode: 'optional', max_age_seconds: 3600, keys: []};
const config = {base_branch: 'main', local_review: trust};
const pr = {number: 8, state: 'open', draft: false, base: {ref: 'main', sha: BASE}, head: {sha: HEAD}};
const github = (value = pr) => ({paginate: async () => [], rest: {pulls: {get: async () => ({data: value}), listFiles() {}}}});
const source = (value = recipe) => ({path: '.clouseau-local.json', ref: BASE, content: JSON.stringify(value)});
const verified = (sources = {verification: {content: JSON.stringify(attested())}, config: source()}) => ({ref: 'r'.repeat(40), bundle: {payload: {reviewer_sha: 'e'.repeat(40)}}, verified: {record: {snapshot: {sources}}}});
const screen = (t, screened, rejected = null) => {
  t.mock.method(receipts, 'screenReceipt', async () => screened);
  t.mock.method(receipts, 'screenSources', async () => rejected);
};
const run = (value = pr) => attestation.receiptAttests({github: github(value), repo: {owner: 'o', repo: 'r'}, pr: value, config, engine: null});

test('only a fully valid receipt that attests the accepted recipe lets CI skip verification', async t => {
  assert.equal(await attestation.receiptAttests({github: github(), repo: {}, pr, config: {}, engine: null}), false);
  screen(t, {ref: null});
  assert.equal(await run(), false);
  screen(t, verified(), 'source');
  assert.equal(await run(), false);
  screen(t, verified());
  assert.equal(await run(), true);
  const bad = {verification: {content: JSON.stringify(attested())}};
  screen(t, verified(bad)); assert.equal(await run(), false);
  screen(t, verified({...bad, config: {...source(), ref: HEAD}})); assert.equal(await run(), false);
  screen(t, verified({...bad, config: {...source(), content: 'not json'}})); assert.equal(await run(), false);
  screen(t, verified({...bad, config: source({...recipe, verification: [['other']]})})); assert.equal(await run(), false);
  screen(t, verified({verification: {content: '{'}, config: source()})); assert.equal(await run(), false);
  screen(t, verified({verification: {content: JSON.stringify(technical())}, config: source()})); assert.equal(await run(), false);
});

test('the attested operation decides for the pull request in context', async t => {
  screen(t, verified());
  const context = {repo: {owner: 'o', repo: 'r'}, payload: {pull_request: {number: 8}}};
  const decide = (value, ctx = context) => attestation.decide({github: github(value), context: ctx, config, engine: null});
  assert.equal(await decide(pr), true);
  await assert.rejects(decide(pr, {...context, payload: {}}), /pull request context/);
  assert.equal(await decide({...pr, state: 'closed'}), false);
  assert.equal(await decide({...pr, draft: true}), false);
  assert.equal(await decide({...pr, base: {ref: 'other', sha: BASE}}), false);
});
