'use strict';
// CI boundary for a receipt signed for graded findings under the protected local_review.human_review "signed": with the setting
// CI holds it for the maintainer's exact-head /approve-intent and never approves it; without it the receipt is refused as
// `not_passing`. Either way it merges nothing. Kept apart from acceptance-controller.test.cjs so a change here does not resend
// that file as review evidence.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createPolicy} = require('./policy.cjs');
const {modelTemplate} = require('./acceptance-review.cjs');
const {digest} = require('./acceptance.cjs');
const {issueReceipt} = require('./local-receipt.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {receiptAttests, decide} = require('./verification-attestation.cjs');
const {CASES, prepareCase} = require('../test/acceptance-cases.cjs');
const {hostedFiles} = require('../test/hosted-files.cjs');
const {withFinding} = require('../test/local-review-fixture.cjs');

const config = {...require('../test/fixtures/config.json'), version: 2, repository_policy: '.github/clouseau.md', readme: 'README.md', acceptance: {
  examiner: 'deepseek-flash', challenger: 'deepseek-flash', grader: 'deepseek', grading_model: 'deepseek-flash', repair_attempts: 2,
}};
const MERGE_WRITES = ['approve', 'enable-auto', 'atomic'];

async function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-signed-refusal-'));
  const old = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional';
  try {
    const {github, repo, snapshot} = await prepareCase(CASES[0]);
    const context = {repo, runId: 7, eventName: 'pull_request_target', payload: {pull_request: {number: 3}}};
    const state = {comments: [], reviews: [], writes: [], calls: 0,
      pr: {number: 3, node_id: 'PR_3', state: 'open', draft: false, changed_files: 1, user: {login: 'contributor', type: 'User'},
        head: {sha: snapshot.head_sha, ref: 'fix/upload', repo: {id: 7, owner: {login: repo.owner}, name: repo.repo}},
        base: {sha: snapshot.base_sha, ref: 'main'}, auto_merge: null, body: ''}};
    const graphql = github.graphql;
    // Every merge path is a recorded write: native auto-merge and the atomic ref update of the private owner path.
    github.graphql = async (query, args) => {
      if (query.includes('updateRefs')) {state.writes.push({name: 'atomic', args}); return {updateRefs: {clientMutationId: null}};}
      if (query.startsWith('mutation')) {
        const disable = query.includes('disablePullRequestAutoMerge');
        state.writes.push({name: disable ? 'disable-auto' : 'enable-auto'}); state.pr.auto_merge = disable ? null : {}; return {};
      }
      return graphql(query, args);
    };
    const endpoint = (name, fn) => Object.assign(fn, {endpointName: name});
    const write = name => endpoint(name, async args => {state.writes.push({name, args}); return {data: {id: 100 + state.writes.length}};});
    github.rest.pulls = {
      get: async () => ({data: structuredClone(state.pr)}),
      listFiles: endpoint('files', async () => ({data: hostedFiles(snapshot)})),
      listReviews: endpoint('reviews', async () => ({data: state.reviews})),
      createReview: write('approve'), requestReviewers: write('request-review'), merge: write('atomic'),
    };
    github.rest.issues = {
      listComments: endpoint('comments', async () => ({data: state.comments})),
      createComment: write('create-ledger'), updateComment: write('update-ledger'), addAssignees: write('assign'),
    };
    github.rest.actions = {
      listWorkflowRuns: async () => ({data: {workflow_runs: [{id: 9, run_attempt: 1, head_sha: state.pr.head.sha,
        event: 'pull_request', pull_requests: [{number: 3}], status: 'completed',
        conclusion: 'success', html_url: 'https://github.com/example/gateway/actions/runs/9'}]}}),
      listJobsForWorkflowRun: endpoint('jobs', async () => ({data: [{id: 10, name: 'verify', conclusion: 'success',
        steps: config.verification.steps.map(name => ({name, conclusion: 'success'}))}]})),
    };
    const readContent = github.rest.repos.getContent;
    let served = null;
    github.rest.repos.getContent = args => {
      if (args.path === 'clouseau-review.json') {
        const text = JSON.stringify(served);
        return Promise.resolve({data: {encoding: 'base64', content: Buffer.from(text).toString('base64'), size: text.length}});
      }
      if (args.path === '.github/CODEOWNERS') return Promise.resolve({data: {encoding: 'base64', content: Buffer.from('* @contributor').toString('base64'), size: 14}});
      return readContent(args);
    };
    Object.assign(github.rest.repos, {
      get: async () => ({data: {allow_auto_merge: true}}), getBranch: async () => ({data: {protected: true}}),
      getCollaboratorPermissionLevel: async () => ({data: {permission: 'write'}}),
    });
    github.paginate = async (method, args) => (await method(args)).data;
    github.request = async () => ({data: [
      {type: 'required_status_checks', parameters: {strict_required_status_checks_policy: true,
        required_status_checks: ['verify', 'approve-and-merge'].map(item => ({context: item, integration_id: 15368}))}},
      {type: 'pull_request', parameters: {required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true}},
      {type: 'non_fast_forward'}, {type: 'deletion'},
    ]});
    const recordPath = path.join(directory, 'record.json');
    const fetchImpl = async (_, options) => {
      state.calls++;
      const body = JSON.parse(options.body);
      if (!body.tools) {
        const {questions} = JSON.parse(body.messages[1].content);
        return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers:
          Object.fromEntries(Object.keys(questions).map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))})}}]})};
      }
      const view = JSON.parse(body.messages[1].content);
      for (const source of Object.values(view.sources)) source.content = source.numbered_lines.replace(/^L[0-9]+: /gm, '');
      const report = modelTemplate(view);
      report.gates.forEach(gate => {gate.state = 'satisfied';});
      return {ok: true, json: async () => ({choices: [{finish_reason: 'tool_calls', message: {tool_calls:
        [{function: {name: 'acceptance_report', arguments: JSON.stringify(report)}}]}}]})};
    };
    await run({recordPath, github, context, state, fetchImpl, serve: bundle => {served = bundle;}});
  } finally {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;
    fs.rmSync(directory, {recursive: true});
  }
}

test('a receipt signed for graded findings is held for /approve-intent under human_review "signed", refused as not_passing without it, and merges nothing', () => fixture(async f => {
  // A real CI record of this change, re-signed locally as the contributor's receipt.
  await createPolicy(config).assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  const keys = crypto.generateKeyPairSync('ed25519');
  const localReview = (mode, humanReview) => ({mode, reviewer_sha: 'e'.repeat(40), reviewer_digest: require('./local-version.cjs').engineDigest(), max_age_seconds: 172800,
    keys: [{id: 'fixture', issuer: 'fixture-runner', github_actor: 'contributor', revoked: false, public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}],
    ...(humanReview ? {human_review: 'signed'} : {})});
  const sign = (trusted, findings) => {
    let copy = structuredClone(record);
    copy.snapshot.number = 0; copy.snapshot.config_digest = digest(trusted); refresh(copy.snapshot);
    copy.result.snapshot = copy.snapshot.digest; copy.result.config_digest = copy.snapshot.config_digest;
    copy.result.usage = ['examiner', 'challenger'].flatMap(role => ['investigation', 'grading'].map(phase =>
      ({role, phase, harness: 'codex', session: `fictional-${role}-${phase}`, request_digest: digest(role), response_digest: digest(phase), transport_digest: digest({fixture_only: true})})));
    copy.result.execution_digest = digest(copy.result.usage);
    for (const item of copy.result.reviews) item.report.snapshot = copy.snapshot.digest;
    if (findings) copy = withFinding(copy);
    return issueReceipt({record: copy, privateKey: keys.privateKey.export({type: 'pkcs8', format: 'pem'}), keyId: 'fixture', issuer: 'fixture-runner',
      reviewerSha: 'e'.repeat(40), humanReview: true, now: Date.now()});
  };
  f.state.pr.body = `Ready change.\n<!-- clouseau-local-review:v1 ${'f'.repeat(40)} -->`;
  const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
  const merges = () => f.state.writes.filter(item => MERGE_WRITES.includes(item.name)).map(item => item.name);

  for (const humanReview of [true, false]) {
    for (const mode of ['required', 'optional']) {
      const label = `${mode}, human_review ${humanReview ? '"signed"' : 'absent'}`;
      const trusted = {...config, local_review: localReview(mode, humanReview)};
      const signed = sign(trusted, true);
      assert.equal(signed.payload.record.result.decision, 'repair_required', 'the receipt is signed for graded findings alone');
      f.serve(signed);
      // `operation: attested` never accepts it, whatever the setting: the repository runs its own checks.
      assert.deepEqual(await receiptAttests({github: f.github, repo: f.context.repo, pr: f.state.pr, config: trusted, engine: null, explain: true}),
        {attests: false, rejected: 'not_passing', detail: {}}, label);
      assert.equal(await decide({github: f.github, context: f.context, config: trusted, engine: null}), false, label);
      const policy = createPolicy(trusted);
      const calls = f.state.calls;
      const assessment = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl, report: () => {}});
      if (humanReview) {
        // CI holds the signed findings for the maintainer's exact-head confirmation; it makes no AI call and approves nothing.
        assert.equal(assessment.decision, 'owner_decision', `${label}: ${assessment.reason}`);
        assert.equal(assessment.review_source, 'authenticated_local', label);
        assert.match(assessment.reason, new RegExp(`requires a human review \\(its signed findings are listed in the review\\); a maintainer approves this exact head with \`/approve-intent ${f.state.pr.head.sha}\``));
        assert.equal(f.state.calls, calls, `${label}: no provider call`);
        f.state.writes.length = 0;
        await assert.rejects(policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment, nativeGate: true, wait: async () => {}}),
          /A maintainer intent confirmation is required/);
        // The gate asks the maintainer for /approve-intent of this exact head. It may arm native auto-merge, as every owner-decision
        // hold does, but that waits for the required approving review: nothing is approved and no ref is written.
        assert.ok(f.state.writes.some(item => item.name === 'create-ledger' && item.args.body.includes(`/approve-intent ${f.state.pr.head.sha}`)), label);
        assert.deepEqual(merges().filter(name => name !== 'enable-auto'), [], label);
        continue;
      }
      assert.equal(assessment.receipt_notice, 'not_passing', `${label}: ${assessment.reason}`);
      assert.notEqual(assessment.review_source, 'authenticated_local', 'the signed non-pass is never the review CI acts on');
      if (mode === 'required') {
        // Required mode cannot review the change itself: it asks for a new receipt and approves nothing.
        assert.equal(assessment.decision, 'review_incomplete'); assert.equal(assessment.cause, 'local_receipt_required');
        assert.equal(f.state.calls, calls, 'no provider call');
        await assert.rejects(policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment, nativeGate: true, wait: async () => {}}));
        assert.deepEqual(merges(), []);
      } else {
        // Optional mode ignores the receipt and reviews the change itself; the receipt carries nothing into that record.
        assert.ok(f.state.calls > calls, 'CI reviewed the change itself');
        const own = JSON.parse(fs.readFileSync(f.recordPath));
        assert.ok(!own.local_receipt_reference && !own.local_receipt, 'the refused receipt is not carried as evidence');
      }
    }
  }

  // The write boundary: a passing receipt's approved record, whose referenced bundle is then the graded-findings receipt, is
  // re-verified by the gate and refused, with or without the setting. Nothing is approved, auto-merge is not enabled and no ref
  // is written. (With the passing bundle still served, this same gate call approves and enables auto-merge.)
  for (const humanReview of [false, true]) {
    f.state.writes.length = 0;
    const trusted = {...config, local_review: localReview('required', humanReview)};
    const policy = createPolicy(trusted);
    f.serve(sign(trusted, false));
    const passing = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl, report: () => {}});
    assert.equal(passing.decision, 'auto_approve', passing.reason);
    assert.equal(passing.review_source, 'authenticated_local');
    f.serve(sign(trusted, true));
    await assert.rejects(policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment: passing, nativeGate: true, wait: async () => {}}),
      // Without the setting the bundle is refused as not passing; with it the bundle verifies as a hold, which is not the approved record.
      humanReview ? /Stale or altered acceptance record/ : error => error.reason === 'not_passing' && /review did not pass/.test(error.message));
    assert.deepEqual(merges(), []);
  }
}));
