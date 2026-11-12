'use strict';
// Owner confirmation of a signed review that carries findings (protected `human_review: "signed"`) under the protected
// `confirmation: "diff"`: an earlier confirmation counts only for a receipt signed at or before the confirmed commit. Kept apart
// from acceptance-controller-human-review.test.cjs so a change here does not resend that file as review evidence.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createPolicy} = require('./policy.cjs');
const {template, modelTemplate} = require('./acceptance-review.cjs');
const {digest} = require('./acceptance.cjs');
const {CASES, prepareCase} = require('../test/acceptance-cases.cjs');
const {hostedFiles} = require('../test/hosted-files.cjs');
const {withFinding} = require('../test/local-review-fixture.cjs');
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


// Commits around the signed reviewed head R (the receipt's `snapshot.head_sha`): S is what the owner confirmed, H the live head.
const EARLIER = '1'.repeat(40);
const LATER = '2'.repeat(40);
const MERGED = '3'.repeat(40);
const REBASED = '4'.repeat(40);
const OLD_BASE = '5'.repeat(40);

// One signed receipt world: `sign` issues a receipt for the hosted record (with findings unless `passing`), `run` drives the
// held assessment and gate for an owner confirmation of `confirmed` while the live head is `head`, and reports what happened.
async function signedWorld(f, local) {
  const crypto = require('node:crypto');
  const {issueReceipt} = require('./local-receipt.cjs');
  const {refresh} = require('./acceptance-sources.cjs');
  await f.assess();
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  const keys = crypto.generateKeyPairSync('ed25519');
  const trust = {mode: 'optional', reviewer_sha: 'e'.repeat(40), reviewer_digest: require('./local-version.cjs').engineDigest(), max_age_seconds: 172800,
    keys: [{id: 'fixture', issuer: 'fixture-runner', github_actor: 'contributor', revoked: false, public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}],
    human_review: 'signed', ...local};
  const signedHead = record.snapshot.head_sha;
  const sign = (trusted, {passing = false, reviewedHead = signedHead, mutate = () => {}} = {}) => {
    let copy = structuredClone(record);
    copy.snapshot.number = 0; copy.snapshot.config_digest = digest(trusted); copy.snapshot.head_sha = reviewedHead; refresh(copy.snapshot);
    copy.result.snapshot = copy.snapshot.digest; copy.result.config_digest = copy.snapshot.config_digest;
    copy.result.usage = ['examiner', 'challenger'].flatMap(role => ['investigation', 'grading'].map(phase =>
      ({role, phase, harness: 'codex', session: `fictional-${role}-${phase}`, request_digest: digest(role), response_digest: digest(phase), transport_digest: digest({fixture_only: true})})));
    copy.result.execution_digest = digest(copy.result.usage);
    for (const item of copy.result.reviews) item.report.snapshot = copy.snapshot.digest;
    if (!passing) copy = withFinding(copy, mutate);
    return issueReceipt({record: copy, privateKey: keys.privateKey.export({type: 'pkcs8', format: 'pem'}), keyId: 'fixture', issuer: 'fixture-runner',
      reviewerSha: trust.reviewer_sha, humanReview: true});
  };
  let served = null;
  const original = f.github.rest.repos.getContent;
  f.github.rest.repos.getContent = async args => args.path === 'clouseau-review.json' ? {data: {encoding: 'base64',
    content: Buffer.from(JSON.stringify(served)).toString('base64'), size: JSON.stringify(served).length}} : original(args);
  f.state.pr.body = `Ready change.\n<!-- clouseau-local-review:v1 ${'f'.repeat(40)} -->`;
  const live = (await f.github.rest.pulls.listFiles({})).data;
  f.state.pr.changed_files = live.length;
  const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
  const approvals = () => f.state.writes.filter(item => item.name === 'approve').length;
  // `lineage` answers compareCommits(base, head) by `${base}..${head}`: a status, or an Error to throw. The confirmed commit's
  // diff from its merge base (the live base) is the live diff.
  const run = async ({trusted, bundle, confirmed, head, lineage}) => {
    served = bundle;
    const compared = [];
    f.github.rest.repos.compareCommits = async ({base, head: tip}) => {
      compared.push(`${base}..${tip}`);
      const answer = lineage[`${base}..${tip}`];
      if (answer instanceof Error) throw answer;
      if (base === f.state.pr.base.sha && answer === undefined) return {data: {status: 'ahead', files: live, merge_base_commit: {sha: f.state.pr.base.sha}}};
      return {data: {status: answer ?? (base === tip ? 'identical' : 'diverged'), files: []}};
    };
    f.state.pr.head.sha = head; f.state.comments = []; f.state.reviews = []; f.state.writes = [];
    // A policy of its own: confirmations are cached per policy, one per run.
    const policy = createPolicy(trusted);
    const assess = async () => policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl, report: () => {}});
    const gate = assessment => policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment, nativeGate: true, wait: async () => {}});
    const calls = f.state.calls;
    const held = await assess();
    assert.equal(held.decision, 'owner_decision', held.reason);
    // The held gate publishes the signed findings; as on GitHub they are on the pull request when the owner confirms.
    await assert.rejects(gate(held), /A maintainer intent confirmation is required/);
    const ledger = f.state.writes.find(item => ['create-ledger', 'update-ledger'].includes(item.name) && /Authenticated local review/.test(item.args.body));
    assert.ok(ledger, 'the held gate published the signed record');
    f.state.comments = [{id: 7001, user: {login: 'github-actions[bot]', type: 'Bot'}, body: ledger.args.body},
      {id: 950, user: {login: 'gaulatti', type: 'User'}, body: `/approve-intent ${confirmed}`}];
    f.state.writes = [];
    const reassessed = await assess();
    assert.equal(reassessed.decision, 'owner_decision', reassessed.reason);
    assert.equal(f.state.calls, calls, 'the receipt stands without a CI AI call');
    let failure = null;
    try {await gate(reassessed);} catch (error) {failure = error;}
    const asked = f.state.writes.some(item => item.name === 'create-ledger' && item.args.body.includes(`<!-- clouseau-intent:${head} -->`) &&
      item.args.body.includes(`/approve-intent ${head}`));
    return {approved: approvals() === 1, failure, asked, compared, held};
  };
  return {trust, signedHead, sign, run};
}

const holds = result => {
  assert.equal(result.approved, false, 'the earlier confirmation does not clear the signed findings');
  assert.match(String(result.failure?.message), /A maintainer intent confirmation is required/);
  assert.ok(result.asked, 'the hold asks for /approve-intent on the current head');
};
const carried = result => {
  assert.equal(result.failure, null, result.failure?.message);
  assert.equal(result.approved, true, 'the earlier confirmation clears the hold on the current head');
};
const diffConfirmation = {binding: 'diff', confirmation: 'diff'};

test('findings: the receipt the owner saw carries over a merge of main to a head with the same diff', () => fixture(async f => {
  const w = await signedWorld(f, diffConfirmation);
  const trusted = {...config, local_review: w.trust};
  const bundle = w.sign(trusted);
  const R = w.signedHead;
  // R is the confirmed commit itself (identical), and the live head merged main into it.
  carried(await w.run({trusted, bundle, confirmed: R, head: MERGED, lineage: {[`${R}..${MERGED}`]: 'ahead'}}));
  // R is an ancestor of the confirmed commit S, and S an ancestor of the merged head.
  const result = await w.run({trusted, bundle, confirmed: LATER, head: MERGED,
    lineage: {[`${R}..${LATER}`]: 'ahead', [`${LATER}..${MERGED}`]: 'ahead'}});
  carried(result);
  assert.ok(result.compared.includes(`${R}..${LATER}`), 'the ancestry of the signed reviewed head is compared');
}));

test('findings: a re-review after the confirmed commit (an empty commit) never carries the earlier confirmation, with the same or different findings', () => fixture(async f => {
  const w = await signedWorld(f, diffConfirmation);
  const trusted = {...config, local_review: w.trust};
  const R = w.signedHead;
  // The owner confirmed EARLIER; the author added an empty commit R (the live head) and reviewed again. The diff is unchanged.
  const lineage = {[`${R}..${EARLIER}`]: 'behind', [`${EARLIER}..${R}`]: 'ahead'};
  holds(await w.run({trusted, bundle: w.sign(trusted), confirmed: EARLIER, head: R, lineage}));
  const different = w.sign(trusted, {mutate: copy => {copy.result.reviews[0].report.findings.at(-1).title = 'Another fictional defect';}});
  holds(await w.run({trusted, bundle: different, confirmed: EARLIER, head: R, lineage}));
  // Re-reviewed at R, then main merged into it: still a receipt the owner never confirmed.
  holds(await w.run({trusted, bundle: w.sign(trusted), confirmed: EARLIER, head: MERGED,
    lineage: {[`${R}..${EARLIER}`]: 'behind', [`${EARLIER}..${MERGED}`]: 'ahead'}}));
  // The exact head always counts.
  carried(await w.run({trusted, bundle: w.sign(trusted), confirmed: R, head: R, lineage: {}}));
}));

test('findings: a rebase that rewrote the signed reviewed head never carries the confirmation', () => fixture(async f => {
  const w = await signedWorld(f, diffConfirmation);
  const trusted = {...config, local_review: w.trust};
  const R = w.signedHead;
  // The owner confirmed the rebased commit; the receipt was signed at the original R, which is not its ancestor.
  holds(await w.run({trusted, bundle: w.sign(trusted), confirmed: REBASED, head: MERGED,
    lineage: {[`${R}..${REBASED}`]: 'diverged', [`${REBASED}..${MERGED}`]: 'ahead'}}));
}));

test('findings: an ancestry the engine cannot establish never carries; any other failure surfaces', () => fixture(async f => {
  const w = await signedWorld(f, diffConfirmation);
  const trusted = {...config, local_review: w.trust};
  const R = w.signedHead;
  for (const status of [404, 422]) {
    holds(await w.run({trusted, bundle: w.sign(trusted), confirmed: LATER, head: MERGED,
      lineage: {[`${R}..${LATER}`]: Object.assign(new Error('Not Found'), {status}), [`${LATER}..${MERGED}`]: 'ahead'}}));
  }
  const broken = await w.run({trusted, bundle: w.sign(trusted), confirmed: LATER, head: MERGED,
    lineage: {[`${R}..${LATER}`]: Object.assign(new Error('Server Error'), {status: 500}), [`${LATER}..${MERGED}`]: 'ahead'}}).catch(error => ({error}));
  assert.match(String(broken.error?.message ?? broken.failure?.message), /Server Error/);
  assert.notEqual(broken.approved, true);
}));

test('no findings: a protected-control hold with a passing receipt confirms exactly as before', () => fixture(async f => {
  const w = await signedWorld(f, diffConfirmation);
  const guarded = {...config, sensitive_paths: [...config.sensitive_paths, 'src/upload.test.js', 'src/upload.js'], local_review: w.trust};
  const R = w.signedHead;
  // R was signed after the confirmed commit: with findings this would not carry; without them only the diff rule applies.
  const result = await w.run({trusted: guarded, bundle: w.sign(guarded, {passing: true}), confirmed: EARLIER, head: R,
    lineage: {[`${R}..${EARLIER}`]: 'behind', [`${EARLIER}..${R}`]: 'ahead'}});
  carried(result);
  assert.match(result.held.reason, /it changes protected review controls/);
  assert.ok(!result.compared.includes(`${R}..${EARLIER}`), 'no reviewed-head comparison is made for a hold without findings');
}));

test('findings with confirmation "diff" off: a confirmation names the exact head only', () => fixture(async f => {
  const w = await signedWorld(f, {binding: 'diff'});
  const trusted = {...config, local_review: w.trust};
  const R = w.signedHead;
  const lineage = {[`${R}..${LATER}`]: 'ahead', [`${LATER}..${MERGED}`]: 'ahead'};
  const earlier = await w.run({trusted, bundle: w.sign(trusted), confirmed: LATER, head: MERGED, lineage});
  holds(earlier);
  assert.deepEqual(earlier.compared.filter(item => item.includes(LATER)), [], 'nothing is compared without the setting');
  carried(await w.run({trusted, bundle: w.sign(trusted), confirmed: MERGED, head: MERGED, lineage}));
}));
