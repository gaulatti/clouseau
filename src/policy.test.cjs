'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createPolicy} = require('./policy.cjs');
const {assess, gate, scopeReason, assessmentResult, maintainerConfirmed, technicalRun,
  assertProtection, needsDeployment, VERIFY_STEPS} = createPolicy(require('../test/fixtures/config.json'));

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const repo = {owner: 'gaulatti', repo: 'colombo'};
const context = {repo, runId: 123, eventName: 'pull_request_target', payload: {pull_request: {number: 8}}};
const file = {filename: 'src/naming.rs', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+fixed'};
const small = {number: 8, node_id: 'PR_8', state: 'open', draft: false, changed_files: 1, additions: 1,
  deletions: 1, title: 'fix: restore naming', body: 'Existing naming breaks; restore the documented behavior.',
  head: {sha: SHA, ref: 'fix/naming', repo: {id: 42}}, base: {sha: BASE, ref: 'main'},
  auto_merge: {enabled_by: {login: 'github-actions[bot]'}}};
const automatic = {number: 8, head_sha: SHA, base_sha: BASE, decision: 'auto_approve', reason: 'Restores the existing naming contract.'};
const assessmentJson = () => ({head_sha: SHA, decision: 'auto_approve', kind: 'bugfix',
  fits_repository: true, scope_minimal: true, intent_supported: true, has_concerns: false, reason: automatic.reason});
const bot = {login: 'github-actions[bot]', type: 'Bot'};
const human = {login: 'maintainer', type: 'User'};

function fixture(overrides = {}) {
  const writes = [];
  let fetches = 0;
  const pr = structuredClone(small);
  const state = {pr, files: [file], comments: [], reviews: [], permission: 'write',
    run: {id: 22, head_sha: SHA, head_branch: pr.head.ref, head_repository: {id: 42}, pull_requests: [],
      event: 'pull_request', status: 'completed', conclusion: 'success', html_url: 'https://github.com/gaulatti/colombo/actions/runs/22'},
    jobs: [{name: 'verify', conclusion: 'success', steps: VERIFY_STEPS.map(name => ({name, conclusion: 'success'}))}],
    ...overrides};
  const endpoint = (name, implementation) => Object.assign(async args => implementation(args), {endpointName: name});
  const write = (name, result = {data: {}}) => endpoint(name, async args => {writes.push({name, args}); return result;});
  const github = {request: async () => ({data: [
    {type: 'required_status_checks', parameters: {strict_required_status_checks_policy: true,
      required_status_checks: ['verify', 'approval-policy'].map(context => ({context, integration_id: 15368}))}},
    {type: 'pull_request', parameters: {required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true}},
    {type: 'deletion'}, {type: 'non_fast_forward'},
  ]}), rest: {
    pulls: {
      get: endpoint('getPr', async () => {fetches++; return {data: structuredClone(state.pr)};}),
      listFiles: endpoint('files', () => ({data: state.files})),
      listReviews: endpoint('reviews', () => ({data: state.reviews})),
      createReview: write('review'),
      requestReviewers: write('requestReview'),
    },
    repos: {
      get: endpoint('repo', () => ({data: {allow_auto_merge: true}})),
      getBranch: endpoint('branch', () => ({data: {protected: true, commit: {sha: BASE}}})),
      getCollaboratorPermissionLevel: endpoint('permission', () => ({data: {permission: state.permission}})),
      getContent: endpoint('content', () => ({data: {content: Buffer.from('original source').toString('base64'), encoding: 'base64'}})),
      listCommits: endpoint('history', () => ({data: [{sha: BASE, commit: {message: 'feat: establish naming contract'}}]})),
    },
    issues: {listComments: endpoint('comments', () => ({data: state.comments})), createComment: write('comment'),
      addAssignees: write('assign')},
    checks: {create: write('createCheck', {data: {id: 1}}), update: write('updateCheck')},
    actions: {
      listWorkflowRuns: endpoint('runs', () => ({data: {workflow_runs: state.run ? [state.run] : []}})),
      listJobsForWorkflowRun: endpoint('jobs', () => ({data: state.jobs})),
      createWorkflowDispatch: write('dispatch'),
    },
  }, graphql: async (query, args) => {
    if (query.startsWith('mutation')) {writes.push({name: 'arm', args}); state.pr.auto_merge = {}; return {};}
    return {repository: {pullRequest: {closingIssuesReferences: {nodes: [{number: 1, title: 'Fix naming', body: 'Restore contract'}], pageInfo: {hasNextPage: false}}}}};
  }};
  github.paginate = async (method, args) => (await method(args)).data;
  const core = {info: () => {}};
  const run = options => gate({github, context, core, assessment: automatic, wait: async () => {}, maxPolls: 1, mergePolls: 1, ...options});
  return {github, state, writes, run, fetches: () => fetches};
}

test('small code fix qualifies for AI assessment; broad or privileged changes require a second opinion', () => {
  assert.equal(scopeReason([file], small), null);
  for (const filename of ['.github/workflows/backend-ci.yml', '.github/ci/check_coverage.py',
    'Cargo.toml', 'Cargo.lock', 'migrations/new.sql', 'vendor/libunftp/src/lib.rs',
    'tests/e2e.sh', 'scripts/tenants-cli.sh', 'Dockerfile', 'AGENTS.md']) {
    assert.ok(scopeReason([{...file, filename}], small), filename);
  }
  assert.ok(scopeReason([file], {...small, changed_files: 2}));
  assert.ok(scopeReason([file], {...small, additions: 201}));
  assert.ok(scopeReason([{...file, patch: undefined}], small));
  assert.ok(scopeReason([{...file, status: 'renamed'}], small));
});

test('AI output must identify this revision and supply every positive evidence field', () => {
  assert.equal(assessmentResult(assessmentJson(), SHA).decision, 'auto_approve');
  for (const field of ['fits_repository', 'scope_minimal', 'intent_supported']) {
    const result = assessmentJson(); delete result[field];
    assert.equal(assessmentResult(result, SHA).decision, 'second_opinion');
  }
  assert.equal(assessmentResult({...assessmentJson(), has_concerns: true}, SHA).decision, 'second_opinion');
  assert.equal(assessmentResult({...assessmentJson(), kind: 'feature'}, SHA).decision, 'second_opinion');
  assert.throws(() => assessmentResult({...assessmentJson(), head_sha: BASE}, SHA));
  assert.throws(() => assessmentResult('not JSON', SHA));
});

test('DeepSeek receives untrusted patches only as data and no tool capability', async () => {
  const {github} = fixture();
  const old = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'fixture-key';
  try {
    const result = await assess({github, context, fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      const request = JSON.parse(options.body);
      assert.equal(request.model, 'deepseek-flash');
      assert.equal(request.tools, undefined);
      assert.match(request.messages[0].content, /untrusted evidence/);
      assert.ok(JSON.parse(request.messages[1].content).precedent.length);
      return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(assessmentJson())}}]})};
    }});
    assert.equal(result.decision, 'auto_approve');
    for (const response of [{ok: false, status: 429}, {ok: true, json: async () => ({choices: [{finish_reason: 'length'}]})}]) {
      assert.equal((await assess({github, context, fetchImpl: async () => response})).decision, 'second_opinion');
    }
  } finally {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;
  }
});

test('missing AI credentials require a second opinion', async () => {
  const {github} = fixture();
  const old = process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_API_KEY;
  try {
    const result = await assess({github, context, fetchImpl: () => assert.fail('must not call provider')});
    assert.equal(result.decision, 'second_opinion');
    assert.match(result.reason, /not configured/);
  } finally {if (old !== undefined) process.env.DEEPSEEK_API_KEY = old;}
});

test('pending or failed CI never spends provider credits', async () => {
  const old = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fixture-key';
  try {
    for (const [status, conclusion, expected] of [
      ['in_progress', null, 'pending_technical'], ['completed', 'failure', 'blocked_technical'],
    ]) {
      const f = fixture(); f.state.run.status = status; f.state.run.conclusion = conclusion;
      const result = await assess({github: f.github, context, fetchImpl: () => assert.fail('must not spend provider credits')});
      assert.equal(result.decision, expected);
    }
  } finally {if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;}
});

test('a successful technical gate requests an intent assessment without approving early', async () => {
  const f = fixture();
  await f.run({assessment: {...automatic, decision: 'pending_technical'}});
  assert.ok(f.writes.some(write => write.name === 'dispatch' && write.args.workflow_id === 'backend-ci.yml' && write.args.inputs.pull_request === '8'));
  assert.ok(!f.writes.some(write => write.name === 'review'));
  assert.ok(!f.writes.some(write => write.args.conclusion === 'success'));
});

test('failed, skipped, incomplete or stale technical checks cannot approve', async () => {
  for (const mutation of [
    state => {state.run.conclusion = 'failure';},
    state => {state.run.head_sha = BASE;},
    state => {state.run.head_repository.id = 999;},
    state => {state.jobs[0].steps[0].conclusion = 'skipped';},
    state => {state.jobs = [];},
  ]) {
    const f = fixture(); mutation(f.state);
    await assert.rejects(f.run());
    assert.ok(!f.writes.some(write => write.name === 'review'));
    assert.ok(f.writes.some(write => write.args.conclusion === 'failure'));
  }
});

test('the exact successful verify job on a fork head is accepted', async () => {
  const {github} = fixture();
  assert.match((await technicalRun(github, repo, small)).url, /runs\/22/);
});

test('stale assessments are refused before any write', async () => {
  const f = fixture();
  await assert.rejects(f.run({assessment: {...automatic, head_sha: BASE}}), /Stale/);
  assert.equal(f.writes.length, 0);
});

test('a PR changed during CI cannot receive an approval', async () => {
  const f = fixture();
  f.state.run.status = 'in_progress';
  await assert.rejects(f.run({wait: async () => {f.state.pr.head.sha = BASE;}, maxPolls: 2}), /PR changed/);
  assert.ok(!f.writes.some(write => write.name === 'review'));
});

test('major changes arm auto-merge but stay action_required and ask once for a second opinion', async () => {
  const f = fixture({files: [{...file, filename: '.github/workflows/backend-ci.yml'}]});
  f.state.pr.auto_merge = null;
  await f.run();
  assert.ok(f.writes.some(write => write.name === 'arm'));
  assert.ok(f.writes.some(write => write.args.conclusion === 'action_required'));
  assert.ok(f.writes.some(write => write.name === 'comment' && write.args.body.includes(`/approve-intent ${SHA}`)));
  assert.ok(!f.writes.some(write => write.name === 'review'));
});

test('maintainer confirmation is revision-specific; contributors and bots cannot grant it', async () => {
  const f = fixture();
  f.state.comments = [{user: human, body: `/approve-intent ${BASE}`}];
  assert.equal(await maintainerConfirmed(f.github, repo, small), false);
  f.state.comments = [{user: human, body: `/approve-intent ${SHA}`}];
  f.state.permission = 'read';
  assert.equal(await maintainerConfirmed(f.github, repo, small), false);
  f.state.permission = 'write';
  assert.equal(await maintainerConfirmed(f.github, repo, small), true);
  f.state.comments[0].user = bot;
  assert.equal(await maintainerConfirmed(f.github, repo, small), false);
});

test('manual decisions are assigned to gaulatti and request his review on contributor PRs', async () => {
  for (const author of ['contributor', 'gaulatti']) {
    const f = fixture();
    f.state.pr.user = {login: author, type: 'User'};
    await f.run({assessment: {...automatic, decision: 'second_opinion'}});
    assert.deepEqual(f.writes.find(write => write.name === 'assign').args.assignees, ['gaulatti']);
    const request = f.writes.find(write => write.name === 'requestReview');
    if (author === 'gaulatti') assert.equal(request, undefined);
    else assert.deepEqual(request.args.reviewers, ['gaulatti']);
    assert.ok(!f.writes.some(write => write.name === 'review'));
  }
});

test('manual handoff does not duplicate an existing assignment or review request', async () => {
  const f = fixture();
  f.state.pr.assignees = [{login: 'gaulatti'}];
  f.state.pr.requested_reviewers = [{login: 'gaulatti'}];
  await f.run({assessment: {...automatic, decision: 'second_opinion'}});
  assert.ok(!f.writes.some(write => ['assign', 'requestReview'].includes(write.name)));
});

test('a withdrawn human approval cannot be reused', async () => {
  const f = fixture({reviews: [
    {user: human, state: 'APPROVED', commit_id: SHA},
    {user: human, state: 'CHANGES_REQUESTED', commit_id: SHA},
  ]});
  assert.equal(await maintainerConfirmed(f.github, repo, small), false);
});

test('arbitrary issue comments cannot use privileged controller permissions', async () => {
  const f = fixture();
  const commentContext = {...context, eventName: 'issue_comment', payload: {
    issue: {number: 8, pull_request: {}}, comment: {user: human, body: `/approve-intent ${SHA}`},
  }};
  f.state.permission = 'read';
  await assert.rejects(f.run({context: commentContext}), /Only a maintainer/);
  assert.equal(f.writes.length, 0);
});

test('technical success produces a real approval bound to the exact head SHA', async () => {
  const f = fixture();
  await f.run();
  const approval = f.writes.find(write => write.name === 'review');
  assert.equal(approval.args.commit_id, SHA);
  assert.equal(approval.args.event, 'APPROVE');
  assert.ok(f.writes.some(write => write.args.conclusion === 'success'));
});

test('a human intent confirmation never bypasses failing tests', async () => {
  const f = fixture({comments: [{user: human, body: `/approve-intent ${SHA}`} ]});
  f.state.run.conclusion = 'failure';
  await assert.rejects(f.run({assessment: {...automatic, decision: 'second_opinion'}}));
  assert.ok(!f.writes.some(write => write.name === 'review'));
});

test('an Actions-authored PR cannot approve itself through an intent comment', async () => {
  const f = fixture({comments: [{user: human, body: `/approve-intent ${SHA}`}]});
  f.state.pr.user = bot;
  await f.run();
  assert.ok(f.writes.some(write => write.args.conclusion === 'action_required'));
  assert.ok(!f.writes.some(write => write.name === 'review'));
});

test('an independent human review permits an Actions-authored PR without self-approval', async () => {
  const f = fixture({reviews: [{user: human, state: 'APPROVED', commit_id: SHA}]});
  f.state.pr.user = bot;
  await f.run();
  assert.ok(f.writes.some(write => write.args.conclusion === 'success'));
  assert.ok(!f.writes.some(write => write.name === 'review'));
});

test('auto-merge cannot be armed on an unprotected branch', async () => {
  const f = fixture();
  f.github.rest.repos.getBranch = async () => ({data: {protected: false}});
  await assert.rejects(f.run(), /protection/);
  assert.equal(f.writes.length, 0);
});

test('partial protection cannot satisfy the policy or arm auto-merge', async () => {
  const f = fixture();
  f.github.request = async () => ({data: []});
  await assert.rejects(assertProtection(f.github, repo), /Main must enforce/);
  await assert.rejects(f.run(), /Main must enforce/);
  assert.equal(f.writes.length, 0);
});

test('a completed bot merge explicitly dispatches CD for the merged revision', async () => {
  const f = fixture();
  const get = f.github.rest.pulls.get;
  f.github.rest.pulls.get = async args => {
    if (f.writes.some(write => write.args.conclusion === 'success')) {
      return {data: {...structuredClone(small), state: 'closed', merged: true, merge_commit_sha: BASE}};
    }
    return get(args);
  };
  await f.run();
  assert.ok(f.writes.some(write => write.name === 'dispatch' && write.args.workflow_id === 'backend-deploy.yml'));
});

test('application changes preserve deployment dispatch; CI and docs alone do not deploy', () => {
  assert.equal(needsDeployment([file]), true);
  assert.equal(needsDeployment([{filename: 'tests/e2e.sh'}]), true);
  assert.equal(needsDeployment([{filename: '.github/ci/policy.cjs'}, {filename: 'README.md'}]), false);
});

test('closed and draft PR events perform no review or merge writes', async () => {
  for (const change of [{state: 'closed'}, {draft: true}]) {
    const f = fixture(); Object.assign(f.state.pr, change);
    assert.equal((await assess({github: f.github, context})).decision, 'not_ready');
    await f.run();
    assert.equal(f.writes.length, 0);
  }
});

test('consumer configuration controls the branch, verification job, owner and deployment boundary', async () => {
  const config = {...require('../test/fixtures/config.json'), base_branch: 'release', workflow: 'quality.yml',
    manual_reviewer: 'project-owner', verification: {job: 'quality', steps: ['Enforce 100% line and branch coverage']},
    sensitive_paths: ['contracts/'], deployment: null};
  const policy = createPolicy(config);
  const f = fixture(); f.state.pr.base.ref = 'release';
  f.github.request = async () => ({data: [
    {type: 'required_status_checks', parameters: {strict_required_status_checks_policy: true,
      required_status_checks: ['quality', 'approval-policy'].map(context => ({context, integration_id: 15368}))}},
    {type: 'pull_request', parameters: {required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true}},
    {type: 'deletion'}, {type: 'non_fast_forward'},
  ]});
  await policy.gate({github: f.github, context, core: {info() {}}, assessment: {...automatic, decision: 'second_opinion'}});
  assert.deepEqual(f.writes.find(write => write.name === 'assign').args.assignees, ['project-owner']);
  assert.ok(policy.scopeReason([{...file, filename: 'contracts/upload.md'}], small));
  assert.equal(policy.needsDeployment([file]), false);
  f.state.jobs = [{name: 'quality', conclusion: 'success', steps: [{name: 'Enforce 100% line and branch coverage', conclusion: 'success'}]}];
  f.github.rest.actions.listWorkflowRuns = async args => {
    assert.equal(args.workflow_id, 'quality.yml');
    return {data: {workflow_runs: [f.state.run]}};
  };
  assert.ok((await policy.technicalRun(f.github, repo, f.state.pr)).url);
});

test('assessment refuses missing identity, bot authors and incomplete precedent before provider use', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const originalNumber = process.env.PR_NUMBER;
  process.env.DEEPSEEK_API_KEY = 'fictional-key';
  try {
    process.env.PR_NUMBER = 'invalid';
    await assert.rejects(assess({github: fixture().github, context: {...context, payload: {}}}), /PR number/);
    process.env.PR_NUMBER = '8';
    const provider = async () => ({ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(assessmentJson())}}]})});
    assert.equal((await assess({github: fixture().github, context: {...context, payload: {}}, fetchImpl: provider})).decision, 'auto_approve');
    for (const mutate of [
      f => {f.state.pr.base.ref = 'other';},
      f => {f.state.pr.user = bot;},
      f => {f.state.files = [{...file, filename: '.github/contract.json'}];},
      f => {f.github.rest.repos.getContent = async () => ({data: {}});},
      f => {f.github.rest.repos.getContent = async () => ({data: {content: 'x', encoding: 'utf8'}});},
      f => {f.github.graphql = async () => ({repository: {pullRequest: {closingIssuesReferences: {pageInfo: {hasNextPage: true}}}}});},
      f => {f.state.pr.body = 'x'.repeat(160001);},
    ]) {
      const f = fixture(); mutate(f);
      let providerCalls = 0;
      assert.notEqual((await assess({github: f.github, context, fetchImpl: () => {providerCalls++; throw new Error('provider must not run');}})).decision, 'auto_approve');
      assert.equal(providerCalls, 0);
    }
    for (const fetchImpl of [async () => {throw new Error('fixture network failure');}, async () => ({ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: 'invalid'}}]})}), async () => ({ok: true, json: async () => ({})})]) {
      assert.equal((await assess({github: fixture().github, context, fetchImpl})).decision, 'second_opinion');
    }
    const f = fixture({files: [{...file, status: 'added'}]});
    assert.equal((await assess({github: f.github, context, fetchImpl: provider})).decision, 'auto_approve');
    assert.ok(scopeReason(Array.from({length: 6}, () => file), {...small, changed_files: 6}));
    assert.ok(scopeReason([], {...small, changed_files: 0}));
    assert.ok(scopeReason([{...file, previous_filename: '.github/workflows/previous.yml'}], small));
    for (const raw of [null, {...assessmentJson(), reason: ''}, {...assessmentJson(), reason: 'x'.repeat(2001)}]) assert.throws(() => assessmentResult(raw, SHA), /Invalid/);
    assert.equal(assessmentResult(JSON.stringify(assessmentJson()), SHA).decision, 'auto_approve');
  } finally {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = originalKey;
    if (originalNumber === undefined) delete process.env.PR_NUMBER; else process.env.PR_NUMBER = originalNumber;
  }
});

test('technical verification selects the newest matching PR run and refuses absent or failed jobs', async () => {
  const f = fixture();
  f.github.rest.actions.listWorkflowRuns = async () => ({data: {workflow_runs: [f.state.run, {...f.state.run, id: 23, pull_requests: [{number: 8}]}]}});
  const jobs = f.github.rest.actions.listJobsForWorkflowRun;
  f.github.rest.actions.listJobsForWorkflowRun = Object.assign(async args => {assert.equal(args.run_id, 23); return jobs(args);}, {endpointName: 'jobs'});
  assert.ok((await technicalRun(f.github, repo, small)).url);
  const absent = fixture({run: null}); assert.equal((await technicalRun(absent.github, repo, small)).pending, true);
  f.state.jobs[0].conclusion = 'failure'; assert.ok((await technicalRun(f.github, repo, small)).failure);
});

test('human confirmation ignores pending, comment-only, anonymous and stale reviews', async () => {
  const f = fixture({reviews: [
    {state: 'COMMENTED', user: human}, {state: 'PENDING', user: human},
    {state: 'APPROVED', commit_id: BASE, user: human},
    {state: 'APPROVED', commit_id: SHA},
  ], comments: [{body: `/approve-intent ${SHA}`}]});
  assert.equal(await maintainerConfirmed(f.github, repo, small), false);
});

test('the gate refuses stale comments, changed revisions and withdrawn human confirmation', async () => {
  for (const comment of [{user: human, body: `/approve-intent ${BASE}`}, {user: bot, body: `/approve-intent ${SHA}`}]) {
    const f = fixture();
    await assert.rejects(f.run({context: {...context, eventName: 'issue_comment', payload: {issue: {number: 8, pull_request: {}}, comment}}}));
  }
  const disabled = fixture(); disabled.github.rest.repos.get = async () => ({data: {allow_auto_merge: false}});
  await assert.rejects(disabled.run(), /auto-merge/);
  const staleArm = fixture(); staleArm.state.pr.auto_merge = null;
  staleArm.github.graphql = async () => ({});
  await assert.rejects(staleArm.run(), /Auto-merge was not enabled/);
  const blocked = fixture(); await assert.rejects(blocked.run({assessment: {...automatic, decision: 'blocked_technical', reason: 'fixture technical failure'}}), /fixture technical/);
  const pending = fixture({run: null}); await assert.rejects(pending.run(), /Verification is pending/);
  await assert.rejects(fixture().run({maxPolls: 0}), /Verification is pending/);
  const changed = fixture();
  let gets = 0;
  changed.github.rest.pulls.get = async () => ({data: {...structuredClone(small), head: {...small.head, sha: ++gets === 4 ? BASE : SHA}}});
  await assert.rejects(changed.run(), /PR changed before approval/);
  const withdrawn = fixture({comments: [{user: human, body: `/approve-intent ${SHA}`}]});
  let comments = 0;
  withdrawn.github.rest.issues.listComments = Object.assign(async () => ({data: ++comments === 1 ? withdrawn.state.comments : []}), {endpointName: 'comments'});
  await assert.rejects(withdrawn.run({assessment: {...automatic, decision: 'second_opinion'}}), /withdrawn/);
  const mergeChanged = fixture();
  const get = mergeChanged.github.rest.pulls.get;
  mergeChanged.github.rest.pulls.get = async args => {
    const result = await get(args);
    if (mergeChanged.writes.some(write => write.args.conclusion === 'success')) result.data.auto_merge = null;
    return result;
  };
  await assert.rejects(mergeChanged.run(), /Auto-merge was disabled/);
});

test('the default polling timer and environment assessment wait for the technical result', async t => {
  const f = fixture(); f.state.run.status = 'in_progress';
  const original = process.env.ASSESSMENT;
  process.env.ASSESSMENT = JSON.stringify(automatic);
  t.mock.method(global, 'setTimeout', callback => {f.state.run.status = 'completed'; callback(); return 0;});
  try {await f.run({wait: undefined, assessment: undefined, maxPolls: 2, mergePolls: 0});}
  finally {if (original === undefined) delete process.env.ASSESSMENT; else process.env.ASSESSMENT = original;}
  assert.ok(f.writes.some(write => write.name === 'review'));
});

test('merge handoff refuses advanced main, avoids duplicate deployments and skips non-deployment changes', async () => {
  for (const mode of ['advanced', 'existing', 'docs']) {
    const f = fixture(mode === 'docs' ? {files: [{...file, filename: 'README.md'}]} : {});
    const get = f.github.rest.pulls.get;
    f.github.rest.pulls.get = async args => {
      if (f.writes.some(write => write.args.conclusion === 'success')) return {data: {...structuredClone(small), merged: true, merge_commit_sha: mode === 'advanced' ? SHA : BASE}};
      return get(args);
    };
    if (mode === 'existing') f.github.rest.actions.listWorkflowRuns = async args => ({data: {workflow_runs: args.workflow_id === 'backend-deploy.yml' ? [{event: 'push'}] : [f.state.run]}});
    if (mode === 'advanced') await assert.rejects(f.run(), /Main advanced/);
    else await f.run();
    assert.ok(!f.writes.some(write => write.name === 'dispatch'));
  }
});

test('confirmed intent produces a technical review and repeated handoffs do not duplicate bot comments', async () => {
  const confirmed = fixture({comments: [{user: human, body: `/approve-intent ${SHA}`}]});
  await confirmed.run({assessment: {...automatic, decision: 'second_opinion'}});
  assert.match(confirmed.writes.find(write => write.name === 'review').args.body, /confirmed by a maintainer/);
  const repeated = fixture({comments: [{user: bot, body: `<!-- clouseau-intent:${SHA} -->`} ]});
  await repeated.run({assessment: {...automatic, decision: 'second_opinion'}});
  assert.ok(!repeated.writes.some(write => write.name === 'comment'));
});
