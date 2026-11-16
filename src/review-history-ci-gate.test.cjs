'use strict';
// CI never reads `"review_history": "pull_request"`: a verified local receipt whose accepted base recipe sets the key is
// assessed, gated and published exactly as one whose recipe does not, and no gh runs (test/gh-recorder.cjs). The fixture and
// harness are copied from acceptance-controller-ledger-matrix.test.cjs (which exports nothing), with one addition: `recipe`,
// the accepted base's `.clouseau-local.json` that the receipt carries as a base source.

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
const {silentGh} = require('../test/gh-recorder.cjs');
const {readLocalConfig} = require('./local-git.cjs');
const {coverageParts} = require('./coverage-plan.cjs');

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
const ledgerWrites = f => f.state.writes.filter(item => ['create-ledger', 'update-ledger'].includes(item.name) && item.args.body.includes(MARKER));
const approvals = f => f.state.writes.filter(item => item.name === 'approve').length;
const confirmation = f => ({id: 950, user: {login: config.manual_reviewer, type: 'User'}, body: `/approve-intent ${f.state.pr.head.sha}`});

// The hosted case of acceptance-controller.test.cjs (copied from acceptance-controller-own-ledger.test.cjs): one pull request,
// its files, verification and a scripted provider.
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

// An advisory finding the examiner reports: it scores below the defect threshold (confidence 0.5, as withAdvisory in
// acceptance-controller-own-ledger.test.cjs), so it is `advisory_closed` and the decision stays `auto_approve`. The same `key`
// names the same finding (path, cause and obligation, so the same ledger identifier) in every review that reports it.
function report(copy, key) {
  const item = copy.result.reviews[0].report;
  const [evidence] = item.accounting[0].evidence;
  item.findings.push({id: `fictional-${key}`, title: `Fictional finding ${key}`, path: item.accounting[0].path,
    cause: `The changed path leaves concern ${key} open.`, trigger: 'A fictional reading.', consequence: 'A fictional slower review.',
    obligation: `Settle concern ${key}.`, evidence: [evidence],
    factors: Object.fromEntries(FACTORS.defect.map(name => [name, {value: name === 'confidence' ? 0.5 : 1,
      evidence: [evidence], reason: 'Established by the cited source.'}])),
    blast_radius: 1, opportunity: {mechanical: false, beneficial: false, within_scope: false, verified: false}, repair_paths: [item.accounting[0].path]});
}

// One pull request whose change touches a protected path (`src/upload.test.js` is made sensitive), held for the owner's
// exact-head `/approve-intent`, and any number of signed local receipts for it. `sign` signs and serves a receipt: its signed
// local history is `history` (`snapshot.prior_findings` and `local_previous.findings`, as `clouseau review` signs it) and
// `review` adds its own findings. The last receipt signed is the one on the pull request.
async function harness(f, {recipe}) {
  const hosted = createPolicy(config);
  assert.equal((await hosted.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl})).decision, 'auto_approve');
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  const keys = crypto.generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({type: 'pkcs8', format: 'pem'});
  const trusted = {...config, sensitive_paths: [...config.sensitive_paths, 'src/upload.test.js'], local_review: {mode: 'optional',
    reviewer_sha: 'e'.repeat(40), reviewer_digest: require('./local-version.cjs').engineDigest(), max_age_seconds: 172800,
    keys: [{id: 'fixture', issuer: 'fixture-runner', github_actor: 'contributor', revoked: false, public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}]}};
  let served = null;
  const original = f.github.rest.repos.getContent;
  // `recipe`: the accepted base's `.clouseau-local.json`, which a receipt carries as a base source (collectLocal) and the
  // receipt check compares with the live base.
  const recipeText = JSON.stringify(recipe);
  f.github.rest.repos.getContent = async args => args.path === 'clouseau-review.json' && served ? {data: {encoding: 'base64',
    content: Buffer.from(JSON.stringify(served)).toString('base64'), size: JSON.stringify(served).length}} :
    args.path === '.clouseau-local.json' && args.ref === record.snapshot.base_sha ? {data: {encoding: 'base64',
      content: Buffer.from(recipeText).toString('base64'), size: Buffer.byteLength(recipeText)}} : original(args);
  f.state.pr.body = `Ready change.\n<!-- clouseau-local-review:v1 ${'f'.repeat(40)} -->`;
  // The record `clouseau review` signs: `previous` is always `{comment: null, findings: []}`.
  const draft = (history, review = () => {}) => {
    const copy = structuredClone(record);
    copy.snapshot.number = 0; copy.snapshot.config_digest = digest(trusted);
    if (history) {copy.snapshot.prior_findings = structuredClone(history); copy.local_previous = {findings: structuredClone(history)};}
    const id = `${copy.snapshot.base_sha}:.clouseau-local.json`;
    copy.snapshot.sources[id] = {path: '.clouseau-local.json', ref: copy.snapshot.base_sha, authority: 'untrusted', kind: 'source', content: recipeText};
    // Each review inventories every source: the recipe is excluded, citing the repository contract it is judged against.
    for (const item of copy.result.reviews) {
      const contract = item.report.coverage.sources.find(entry => entry.source.endsWith(':README.md'));
      item.report.coverage.sources.push({source: id, state: 'excluded', reason: 'The verification recipe has no bearing on the reviewed behaviour.', evidence: contract.evidence});
    }
    refresh(copy.snapshot);
    copy.result.snapshot = copy.snapshot.digest; copy.result.config_digest = copy.snapshot.config_digest;
    copy.result.usage = ['examiner', 'challenger'].flatMap(role => ['investigation', 'grading'].map(phase =>
      ({role, phase, harness: 'codex', session: `fictional-${role}-${phase}`, request_digest: digest(role), response_digest: digest(phase), transport_digest: digest({fixture_only: true})})));
    copy.result.execution_digest = digest(copy.result.usage);
    for (const item of copy.result.reviews) item.report.snapshot = copy.snapshot.digest;
    review(copy);
    // The calculated decision, as the reviewer records it.
    copy.result.decision = ['auto_approve', 'repair_required', 'review_incomplete', 'blocked_integrity'].find(decision => {
      try {reviewDecision({...copy, result: {...copy.result, decision}}); return true;} catch {return false;}
    });
    assert.ok(copy.result.decision, 'a consistent decision');
    assert.deepEqual(copy.previous, {comment: null, findings: []});
    return copy;
  };
  const issue = copy => issueReceipt({record: copy, privateKey, keyId: 'fixture', issuer: 'fixture-runner',
    reviewerSha: trusted.local_review.reviewer_sha});
  // A review's ledger reconciled with its signed local history (Out): what the gate publishes, and the next review's history.
  const reconciled = (copy, history) => reconcile({...copy.result, reviews: reviewDecision(copy).reviews}, copy.snapshot, history).findings;
  const sign = ({history = null, review} = {}) => {
    const copy = draft(history, review);
    served = issue(copy);
    return {copy, Out: reconciled(copy, history || [])};
  };
  const policy = () => createPolicy(trusted);
  const assess = async () => {
    const calls = f.state.calls;
    const result = await policy().assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
    assert.equal(f.state.calls, calls, 'a receipt run calls no provider');
    return result;
  };
  const gate = assessment => policy().gate({github: f.github, context: f.context, core: f.core, recordPath: f.recordPath, assessment, nativeGate: true, wait: async () => {}});
  // The ledger comment holding `findings`: the body the gate publishes from the served receipt, with those findings.
  const ledger = findings => {
    const signed = served.payload.record;
    const {reviews} = reviewDecision(signed);
    const body = publication({...signed.result, reviews, decision: 'owner_decision'}, {...signed.snapshot, number: 3},
      reconcile({...signed.result, reviews}, signed.snapshot, signed.local_previous?.findings || [])).body;
    return withState(body, value => {value.findings = structuredClone(findings);});
  };
  return {sign, assess, gate, ledger};
}

test('CI assesses and gates a receipt whose accepted recipe sets review_history exactly as one whose recipe does not', async () => {
  const plain = {version: 2, base_branch: 'main', readme: 'README.md', repository_policy: '.github/clouseau.md', verification: [['npm', 'test']],
    coverage: [{format: 'istanbul', report: 'coverage/coverage-final.json', source_directory: 'src'}]};
  const outcomes = [];
  await silentGh(async () => {
    for (const recipe of [plain, {...plain, review_history: 'pull_request'}]) {
      // The recipe is one `clouseau review` signs from and the CI verification job's coverage gate reads.
      assert.deepEqual(readLocalConfig(structuredClone(recipe)), recipe);
      assert.deepEqual(coverageParts(recipe), coverageParts(plain));
      await fixture(async f => {
        const h = await harness(f, {recipe});
        const first = h.sign({review: copy => report(copy, 'A')});
        const later = h.sign({history: first.Out, review: copy => {report(copy, 'A'); report(copy, 'B');}});
        const source = later.copy.snapshot.sources[`${later.copy.snapshot.base_sha}:.clouseau-local.json`];
        assert.deepEqual(JSON.parse(source.content), recipe, 'the receipt carries the accepted recipe');
        f.state.comments = [bot(7101, h.ledger(first.Out)), confirmation(f)];
        const assessment = await h.assess();
        await h.gate(assessment);
        outcomes.push({decision: assessment.decision, cause: assessment.cause, source: assessment.review_source, approvals: approvals(f),
          writes: f.state.writes.map(item => item.name), published: stateOf(ledgerWrites(f)[0].args.body).findings});
      });
    }
  });
  assert.equal(outcomes[0].decision, 'owner_decision');
  assert.equal(outcomes[0].approvals, 1);
  assert.deepEqual(outcomes[1], outcomes[0]);
});
