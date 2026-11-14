'use strict';
// Owner confirmation of a signed review that carries findings (protected `human_review: "signed"`) under the protected
// `confirmation: "diff"`: while the signed review carries findings, only a confirmation of the exact head counts; nothing
// carries. A hold without findings keeps the diff rule. Kept apart from acceptance-controller-human-review.test.cjs so a change here does not resend that file as review evidence.

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


// Commits around the signed reviewed head R (the receipt's `snapshot.head_sha`): EARLIER precedes it, MERGED merged main into it.
const EARLIER = '1'.repeat(40);
const MERGED = '3'.repeat(40);

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
  const sign = (trusted, {passing = false, mutate = () => {}} = {}) => {
    let copy = structuredClone(record);
    copy.snapshot.number = 0; copy.snapshot.config_digest = digest(trusted); refresh(copy.snapshot);
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
  const run = async ({trusted, bundle, confirmed, head, lineage, beforeGate = () => {}, updateGithub = null}) => {
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
    const gate = assessment => policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment, nativeGate: true, wait: async () => {}, updateGithub});
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
    beforeGate();
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

// A findings hold reads no lineage or diff for an earlier confirmation: none of its comparisons is made.
const noComparisonOf = (result, sha) => assert.deepEqual(result.compared.filter(item => item.startsWith(`${sha}..`)), [],
  'an earlier confirmation of a findings hold starts no comparison');

test('findings: a confirmation of an earlier commit does not carry over a merge of main to a head with the same diff', () => fixture(async f => {
  const w = await signedWorld(f, diffConfirmation);
  const trusted = {...config, local_review: w.trust};
  const R = w.signedHead;
  // The owner confirmed R, the commit the receipt was signed at; the live head merged main into it and its diff is the same.
  const result = await w.run({trusted, bundle: w.sign(trusted), confirmed: R, head: MERGED, lineage: {[`${R}..${MERGED}`]: 'ahead'}});
  holds(result);
  noComparisonOf(result, R);
}));

test('findings: a confirmation of the exact head carries', () => fixture(async f => {
  const w = await signedWorld(f, diffConfirmation);
  const trusted = {...config, local_review: w.trust};
  const R = w.signedHead;
  carried(await w.run({trusted, bundle: w.sign(trusted), confirmed: R, head: R, lineage: {}}));
  // After a merge of main, the owner confirms the merged head itself.
  carried(await w.run({trusted, bundle: w.sign(trusted), confirmed: MERGED, head: MERGED, lineage: {[`${R}..${MERGED}`]: 'ahead'}}));
}));

test('findings: a re-review after the confirmed commit (an empty commit) does not carry the earlier confirmation, with the same or different findings', () => fixture(async f => {
  const w = await signedWorld(f, diffConfirmation);
  const trusted = {...config, local_review: w.trust};
  const R = w.signedHead;
  // The owner confirmed EARLIER; the author added an empty commit R (the live head) and reviewed again. The diff is unchanged.
  const lineage = {[`${EARLIER}..${R}`]: 'ahead'};
  const same = await w.run({trusted, bundle: w.sign(trusted), confirmed: EARLIER, head: R, lineage});
  holds(same);
  noComparisonOf(same, EARLIER);
  const different = w.sign(trusted, {mutate: copy => {copy.result.reviews[0].report.findings.at(-1).title = 'Another fictional defect';}});
  holds(await w.run({trusted, bundle: different, confirmed: EARLIER, head: R, lineage}));
}));

test('no findings: a protected-control hold with a passing receipt carries on the diff rule as before', () => fixture(async f => {
  const w = await signedWorld(f, diffConfirmation);
  const guarded = {...config, sensitive_paths: [...config.sensitive_paths, 'src/upload.test.js', 'src/upload.js'], local_review: w.trust};
  const R = w.signedHead;
  // An earlier confirmation with the same diff: without findings the diff rule applies, as on main.
  const result = await w.run({trusted: guarded, bundle: w.sign(guarded, {passing: true}), confirmed: EARLIER, head: R,
    lineage: {[`${EARLIER}..${R}`]: 'ahead'}});
  carried(result);
  assert.match(result.held.reason, /it changes protected review controls/);
  assert.ok(result.compared.includes(`${EARLIER}..${R}`), 'the diff rule compares the confirmed commit with the head');
  // So does a merge of main after the confirmed commit.
  carried(await w.run({trusted: guarded, bundle: w.sign(guarded, {passing: true}), confirmed: R, head: MERGED,
    lineage: {[`${R}..${MERGED}`]: 'ahead'}}));
}));

test('confirmation "diff" off: a confirmation names the exact head only, with or without findings', () => fixture(async f => {
  const w = await signedWorld(f, {binding: 'diff'});
  const trusted = {...config, local_review: w.trust};
  const guarded = {...trusted, sensitive_paths: [...config.sensitive_paths, 'src/upload.test.js', 'src/upload.js']};
  const R = w.signedHead;
  const lineage = {[`${R}..${MERGED}`]: 'ahead'};
  const earlier = await w.run({trusted, bundle: w.sign(trusted), confirmed: R, head: MERGED, lineage});
  holds(earlier);
  noComparisonOf(earlier, R);
  const passing = await w.run({trusted: guarded, bundle: w.sign(guarded, {passing: true}), confirmed: R, head: MERGED, lineage});
  holds(passing);
  noComparisonOf(passing, R);
  carried(await w.run({trusted, bundle: w.sign(trusted), confirmed: MERGED, head: MERGED, lineage}));
}));

// The controller-managed private-owner path (private repository, unprotected branch, the upgrade-plan 403, `merge_mode:
// "automatic"`): the gate approves and makes the atomic write itself, recorded as `atomic`.
function privateOwner(f) {
  f.state.pr.auto_merge = null;
  f.state.pr.head.repo.node_id = 'R_private'; f.state.pr.base.repo = {node_id: 'R_private'};
  f.github.rest.repos.get = async () => ({data: {private: true, allow_auto_merge: false, node_id: 'R_private'}});
  f.github.rest.repos.getBranch = async () => ({data: {protected: false,
    commit: {sha: f.state.pr.merged ? f.state.pr.head.sha : f.state.pr.base.sha}}});
  f.github.request = async () => {throw Object.assign(new Error('Upgrade to GitHub Pro or make this repository public to enable this feature.'), {status: 403});};
  f.github.rest.checks = {create: async () => ({data: {id: 71}}), update: async () => ({data: {}})};
  const graphql = f.github.graphql;
  f.github.graphql = async (query, args) => {
    if (!query.includes('updateRefs')) return graphql(query, args);
    f.state.writes.push({name: 'atomic', args});
    Object.assign(f.state.pr, {merged: true, state: 'closed', merge_commit_sha: f.state.pr.head.sha});
    return {updateRefs: {clientMutationId: null}};
  };
  // After the bot approves, before the atomic write: `between` changes what the write boundary reads.
  const between = {run: () => {}};
  f.github.rest.pulls.createReview = Object.assign(async args => {
    f.state.writes.push({name: 'approve', args});
    f.state.reviews.push({user: {login: 'github-actions[bot]', type: 'Bot'}, state: 'APPROVED', commit_id: args.commit_id});
    between.run();
    return {data: {}};
  }, {endpointName: 'approve'});
  return between;
}

test('findings on the private-owner path: an exact-head confirmation merges, an earlier-commit confirmation does not', () => fixture(async f => {
  const w = await signedWorld(f, diffConfirmation);
  // Protected review controls, so the receipt records the owner authorization the private-merge revalidation re-reads.
  const trusted = {...config, merge_mode: 'automatic', sensitive_paths: [...config.sensitive_paths, 'src/upload.test.js', 'src/upload.js'], local_review: w.trust};
  const R = w.signedHead;
  const between = privateOwner(f);
  const atomic = () => f.state.writes.filter(item => item.name === 'atomic').length;
  // The owner confirmed EARLIER; the live head R has the same diff and EARLIER is its ancestor. It still does not carry.
  const lineage = {[`${EARLIER}..${R}`]: 'ahead'};
  holds(await w.run({trusted, bundle: w.sign(trusted), confirmed: EARLIER, head: R, lineage}));
  assert.equal(atomic(), 0);
  assert.equal(f.state.pr.merged, undefined);
  // The exact head reaches the private-owner merge.
  carried(await w.run({trusted, bundle: w.sign(trusted), confirmed: R, head: R, lineage}));
  assert.equal(atomic(), 1, 'the exact-head confirmation completes the controller-managed merge');
  // At the write boundary a later `/approve-intent EARLIER` by the same maintainer is on the pull request. The revalidation
  // re-reads the authorization with the same findings hold, so it confirms nothing and the recorded exact-head authorization
  // still stands; read without the hold, it would carry on the diff rule, replace that authorization and void the merge.
  delete f.state.pr.merged; f.state.pr.state = 'open'; delete f.state.pr.merge_commit_sha;
  between.run = () => {between.run = () => {};
    f.state.comments.push({id: 951, user: {login: 'gaulatti', type: 'User'}, body: `/approve-intent ${EARLIER}`});};
  carried(await w.run({trusted, bundle: w.sign(trusted), confirmed: R, head: R, lineage}));
  assert.equal(atomic(), 1, 'the exact-head authorization still merges at the atomic write');
  assert.ok(f.state.comments.some(item => item.id === 951), 'the earlier confirmation was present at the write boundary');
}));

test('findings under base_moved "update": a base move never updates on an earlier commit\'s confirmation; only the exact head\'s', () => fixture(async f => {
  const w = await signedWorld(f, {...diffConfirmation, base_moved: 'update'});
  const trusted = {...config, local_review: w.trust};
  const R = w.signedHead;
  const assessedBase = f.state.pr.base.sha; const getBranch = f.github.rest.repos.getBranch;
  const restore = () => {f.state.pr.base.sha = assessedBase; f.github.rest.repos.getBranch = getBranch;};
  const updates = [];
  const updateGithub = {rest: {pulls: {updateBranch: async args => {updates.push(args); return {data: {}};}}}};
  // Main moves after the reassessment, before the gate: only the base differs, so the gate's first base-move check decides.
  const moveBase = () => {
    f.state.pr.base.sha = 'e'.repeat(40); f.state.pr.head.repo.full_name = `${f.context.repo.owner}/${f.context.repo.repo}`;
    f.github.rest.repos.getBranch = async () => ({data: {protected: true, commit: {sha: f.state.pr.base.sha}}});
  };
  // The owner confirmed an earlier commit of the same diff: a findings hold counts only the exact head, so nothing is updated
  // and the gate posts today's needs-branch-update notice.
  const earlier = await w.run({trusted, bundle: w.sign(trusted), confirmed: EARLIER, head: R, lineage: {[`${EARLIER}..${R}`]: 'ahead'},
    beforeGate: moveBase, updateGithub});
  assert.deepEqual(updates, [], 'no update on an earlier commit\'s confirmation of a findings hold');
  assert.match(String(earlier.failure?.message), /^Needs branch update: main moved after approval/);
  // The owner confirmed the exact head: the same base move is updated server-side once.
  restore();
  const exact = await w.run({trusted, bundle: w.sign(trusted), confirmed: R, head: R, lineage: {}, beforeGate: moveBase, updateGithub});
  assert.equal(exact.failure?.code, 'BASE_UPDATE_REQUESTED', String(exact.failure?.message));
  assert.deepEqual(updates.map(item => item.expected_head_sha), [R]);
}));
