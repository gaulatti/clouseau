'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const {cliApi, githubFromApi} = require('./installation-github.cjs');

test('native gh adapter pins github.com and sends structured public enrollment through stdin', async () => {
  const calls = [];
  const api = cliApi((...args) => {calls.push(args); return JSON.stringify({id: 31});});
  assert.deepEqual(await api('GET', 'user'), {id: 31});
  assert.deepEqual(calls[0], ['gh', ['api', '--hostname', 'github.com', '--method', 'GET', 'user'], {encoding: 'utf8', maxBuffer: 3000000}]);
  const body = {body: '/authorize-clouseau-installation v1\n{"identity":{"public_key":"PUBLIC"}}'};
  assert.deepEqual(await api('POST', 'repos/fixture-owner/project/commits/' + 'a'.repeat(40) + '/comments', body), {id: 31});
  const [program, args, options] = calls[1];
  assert.equal(program, 'gh');
  assert.deepEqual(args.slice(-2), ['--input', '-']);
  assert.equal(args.includes(body.body), false, 'authorization content must not be a process argument');
  assert.deepEqual(JSON.parse(options.input), body);
  assert.ok(!options.input.includes('private_key'));
  assert.equal(options.encoding, 'utf8');
  await api('POST', 'repos/fixture-owner/project/commits/' + 'a'.repeat(40) + '/comments', null);
  assert.equal(calls[2][2].input, 'null', 'an explicit JSON null is distinct from no request body');
});

test('default API runner uses the existing authenticated gh command without shell evaluation', async t => {
  t.mock.method(cp, 'execFileSync', (program, args, settings) => {
    assert.equal(program, 'gh');
    assert.deepEqual(args, ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/fixture/project']);
    assert.equal(settings.shell, undefined);
    return '{"full_name":"fixture/project"}';
  });
  assert.deepEqual(await cliApi()('GET', 'repos/fixture/project'), {full_name: 'fixture/project'});
});

test('unsupported methods, hosts and endpoint families fail before invoking authentication', async () => {
  let calls = 0;
  const api = cliApi(() => {calls++; return '{}';});
  for (const [method, endpoint] of [['DELETE', 'repos/fixture/project'], ['PUT', 'user'], ['get', 'user'],
    ['GET', null], ['GET', 123], ['GET', ''], ['GET', 'https://attacker.invalid/repos/fixture/project'],
    ['GET', 'users/fixture-owner'], ['GET', 'user/keys'], ['GET', 'orgs/fixture'],
  ]) await assert.rejects(api(method, endpoint), /Unsupported/);
  assert.equal(calls, 0);
});

test('transport, authorization and malformed JSON failures propagate without alternate credentials or paid fallback', async () => {
  for (const text of ['', 'not JSON', '{']) await assert.rejects(cliApi(() => text)('GET', 'user'), SyntaxError);
  const denied = new Error('HTTP403 fixture denial');
  await assert.rejects(cliApi(() => {throw denied;})('GET', 'repos/fixture/project'), error => error === denied);
});

test('read-only GitHub facade emits exact encoded source, PR, comment and workflow routes', async () => {
  const calls = [];
  const api = async (...args) => {calls.push(args); return {fixture: true, jobs: [{id: 9}]};};
  const github = githubFromApi(api);
  const repo = {owner: 'fixture owner', repo: 'project/name'};
  const prefix = 'repos/fixture%20owner/project%2Fname';
  assert.deepEqual(await github.rest.repos.getContent({...repo, path: '.github/a file.json', ref: 'branch/one'}), {data: {fixture: true, jobs: [{id: 9}]}});
  assert.equal(calls.at(-1)[1], `${prefix}/contents/.github/a%20file.json?ref=branch%2Fone`);
  await github.rest.pulls.get({...repo, pull_number: 4});
  assert.equal(calls.at(-1)[1], `${prefix}/pulls/4`);
  await github.rest.pulls.listFiles({...repo, pull_number: 4, per_page: 100, page: 2});
  assert.equal(calls.at(-1)[1], `${prefix}/pulls/4/files?per_page=100&page=2`);
  await github.rest.issues.listComments({...repo, issue_number: 4, per_page: 100, page: 3});
  assert.equal(calls.at(-1)[1], `${prefix}/issues/4/comments?per_page=100&page=3`);
  await github.rest.actions.listWorkflowRuns({...repo, workflow_id: 'review workflow.yml', event: 'pull_request_target', head_sha: 'a'.repeat(40), per_page: 100});
  assert.equal(calls.at(-1)[1], `${prefix}/actions/workflows/review%20workflow.yml/runs?event=pull_request_target&head_sha=${'a'.repeat(40)}&per_page=100`);
  assert.deepEqual(await github.rest.actions.listJobsForWorkflowRun({...repo, run_id: 7, filter: 'latest', per_page: 100, page: 2}), {data: [{id: 9}]});
  assert.equal(calls.at(-1)[1], `${prefix}/actions/runs/7/jobs?filter=latest&per_page=100&page=2`);
  assert.ok(calls.every(call => call[0] === 'GET' && call.length === 2));
  assert.deepEqual(Object.keys(github.rest.pulls).sort(), ['get', 'listFiles']);
  assert.equal(github.rest.pulls.createReview, undefined);
  assert.equal(github.graphql, undefined, 'read-only assessment must not gain an approval/merge writer');
});

test('pagination retrieves every page at the fixed size and preserves input arguments and result order', async () => {
  const github = githubFromApi(async () => {});
  const calls = [];
  const args = {owner: 'fixture', repo: 'project', pull_number: 8, per_page: 1, page: 99};
  const method = async options => {
    calls.push(options);
    return {data: options.page === 1 ? Array.from({length: 100}, (_, id) => ({id})) : [{id: 100}, {id: 101}]};
  };
  const values = await github.paginate(method, args);
  assert.deepEqual(values.map(value => value.id), Array.from({length: 102}, (_, id) => id));
  assert.deepEqual(calls.map(call => [call.per_page, call.page]), [[100, 1], [100, 2]]);
  assert.deepEqual(args, {owner: 'fixture', repo: 'project', pull_number: 8, per_page: 1, page: 99});
  assert.deepEqual(await github.paginate(async () => ({data: []}), {}), []);
});

test('actual listFiles and nested jobs collections are fully paginated through the read-only facade', async () => {
  const calls = [];
  const github = githubFromApi(async (method, endpoint) => {
    assert.equal(method, 'GET'); calls.push(endpoint);
    const values = endpoint.endsWith('page=1') ? Array.from({length: 100}, (_, id) => ({id})) : [{id: 100}];
    return endpoint.includes('/jobs?') ? {jobs: values} : values;
  });
  const repo = {owner: 'fixture', repo: 'project'};
  assert.equal((await github.paginate(github.rest.pulls.listFiles, {...repo, pull_number: 9})).length, 101);
  assert.equal((await github.paginate(github.rest.actions.listJobsForWorkflowRun, {...repo, run_id: 3, filter: 'all'})).length, 101);
  assert.equal(calls.length, 4);
});

test('malformed, unavailable and over-budget evidence collections fail without returning partial results', async () => {
  const github = githubFromApi(async () => {});
  for (const value of [undefined, null, {}, 'not a collection']) await assert.rejects(github.paginate(async () => ({data: value}), {}), /Incomplete/);
  await assert.rejects(github.paginate(async () => {throw new Error('403 evidence unavailable');}, {}), /unavailable/);
  let pages = 0;
  await assert.rejects(github.paginate(async () => {pages++; return {data: Array(100).fill({fixture: true})};}, {}), /complete evidence budget/);
  assert.equal(pages, 100);
});
