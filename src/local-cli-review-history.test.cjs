'use strict';
// `clouseau review` with and without the base's `"review_history": "pull_request"` (docs/review-history.md), end
// to end through runReview: the signed prior history, the local history written after the
// review, what is said on stderr, and every gh call.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {git} = require('./local-git.cjs');
const {digest} = require('./acceptance.cjs');
const {MARKER} = require('./acceptance-ledger.cjs');
const {repository} = require('../test/local-git-fixture.cjs');
const {initializeIdentity, runReview, main} = require('./local-cli.cjs');

const SLUG = 'example/local-fixture';
const fixtureInstallation = () => ({sha: 'e'.repeat(40), digest: require('./local-version.cjs').engineDigest(), clean: true});
const finding = (key, extra = {}) => ({id: key.repeat(64), kind: 'technical', blocking: false, state: 'advisory_closed',
  title: `Fictional finding ${key}`, path: 'src/handler.js', cause: `Cause ${key}.`, obligation: `Settle ${key}.`, ...extra});
const ledger = (findings, number = 7) => ({id: 900, user: {login: 'github-actions[bot]', type: 'Bot'}, body: `${MARKER}\n## Clouseau\n` +
  `<!-- clouseau-state:${Buffer.from(JSON.stringify({version: 2, repository: SLUG, number, head_sha: 'a'.repeat(40), findings})).toString('base64')} -->`});

function fakeHarness() {
  let calls = 0;
  const ask = async task => {
    let value;
    if (task.phase === 'investigation') {
      const report = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1)).template;
      report.gates.forEach(gate => {gate.state = 'satisfied';});
      value = {kind: 'report', report, request_sources: []};
    } else value = {answers: Object.fromEntries(Object.keys(task.schema.properties.answers.properties).map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))};
    return {value, provenance: {harness: 'codex', role: task.role, phase: task.phase, session: `fictional-session-${++calls}`,
      request_digest: digest(task), response_digest: digest(value), transport_digest: digest({fixture_only: value})}};
  };
  return ask;
}

// A gh stand-in for the repository fixture (origin example/local-fixture, branch main): `routes` answers an endpoint.
function gh(routes = {}) {
  const calls = [];
  const execute = (program, args) => {
    assert.equal(program, 'gh');
    const endpoint = args[0] === 'api' && args[1] === '--hostname' ? args[5] : args[1];
    calls.push(endpoint);
    const answer = {
      [`repos/${SLUG}`]: {fork: false},
      [`repos/${SLUG}/pulls?head=example:main&state=open&per_page=100`]: [{number: 7}],
      [`repos/${SLUG}/issues/7/comments?per_page=100&page=1`]: [],
      ...routes,
    }[endpoint];
    if (answer === undefined) throw new Error(`unexpected gh call ${endpoint}`);
    if (answer instanceof Error) throw answer;
    return JSON.stringify(answer);
  };
  return {execute, calls};
}
const DISCOVERY = [`repos/${SLUG}`, `repos/${SLUG}/pulls?head=example:main&state=open&per_page=100`, `repos/${SLUG}/issues/7/comments?per_page=100&page=1`];

// The local history `clouseau review` keeps for this branch, as an earlier review on another head wrote it.
const historyFile = (state, branch = 'main') => path.join(state, 'ledgers', `${digest({repository: SLUG, branch})}.json`);
function seedHistory(state, findings) {
  fs.mkdirSync(path.dirname(historyFile(state)), {recursive: true});
  fs.writeFileSync(historyFile(state), JSON.stringify({version: 1, repository: SLUG, branch: 'main', head_sha: 'c'.repeat(40), base_sha: 'c'.repeat(40),
    reviewer_sha: 'e'.repeat(40), reviewer_digest: 'e'.repeat(64), request_digest: 'd'.repeat(64), cache_id: 'f'.repeat(64), has_receipt: false,
    decision: 'auto_approve', findings}));
}

const withKey = directory => {
  const recipe = path.join(directory, '.clouseau-local.json');
  fs.writeFileSync(recipe, JSON.stringify({...JSON.parse(fs.readFileSync(recipe, 'utf8')), review_history: 'pull_request'}));
};

// Runs one review with stderr captured; returns the result, the signed record, the written history and the stderr lines.
async function review(f, {state, execute, ask = fakeHarness(), verify = () => ({fixture_execution_only: true}), extra = {}, runtime = {}, branch = 'main'}) {
  const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
  const lines = []; const write = process.stderr.write;
  process.stderr.write = chunk => {lines.push(...String(chunk).split('\n').filter(Boolean)); return true;};
  try {
    const result = await runReview({directory: f.directory, base: f.base, 'request-file': request, harness: 'claude', ...extra},
      {state, ask, attest: technical => technical, verify, installed: fixtureInstallation, execute, ...runtime});
    return {result, record: JSON.parse(fs.readFileSync(result.record, 'utf8')), history: JSON.parse(fs.readFileSync(historyFile(state, branch), 'utf8')), lines};
  } finally {process.stderr.write = write;}
}
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-review-history-'));
const LOCAL = [finding('1'), finding('2', {blocking: true, state: 'corrected'})];

test('without review_history a review makes no gh call, says nothing new and reviews against the local history as before', () => repository(async f => {
  const state = scratch();
  try {
    seedHistory(state, LOCAL);
    const stub = gh();
    const absent = await review(f, {state, execute: stub.execute});
    assert.deepEqual(stub.calls, [], 'no gh call at all');
    assert.deepEqual(absent.lines, [], 'nothing on stderr');
    assert.equal(absent.result.decision, 'auto_approve');
    // The signed prior history is the local history, exactly as before the key existed.
    assert.deepEqual(absent.record.snapshot.prior_findings, LOCAL);
    assert.deepEqual(absent.record.local_previous, {findings: LOCAL});
    assert.deepEqual(absent.history.findings.map(item => [item.id, item.state]), LOCAL.map(item => [item.id, item.state]));
    assert.equal(absent.history.branch, 'main');
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}));

test('with review_history and no open pull request the review is the same as without the key, and says nothing', async () => {
  const outcomes = [];
  for (const setup of [() => {}, withKey]) {
    await repository(async f => {
      const state = scratch();
      try {
        seedHistory(state, LOCAL);
        const stub = gh({[DISCOVERY[1]]: []});
        const run = await review(f, {state, execute: stub.execute});
        outcomes.push({calls: stub.calls, lines: run.lines, decision: run.result.decision, prior: run.record.snapshot.prior_findings,
          local: run.record.local_previous, written: run.history.findings, has_receipt: run.history.has_receipt});
      } finally {fs.rmSync(state, {recursive: true, force: true});}
    }, setup);
  }
  assert.deepEqual(outcomes[0].calls, []);
  assert.deepEqual(outcomes[1].calls, DISCOVERY.slice(0, 2));
  assert.deepEqual({...outcomes[1], calls: []}, outcomes[0]);
});

test('with review_history an open pull request\'s ledger is the signed prior history, and a local-only blocker is named', () => repository(async f => {
  const state = scratch();
  try {
    const L = [finding('b')];
    seedHistory(state, [finding('a', {blocking: true, state: 'confirmed'}), finding('c'), ...L]);
    const stub = gh({[DISCOVERY[2]]: [ledger(L)]});
    const run = await review(f, {state, execute: stub.execute});
    assert.deepEqual(stub.calls, DISCOVERY);
    assert.equal(run.result.decision, 'auto_approve');
    assert.deepEqual(run.record.snapshot.prior_findings, L, 'In = L by construction');
    assert.deepEqual(run.record.local_previous, {findings: L});
    assert.deepEqual(run.lines, [`Local-only finding not on the pull request ledger: ${'a'.repeat(64)} "Fictional finding a" (confirmed)`]);
    // The local history is still written after the review: Out reconciled with L.
    assert.deepEqual(run.history.findings.map(item => [item.id, item.state]), [['b'.repeat(64), 'advisory_closed']]);
    assert.equal(run.history.decision, 'auto_approve');
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}, withKey));

test('with review_history a changed ledger is a new review input on the same head; an unchanged one is the same input', () => repository(async f => {
  const state = scratch();
  try {
    const routes = {[DISCOVERY[2]]: [ledger([finding('b')])]};
    const first = await review(f, {state, execute: gh(routes).execute});
    assert.deepEqual(first.record.snapshot.prior_findings, [finding('b')]);
    // The same ledger again: the same input, which never runs twice.
    await assert.rejects(review(f, {state, execute: gh(routes).execute}), /This exact review input has already run/);
    // A hosted review published in between: the same head is reviewed against the ledger now on the pull request.
    routes[DISCOVERY[2]] = [ledger([finding('b'), finding('c')])];
    const second = await review(f, {state, execute: gh(routes).execute});
    assert.equal(second.result.decision, 'auto_approve');
    assert.deepEqual(second.record.snapshot.prior_findings, [finding('b'), finding('c')]);
    assert.notEqual(second.result.record, first.result.record);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}, withKey));

test('with review_history a pull request without a ledger comment reviews against an empty history', () => repository(async f => {
  const state = scratch();
  try {
    seedHistory(state, [finding('a', {blocking: true, state: 'outstanding'})]);
    const stub = gh({[DISCOVERY[2]]: [{id: 5, user: {login: 'fixture-author'}, body: 'Ready.'}]});
    const run = await review(f, {state, execute: stub.execute});
    assert.deepEqual(run.record.snapshot.prior_findings, []);
    assert.equal(run.result.decision, 'auto_approve', 'the local-only blocker is not carried in, so it cannot hold the review');
    assert.deepEqual(run.lines, [`Local-only finding not on the pull request ledger: ${'a'.repeat(64)} "Fictional finding a" (outstanding)`]);
    assert.deepEqual(run.history.findings, []);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}, withKey));

test('with review_history every ledger failure stops the review before verification, a harness call or a history write', () => repository(async f => {
  const failure = (stderr, status = 1) => Object.assign(new Error('Command failed: gh api'), {status, stderr});
  const cases = [
    [{[DISCOVERY[0]]: Object.assign(new Error('spawnSync gh ENOENT'), {code: 'ENOENT'})}, /^Pull request ledger: gh is not available/],
    [{[DISCOVERY[0]]: failure('To get started with GitHub CLI, please run:  gh auth login', 4)}, /^Pull request ledger: gh is not authenticated/],
    [{[DISCOVERY[1]]: failure('error connecting to api.github.com')}, /^Pull request ledger: the pull request lookup failed \(error connecting to api\.github\.com\)/],
    [{[DISCOVERY[1]]: [{number: 7}, {number: 8}]}, /^Pull request ledger: more than one open pull request for branch main \(#7, #8\)/],
    [{[DISCOVERY[0]]: {fork: true}}, /^Pull request ledger: forks are not supported yet/],
    [{[DISCOVERY[2]]: failure('gh: Server Error (HTTP 502)')}, /^Pull request ledger: the ledger could not be read \(GitHub status 502/],
    [{[DISCOVERY[2]]: [ledger([finding('b')], 8)]}, /^Pull request ledger: the ledger failed validation/],
  ];
  for (const [routes, message] of cases) {
    const state = scratch();
    try {
      seedHistory(state, LOCAL);
      const before = fs.readFileSync(historyFile(state), 'utf8');
      const unreachable = () => {throw new Error('Must not verify or ask');};
      const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
      await assert.rejects(runReview({directory: f.directory, base: f.base, 'request-file': request, harness: 'claude'},
        {state, ask: unreachable, verify: unreachable, attest: unreachable, installed: fixtureInstallation, execute: gh(routes).execute}), error => {
        assert.match(error.message, message); return true;
      });
      assert.equal(fs.readFileSync(historyFile(state), 'utf8'), before, 'the local history is untouched');
      assert.equal(fs.existsSync(path.join(state, 'reviews')), false, 'no review evidence was started');
    } finally {fs.rmSync(state, {recursive: true, force: true});}
  }
}, withKey));

test('with review_history, --pr reads the attested pull request\'s ledger instead of discovering one by branch', async () => {
  const state = scratch();
  try {
    const identity = initializeIdentity(state, 'fixture-maintainer');
    const config = {...require('../test/fixtures/config.json'), version: 2, repository_policy: 'AGENTS.md', readme: 'README.md',
      acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash', repair_attempts: 2},
      local_review: {mode: 'optional', reviewer_digest: 'e'.repeat(64), max_age_seconds: 3600, keys: [identity.public_identity], attest: {authors: ['dependabot[bot]']}}};
    await repository(async f => {
      const L = [finding('b')];
      const pull = {author: 'dependabot[bot]', state: 'open', base: 'main', head: git(f.directory, ['rev-parse', 'HEAD']).trim()};
      const stub = gh({[`repos/${SLUG}/pulls/7`]: pull, [DISCOVERY[2]]: [ledger(L)]});
      const reviewState = fs.mkdtempSync(path.join(state, 'review-'));
      const run = await review(f, {state: reviewState, execute: stub.execute, extra: {identity: identity.identity_file, pr: '7'},
        runtime: {installed: () => ({sha: 'e'.repeat(40), digest: 'e'.repeat(64), clean: true}), verify: () => ({})}, branch: 'pull/7'});
      assert.deepEqual(stub.calls, [`repos/${SLUG}/pulls/7`, DISCOVERY[2]], 'no fork check and no lookup by branch');
      assert.deepEqual(run.record.snapshot.prior_findings, L);
      assert.deepEqual(run.result.maintainer_attested, {author: 'dependabot[bot]', pull_request: 7});
      assert.deepEqual(JSON.parse(fs.readFileSync(run.result.receipt)).payload.record.local_previous, {findings: L});
    }, directory => {
      withKey(directory);
      fs.mkdirSync(path.join(directory, '.github'));
      fs.writeFileSync(path.join(directory, '.github/clouseau.json'), JSON.stringify(config));
    });
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});

test('the review_history value is validated where the base recipe is read', () => repository(async f => {
  const state = scratch();
  try {
    const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
    await assert.rejects(main(['review', '--directory', f.directory, '--base', f.base, '--request-file', request, '--harness', 'claude'],
      {state, ask: fakeHarness(), installed: fixtureInstallation, execute: gh().execute}),
    /^Error: Invalid local-only Clouseau configuration: review_history must be "pull_request" when set$/);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}, directory => {
  const recipe = path.join(directory, '.clouseau-local.json');
  fs.writeFileSync(recipe, JSON.stringify({...JSON.parse(fs.readFileSync(recipe, 'utf8')), review_history: 'local'}));
}));
