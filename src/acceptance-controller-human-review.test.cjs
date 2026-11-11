'use strict';
// Gate behavior under the protected local_review.human_review setting. Kept apart from acceptance-controller.test.cjs so a change here does not resend that file as review evidence.

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
const {withFinding} = require('../test/local-review-fixture.cjs');
const {describe} = require('./receipt-rejection.cjs');
// The one notice a run reports for an ignored receipt: its header names the cause class and its lead says what the run did.
const isNotice = (reason, mode = 'optional') => line => line.startsWith(`Local review receipt not used (cause: \`receipt_${reason}\`): `) &&
  line.includes(describe(reason, {mode}).lead) && /\n\n1\. /.test(line);
const config = {...require('../test/fixtures/config.json'), version: 2, repository_policy: '.github/clouseau.md', readme: 'README.md', acceptance: {
  examiner: 'deepseek-flash', challenger: 'deepseek-flash', grader: 'deepseek', grading_model: 'deepseek-flash', repair_attempts: 2,
}};

const withoutFieldConfig = value => {
  const copy = structuredClone(value);
  delete copy.local_review.human_review;
  return copy;
};
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

for (const setting of [undefined, 'signed']) test(`human_review=${setting}: a signed review that requires a human is held for the maintainer's exact-head approval, never accepted as a pass`, () => fixture(async f => {
  const crypto = require('node:crypto');
  const {issueReceipt, reviewDecision} = require('./local-receipt.cjs');
  const {refresh} = require('./acceptance-sources.cjs');
  await f.assess();
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  const keys = crypto.generateKeyPairSync('ed25519');
  const local = {mode: 'optional', reviewer_sha: 'e'.repeat(40), reviewer_digest: require('./local-version.cjs').engineDigest(), max_age_seconds: 172800,
    keys: [{id: 'fixture', issuer: 'fixture-runner', github_actor: 'contributor', revoked: false, public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}],
    ...(setting ? {human_review: setting} : {})};
  const sign = (trusted, mutate = () => {}) => {
    const copy = structuredClone(record);
    copy.snapshot.number = 0; copy.snapshot.config_digest = digest(trusted); refresh(copy.snapshot);
    copy.result.snapshot = copy.snapshot.digest; copy.result.config_digest = copy.snapshot.config_digest;
    copy.result.usage = ['examiner', 'challenger'].flatMap(role => ['investigation', 'grading'].map(phase =>
      ({role, phase, harness: 'codex', session: `fictional-${role}-${phase}`, request_digest: digest(role), response_digest: digest(phase), transport_digest: digest({fixture_only: true})})));
    copy.result.execution_digest = digest(copy.result.usage);
    for (const item of copy.result.reviews) item.report.snapshot = copy.snapshot.digest;
    mutate(copy);
    return issueReceipt({record: copy, privateKey: keys.privateKey.export({type: 'pkcs8', format: 'pem'}), keyId: 'fixture', issuer: 'fixture-runner',
      reviewerSha: local.reviewer_sha, humanReview: true});
  };
  // A finding at or above the threshold with every gate satisfied, so the recalculated decision is repair_required.
  const findings = copy => {Object.assign(copy, withFinding(copy));};
  const trusted = {...config, local_review: local};
  let served = sign(trusted, findings);
  assert.equal(served.payload.record.result.decision, 'repair_required');
  const original = f.github.rest.repos.getContent;
  f.github.rest.repos.getContent = async args => args.path === 'clouseau-review.json' ? {data: {encoding: 'base64',
    content: Buffer.from(JSON.stringify(served)).toString('base64'), size: JSON.stringify(served).length}} : original(args);
  const policy = createPolicy(trusted);
  f.state.pr.body = `Ready change.\n<!-- clouseau-local-review:v1 ${'f'.repeat(40)} -->`;
  const assess = async (target = policy) => {
    const calls = f.state.calls; const lines = [];
    const result = await target.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl, report: line => lines.push(line)});
    return {result, lines, providerCalls: f.state.calls - calls};
  };
  const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
  const approvals = () => f.state.writes.filter(item => item.name === 'approve').length;
  // It never attests the verification, whatever the setting.
  assert.equal(await require('./verification-attestation.cjs').receiptAttests({github: f.github, repo: f.context.repo, pr: f.state.pr, config: trusted, engine: null}), false);
  const held = await assess();
  if (setting === undefined) {
    // Today: a failing review is not a receipt; it is ignored and CI reviews the change itself.
    assert.equal(held.result.receipt_notice, 'not_passing'); assert.ok(held.providerCalls > 0);
    assert.notEqual(held.result.review_source, 'authenticated_local');
    return;
  }
  assert.equal(held.result.decision, 'owner_decision', held.result.reason); assert.equal(held.providerCalls, 0);
  assert.equal(held.result.review_source, 'authenticated_local');
  assert.match(held.result.reason, new RegExp(`requires a human review \\(its signed findings are listed in the review\\); a maintainer approves this exact head with \`/approve-intent ${f.state.pr.head.sha}\``));
  assert.ok(held.lines.some(line => line.includes('it requires a human review')));
  // The gate shows the signed verdict and its findings, and holds until a maintainer approves this exact head.
  await assert.rejects(policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment: held.result, nativeGate: true, wait: async () => {}}), /A maintainer intent confirmation is required/);
  assert.equal(approvals(), 0);
  const ledger = f.state.writes.find(item => ['create-ledger', 'update-ledger'].includes(item.name) && /Authenticated local review/.test(item.args.body));
  assert.ok(ledger, 'the verdict and its reasons are shown from the signed record');
  // Claiming a pass for that record is a decision mismatch, never an approval.
  await assert.rejects(policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment: {...held.result, decision: 'auto_approve'}, nativeGate: true, wait: async () => {}}), /cannot approve or merge|decision/i);
  assert.equal(approvals(), 0);
  // An approval of an older head, by comment or by review, never clears the hold of this head.
  const older = 'c'.repeat(40);
  f.state.comments = [...f.state.comments, {id: 949, user: {login: 'gaulatti', type: 'User'}, body: `/approve-intent ${older}`}];
  f.state.reviews = [{id: 1, user: {login: 'gaulatti', type: 'User'}, state: 'APPROVED', commit_id: older}];
  await assert.rejects(policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment: held.result, nativeGate: true, wait: async () => {}}), /A maintainer intent confirmation is required/);
  assert.equal(approvals(), 0, 'a stale approval leaves the signed findings held');
  f.state.reviews = [];
  f.state.comments = [...f.state.comments, {id: 950, user: {login: 'gaulatti', type: 'User'}, body: `/approve-intent ${f.state.pr.head.sha}`}];
  await policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment: held.result, nativeGate: true, wait: async () => {}});
  assert.equal(approvals(), 1, 'the maintainer approval of the exact head clears the signed findings');
  // A change the fixed rules send to a human (here a protected path) is the same hold instead of an unusable receipt.
  f.state.comments = [];
  const guarded = {...trusted, sensitive_paths: [...trusted.sensitive_paths, 'src/upload.test.js']};
  served = sign(guarded);
  const controls = await assess(createPolicy(guarded));
  assert.equal(controls.result.decision, 'owner_decision', controls.result.reason); assert.equal(controls.providerCalls, 0);
  assert.match(controls.result.reason, /it changes protected review controls/);
  // The transported hold flag is never trusted: it must be exactly true, and only where the protected setting allows it.
  const compact = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'));
  assert.equal(compact.local_controls, true);
  // The valid hold record reaches the gate and holds there until the maintainer confirms this exact head; then it approves.
  const approved = approvals();
  const gateControls = () => createPolicy(guarded).gate({github: f.github, context: f.context, core, recordPath: f.recordPath,
    assessment: controls.result, nativeGate: true, wait: async () => {}});
  await assert.rejects(gateControls(), /A maintainer intent confirmation is required/);
  assert.equal(approvals(), approved);
  f.state.comments = [{id: 951, user: {login: 'gaulatti', type: 'User'}, body: `/approve-intent ${f.state.pr.head.sha}`}];
  await gateControls();
  assert.equal(approvals(), approved + 1, 'the exact-head confirmation clears the protected-controls hold');
  f.state.comments = [];
  await assert.rejects(createPolicy(withoutFieldConfig(guarded)).gate({github: f.github, context: f.context, core, recordPath: f.recordPath,
    assessment: controls.result, nativeGate: true, wait: async () => {}}), /Invalid compact local review record/);
  const forged = {...compact, local_controls: 'yes'};
  fs.writeFileSync(f.recordPath, JSON.stringify(forged));
  await assert.rejects(createPolicy(guarded).gate({github: f.github, context: f.context, core, recordPath: f.recordPath,
    assessment: {...controls.result, record_reference_digest: digest(forged)}, nativeGate: true, wait: async () => {}}), /Invalid compact local review record/);
  const withoutField = withoutFieldConfig(guarded);
  served = sign(withoutField);
  const today = await assess(createPolicy(withoutField));
  assert.equal(today.result.cause, 'receipt_protected_controls');
}));
