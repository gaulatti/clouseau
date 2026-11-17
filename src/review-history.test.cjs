'use strict';
// `"review_history": "pull_request"` (review-history.cjs): the prior findings of a local review are the pull request's acceptance
// ledger, discovered and read through gh only, and every failure stops the review with one stable prefix.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {MARKER} = require('./acceptance-ledger.cjs');
const history = require('./review-history.cjs');

const repo = {owner: 'example', repo: 'local-fixture'};
const SLUG = 'example/local-fixture';
const finding = (key, extra = {}) => ({id: key.repeat(64), kind: 'technical', blocking: false, state: 'advisory_closed',
  title: `Fictional finding ${key}`, path: 'src/handler.js', cause: `Cause ${key}.`, obligation: `Settle ${key}.`, ...extra});
const state = (findings, extra = {}) => Buffer.from(JSON.stringify({version: 2, repository: SLUG, number: 7, head_sha: 'a'.repeat(40), findings, ...extra})).toString('base64');
const ledger = (findings, extra) => `${MARKER}\n## Clouseau\n<!-- clouseau-state:${state(findings, extra)} -->`;
const bot = (id, body) => ({id, user: {login: 'github-actions[bot]', type: 'Bot'}, body});
const person = (id, body) => ({id, user: {login: 'fixture-author', type: 'User'}, body});
const failure = (stderr, status = 1) => Object.assign(new Error(`Command failed: gh api\n${stderr}`), {status, stderr});
const missing = () => Object.assign(new Error('spawnSync gh ENOENT'), {code: 'ENOENT', errno: -2});

// A gh stand-in: every call must be a GET through `gh api`; `routes` answers an endpoint (an Error is thrown).
function gh(routes) {
  const calls = [];
  const execute = (program, args, options) => {
    assert.equal(program, 'gh');
    assert.deepEqual(args.slice(0, 5), ['api', '--hostname', 'github.com', '--method', 'GET']);
    assert.equal(options.encoding, 'utf8');
    calls.push(args[5]);
    const value = routes(args[5]);
    if (value instanceof Error) throw value;
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  return {execute, calls};
}
const LOOKUP = `repos/${SLUG}/pulls?head=example:feature%2Fledger&state=open&per_page=100`;
const COMMENTS = page => `repos/${SLUG}/issues/7/comments?per_page=100&page=${page}`;
const github = ({origin = {fork: false}, pulls = [{number: 7}], comments = []} = {}) => gh(endpoint => {
  if (endpoint === `repos/${SLUG}`) return origin;
  if (endpoint === LOOKUP) return pulls;
  if (endpoint === COMMENTS(1)) return comments;
  throw new Error(`unexpected endpoint ${endpoint}`);
});
const select = (stub, {local = [], number = null, warnings = []} = {}) => history.priorFindings({local, repo, branch: 'feature/ledger', number,
  execute: stub.execute, warn: line => warnings.push(line)}).then(selected => {
    assert.equal(selected.number, selected.findings === local ? null : 7);
    return selected.findings;
  });

test('no open pull request for the branch is a definite answer: the local history, and nothing said', async () => {
  const local = [finding('a', {blocking: true, state: 'confirmed'})];
  const stub = github({pulls: []}); const warnings = [];
  assert.equal(await select(stub, {local, warnings}), local);
  assert.deepEqual(stub.calls, [`repos/${SLUG}`, LOOKUP]);
  assert.deepEqual(warnings, []);
});

test('an open pull request\'s newest bot ledger is the prior history, and each local-only unresolved blocker is named', async () => {
  const L = [finding('b'), finding('c', {blocking: true, state: 'confirmed'})];
  const older = [finding('9')];
  const local = [finding('c', {blocking: true, state: 'confirmed'}), finding('d', {blocking: true, state: 'confirmed', title: 'Two\nlines'}),
    finding('e', {blocking: true, state: 'outstanding'}), finding('f', {state: 'corrected'}), finding('1', {state: 'dismissed'}), finding('2'),
    finding('3', {blocking: false, state: 'confirmed'})];
  const comments = [bot(1, ledger(older)), person(2, ledger([finding('8')])), bot(3, 'An unrelated bot comment'), bot(4, ledger(L)), person(5, 'Thanks')];
  const stub = github({comments}); const warnings = [];
  assert.deepEqual(await select(stub, {local, warnings}), L);
  assert.deepEqual(stub.calls, [`repos/${SLUG}`, LOOKUP, COMMENTS(1)]);
  assert.deepEqual(warnings, [
    `Local-only finding not on the pull request ledger: ${'d'.repeat(64)} "Two lines" (confirmed)`,
    `Local-only finding not on the pull request ledger: ${'e'.repeat(64)} "Fictional finding e" (outstanding)`,
  ]);
});

test('a pull request with no ledger comment has an empty ledger, so the prior history is empty', async () => {
  const local = [finding('a', {blocking: true, state: 'confirmed'}), finding('b')];
  const stub = github({comments: [person(1, ledger([finding('7')])), bot(2, 'No marker here')]}); const warnings = [];
  assert.deepEqual(await select(stub, {local, warnings}), []);
  assert.deepEqual(warnings, [`Local-only finding not on the pull request ledger: ${'a'.repeat(64)} "Fictional finding a" (confirmed)`]);
});

test('a known pull request number reads that ledger without any discovery, across every page of comments', async () => {
  const L = [finding('b')];
  const page = Array.from({length: 100}, (_, index) => person(index + 10, 'Noise'));
  const stub = gh(endpoint => endpoint === COMMENTS(1) ? page : endpoint === COMMENTS(2) ? [bot(500, ledger(L))] : new Error(`unexpected ${endpoint}`));
  assert.deepEqual(await select(stub, {number: 7}), L);
  assert.deepEqual(stub.calls, [COMMENTS(1), COMMENTS(2)]);
});

// Each failure stops the review with exactly one stable prefix.
const REFUSALS = [
  ['gh missing', () => github({origin: missing()}), 'Pull request ledger: gh is not available'],
  ['gh missing at the ledger read', () => github({comments: missing()}), 'Pull request ledger: gh is not available'],
  ['no gh login (exit 4)', () => github({origin: failure('To get started with GitHub CLI, please run:  gh auth login', 4)}), 'Pull request ledger: gh is not authenticated'],
  ['a rejected token (401)', () => github({pulls: failure('gh: Bad credentials (HTTP 401)')}), 'Pull request ledger: gh is not authenticated'],
  ['a 401 at the ledger read', () => github({comments: failure('gh: Bad credentials (HTTP 401)')}), 'Pull request ledger: gh is not authenticated'],
  ['the origin is not found', () => github({origin: failure('gh: Not Found (HTTP 404)')}), 'Pull request ledger: the pull request lookup failed (GitHub status 404: gh: Not Found (HTTP 404))'],
  ['offline', () => github({pulls: failure('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com')}),
    'Pull request ledger: the pull request lookup failed (error connecting to api.github.com)'],
  ['rate limited', () => github({pulls: failure('gh: API rate limit exceeded for user ID 1. (HTTP 403)')}), 'Pull request ledger: the pull request lookup failed (GitHub status 403: '],
  ['a lookup that is not a list', () => github({pulls: {message: 'odd'}}), 'Pull request ledger: the pull request lookup failed (GitHub returned no list of pull requests)'],
  ['a lookup that is not JSON', () => github({pulls: 'not json'}), 'Pull request ledger: the pull request lookup failed ('],
  ['a pull request without a number', () => github({pulls: [{number: 'seven'}]}), 'Pull request ledger: the pull request lookup failed (GitHub returned a pull request without a number)'],
  ['two open pull requests', () => github({pulls: [{number: 7}, {number: 9}]}), 'Pull request ledger: more than one open pull request for branch feature/ledger (#7, #9)'],
  ['a fork', () => github({origin: {fork: true}}), 'Pull request ledger: forks are not supported yet'],
  ['the comments read fails', () => github({comments: failure('gh: Server Error (HTTP 500)')}), 'Pull request ledger: the ledger could not be read (GitHub status 500: gh: Server Error (HTTP 500))'],
  ['a failure without stderr', () => github({comments: new Error('spawnSync gh ETIMEDOUT')}), 'Pull request ledger: the ledger could not be read (spawnSync gh ETIMEDOUT)'],
  ['comments that are not a list', () => github({comments: {}}), 'Pull request ledger: the ledger could not be read (GitHub returned no list of comments)'],
  ['an incomplete ledger', () => github({comments: [bot(4, `${MARKER}\nno state`)]}), 'Pull request ledger: the ledger failed validation (The previous acceptance ledger is incomplete)'],
  ['a ledger of another pull request', () => github({comments: [bot(4, ledger([], {number: 8}))]}), 'Pull request ledger: the ledger failed validation (The previous acceptance ledger failed identity validation)'],
  ['a ledger finding of an unknown state', () => github({comments: [bot(4, ledger([finding('a', {state: 'open'})]))]}), 'Pull request ledger: the ledger failed validation ('],
  ['a ledger that is not JSON', () => github({comments: [bot(4, `${MARKER}\n<!-- clouseau-state:bm90IGpzb24= -->`)]}), 'Pull request ledger: the ledger failed validation ('],
];

test('every failure stops with its stable prefix, and only the newest bot ledger is validated', async () => {
  for (const [name, stub, prefix] of REFUSALS) {
    const warnings = [];
    await assert.rejects(select(stub(), {local: [finding('a', {blocking: true, state: 'confirmed'})], warnings}), error => {
      assert.ok(error.message.startsWith(prefix), `${name}: ${error.message}`);
      assert.equal(error.message.split('\n').length, 1, `${name}: one line`);
      return true;
    });
    assert.deepEqual(warnings, [], `${name}: no warning before a refusal`);
  }
  // A failure detail is bounded.
  await assert.rejects(select(github({pulls: failure(`gh: ${'x'.repeat(400)} (HTTP 502)`)})), error => error.message.length < 300);
  // A malformed older ledger does not matter once a newer valid one exists (the gate reads the newest too).
  assert.deepEqual(await select(github({comments: [bot(1, `${MARKER}\nbroken`), bot(2, ledger([finding('b')]))]})), [finding('b')]);
});

test('more than 100 pages of comments is not a readable ledger', async () => {
  const page = Array.from({length: 100}, (_, index) => person(index, 'Noise'));
  const stub = gh(() => page);
  await assert.rejects(select(stub, {number: 7}), /^Error: Pull request ledger: the ledger could not be read \(more than 10000 comments\)$/);
  assert.equal(stub.calls.length, 100);
});

test('localOnly names only blocking, unresolved local findings that the ledger lacks', () => {
  const local = [finding('a', {blocking: true, state: 'confirmed'}), finding('b', {blocking: true, state: 'outstanding'}), finding('c', {blocking: true, state: 'investigating'}), finding('d')];
  assert.deepEqual(history.localOnly(local, [finding('b')]).map(item => item.id), ['a'.repeat(64)]);
  assert.deepEqual(history.localOnly([], []), []);
});
