'use strict';
// Gate behavior under the protected local_review.binding setting. Kept apart from acceptance-controller.test.cjs so a change here does not resend that file as review evidence.

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
// The one notice a run reports for an ignored receipt: its header names the cause class and its lead says what the run did.
const isNotice = (reason, mode = 'optional') => line => line.startsWith(`Local review receipt not used (cause: \`receipt_${reason}\`): `) &&
  line.includes(describe(reason, {mode}).lead) && /\n\n1\. /.test(line);
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

for (const binding of [undefined, 'diff']) test(`binding=${binding}: after the base moved and the branch was updated, only a receipt bound to an unchanged diff still stands, with zero CI AI calls`, () => fixture(async f => {
  const crypto = require('node:crypto');
  const {issueReceipt} = require('./local-receipt.cjs');
  const {refresh} = require('./acceptance-sources.cjs');
  await f.assess();
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  const keys = crypto.generateKeyPairSync('ed25519');
  const trusted = {...config, local_review: {mode: 'optional', reviewer_sha: 'e'.repeat(40),
    reviewer_digest: require('./local-version.cjs').engineDigest(), max_age_seconds: 172800,
    keys: [{id: 'fixture', issuer: 'fixture-runner', github_actor: 'contributor', revoked: false,
      public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}], ...(binding ? {binding} : {})}};
  record.snapshot.number = 0; record.snapshot.config_digest = digest(trusted); refresh(record.snapshot);
  record.result.snapshot = record.snapshot.digest; record.result.config_digest = record.snapshot.config_digest;
  record.result.usage = ['examiner', 'challenger'].flatMap(role => ['investigation', 'grading'].map(phase =>
    ({role, phase, harness: 'codex', session: `fictional-${role}-${phase}`, request_digest: digest(role),
      response_digest: digest(phase), transport_digest: digest({fixture_only: true})})));
  record.result.execution_digest = digest(record.result.usage);
  for (const item of record.result.reviews) item.report.snapshot = record.snapshot.digest;
  const bundle = issueReceipt({record, privateKey: keys.privateKey.export({type: 'pkcs8', format: 'pem'}),
    keyId: 'fixture', issuer: 'fixture-runner', reviewerSha: trusted.local_review.reviewer_sha});
  const original = f.github.rest.repos.getContent;
  const reads = [];
  f.github.rest.repos.getContent = async args => {
    reads.push(args);
    return args.path === 'clouseau-review.json' ? {data: {encoding: 'base64', content: Buffer.from(JSON.stringify(bundle)).toString('base64'),
      size: JSON.stringify(bundle).length}} : original(args);
  };
  const policy = createPolicy(trusted);
  f.state.pr.body = `Ready change.\n<!-- clouseau-local-review:v1 ${'f'.repeat(40)} -->`;
  const assess = async () => {
    const calls = f.state.calls; const lines = []; reads.length = 0;
    const result = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl, report: line => lines.push(line)});
    return {result, lines, providerCalls: f.state.calls - calls};
  };
  const exact = await assess();
  assert.equal(exact.result.review_source, 'authenticated_local'); assert.equal(exact.providerCalls, 0);
  // The base moves and GitHub merges it into the branch; the pull request's diff is unchanged (lines above shift only).
  const files = f.github.rest.pulls.listFiles;
  const signedHead = f.state.pr.head.sha;
  f.state.pr.base.sha = 'b1'.padEnd(40, '1'); f.state.pr.head.sha = 'a1'.padEnd(40, '1');
  f.github.rest.pulls.listFiles = Object.assign(async args => {
    const listed = await files(args);
    return {data: listed.data.map(file => ({...file, patch: file.patch?.replace(/^@@ -(\d+)(,\d+)? \+(\d+)/gm, (_, a, b, c) => `@@ -${Number(a) + 4}${b ?? ''} +${Number(c) + 4}`)}))};
  }, {endpointName: 'files'});
  const moved = await assess();
  if (binding === undefined) {
    // Today: the receipt is ignored for its head and CI reviews the change itself.
    assert.equal(moved.result.receipt_notice, 'revision_head'); assert.notEqual(moved.result.review_source, 'authenticated_local');
    assert.ok(moved.providerCalls > 0);
    return;
  }
  assert.equal(moved.result.decision, 'auto_approve', moved.result.reason);
  assert.equal(moved.result.review_source, 'authenticated_local'); assert.equal(moved.providerCalls, 0);
  assert.equal(moved.result.head_sha, f.state.pr.head.sha); assert.equal(moved.result.receipt_notice, undefined);
  assert.ok(!reads.some(read => read.ref === f.state.pr.head.sha || read.ref === f.state.pr.base.sha),
    'no signed full-file source is compared with the live revisions');
  await policy.gate({github: f.github, context: f.context, core: {info() {}, summary: {addRaw() {return this;}, async write() {}}},
    recordPath: f.recordPath, assessment: moved.result, nativeGate: true, wait: async () => {}});
  assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 1);
  // A change to a changed or context line voids the receipt, with the source notice naming the file; CI then reviews.
  f.github.rest.pulls.listFiles = Object.assign(async args => {
    const listed = await files(args);
    return {data: listed.data.map(file => ({...file, patch: `${file.patch}\n+an added line`}))};
  }, {endpointName: 'files'});
  const changed = await assess();
  assert.equal(changed.result.receipt_notice, 'source'); assert.ok(changed.providerCalls > 0);
  assert.ok(changed.lines.some(line => line.includes('receipt_source') && line.includes('(file: `')));
  assert.notEqual(signedHead, f.state.pr.head.sha);
}));
