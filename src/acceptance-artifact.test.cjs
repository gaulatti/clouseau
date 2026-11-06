'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {resolveArtifactName} = require('./acceptance-artifact.cjs');

const SHA = 'c'.repeat(40);
const repo = {owner: 'gaulatti', repo: 'guggiana'};
// A pull_request_target run executes at the base branch tip (context.sha); the revision it assessed is the PR head.
const BASE = 'b'.repeat(40);
const context = {repo, runId: 41479159933, eventName: 'pull_request_target', sha: BASE, payload: {pull_request: {head: {sha: SHA}}}};
const pushContext = {repo, runId: 41479159933, eventName: 'push', sha: SHA};
const artifact = (name, patch = {}) => ({name, expired: false, workflow_run: {id: 41479159933, head_sha: SHA}, ...patch});

function client(artifacts) {
  const calls = [];
  const listWorkflowRunArtifacts = Object.assign(() => {}, {id: 'list'});
  return {calls, rest: {actions: {listWorkflowRunArtifacts}}, paginate: async (method, args) => {
    assert.equal(method, listWorkflowRunArtifacts); calls.push(args); return artifacts;
  }};
}

test('a rerun of failed jobs resolves the artifact the first attempt produced', async () => {
  const github = client([artifact('clouseau-acceptance-41479159933-1'), artifact('native-verification-41479159933-1')]);
  assert.equal(await resolveArtifactName({github, context, attempt: '2'}), 'clouseau-acceptance-41479159933-1');
  assert.deepEqual(github.calls, [{...repo, run_id: 41479159933, per_page: 100}]);
  assert.equal(await resolveArtifactName({github, context, attempt: '1'}), 'clouseau-acceptance-41479159933-1');
});

test('the newest attempt that is not in the future wins; a full rerun supersedes the earlier record', async () => {
  const github = client(['3', '1', '2', '4'].map(attempt => artifact(`clouseau-acceptance-41479159933-${attempt}`)));
  assert.equal(await resolveArtifactName({github, context, attempt: '3'}), 'clouseau-acceptance-41479159933-3');
  assert.equal(await resolveArtifactName({github, context, attempt: 2}), 'clouseau-acceptance-41479159933-2');
  assert.equal(await resolveArtifactName({github, context, attempt: '10'}), 'clouseau-acceptance-41479159933-4');
});

test('artifacts of another run, revision, attempt or shape are refused', async () => {
  const foreign = [
    artifact('clouseau-acceptance-41479159934-1'),                                        // another run's name
    artifact('clouseau-acceptance-41479159933-1', {workflow_run: {id: 41479159934, head_sha: SHA}}),  // name forged, produced by another run
    artifact('clouseau-acceptance-41479159933-1', {workflow_run: {id: 41479159933, head_sha: 'd'.repeat(40)}}), // another revision
    artifact('clouseau-acceptance-41479159933-1', {workflow_run: undefined}),
    artifact('clouseau-acceptance-41479159933-1', {expired: true}),
    artifact('clouseau-acceptance-41479159933-3'),                                        // a future attempt
    artifact('clouseau-acceptance-41479159933-0'), artifact('clouseau-acceptance-41479159933-01'),
    artifact('clouseau-acceptance-41479159933-1-extra'), artifact('x-clouseau-acceptance-41479159933-1'),
    artifact('clouseau-acceptance-4147915993-1'), artifact('clouseau-acceptance-414791599331-1'),
    artifact('clouseau-acceptance-41479159933-2', {workflow_run: {id: 7, head_sha: SHA}}),
  ];
  await assert.rejects(resolveArtifactName({github: client(foreign), context, attempt: '2'}),
    /No acceptance artifact of run 41479159933 \(attempts up to 2\) is available; re-run the assessment job\./);
  await assert.rejects(resolveArtifactName({github: client([]), context, attempt: '2'}), /No acceptance artifact/);
  // A forged record beside the genuine one never displaces it.
  const github = client([...foreign, artifact('clouseau-acceptance-41479159933-1')]);
  assert.equal(await resolveArtifactName({github, context, attempt: '2'}), 'clouseau-acceptance-41479159933-1');
});

test('a pull_request_target run matches the PR head revision, never the base commit it executes at', async () => {
  const github = client([artifact('clouseau-acceptance-41479159933-1'), artifact('clouseau-acceptance-41479159933-2', {workflow_run: {id: 41479159933, head_sha: BASE}})]);
  assert.equal(await resolveArtifactName({github, context, attempt: '2'}), 'clouseau-acceptance-41479159933-1');
  await assert.rejects(resolveArtifactName({github: client([artifact('clouseau-acceptance-41479159933-1', {workflow_run: {id: 41479159933, head_sha: BASE}})]), context, attempt: '1'}), /No acceptance artifact/);
});

test('a push run matches the pushed commit', async () => {
  const github = client([artifact('clouseau-acceptance-41479159933-1')]);
  assert.equal(await resolveArtifactName({github, context: pushContext, attempt: '1'}), 'clouseau-acceptance-41479159933-1');
  await assert.rejects(resolveArtifactName({github, context: {...pushContext, sha: BASE}, attempt: '1'}), /No acceptance artifact/);
});

test('a missing or malformed revision fails before any lookup', async () => {
  for (const bad of [{...context, payload: {}}, {...context, payload: undefined}, {...context, payload: {pull_request: {head: {sha: 'abc'}}}}, {...pushContext, sha: undefined}, {...pushContext, sha: 'abc'}]) {
    const github = client([]);
    github.paginate = async () => assert.fail('must not look up');
    await assert.rejects(resolveArtifactName({github, context: bad, attempt: '1'}), /requires a frozen 40-character revision/);
  }
});

test('a malformed run id or attempt fails before any lookup', async () => {
  for (const [runId, attempt] of [[0, '1'], [-1, '1'], ['abc', '1'], [1.5, '1'], [undefined, '1'], [41479159933, '0'], [41479159933, ''], [41479159933, 'x'], [41479159933, undefined], [41479159933, '1.5']]) {
    const github = client([]);
    github.paginate = async () => assert.fail('must not look up');
    await assert.rejects(resolveArtifactName({github, context: {...context, runId}, attempt}), /requires a positive run id and run attempt/);
  }
});
