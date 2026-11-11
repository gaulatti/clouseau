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

test('explained, the same decision also names the class of a refused receipt and nothing else', async t => {
  const explain = (value = pr) => attestation.receiptAttests({github: github(value), repo: {owner: 'o', repo: 'r'}, pr: value, config, engine: null, explain: true});
  assert.deepEqual(await attestation.receiptAttests({github: github(), repo: {}, pr, config: {}, engine: null, explain: true}), {attests: false, rejected: null, detail: {}});
  screen(t, {ref: null, rejected: null});
  assert.deepEqual(await explain(), {attests: false, rejected: null, detail: {}});
  screen(t, {ref: null, rejected: 'expired', detail: {expires: '2026-11-01T00:00:00.000Z'}});
  assert.deepEqual(await explain(), {attests: false, rejected: 'expired', detail: {expires: '2026-11-01T00:00:00.000Z'}});
  screen(t, {ref: null, rejected: 'malformed'});
  assert.deepEqual(await explain(), {attests: false, rejected: 'malformed', detail: {}});
  screen(t, verified(), 'source');
  assert.deepEqual(await explain(), {attests: false, rejected: 'source', detail: {}});
  screen(t, verified());
  assert.deepEqual(await explain(), {attests: true, rejected: null, detail: {}});
  screen(t, verified({verification: {content: '{'}, config: source()}));
  assert.deepEqual(await explain(), {attests: false, rejected: null, detail: {}});
  screen(t, verified({verification: {content: JSON.stringify(technical())}, config: source()}));
  assert.deepEqual(await explain(), {attests: false, rejected: null, detail: {}});
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

// Policy side: skipped required steps are accepted only on an attestation. The policy suite stays untouched to keep its evidence small.
const {createPolicy} = require('./policy.cjs');
const policyConfig = require('../test/fixtures/config.json');
const PR_REPO = {owner: 'gaulatti', repo: 'colombo'};
const small = {number: 8, head: {sha: HEAD, ref: 'fix/naming', repo: {id: 42}}, base: {sha: BASE, ref: 'main'}};
function ci(stepConclusions) {
  const steps = policyConfig.verification.steps.map((name, index) => ({name, conclusion: stepConclusions[index] ?? 'success'}));
  return {rest: {actions: {
    listWorkflowRuns: async () => ({data: {workflow_runs: [{id: 22, head_sha: HEAD, head_branch: 'fix/naming', head_repository: {id: 42}, pull_requests: [],
      event: 'pull_request', status: 'completed', conclusion: 'success', html_url: 'https://github.com/gaulatti/colombo/actions/runs/22'}]}}),
    listJobsForWorkflowRun: async () => ({data: [{name: policyConfig.verification.job, conclusion: 'success', steps}]}),
  }}, paginate: async (method, options) => (await method(options)).data};
}

test('skipped required steps count only when a valid receipt attests the verification', async () => {
  const seen = [];
  const attesting = answer => createPolicy(policyConfig, {attested: async (github, repository, pull) => {seen.push([repository, pull.number]); return answer;}});
  const skipped = () => ci(policyConfig.verification.steps.map(() => 'skipped'));
  assert.match((await attesting(true).technicalRun(skipped(), PR_REPO, small)).url, /runs\/22/);
  assert.deepEqual(seen, [[PR_REPO, 8]]);
  assert.match((await attesting(false).technicalRun(skipped(), PR_REPO, small)).failure, /Required verification step "[^"]+" concluded skipped/);
  assert.match((await createPolicy(policyConfig).technicalRun(skipped(), PR_REPO, small)).failure, /concluded skipped/);
  // A failed step is never excused by an attestation, and a fully successful job never asks for one.
  assert.match((await attesting(true).technicalRun(ci(['skipped', 'failure']), PR_REPO, small)).failure, /concluded failure/);
  seen.length = 0;
  assert.ok((await attesting(true).technicalRun(ci([]), PR_REPO, small)).url);
  assert.deepEqual(seen, []);
});

test('a skipped required step names why the receipt no longer attests, and only a refused receipt changes the message', async () => {
  const answering = answer => createPolicy(policyConfig, {attested: async () => answer});
  const skipped = () => ci(policyConfig.verification.steps.map(() => 'skipped'));
  const plain = /^Required verification step "[^"]+" concluded skipped$/;
  const failure = async (answer, pull = small) => (await answering(answer).technicalRun(skipped(), PR_REPO, pull)).failure;
  // No receipt at all, a valid receipt that attests nothing, or a plain boolean: the failure is exactly as before.
  assert.match(await failure({attests: false, rejected: null, detail: {}}), plain);
  assert.match(await failure(false), plain);
  assert.match(await failure(null), plain);
  assert.match(await failure({attests: false, rejected: 'not-a-class', detail: {}}), plain);
  assert.ok((await answering({attests: true, rejected: null, detail: {}}).technicalRun(skipped(), PR_REPO, small)).url);
  // An expired receipt: the class, its expiry instant and the steps that fix it, with nothing from the receipt itself.
  const expired = await failure({attests: false, rejected: 'expired', detail: {expires: '2026-11-01T00:00:00.000Z', injected: '@someone <b>'}});
  assert.match(expired, /^Required verification step "[^"]+" concluded skipped: the pull request's local review receipt no longer attests the verification \(cause: `receipt_expired`: it is expired or not yet valid \(it expires `2026-11-01T00:00:00.000Z`\)\)\. Re-run the verification workflow for this head so CI runs the step itself, or renew the receipt first with `clouseau refresh --pr 8` so the step can be skipped again\.$/);
  assert.doesNotMatch(expired, /someone|<b>/);
  // A malformed expiry is not shown; an unknown number stays a placeholder.
  assert.match(await failure({attests: false, rejected: 'expired', detail: {expires: 'tomorrow'}}, {...small, number: 0}),
    /\(cause: `receipt_expired`: it is expired or not yet valid\)\. .*`clouseau refresh --pr PR_NUMBER`/);
  // Any other class names itself and the one generic step.
  assert.match(await failure({attests: false, rejected: 'revision_head', detail: {}}),
    /\(cause: `receipt_revision_head`: [^)]+\)\. Re-run the verification workflow for this head so CI runs the step itself\.$/);
});

test('a version 2 policy asks the receipt verifier whether verification is attested', async t => {
  const calls = [];
  t.mock.method(attestation, 'receiptAttests', async options => {calls.push(options); return true;});
  const policy = createPolicy({...policyConfig, version: 2,
    acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash', repair_attempts: 2}}, {engine: null});
  assert.ok((await policy.technicalRun(ci(policyConfig.verification.steps.map(() => 'skipped')), PR_REPO, small)).url);
  assert.equal(calls.length, 1); assert.equal(calls[0].pr, small); assert.equal(calls[0].config.version, 2);
  assert.equal(calls[0].explain, true);
});
