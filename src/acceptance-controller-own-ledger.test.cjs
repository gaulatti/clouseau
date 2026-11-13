'use strict';
// A local receipt meeting, on a later run, the acceptance ledger the gate published from that same receipt. Kept apart
// from acceptance-controller.test.cjs so a change here does not resend that file as review evidence.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createPolicy} = require('./policy.cjs');
const {modelTemplate} = require('./acceptance-review.cjs');
const {digest, FACTORS} = require('./acceptance.cjs');
const {MARKER, reconcile, publication} = require('./acceptance-ledger.cjs');
const {issueReceipt, reviewDecision} = require('./local-receipt.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {CASES, prepareCase} = require('../test/acceptance-cases.cjs');
const {hostedFiles} = require('../test/hosted-files.cjs');

const config = {...require('../test/fixtures/config.json'), version: 2, repository_policy: '.github/clouseau.md', readme: 'README.md', acceptance: {
  examiner: 'deepseek-flash', challenger: 'deepseek-flash', grader: 'deepseek', grading_model: 'deepseek-flash', repair_attempts: 2,
}};
const STATE = /<!-- clouseau-state:([A-Za-z0-9+/=]+) -->/;
const stateOf = body => JSON.parse(Buffer.from(body.match(STATE)[1], 'base64').toString('utf8'));
const withState = (body, mutate) => {
  const value = stateOf(body); mutate(value);
  return body.replace(STATE, `<!-- clouseau-state:${Buffer.from(JSON.stringify(value)).toString('base64')} -->`);
};
const bot = (id, body) => ({id, user: {login: 'github-actions[bot]', type: 'Bot'}, body});
const FOREIGN = {id: 'f'.repeat(64), kind: 'technical', blocking: false, state: 'advisory_closed', title: 'Another review finding',
  path: 'src/upload.test.js', cause: 'A finding this receipt never made.', obligation: 'Keep the history the receipt signed.'};

// The hosted case of acceptance-controller.test.cjs: one pull request, its files, verification and a scripted provider.
async function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-acceptance-'));
  const old = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional';
  try {
    const {github, repo, snapshot} = await prepareCase(CASES[0]);
    const context = {repo, runId: 7, eventName: 'pull_request_target', payload: {pull_request: {number: 3}}};
    const state = {comments: [], reviews: [], writes: [], failed: false, calls: 0,
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
        event: 'pull_request', pull_requests: [{number: 3}], status: 'completed',
        conclusion: state.failed ? 'failure' : 'success', html_url: 'https://github.com/example/gateway/actions/runs/9'}]}}),
      listJobsForWorkflowRun: endpoint('jobs', async () => ({data: [{id: 10, name: 'verify', conclusion: 'success',
        steps: config.verification.steps.map(name => ({name, conclusion: 'success'}))}]})),
    };
    const readContent = github.rest.repos.getContent;
    github.rest.repos.getContent = args => args.path === '.github/CODEOWNERS' ? Promise.resolve({data: {
      encoding: 'base64', content: Buffer.from('* @contributor').toString('base64'), size: 14}}) : readContent(args);
    Object.assign(github.rest.repos, {
      get: async () => ({data: {allow_auto_merge: true}}), getBranch: async () => ({data: {protected: true}}),
      // The owner who comments `/approve-intent` holds maintainer permission.
      getCollaboratorPermissionLevel: async () => ({data: {permission: 'maintain'}}),
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
    await run({directory, recordPath, github, context, state, core, fetchImpl});
  } finally {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;
    fs.rmSync(directory, {recursive: true});
  }
}

// One finding below the defect threshold (confidence 0.5 scores 50 of the 70 that block): `reconcile` gives it the disposition
// `nonblocking`, so it is recorded `advisory_closed`, and the decision stays `auto_approve`, the only one signable without
// `local_review.human_review`.
function withAdvisory(copy) {
  const report = copy.result.reviews[0].report;
  const [evidence] = report.accounting[0].evidence;
  report.findings.push({id: 'fictional-advisory', title: 'Fictional advisory', path: report.accounting[0].path,
    cause: 'The changed path could state its contract more plainly.', trigger: 'A fictional reading.', consequence: 'A fictional slower review.',
    obligation: 'State the accepted contract.', evidence: [evidence],
    factors: Object.fromEntries(FACTORS.defect.map(name => [name, {value: name === 'confidence' ? 0.5 : 1, evidence: [evidence], reason: 'Established by the cited source.'}])),
    blast_radius: 1, opportunity: {mechanical: false, beneficial: false, within_scope: false, verified: false}, repair_paths: [report.accounting[0].path]});
}

// The hosted record of this pull request turned into a signed local receipt, served at its immutable reference, as
// `clouseau review` and `clouseau publish` leave it: `previous` is always `{comment: null, findings: []}`.
function serveReceipt(f, record, {trusted, advisory}) {
  const keys = crypto.generateKeyPairSync('ed25519');
  trusted.local_review.keys = [{id: 'fixture', issuer: 'fixture-runner', github_actor: 'contributor', revoked: false,
    public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}];
  const copy = structuredClone(record);
  copy.snapshot.number = 0; copy.snapshot.config_digest = digest(trusted); refresh(copy.snapshot);
  copy.result.snapshot = copy.snapshot.digest; copy.result.config_digest = copy.snapshot.config_digest;
  copy.result.usage = ['examiner', 'challenger'].flatMap(role => ['investigation', 'grading'].map(phase =>
    ({role, phase, harness: 'codex', session: `fictional-${role}-${phase}`, request_digest: digest(role), response_digest: digest(phase), transport_digest: digest({fixture_only: true})})));
  copy.result.execution_digest = digest(copy.result.usage);
  for (const item of copy.result.reviews) item.report.snapshot = copy.snapshot.digest;
  if (advisory) withAdvisory(copy);
  assert.deepEqual(copy.previous, {comment: null, findings: []});
  const bundle = issueReceipt({record: copy, privateKey: keys.privateKey.export({type: 'pkcs8', format: 'pem'}), keyId: 'fixture',
    issuer: 'fixture-runner', reviewerSha: trusted.local_review.reviewer_sha});
  const original = f.github.rest.repos.getContent;
  f.github.rest.repos.getContent = async args => args.path === 'clouseau-review.json' ? {data: {encoding: 'base64',
    content: Buffer.from(JSON.stringify(bundle)).toString('base64'), size: JSON.stringify(bundle).length}} : original(args);
  f.state.pr.body = `Ready change.\n<!-- clouseau-local-review:v1 ${'f'.repeat(40)} -->`;
  return bundle;
}

// The gate publishes no acceptance ledger on a run whose assessment held with `receipt_protected_controls` (that assessment has
// no record), so the ledger an earlier gate run published from this receipt is constructed here as exactly `publication(...)`'s
// body for the signed record, the ledger the gate publishes from it once it holds a record. The tests check that the gate, once
// it runs, publishes the same findings.
function ownLedger(bundle, number = 3) {
  const signed = bundle.payload.record;
  const {reviews} = reviewDecision(signed);
  const state = reconcile({...signed.result, reviews}, signed.snapshot, signed.previous.findings);
  return publication({...signed.result, reviews, decision: 'owner_decision'}, {...signed.snapshot, number}, state).body;
}

const ledgerWrites = f => f.state.writes.filter(item => ['create-ledger', 'update-ledger'].includes(item.name) && item.args.body.includes(MARKER));
const approvals = f => f.state.writes.filter(item => item.name === 'approve').length;
const confirmation = f => ({id: 950, user: {login: config.manual_reviewer, type: 'User'}, body: `/approve-intent ${f.state.pr.head.sha}`});

// A public pull request that changes a protected path (`src/upload.test.js` is made sensitive), reviewed by a signed receipt.
async function protectedReceipt(f, {advisory = true} = {}) {
  const hosted = createPolicy(config);
  assert.equal((await hosted.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl})).decision, 'auto_approve');
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  const trusted = {...config, sensitive_paths: [...config.sensitive_paths, 'src/upload.test.js'], local_review: {mode: 'optional',
    reviewer_sha: 'e'.repeat(40), reviewer_digest: require('./local-version.cjs').engineDigest(), max_age_seconds: 172800}};
  const bundle = serveReceipt(f, record, {trusted, advisory});
  const policy = createPolicy(trusted);
  const assess = async () => {
    const calls = f.state.calls;
    const result = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
    assert.equal(f.state.calls, calls, 'a receipt run calls no provider');
    return result;
  };
  const gate = assessment => policy.gate({github: f.github, context: f.context, core: f.core, recordPath: f.recordPath, assessment, nativeGate: true, wait: async () => {}});
  return {trusted, bundle, policy, assess, gate};
}

test('a receipt held for protected controls finds its own published ledger after the owner confirms, and the gate approves', () => fixture(async f => {
  const r = await protectedReceipt(f);
  assert.equal(r.bundle.payload.record.result.decision, 'auto_approve');
  // First run: the protected path holds the receipt for the owner's exact-head confirmation.
  const first = await r.assess();
  assert.equal(first.decision, 'review_incomplete'); assert.equal(first.cause, 'receipt_protected_controls');
  await assert.rejects(r.gate(first), /produced no acceptance record/);
  assert.deepEqual(ledgerWrites(f), [], 'that run publishes no acceptance ledger itself');
  const body = ownLedger(r.bundle);
  const published = stateOf(body).findings;
  assert.equal(published.length, 1);
  assert.equal(published[0].state, 'advisory_closed'); assert.equal(published[0].blocking, false);
  f.state.comments = [bot(7101, body), confirmation(f)];
  // The run the confirmation starts: the ledger is the receipt's own publication, not a change in history.
  const confirmed = await r.assess();
  assert.equal(confirmed.decision, 'owner_decision', confirmed.reason);
  assert.notEqual(confirmed.cause, 'receipt_history_changed');
  assert.equal(confirmed.review_source, 'authenticated_local');
  // The stored record keeps the signed history, so the gate re-derives exactly the published ledger.
  assert.deepEqual(JSON.parse(fs.readFileSync(f.recordPath)).previous, {comment: 7101, findings: []});
  await r.gate(confirmed);
  assert.equal(approvals(f), 1, 'the exact-head confirmation approves');
  const updated = ledgerWrites(f);
  assert.equal(updated.length, 1); assert.equal(updated[0].name, 'update-ledger'); assert.equal(updated[0].args.comment_id, 7101);
  assert.deepEqual(stateOf(updated[0].args.body).findings, published, 'the gate publishes the same findings the constructed ledger holds');
}));

test('a ledger holding any other finding, an extra finding, or the same finding in another state still voids the receipt', async () => {
  const variants = {
    different: findings => [{...FOREIGN}],
    extra: findings => [...findings, {...FOREIGN}],
    state: findings => [{...findings[0], state: 'confirmed'}],
    blocking: findings => [{...findings[0], blocking: true, state: 'confirmed'}],
  };
  for (const [name, change] of Object.entries(variants)) await fixture(async f => {
    const r = await protectedReceipt(f);
    const body = withState(ownLedger(r.bundle), value => {value.findings = change(value.findings);});
    f.state.comments = [bot(7101, body), confirmation(f)];
    const refused = await r.assess();
    assert.equal(refused.decision, 'review_incomplete', name);
    assert.equal(refused.cause, 'receipt_history_changed', name);
    assert.equal(refused.record_digest, undefined, name);
  });
});

test('a receipt with no findings: its empty ledger is accepted as before, and a ledger with a foreign finding is refused', async () => {
  for (const foreign of [false, true]) await fixture(async f => {
    const r = await protectedReceipt(f, {advisory: false});
    const body = ownLedger(r.bundle);
    assert.deepEqual(stateOf(body).findings, []);
    f.state.comments = [bot(7101, foreign ? withState(body, value => {value.findings = [{...FOREIGN}];}) : body), confirmation(f)];
    const result = await r.assess();
    if (foreign) {
      assert.equal(result.cause, 'receipt_history_changed');
      return;
    }
    assert.equal(result.decision, 'owner_decision', result.reason);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.recordPath)).previous, {comment: 7101, findings: []});
    await r.gate(result);
    assert.equal(approvals(f), 1);
  });
});

// The controller-managed private-owner path (acceptance-controller.test.cjs privateOwnerFixture and privateReceiptFixture):
// a private plan without native protection, merged by the atomic `updateRefs` write after verifyAcceptance re-verifies.
async function privateOwner(f) {
  const owner = createPolicy({...config, merge_mode: 'automatic'});
  const hosted = await owner.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
  assert.equal(hosted.decision, 'auto_approve');
  f.state.pr.auto_merge = null;
  f.state.pr.head.repo.node_id = 'R_private'; f.state.pr.base.repo = {node_id: 'R_private'};
  f.github.rest.repos.get = async () => ({data: {private: true, allow_auto_merge: false, node_id: 'R_private'}});
  f.github.rest.repos.getBranch = async () => ({data: {protected: false, commit: {sha: f.state.pr.merged ? hosted.head_sha : hosted.base_sha}}});
  f.github.rest.repos.compareCommits = async () => ({data: {status: 'ahead', merge_base_commit: {sha: hosted.base_sha}}});
  f.github.request = async () => {throw Object.assign(new Error('Upgrade to GitHub Pro or make this repository public to enable this feature.'), {status: 403});};
  f.github.rest.pulls.createReview = async args => {f.state.writes.push({name: 'approve', args});
    f.state.reviews.push({user: {login: 'github-actions[bot]', type: 'Bot'}, state: 'APPROVED', commit_id: args.commit_id}); return {data: {}};};
  f.github.rest.checks = {create: async () => ({data: {id: 71}}), update: async () => ({data: {}})};
  f.github.rest.actions.createWorkflowDispatch = async args => {f.state.writes.push({name: 'dispatch', args}); return {data: {}};};
  const graphql = f.github.graphql;
  f.github.graphql = async (query, args) => {
    if (!query.includes('updateRefs')) return graphql(query, args);
    f.state.writes.push({name: 'atomic', args});
    f.state.pr.merged = true; f.state.pr.state = 'closed'; f.state.pr.merge_commit_sha = hosted.head_sha;
    return {updateRefs: {clientMutationId: null}};
  };
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  const trusted = {...config, merge_mode: 'automatic', sensitive_paths: [...config.sensitive_paths, 'src/upload.test.js'],
    local_review: {mode: 'required', reviewer_sha: 'e'.repeat(40), central_source: {...require('./central-version.cjs').SOURCE}, max_age_seconds: 172800}};
  const engine = {...require('./central-version.cjs').SOURCE, sha: trusted.local_review.reviewer_sha, digest: require('./local-version.cjs').engineDigest()};
  const bundle = serveReceipt(f, record, {trusted, advisory: true});
  const policy = createPolicy(trusted, {engine});
  const assess = () => policy.assess({github: f.github, context: f.context, recordPath: f.recordPath,
    fetchImpl: async () => {throw new Error('No paid local receipt fallback');}});
  const gate = assessment => policy.gate({github: f.github, context: f.context, core: f.core, recordPath: f.recordPath, assessment, nativeGate: true, wait: async () => {}});
  return {bundle, assess, gate};
}

test('private owner path: a held receipt with an advisory finding merges by the atomic write after the owner confirms', async () => {
  for (const changed of [false, true]) await fixture(async f => {
    const p = await privateOwner(f);
    const first = await p.assess();
    assert.equal(first.cause, 'receipt_protected_controls');
    await assert.rejects(p.gate(first), /produced no acceptance record/);
    assert.deepEqual(ledgerWrites(f), []);
    const body = ownLedger(p.bundle);
    assert.deepEqual(stateOf(body).findings.map(item => item.state), ['advisory_closed']);
    f.state.comments = [bot(7101, body), confirmation(f)];
    const confirmed = await p.assess();
    assert.equal(confirmed.decision, 'owner_decision', confirmed.reason);
    if (changed) {
      // verifyAcceptance does re-read the ledger at that boundary: one changed after the bot approval never reaches the write.
      const approve = f.github.rest.pulls.createReview;
      f.github.rest.pulls.createReview = async args => {
        const value = await approve(args);
        f.state.comments = [bot(7101, withState(body, state => {state.findings = [{...FOREIGN}];})), confirmation(f)];
        return value;
      };
      await assert.rejects(p.gate(confirmed), /Acceptance findings changed before private merge/);
      assert.equal(f.state.writes.filter(w => w.name === 'atomic').length, 0);
      return;
    }
    // The second run reaches the atomic write: verifyAcceptance re-verifies the record and the ledger at that boundary.
    await p.gate(confirmed);
    assert.deepEqual(f.state.writes.filter(w => ['approve', 'atomic', 'enable-auto'].includes(w.name)).map(w => w.name), ['approve', 'atomic']);
    assert.equal(f.state.pr.merged, true);
    assert.deepEqual(stateOf(ledgerWrites(f)[0].args.body).findings, stateOf(body).findings);
  });
});

test('the gate write boundary accepts only the ledger the receipt itself publishes, and a hosted record never', async () => {
  // A receipt assessed before its ledger was on the pull request: its record holds `{comment: null, findings: []}`. By the
  // gate, the ledger a concurrent gate run published from the same receipt is there.
  const variants = ['own', 'different', 'state', 'extra'];
  for (const name of variants) await fixture(async f => {
    const r = await protectedReceipt(f);
    f.state.comments = [confirmation(f)];
    const assessment = await r.assess();
    assert.equal(assessment.decision, 'owner_decision', assessment.reason);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.recordPath)).previous, {comment: null, findings: []});
    const own = ownLedger(r.bundle);
    const body = {
      own,
      different: withState(own, value => {value.findings = [{...FOREIGN}];}),
      state: withState(own, value => {value.findings = [{...value.findings[0], state: 'confirmed'}];}),
      extra: withState(own, value => {value.findings = [...value.findings, {...FOREIGN}];}),
    }[name];
    f.state.comments = [bot(7101, body), confirmation(f)];
    if (name === 'own') {
      await r.gate(assessment);
      assert.equal(approvals(f), 1);
    } else {
      await assert.rejects(r.gate(assessment), /Acceptance history changed; reassess the current record/, name);
      assert.equal(approvals(f), 0, name);
    }
  });
  // A hosted record has no receipt: a ledger it did not assess against is a change, whatever its findings.
  await fixture(async f => {
    const policy = createPolicy(config);
    const assessment = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
    const record = JSON.parse(fs.readFileSync(f.recordPath));
    const {verifyRecord} = require('./acceptance-controller.cjs');
    const verified = verifyRecord(record, assessment, config);
    assert.equal(verified.ownLedger, false);
    f.state.comments = [bot(7101, verified.body)];
    await assert.rejects(policy.gate({github: f.github, context: f.context, core: f.core, recordPath: f.recordPath, assessment, nativeGate: true}),
      /Acceptance history changed; reassess the current record/);
  });
});
