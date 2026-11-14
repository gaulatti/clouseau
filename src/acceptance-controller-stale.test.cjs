'use strict';
// The gate's check for an assessment made before the owner's confirmation (src/stale-assessment.cjs). Kept apart from
// acceptance-controller.test.cjs so a change here does not resend that file as review evidence; the fixture is that file's.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createPolicy} = require('./policy.cjs');
const {template, modelTemplate} = require('./acceptance-review.cjs');
const {digest} = require('./acceptance.cjs');
const {verifyRecord, numberFor, decided} = require('./acceptance-controller.cjs');
const {CASES, prepareCase} = require('../test/acceptance-cases.cjs');
const {hostedFiles} = require('../test/hosted-files.cjs');
const {describe} = require('./receipt-rejection.cjs');

const config = {...require('../test/fixtures/config.json'), version: 2, repository_policy: '.github/clouseau.md', readme: 'README.md', acceptance: {
  examiner: 'deepseek-flash', challenger: 'deepseek-flash', grader: 'deepseek', grading_model: 'deepseek-flash', repair_attempts: 2,
}};

async function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-acceptance-'));
  const old = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional';
  try {
    const {github, repo, snapshot} = await prepareCase(CASES[0]);
    const policy = createPolicy(config);
    const context = {repo, runId: 7, eventName: 'pull_request_target', payload: {pull_request: {number: 3}}};
    const state = {comments: [], reviews: [], writes: [], failed: false, calls: 0, pending: false,
      pr: {number: 3, node_id: 'PR_3', state: 'open', draft: false, changed_files: 1, user: {login: 'contributor', type: 'User'},
        head: {sha: snapshot.head_sha, ref: 'fix/upload', repo: {id: 7, owner: {login: repo.owner}, name: repo.repo}},
        base: {sha: snapshot.base_sha, ref: 'main'}, auto_merge: {enabled_by: {login: 'github-actions[bot]'}}}};
    const graphql = github.graphql;
    github.graphql = async (query, args) => {
      if (query.startsWith('mutation')) {const disable = query.includes('disablePullRequestAutoMerge'); state.writes.push({name: disable ? 'disable-auto' : 'enable-auto'}); state.pr.auto_merge = disable ? null : {}; return {};}
      return graphql(query, args);
    };
    const endpoint = (name, fn) => Object.assign(fn, {endpointName: name});
    const write = name => endpoint(name, async args => {state.writes.push({name, args}); return {data: {id: 100 + state.writes.length}};});
    github.rest.pulls = {
      get: async () => ({data: structuredClone(state.pr)}),
      listFiles: endpoint('files', async () => ({data: hostedFiles(snapshot)})),
      listReviews: endpoint('reviews', async () => ({data: state.reviews})),
      createReview: write('approve'), requestReviewers: write('request-review'),
    };
    github.rest.issues = {
      listComments: endpoint('comments', async () => ({data: state.comments})),
      createComment: write('create-ledger'), updateComment: write('update-ledger'), addAssignees: write('assign'),
    };
    github.rest.actions = {
      listWorkflowRuns: async () => ({data: {workflow_runs: [{id: 9, run_attempt: 1, head_sha: state.pr.head.sha,
        event: 'pull_request', pull_requests: [{number: 3}], status: state.pending ? 'in_progress' : 'completed',
        conclusion: state.failed ? 'failure' : 'success', html_url: 'https://github.com/example/gateway/actions/runs/9'}]}}),
      listJobsForWorkflowRun: endpoint('jobs', async () => ({data: [{id: 10, name: 'verify', conclusion: 'success',
        steps: config.verification.steps.map(name => ({name, conclusion: 'success'}))}]})),
    };
    const readContent = github.rest.repos.getContent;
    github.rest.repos.getContent = args => args.path === '.github/CODEOWNERS' ? Promise.resolve({data: {
      encoding: 'base64', content: Buffer.from('* @contributor').toString('base64'), size: 14}}) : readContent(args);
    Object.assign(github.rest.repos, {
      get: async () => ({data: {allow_auto_merge: true}}), getBranch: async () => ({data: {protected: true}}),
      getCollaboratorPermissionLevel: async () => ({data: {permission: 'write'}}),
    });
    github.paginate = async (method, args) => (await method(args)).data;
    github.request = async () => ({data: [
      {type: 'required_status_checks', parameters: {strict_required_status_checks_policy: true,
        required_status_checks: ['verify', 'approve-and-merge'].map(context => ({context, integration_id: 15368}))}},
      {type: 'pull_request', parameters: {required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true}},
      {type: 'non_fast_forward'}, {type: 'deletion'},
    ]});
    const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
    const recordPath = path.join(directory, 'record.json');
    const fetchImpl = async (_, options) => {
      state.calls++;
      const body = JSON.parse(options.body);
      if (body.tools?.[0].function.name === 'repair_proposal') {
        const state = JSON.parse(body.messages[1].content);
        const value = {envelope_digest: digest(state.envelope), summary: 'Restore the accepted boundary.', edits:
          [{path: state.envelope.paths[0].path, before: state.envelope.paths[0].before, action: 'replace', content: 'Production-bound regression assertion restored.\n'}]};
        return {ok: true, json: async () => ({choices: [{finish_reason: 'tool_calls', message: {tool_calls:
          [{function: {name: 'repair_proposal', arguments: JSON.stringify(value)}}]}}]})};
      }
      if (!body.tools) {
        const {questions} = JSON.parse(body.messages[1].content);
        return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers:
          Object.fromEntries(Object.keys(questions).map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))})}}]})};
      }
      const view = JSON.parse(body.messages[1].content);
      for (const source of Object.values(view.sources)) source.content = source.numbered_lines.replace(/^L[0-9]+: /gm, '');
      const report = state.alter ? template(view) : modelTemplate(view);
      report.gates.forEach(gate => {gate.state = 'satisfied';});
      if (state.alter) state.alter(report);
      return {ok: true, json: async () => ({choices: [{finish_reason: 'tool_calls', message: {tool_calls:
        [{function: {name: 'acceptance_report', arguments: JSON.stringify(report)}}]}}]})};
    };
    const assess = extra => policy.assess({github, context, recordPath, fetchImpl, ...extra});
    const gate = assessment => policy.gate({github, context, core, recordPath, assessment, nativeGate: true, wait: async () => {}});
    await run({directory, recordPath, config, policy, github, context, state, assess, gate, fetchImpl});
  } finally {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;
    fs.rmSync(directory, {recursive: true});
  }
}

test('a gate re-run on an assessment made before the owner confirmation fails with a named cause and one recovery notice', () => fixture(async f => {
  const head = f.state.pr.head.sha;
  const assessment = {version: 2, number: 3, head_sha: head, base_sha: f.state.pr.base.sha, engine: null, decision: 'review_incomplete',
    cause: 'receipt_protected_controls', reason: 'The exact-head owner confirmation is missing.', assessed_at: '2026-11-12T14:21:10.000Z'};
  const confirmation = at => ({id: 88, user: {login: config.manual_reviewer, type: 'User'}, body: `/approve-intent ${head}`, created_at: at,
    html_url: 'https://github.com/example/gateway/pull/3#issuecomment-88'});
  const gate = value => f.policy.gate({github: f.github, context: f.context, core: {info() {}, summary: {addRaw() {return this;}, async write() {}}},
    assessment: value, recordPath: f.recordPath, nativeGate: true});
  const notices = () => f.state.writes.filter(w => w.name === 'create-ledger' && w.args.body.startsWith(`<!-- clouseau-stale-assessment:${head}:88 -->\n`));
  f.github.rest.issues.createComment = async args => {
    f.state.writes.push({name: 'create-ledger', args}); f.state.comments.push({id: 900 + f.state.comments.length, user: {login: 'github-actions[bot]'}, body: args.body});
    return {data: {id: 900}};
  };
  f.state.comments.push(confirmation('2026-11-12T14:36:19Z'));
  await assert.rejects(gate(assessment), /Cause: `assessment_predates_confirmation`.*re-run all jobs/s);
  assert.equal(notices().length, 1);
  assert.match(notices()[0].args.body, /Re-run all jobs\*\* \(not "Re-run failed jobs"\)/);
  // The same head and confirmation again: still held, no second notice.
  await assert.rejects(gate(assessment), /assessment_predates_confirmation/);
  assert.equal(notices().length, 1, 'one notice per head and confirmation, not one per re-run');
  assert.deepEqual(f.state.writes.filter(w => ['approve', 'enable-auto'].includes(w.name)), [], 'nothing is approved or armed');
}));

test('a confirmation the assessment could have read, an approvable assessment or one without the stamp take today\'s path', () => fixture(async f => {
  const head = f.state.pr.head.sha;
  const base = {version: 2, number: 3, head_sha: head, base_sha: f.state.pr.base.sha, engine: null, decision: 'review_incomplete',
    cause: 'receipt_protected_controls', reason: 'The exact-head owner confirmation is missing.'};
  f.state.comments.push({id: 88, user: {login: config.manual_reviewer, type: 'User'}, body: `/approve-intent ${head}`, created_at: '2026-11-12T14:36:19Z'});
  const gate = value => f.policy.gate({github: f.github, context: f.context, core: {info() {}, summary: {addRaw() {return this;}, async write() {}}},
    assessment: value, recordPath: f.recordPath, nativeGate: true});
  // A comment GitHub created in the same second as the listing's date counts as seen.
  for (const assessment of [{...base, assessed_at: '2026-11-12T14:40:00.000Z'}, {...base, assessed_at: '2026-11-12T14:36:19.000Z'}, base, {...base, assessed_at: 'not a time'},
    {...base, assessed_at: '2026-11-12T14:21:10.000Z', head_sha: 'f'.repeat(40)}]) {
    await assert.rejects(gate(assessment), error => !/assessment_predates_confirmation/.test(error.message), JSON.stringify(assessment.assessed_at));
  }
  const {newerConfirmation} = require('./stale-assessment.cjs');
  // A closed, draft or other-base pull request, or one whose base moved, takes the gate's own path: no stale notice.
  const stamped = {...base, assessed_at: '2026-11-12T14:21:10.000Z'};
  f.state.comments.push({id: 91, user: {login: config.manual_reviewer, type: 'User'}, body: `/approve-intent ${head}`, created_at: '2026-11-12T14:36:19Z'});
  for (const change of [pr => {pr.state = 'closed';}, pr => {pr.draft = true;}, pr => {pr.base.ref = 'release';}, pr => {pr.base.sha = 'f'.repeat(40);}]) {
    const saved = structuredClone(f.state.pr); change(f.state.pr);
    assert.equal(await newerConfirmation({github: f.github, context: f.context, number: 3, legacy: f.policy, baseBranch: 'main', assessment: stamped}), null);
    f.state.pr = saved;
  }
  assert.ok(await newerConfirmation({github: f.github, context: f.context, number: 3, legacy: f.policy, baseBranch: 'main', assessment: stamped}), 'the ready case is still detected');
  f.state.comments.pop();
  // Only the hold an owner confirmation resolves is checked; any other hold keeps its own reason.
  for (const other of [{decision: 'blocked_technical', cause: undefined}, {decision: 'pending_technical', cause: 'verification_pending'},
    {decision: 'review_incomplete', cause: 'local_receipt_required'}, {decision: 'blocked_integrity', cause: undefined}]) {
    assert.equal(await newerConfirmation({github: f.github, context: f.context, number: 3, legacy: f.policy, baseBranch: 'main',
      assessment: {...base, ...other, assessed_at: '2026-11-12T14:21:10.000Z'}}), null, JSON.stringify(other));
  }
  for (const decision of ['auto_approve', 'owner_decision']) {
    assert.equal(await newerConfirmation({github: f.github, context: f.context, number: 3, legacy: f.policy, baseBranch: 'main',
      assessment: {...base, decision, assessed_at: '2026-11-12T14:21:10.000Z'}}), null, decision);
  }
  // Another user's comment, or one that names another head, is not a confirmation of this head.
  f.state.comments.splice(0, 1, {id: 89, user: {login: 'someone-else', type: 'User'}, body: `/approve-intent ${head}`, created_at: '2026-11-12T14:36:19Z'},
    {id: 90, user: {login: config.manual_reviewer, type: 'User'}, body: `/approve-intent ${'e'.repeat(40)}`, created_at: '2026-11-12T14:36:19Z'});
  assert.equal(await newerConfirmation({github: f.github, context: f.context, number: 3, legacy: f.policy, baseBranch: 'main',
    assessment: {...base, assessed_at: '2026-11-12T14:21:10.000Z'}}), null);
}));
