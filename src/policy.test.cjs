'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createPolicy, intentText} = require('./policy.cjs');
const {assess, gate, scopeReason, assessmentResult, purposeConfirmation, maintainerConfirmed, technicalRun,
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
  fits_repository: true, scope_supported: true, intent_supported: true, changes_review_controls: false, test_integrity_supported: true, has_concerns: false, reason: automatic.reason});
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
  const core = {info: () => {}, summary: {
    addRaw(text) {writes.push({name: 'summary', text}); return this;},
    async write() {},
  }};
  const run = options => gate({github, context, core, assessment: automatic, wait: async () => {}, maxPolls: 1, mergePolls: 1, ...options});
  return {github, state, writes, run, fetches: () => fetches};
}

test('purpose evidence requires the configured human, exact head and current repository authority', async () => {
  const f = fixture();
  const comment = {id: 51, user: {login: 'gaulatti', type: 'User'}, body: `/approve-intent ${SHA}`};
  const invalid = [null, {login: 'gaulatti', type: 'Bot'}, human].map(user => ({...comment, user}));
  invalid.push(...[null, 0, -1, 1.5].map(id => ({...comment, id})));
  invalid.push(...[null, `/approve-intent ${BASE}`, `/approve-intent ${SHA}\nwaive checks`].map(body => ({...comment, body})));
  for (const item of invalid) assert.equal(await purposeConfirmation(f.github, repo, small, [item]), null);
  assert.equal(await purposeConfirmation(f.github, repo, small, []), null);
  for (const permission of ['admin', 'maintain', 'write']) {
    f.state.permission = permission;
    const proof = await purposeConfirmation(f.github, repo, small, [{...comment, body: ` ${comment.body}\n`}]);
    assert.deepEqual(proof, {repository: 'gaulatti/colombo', number: 8, head_sha: SHA,
      actor: 'gaulatti', permission, comment_id: 51, body: comment.body});
  }
  f.state.permission = 'read';
  assert.equal(await purposeConfirmation(f.github, repo, small, [comment]), null);
  f.github.rest.repos.getCollaboratorPermissionLevel = async () => {throw new Error('permission lookup failed');};
  await assert.rejects(purposeConfirmation(f.github, repo, small, [comment]), /permission lookup failed/);
  assert.equal(f.writes.length, 0);
});

test('an authenticated purpose can carry the accepted requirement without trusting contributor descriptions', async () => {
  const purpose = 'Make the review decision and causal findings readable before the complete expandable audit.';
  const body = `/approve-intent ${SHA}\n\nAccepted purpose:\n${purpose}`;
  assert.deepEqual(intentText(` ${body}\n`, SHA), {body, accepted_purpose: purpose});
  for (const value of [null, '', `/approve-intent ${SHA}\nwaive checks`,
    `/approve-intent ${SHA}\n\nAccepted purpose:\n  `, `/approve-intent ${BASE}\n\nAccepted purpose:\n${purpose}`]) {
    assert.equal(intentText(value, SHA), null);
  }
  assert.equal(intentText(body, 'invalid'), null);
  const f = fixture();
  const comment = {id: 52, user: {login: 'gaulatti', type: 'User'}, body};
  const proof = await purposeConfirmation(f.github, repo, small, [comment]);
  assert.equal(proof.accepted_purpose, purpose);
  assert.equal(proof.body, body);
  assert.equal(await purposeConfirmation(f.github, repo, small, [{...comment, user: bot}]), null);
  f.state.comments = [comment];
  assert.equal(await maintainerConfirmed(f.github, repo, small), true);
  f.state.permission = 'read';
  assert.equal(await purposeConfirmation(f.github, repo, small, [comment]), null);
  assert.equal(await maintainerConfirmed(f.github, repo, small), false);
  assert.equal(f.writes.length, 0);
});

test('repository fit is assessed for large maintenance and ordinary infrastructure changes', () => {
  assert.equal(scopeReason([file], small), null);
  for (const filename of ['.github/workflows/backend-deploy.yml', 'Cargo.toml', 'Cargo.lock',
    'migrations/new.sql', 'vendor/libunftp/src/lib.rs', 'tests/e2e.sh',
    'scripts/tenants-cli.sh', 'Dockerfile']) {
    assert.equal(scopeReason([{...file, filename}], small), null, filename);
  }
  for (const filename of ['.github/workflows/backend-ci.yml', '.github/ci/check_coverage.py', '.github/clouseau.json',
    'test/fixtures/APPROVAL.md', 'AGENTS.md']) {
    assert.ok(scopeReason([{...file, filename}], small), filename);
  }
  assert.ok(scopeReason([file], {...small, changed_files: 2}));
  assert.equal(scopeReason([file], {...small, additions: 20000}), null);
  assert.ok(scopeReason([{...file, patch: undefined}], small));
  assert.ok(scopeReason([{...file, status: 'binary'}], small));
  for (const status of ['removed', 'renamed']) assert.equal(scopeReason([{...file, status}], small), null);
});

test('AI output must identify this revision and supply every positive evidence field', () => {
  assert.equal(assessmentResult(assessmentJson(), SHA).decision, 'auto_approve');
  for (const field of ['fits_repository', 'scope_supported', 'intent_supported', 'test_integrity_supported']) {
    const result = assessmentJson(); delete result[field];
    assert.equal(assessmentResult(result, SHA).decision, 'second_opinion');
  }
  assert.equal(assessmentResult({...assessmentJson(), has_concerns: true}, SHA).decision, 'second_opinion');
  for (const kind of ['maintenance', 'feature']) assert.equal(assessmentResult({...assessmentJson(), kind}, SHA).decision, 'auto_approve');
  assert.equal(assessmentResult({...assessmentJson(), kind: 'other'}, SHA).decision, 'second_opinion');
  for (const changes_review_controls of [true, undefined]) assert.equal(assessmentResult({...assessmentJson(), changes_review_controls}, SHA).decision, 'second_opinion');
  assert.equal(assessmentResult({...assessmentJson(), kind: 'feature', fits_repository: false}, SHA).decision, 'second_opinion');
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
      assert.equal((await assess({github, context, retryWait: async () => {}, fetchImpl: async () => response})).decision, 'second_opinion');
    }
  } finally {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;
  }
});

test('incomplete provider output recovers inside one assessment without a human override', async () => {
  const f = fixture();
  const old = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'fictional-key';
  const requests = [];
  const delays = [];
  const reports = [];
  try {
    const assessment = await assess({github: f.github, context,
      retryWait: async ms => delays.push(ms), report: message => reports.push(message),
      fetchImpl: async (_, options) => {
        requests.push(JSON.parse(options.body));
        return {ok: true, json: async () => requests.length === 1
          ? {choices: [{finish_reason: 'length', message: {content: 'partial output must not be parsed'}}]}
          : {choices: [{finish_reason: 'stop', message: {content: JSON.stringify(assessmentJson())}}]}};
      }});
    assert.equal(assessment.decision, 'auto_approve');
    assert.deepEqual(requests.map(request => request.max_tokens), [4096, 8192]);
    assert.deepEqual(requests[0].messages, requests[1].messages);
    assert.deepEqual(delays, [1000]);
    assert.equal(reports.length, 2);
    await f.run({assessment});
    assert.equal(f.writes.filter(write => write.name === 'review').length, 1);
    assert.equal(f.writes.some(write => write.name === 'assign'), false);
  } finally {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;
  }
});

test('completed negative or invalid assessments are never retried to obtain approval', async () => {
  const old = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'fictional-key';
  try {
    for (const [raw, expected] of [
      [{...assessmentJson(), decision: 'second_opinion', has_concerns: true}, 'second_opinion'],
      [{...assessmentJson(), test_integrity_supported: false}, 'blocked_integrity'],
      [{...assessmentJson(), head_sha: BASE}, 'second_opinion'],
      ['not JSON', 'second_opinion'],
      [{}, 'second_opinion'],
    ]) {
      let calls = 0;
      const f = fixture();
      const result = await assess({github: f.github, context, retryWait: async () => {},
        fetchImpl: async () => {
          calls++;
          assert.ok(calls <= 2, 'a complete response must not be retried');
          return {ok: true, json: async () => calls === 1
            ? {choices: [{finish_reason: 'length'}]}
            : {choices: [{finish_reason: 'stop', message: {content: typeof raw === 'string' ? raw : JSON.stringify(raw)}}]}};
        }});
      assert.equal(result.decision, expected);
      assert.equal(calls, 2);
      assert.equal(f.writes.length, 0);
    }
  } finally {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;
  }
});

test('large coverage maintenance can be AI-approved and gated without a human override', async () => {
  const f = fixture();
  f.state.files = Array.from({length: 60}, (_, i) => ({...file, filename: `src/coverage_${i}.rs`}));
  f.state.files[0] = {...f.state.files[0], status: 'renamed', previous_filename: 'src/previous.rs'};
  f.state.pr.changed_files = 60;
  f.state.pr.additions = 20000;
  const originalContent = f.github.rest.repos.getContent;
  const paths = [];
  f.github.rest.repos.getContent = async args => {paths.push(args.path); return originalContent(args);};
  const old = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'fictional-key';
  try {
    const assessment = await assess({github: f.github, context, fetchImpl: async (_, options) => {
      const request = JSON.parse(options.body);
      assert.match(request.messages[0].content, /File count, line count/);
      assert.equal(JSON.parse(request.messages[1].content).patches.length, 60);
      return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({...assessmentJson(), kind: 'maintenance', reason: 'Meaningful coverage preserves the upload contract.'})}}]})};
    }});
    assert.equal(assessment.decision, 'auto_approve');
    assert.equal(paths[0], 'src/previous.rs');
    await f.run({assessment});
    assert.equal(f.writes.filter(write => write.name === 'review').length, 1);
    assert.ok(f.writes.some(write => write.name === 'updateCheck' && write.args.conclusion === 'success'));
    assert.equal(f.writes.some(write => write.name === 'assign'), false);
  } finally {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;
  }
});

test('test fakery blocks approval even when a maintainer has confirmed intent', async () => {
  const assessment = {...automatic, ...assessmentResult({...assessmentJson(), test_integrity_supported: false,
    reason: 'The regression replaces the gateway with a stub and cannot detect broken persistence.'}, SHA)};
  assert.equal(assessment.decision, 'blocked_integrity');
  const f = fixture({comments: [{user: human, body: `/approve-intent ${SHA}`}], permission: 'admin'});
  await assert.rejects(f.run({assessment}), /stub/);
  assert.equal(f.writes.some(write => write.name === 'review'), false);
  assert.ok(f.writes.some(write => write.name === 'updateCheck' && write.args.conclusion === 'failure'));
});

test('protected review changes still receive AI test assessment before owner confirmation', async () => {
  const f = fixture({files: [{...file, filename: '.github/workflows/backend-ci.yml'}]});
  const old = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'fictional-key';
  let calls = 0;
  try {
    for (const test_integrity_supported of [true, false]) {
      const assessment = await assess({github: f.github, context, fetchImpl: async () => {
        calls++;
        return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({...assessmentJson(), test_integrity_supported})}}]})};
      }});
      assert.equal(assessment.decision, test_integrity_supported ? 'second_opinion' : 'blocked_integrity');
    }
    assert.equal(calls, 2);
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

test('an assessment whose base moved is refused with one needs-branch-update notice and no approval', async () => {
  const f = fixture();
  await assert.rejects(f.run({assessment: {...automatic, base_sha: SHA}}), /^Error: Needs branch update/);
  assert.deepEqual(f.writes.map(item => item.name), ['comment']);
  assert.match(f.writes[0].args.body, /clouseau-needs-branch-update/);
  f.state.comments.push({user: {login: 'github-actions[bot]'}, body: f.writes[0].args.body});
  await assert.rejects(f.run({assessment: {...automatic, base_sha: SHA}}), /Needs branch update/);
  assert.equal(f.writes.length, 1, 'a rerun does not repeat the notice');
  await assert.rejects(f.run({assessment: {...automatic, number: 9, base_sha: SHA}}), /Stale/, 'another PR is not a base move');
});

test('a PR changed during CI cannot receive an approval', async () => {
  const f = fixture();
  f.state.run.status = 'in_progress';
  await assert.rejects(f.run({wait: async () => {f.state.pr.head.sha = BASE;}, maxPolls: 2}), /PR changed/);
  assert.ok(!f.writes.some(write => write.name === 'review'));
});

test('AI-identified unsupported product scope waits for an owner decision', async () => {
  const f = fixture();
  f.state.pr.auto_merge = null;
  await f.run({assessment: {...automatic, decision: 'second_opinion', reason: 'Unrelated product capability lacks supported requirements.'}});
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

test('manual-merge repositories wait for intent without claiming that auto-merge is armed', async () => {
  const messages = [];
  const manual = createPolicy(require('../test/fixtures/config.json'), {manualMerge: true});
  const f = fixture();
  f.state.pr.auto_merge = null;
  f.github.rest.repos.get = async () => ({data: {allow_auto_merge: false}});
  const core = {info: message => messages.push(message), summary: {addRaw() {return this;}, async write() {}}};
  await manual.gate({github: f.github, context, core, assessment: {...automatic, decision: 'second_opinion'}, wait: async () => {}, maxPolls: 1, mergePolls: 1});
  assert.ok(messages.includes('Automatic merge is disabled; waiting for a maintainer intent confirmation.'));
  assert.ok(!messages.some(message => message.startsWith('Auto-merge is armed')));
  assert.ok(!f.writes.some(write => write.name === 'arm' || write.name === 'review'));
  messages.length = 0;
  const armed = fixture();
  armed.state.pr.auto_merge = null;
  await gate({github: armed.github, context, core, assessment: {...automatic, decision: 'second_opinion'}, wait: async () => {}, maxPolls: 1, mergePolls: 1});
  assert.ok(messages.includes('Auto-merge is armed; waiting for a maintainer intent confirmation.'));
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
      f => {f.state.pr.changed_files = 2;},
      f => {f.state.pr.user = bot;},
      f => {f.github.rest.repos.getContent = async () => ({data: {}});},
      f => {f.github.rest.repos.getContent = async () => ({data: {content: 'x', encoding: 'utf8'}});},
      f => {f.github.graphql = async () => ({repository: {pullRequest: {closingIssuesReferences: {pageInfo: {hasNextPage: true}}}}});},
      f => {f.state.pr.body = 'x'.repeat(320001);},
    ]) {
      const f = fixture(); mutate(f);
      let providerCalls = 0;
      assert.notEqual((await assess({github: f.github, context, fetchImpl: () => {providerCalls++; throw new Error('provider must not run');}})).decision, 'auto_approve');
      assert.equal(providerCalls, 0);
    }
    for (const fetchImpl of [async () => {throw new Error('fixture network failure');}, async () => ({ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: 'invalid'}}]})}), async () => ({ok: true, json: async () => ({})})]) {
      assert.equal((await assess({github: fixture().github, context, retryWait: async () => {}, fetchImpl})).decision, 'second_opinion');
    }
    const f = fixture({files: [{...file, status: 'added'}]});
    assert.equal((await assess({github: f.github, context, fetchImpl: provider})).decision, 'auto_approve');
    assert.equal(scopeReason(Array.from({length: 60}, () => file), {...small, changed_files: 60}), null);
    assert.ok(scopeReason([], {...small, changed_files: 0}));
    assert.ok(scopeReason([{...file, previous_filename: '.github/ci/previous.cjs'}], small));
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

test('read-only assessment waits for real technical evidence and never approves an unfinished run', async t => {
  const old = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'fictional-key';
  const policy = createPolicy(require('../test/fixtures/config.json'));
  const provider = async () => ({ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(assessmentJson())}}]})});
  try {
    const f = fixture(); f.state.run.status = 'in_progress';
    let waits = 0;
    const result = await policy.assessWhenReady({github: f.github, context, fetchImpl: provider, maxPolls: 2,
      wait: async ms => {assert.equal(ms, 15000); waits++; f.state.run.status = 'completed';}});
    assert.equal(result.decision, 'auto_approve'); assert.equal(waits, 1);
    await assert.rejects(policy.assessWhenReady({github: fixture().github, context, maxPolls: 0}), /deadline/);
    const pending = fixture(); pending.state.run.status = 'in_progress';
    await assert.rejects(policy.assessWhenReady({github: pending.github, context, maxPolls: 1, wait: async () => {}}), /deadline/);
    const timed = fixture(); timed.state.run.status = 'in_progress';
    t.mock.method(global, 'setTimeout', callback => {timed.state.run.status = 'completed'; callback(); return 0;});
    assert.equal((await policy.assessWhenReady({github: timed.github, context, fetchImpl: provider})).decision, 'auto_approve');
  } finally {if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;}
});

function nativeFixture(overrides) {
  const f = fixture(overrides);
  const request = f.github.request;
  f.github.request = async (route, args) => {
    if (route.startsWith('POST')) {f.writes.push({name: 'rerun', args}); return {};}
    const result = await request(route, args);
    result.data[0].parameters.required_status_checks[1].context = 'approve-and-merge';
    return result;
  };
  return f;
}

test('native policy result fails on missing intent, pending assessment and integrity concerns', async () => {
  for (const decision of ['second_opinion', 'pending_technical', 'blocked_integrity']) {
    const f = nativeFixture();
    await assert.rejects(f.run({nativeGate: true, assessment: {...automatic, decision, reason: 'test evidence was bypassed'}}));
    assert.equal(f.writes.some(w => w.name === 'review'), false);
    assert.ok(f.writes.some(w => w.name === 'summary' && w.text.includes('Clouseau review: failure')));
    assert.equal(f.writes.some(w => w.name === 'createCheck' || w.name === 'updateCheck'), false);
  }
  const wrongProtection = fixture();
  await assert.rejects(wrongProtection.run({nativeGate: true}), /approve-and-merge/);
});

test('native policy success requires completed evidence and finishes before merge finalization', async () => {
  for (const confirmed of [false, true]) {
    const f = nativeFixture(confirmed ? {comments: [{user: human, body: `/approve-intent ${SHA}`}]} : {});
    await f.run({nativeGate: true, assessment: {...automatic, decision: confirmed ? 'second_opinion' : 'auto_approve'}});
    assert.equal(f.writes.some(w => w.name === 'createCheck' || w.name === 'updateCheck'), false);
    assert.ok(f.writes.some(w => w.name === 'review'));
    assert.ok(f.writes.some(w => w.name === 'summary' && w.text.includes('Clouseau review: success')));
    assert.equal(f.writes.some(w => w.name === 'dispatch'), false);
  }
});

function reassessmentFixture() {
  const f = nativeFixture();
  f.state.run.event = 'pull_request_target';
  f.github.rest.actions.getWorkflowRun = async args => {
    assert.equal(args.run_id, 22); return {data: f.state.run};
  };
  return f;
}
const commentTrigger = () => ({...context, eventName: 'issue_comment', payload: {
  issue: {number: 8, pull_request: {}}, comment: {user: human, body: `/approve-intent ${SHA}`},
}});

test('intent comment reruns only the trusted metadata workflow for the exact revision', async () => {
  const f = reassessmentFixture();
  const policy = createPolicy(require('../test/fixtures/config.json'));
  await policy.requestReassessment({github: f.github, context: commentTrigger(), core: {info() {}}, wait: async () => {}});
  assert.deepEqual(f.writes.filter(w => w.name === 'rerun').map(w => w.args.run_id), [22]);
  assert.equal(f.writes.some(w => w.name === 'dispatch' || w.name === 'review'), false);
  const manual = reassessmentFixture();
  await policy.requestReassessment({github: manual.github, context: {...context, actor: human.login, eventName: 'workflow_dispatch'}, core: {info() {}}, wait: async () => {}});
  assert.ok(manual.writes.some(w => w.name === 'rerun'));
  const accepted = reassessmentFixture();
  const acceptedContext = commentTrigger();
  acceptedContext.payload.comment.body += '\n\nAccepted purpose:\nRestore the established naming behavior.';
  await policy.requestReassessment({github: accepted.github, context: acceptedContext, core: {info() {}}, wait: async () => {}});
  assert.equal(accepted.writes.filter(w => w.name === 'rerun').length, 1);
});

test('reassessment rejects unauthorized, stale, unrelated and missing metadata runs', async () => {
  const policy = createPolicy(require('../test/fixtures/config.json'));
  for (const mutate of [
    (f, c) => {c.payload.comment.body = `/approve-intent ${BASE}`;},
    f => {f.state.permission = 'read';},
    (f, c) => {c.payload.comment.user = bot;},
    f => {f.state.pr.state = 'closed';},
    f => {f.state.pr.draft = true;},
    f => {f.state.pr.base.ref = 'other';},
    f => {f.state.run.event = 'pull_request';},
    f => {f.state.run.head_sha = BASE;},
    f => {f.state.run.head_repository = undefined; f.state.run.head_branch = 'other';},
  ]) {
    const f = reassessmentFixture(); const c = commentTrigger(); mutate(f, c);
    await assert.rejects(policy.requestReassessment({github: f.github, context: c, core: {info() {}}, wait: async () => {}}));
    assert.equal(f.writes.length, 0);
  }
});

test('an active metadata run consumes confirmation without duplicating work', async t => {
  const f = reassessmentFixture(); f.state.run.status = 'in_progress';
  const policy = createPolicy(require('../test/fixtures/config.json'));
  t.mock.method(global, 'setTimeout', callback => {callback(); return 0;});
  await policy.requestReassessment({github: f.github, context: commentTrigger(), core: {info() {} }});
  assert.equal(f.writes.length, 0);
  f.state.run.status = 'completed'; f.state.run.pull_requests = [{number: 8}];
  f.github.rest.actions.listWorkflowRuns = async () => ({data: {workflow_runs: [{...f.state.run, id: 21}, f.state.run]}});
  await policy.requestReassessment({github: f.github, context: commentTrigger(), core: {info() {}}, wait: async () => {}});
  assert.equal(f.writes.find(w => w.name === 'rerun').args.run_id, 22);
});

test('separate finalization validates revision and dispatches CD only for the merged main head', async () => {
  const policy = createPolicy(require('../test/fixtures/config.json'));
  for (const changed of ['number', 'head', 'base']) {
    const f = fixture(); const assessment = {...automatic};
    if (changed === 'number') assessment.number = 9;
    if (changed === 'head') f.state.pr.head.sha = BASE;
    if (changed === 'base') f.state.pr.base.ref = 'other';
    await assert.rejects(policy.finalize({github: f.github, context, core: {info() {}}, assessment}), /changed/);
    assert.equal(f.writes.length, 0);
  }
  const f = fixture(); f.state.pr.merged = true; f.state.pr.merge_commit_sha = BASE;
  const original = process.env.ASSESSMENT; process.env.ASSESSMENT = JSON.stringify(automatic);
  try {await policy.finalize({github: f.github, context, core: {info() {} }});}
  finally {if (original === undefined) delete process.env.ASSESSMENT; else process.env.ASSESSMENT = original;}
  assert.ok(f.writes.some(w => w.name === 'dispatch' && w.args.workflow_id === 'backend-deploy.yml'));
});


test('legacy controller callers cannot select private automatic writes without a validated acceptance record', async () => {
  const f = fixture();
  const policy = createPolicy(require('../test/fixtures/config.json'), {privateOwnerAutomatic: true});
  f.github.rest.repos.get = async () => ({data: {private: true, allow_auto_merge: false}});
  f.github.rest.repos.getBranch = async () => ({data: {protected: false}});
  f.github.request = async () => {throw Object.assign(new Error('Upgrade to GitHub Pro or make this repository public to enable this feature.'), {status: 403});};
  await assert.rejects(policy.gate({github: f.github, context, core: {info() {}}, assessment: automatic}), /validated protocol-two acceptance record/);
  assert.equal(f.writes.length, 0);
});

test('verification state distinguishes an absent, queued and running PR run', async () => {
  assert.deepEqual(await technicalRun(fixture({run: null}).github, repo, small), {pending: true, state: 'absent'});
  for (const [status, state] of [['queued', 'queued'], ['waiting', 'queued'], ['in_progress', 'running']]) {
    const f = fixture(); f.state.run.status = status;
    assert.deepEqual(await technicalRun(f.github, repo, small), {pending: true, state});
  }
});

// A single-slot pool: while the review job runs, the verification job queued
// behind it never starts, so every poll observes the same queued run.
function singleSlotDeadlock() {
  const f = fixture(); f.state.run.status = 'queued'; f.state.run.conclusion = null;
  const messages = []; const outputs = {}; let waits = 0;
  return {f, messages, outputs, core: {info: message => messages.push(message), setOutput: (name, value) => {outputs[name] = value;}},
    wait: async ms => {assert.equal(ms, 15000); waits++;}, waits: () => waits};
}
const awaiting = createPolicy(require('../test/fixtures/config.json'));
const waitSupport = require('./verification-wait.cjs');
const quiet = {info() {}, setOutput() {}};

test('the queue grace is a validated, conservative configuration knob', () => {
  assert.equal(waitSupport.graceSeconds({}), 900);
  assert.equal(waitSupport.graceSeconds({verification_queue_grace_seconds: 60}), 60);
  const base = require('../test/fixtures/config.json');
  for (const value of [0, 60, 3600]) assert.doesNotThrow(() => createPolicy({...base, verification_queue_grace_seconds: value}));
  for (const value of [-1, 3601, 1.5, '900', null]) {
    assert.throws(() => createPolicy({...base, verification_queue_grace_seconds: value}), /verification queue grace/);
  }
});

test('a review whose verification never starts ends pending after the grace instead of holding the only runner or failing', async () => {
  const d = singleSlotDeadlock();
  const result = await awaiting.awaitVerification({github: d.f.github, context, core: d.core, expectedHead: SHA, wait: d.wait});
  assert.equal(result.pending, true);
  assert.equal(d.outputs.verified, 'false');
  assert.equal(d.waits(), 60, 'the default 15 minute grace is 60 polls, not the 120-poll deadline');
  assert.match(d.messages.at(-1), /had not started.*without holding a runner.*made no decision.*reassessed automatically/s);
  const quick = singleSlotDeadlock();
  await awaiting.awaitVerification({github: quick.f.github, context, core: quick.core, expectedHead: SHA, wait: quick.wait, queuedGraceSeconds: 30});
  assert.equal(quick.waits(), 2);
  const none = singleSlotDeadlock();
  await awaiting.awaitVerification({github: none.f.github, context, core: none.core, expectedHead: SHA, wait: none.wait, queuedGraceSeconds: 0});
  assert.equal(none.waits(), 0, 'a zero grace releases the runner on the first idle check');
  const configured = createPolicy({...require('../test/fixtures/config.json'), verification_queue_grace_seconds: 15});
  const absent = {f: fixture({run: null}), outputs: {}, wait: async () => {}};
  await configured.awaitVerification({github: absent.f.github, context, core: {info() {}, setOutput: (n, v) => {absent.outputs[n] = v;}}, expectedHead: SHA, wait: absent.wait});
  assert.equal(absent.outputs.verified, 'false');
});

test('a read-only assessment whose verification never starts returns a pending decision, never an approval', async () => {
  const old = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional-key';
  try {
    const d = singleSlotDeadlock();
    const result = await awaiting.assessWhenReady({github: d.f.github, context, wait: d.wait, queuedGraceSeconds: 30});
    assert.equal(result.decision, 'pending_technical');
    assert.equal(result.verification, 'queued');
    assert.match(result.reason, /reassessed automatically/);
    assert.equal(d.waits(), 2);
    assert.ok(!result.record_digest);
  } finally {if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;}
});

test('verification that is genuinely running is awaited until it succeeds, and resets the queue grace', async () => {
  const f = fixture(); f.state.run.status = 'queued';
  const sequence = ['queued', 'queued', 'in_progress', 'in_progress', 'queued', 'completed'];
  let index = 0; const messages = []; const outputs = {};
  const result = await awaiting.awaitVerification({github: f.github, context,
    core: {info: message => messages.push(message), setOutput: (name, value) => {outputs[name] = value;}},
    expectedHead: SHA, queuedGraceSeconds: 30, wait: async () => {f.state.run.status = sequence[++index];}});
  assert.match(result.url, /runs\/22/);
  assert.equal(outputs.verified, 'true');
  assert.ok(messages.some(message => /Verified PR CI/.test(message)));
  assert.ok(messages.some(message => /No AI request has been made/.test(message)));
});

test('awaiting verification refuses failures, a changed PR, closed or draft PRs and an exhausted deadline', async () => {
  const failed = fixture(); failed.state.run.conclusion = 'failure';
  await assert.rejects(awaiting.awaitVerification({github: failed.github, context, core: quiet, expectedHead: SHA}), /concluded failure/);
  const changed = fixture();
  await assert.rejects(awaiting.awaitVerification({github: changed.github, context, core: quiet, expectedHead: BASE}), /changed while verification/);
  const push = sha => ({...context, eventName: 'push', sha});
  await assert.rejects(awaiting.awaitVerification({github: changed.github, context: push(BASE), core: quiet}), /changed while verification/);
  assert.ok((await awaiting.awaitVerification({github: changed.github, context: push(SHA), core: quiet})).url);
  // A comment or manual run executes on the default branch: its own sha is not the PR head.
  const comment = {...context, eventName: 'issue_comment', sha: 'c'.repeat(40)};
  assert.ok((await awaiting.awaitVerification({github: changed.github, context: comment, core: quiet})).url);
  const moving = fixture(); moving.state.run.status = 'in_progress';
  await assert.rejects(awaiting.awaitVerification({github: moving.github, context: comment, core: quiet,
    wait: async () => {moving.state.pr.head.sha = BASE;}}), /changed while verification/);
  for (const mutate of [pr => {pr.state = 'closed';}, pr => {pr.draft = true;}]) {
    const f = fixture(); mutate(f.state.pr);
    await assert.rejects(awaiting.awaitVerification({github: f.github, context, core: quiet, expectedHead: SHA}), /closed, became draft/);
  }
  const running = fixture(); running.state.run.status = 'in_progress';
  await assert.rejects(awaiting.awaitVerification({github: running.github, context, core: quiet, expectedHead: SHA,
    maxPolls: 2, wait: async () => {}}), /did not complete before the wait deadline/);
  await assert.rejects(awaiting.awaitVerification({github: running.github, context, core: quiet, expectedHead: SHA, maxPolls: 0}), /deadline/);
});

test('the default sleep paces verification polling', async t => {
  const f = fixture(); f.state.run.status = 'in_progress';
  t.mock.method(global, 'setTimeout', callback => {f.state.run.status = 'completed'; callback(); return 0;});
  assert.ok((await awaiting.awaitVerification({github: f.github, context, core: quiet, expectedHead: SHA})).url);
});

test('a held technical assessment reports its own reason on a private owner repository instead of a missing record', async () => {
  for (const decision of ['blocked_technical', 'blocked_integrity']) {
    const f = fixture(); f.state.pr.auto_merge = null;
    const policy = createPolicy(require('../test/fixtures/config.json'), {privateOwnerAutomatic: true});
    f.github.rest.repos.get = async () => ({data: {private: true, allow_auto_merge: false}});
    f.github.rest.repos.getBranch = async () => ({data: {protected: false}});
    f.github.request = async () => {throw Object.assign(new Error('Upgrade to GitHub Pro or make this repository public to enable this feature.'), {status: 403});};
    await assert.rejects(policy.gate({github: f.github, context, core: {info() {}, summary: {addRaw() {return this;}, async write() {}}},
      nativeGate: true, assessment: {...automatic, decision, reason: 'fixture held reason'}}), error => error.message === 'fixture held reason');
  }
});

// The verification run that a pending review was waiting for has completed.
const verificationTrigger = (overrides = {}) => ({...context, eventName: 'workflow_run', payload: {workflow_run: {
  event: 'pull_request', path: '.github/workflows/backend-ci.yml', head_sha: SHA, pull_requests: [{number: 8}], ...overrides}}});

test('a completed verification run reassesses a review that ended pending, without any maintainer comment', async () => {
  const policy = createPolicy(require('../test/fixtures/config.json'));
  const f = reassessmentFixture(); f.state.run.conclusion = 'failure';
  f.github.rest.repos.getCollaboratorPermissionLevel = async () => assert.fail('the trusted workflow event needs no actor permission');
  await policy.requestReassessment({github: f.github, context: verificationTrigger(), core: {info() {}}, wait: async () => {}});
  assert.deepEqual(f.writes.filter(w => w.name === 'rerun').map(w => w.args.run_id), [22]);
  const forked = reassessmentFixture(); forked.state.run.conclusion = 'cancelled';
  forked.github.rest.repos.listPullRequestsAssociatedWithCommit = async args => {
    assert.equal(args.commit_sha, SHA);
    return {data: [{number: 8, state: 'open', base: {ref: 'main'}}, {number: 9, state: 'closed', base: {ref: 'main'}}, {number: 10, state: 'open', base: {ref: 'other'}}]};
  };
  await policy.requestReassessment({github: forked.github, context: verificationTrigger({pull_requests: []}), core: {info() {}}, wait: async () => {}});
  assert.equal(forked.writes.filter(w => w.name === 'rerun').length, 1);
  // The pending review may still be ending when verification completes: wait for it.
  const ending = reassessmentFixture(); ending.state.run.conclusion = 'failure'; ending.state.run.status = 'in_progress';
  let waits = 0;
  await policy.requestReassessment({github: ending.github, context: verificationTrigger(), core: {info() {}},
    wait: async ms => {assert.equal(ms, 10000); if (++waits === 3) ending.state.run.status = 'completed';}});
  assert.equal(waits, 3); assert.equal(ending.writes.filter(w => w.name === 'rerun').length, 1);
});

test('a completed verification run never reruns a succeeded, running, stale, unrelated or absent review', async () => {
  const policy = createPolicy(require('../test/fixtures/config.json'));
  const messages = [];
  const core = {info: message => messages.push(message)};
  const attempt = async (mutate, trigger = verificationTrigger()) => {
    const f = reassessmentFixture(); f.state.run.conclusion = 'failure'; mutate(f, trigger);
    await policy.requestReassessment({github: f.github, context: trigger, core, wait: async () => {}});
    assert.equal(f.writes.length, 0);
    return messages.at(-1);
  };
  assert.match(await attempt(f => {f.state.run.conclusion = 'success';}), /already succeeded/);
  assert.match(await attempt(f => {f.state.run.status = 'in_progress';}), /still running/);
  assert.match(await attempt(f => {f.state.run.head_sha = BASE;}), /No trusted PR metadata run/);
  assert.match(await attempt(() => {}, verificationTrigger({event: 'push'})), /Not a PR verification run/);
  assert.match(await attempt(() => {}, verificationTrigger({path: '.github/workflows/other.yml'})), /Not a PR verification run/);
  assert.match(await attempt(() => {}, verificationTrigger({head_sha: BASE})), /no longer a ready PR head/);
  assert.match(await attempt(f => {f.state.pr.state = 'closed';}), /no longer a ready PR head/);
  assert.match(await attempt(f => {f.state.pr.draft = true;}), /no longer a ready PR head/);
  assert.match(await attempt(f => {f.state.pr.base.ref = 'other';}), /no longer a ready PR head/);
  assert.match(await attempt(() => {}, verificationTrigger({pull_requests: [{number: 8}, {number: 9}]})), /No single open PR/);
  assert.match(await attempt(f => {
    f.github.rest.repos.listPullRequestsAssociatedWithCommit = async () => ({data: []});
  }, verificationTrigger({pull_requests: []})), /No single open PR/);
});
