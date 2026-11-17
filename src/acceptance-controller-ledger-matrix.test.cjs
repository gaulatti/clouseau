'use strict';
// The acceptance-ledger matrix at the gate boundary: which pull request ledger a verified local receipt accepts, at the
// assessment and at the gate's write boundary, and which ledger the gate then publishes. Kept apart from
// acceptance-controller.test.cjs and acceptance-controller-own-ledger.test.cjs (whose fixtures are copied here, not shared)
// so a change here does not resend those files as review evidence.
//
// Notation: L = the pull request ledger findings; In = the receipt's signed local history (`local_previous.findings`, bound to
// `snapshot.prior_findings`); Out = reconcile(result, snapshot, In), what the gate publishes; Leg = reconcile(result, snapshot,
// record.previous.findings), the legacy form (`previous` is always `{comment: null, findings: []}` for a local receipt).
// The accepted ledgers: L ∈ {In, Out, Leg}, or an empty ledger L = [] (the record's own signed `previous`).
//
// Where In comes from: without the base's `"review_history": "pull_request"`, `clouseau review` signs this machine's local
// history; with it, the pull request's ledger, read and validated by review-history.cjs `priorFindings` (the function
// runReview calls), so In = L by construction. A `reviewHistory` row builds its later receipt from that function's answer to a
// gh stand-in serving the row's ledger comment. CI never reads the key: the gate's rule is the same for every row.

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
const {issueReceipt, reviewDecision, verifyReceipt, DOMAIN} = require('./local-receipt.cjs');
const {verifyRecord} = require('./acceptance-controller.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const reviewHistory = require('./review-history.cjs');
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
// A finding of a hosted review the receipt never saw.
const HOSTED = {...FOREIGN, id: 'd'.repeat(64), title: 'A hosted review finding', cause: 'A hosted review recorded this after the receipt.'};
const ledgerWrites = f => f.state.writes.filter(item => ['create-ledger', 'update-ledger'].includes(item.name) && item.args.body.includes(MARKER));
const approvals = f => f.state.writes.filter(item => item.name === 'approve').length;
const confirmation = f => ({id: 950, user: {login: config.manual_reviewer, type: 'User'}, body: `/approve-intent ${f.state.pr.head.sha}`});
const same = (left, right) => digest(left) === digest(right);

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

// The findings a review reports. An advisory finding scores below the defect threshold (confidence 0.5, as withAdvisory in
// acceptance-controller-own-ledger.test.cjs): `advisory_closed`, and the decision stays `auto_approve`. A blocking one has every
// gate still satisfied (as withFinding in test/local-review-fixture.cjs): `confirmed`, the decision `repair_required`, signable
// only under the protected `local_review.human_review: "signed"` as the owner-decision hold. The same `key` names the same
// finding (path, cause and obligation, so the same ledger identifier) in every review that reports it.
function report(copy, key, {blocking = false, role = 0} = {}) {
  const item = copy.result.reviews[role].report;
  const [evidence] = item.accounting[0].evidence;
  item.findings.push({id: `fictional-${key}`, title: `Fictional finding ${key}`, path: item.accounting[0].path,
    cause: `The changed path leaves concern ${key} open.`, trigger: 'A fictional reading.', consequence: 'A fictional slower review.',
    obligation: `Settle concern ${key}.`, evidence: [evidence],
    factors: Object.fromEntries(FACTORS.defect.map(name => [name, {value: blocking ? (name.includes('excess') ? 0 : 1) : name === 'confidence' ? 0.5 : 1,
      evidence: [evidence], reason: 'Established by the cited source.'}])),
    blast_radius: 1, opportunity: {mechanical: false, beneficial: false, within_scope: false, verified: false}, repair_paths: [item.accounting[0].path]});
}
// Both reviews resolve an earlier blocking finding, citing current-revision evidence.
function resolve(copy, id, state = 'corrected') {
  for (const review of copy.result.reviews) {
    review.report.resolutions.push({id, state, reason: `The current revision settles ${state === 'corrected' ? 'and repairs' : 'and disproves'} it.`,
      evidence: [review.report.accounting[0].evidence[0]]});
  }
}

// One pull request whose change touches a protected path (`src/upload.test.js` is made sensitive), held for the owner's
// exact-head `/approve-intent`, and any number of signed local receipts for it. `sign` signs and serves a receipt: its signed
// local history is `history` (`snapshot.prior_findings` and `local_previous.findings`, as `clouseau review` signs it) and
// `review` adds its own findings. The last receipt signed is the one on the pull request.
async function harness(f, {human = false, recipe = null} = {}) {
  const hosted = createPolicy(config);
  assert.equal((await hosted.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl})).decision, 'auto_approve');
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  const keys = crypto.generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({type: 'pkcs8', format: 'pem'});
  const trusted = {...config, sensitive_paths: [...config.sensitive_paths, 'src/upload.test.js'], local_review: {mode: 'optional',
    reviewer_sha: 'e'.repeat(40), reviewer_digest: require('./local-version.cjs').engineDigest(), max_age_seconds: 172800,
    ...(human ? {human_review: 'signed'} : {}),
    keys: [{id: 'fixture', issuer: 'fixture-runner', github_actor: 'contributor', revoked: false, public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}]}};
  let served = null;
  const original = f.github.rest.repos.getContent;
  // `recipe`: the accepted base's `.clouseau-local.json`, which a receipt carries as a base source (collectLocal) and the
  // receipt check compares with the live base.
  const recipeText = recipe && JSON.stringify(recipe);
  f.github.rest.repos.getContent = async args => args.path === 'clouseau-review.json' && served ? {data: {encoding: 'base64',
    content: Buffer.from(JSON.stringify(served)).toString('base64'), size: JSON.stringify(served).length}} :
    recipe && args.path === '.clouseau-local.json' && args.ref === record.snapshot.base_sha ? {data: {encoding: 'base64',
      content: Buffer.from(recipeText).toString('base64'), size: Buffer.byteLength(recipeText)}} : original(args);
  f.state.pr.body = `Ready change.\n<!-- clouseau-local-review:v1 ${'f'.repeat(40)} -->`;
  // The record `clouseau review` signs: `previous` is always `{comment: null, findings: []}`.
  const draft = (history, review = () => {}) => {
    const copy = structuredClone(record);
    copy.snapshot.number = 0; copy.snapshot.config_digest = digest(trusted);
    if (history) {copy.snapshot.prior_findings = structuredClone(history); copy.local_previous = {findings: structuredClone(history)};}
    if (recipe) {
      const id = `${copy.snapshot.base_sha}:.clouseau-local.json`;
      copy.snapshot.sources[id] = {path: '.clouseau-local.json', ref: copy.snapshot.base_sha, authority: 'untrusted', kind: 'source', content: recipeText};
      // Each review inventories every source: the recipe is excluded, citing the repository contract it is judged against.
      for (const item of copy.result.reviews) {
        const contract = item.report.coverage.sources.find(entry => entry.source.endsWith(':README.md'));
        item.report.coverage.sources.push({source: id, state: 'excluded', reason: 'The verification recipe has no bearing on the reviewed behaviour.', evidence: contract.evidence});
      }
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
    reviewerSha: trusted.local_review.reviewer_sha, humanReview: human});
  // A review's ledger reconciled with a history: Out with its signed local history, Leg with `[]`, and the local history
  // `clouseau review` writes after it (the next review's In).
  const reconciled = (copy, history) => reconcile({...copy.result, reviews: reviewDecision(copy).reviews}, copy.snapshot, history).findings;
  const sign = ({history = null, review} = {}) => {
    const copy = draft(history, review);
    const bundle = issue(copy);
    served = bundle;
    return {copy, bundle, In: history, Out: reconciled(copy, history || []), Leg: reconciled(copy, [])};
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
  // What `clouseau review` signs as In under `"review_history": "pull_request"`: runReview's own selection
  // (review-history.cjs), given this machine's local history and a gh that serves the pull request's ledger comment for L.
  const select = async (L, local) => {
    const comments = [bot(7101, ledger(L))];
    const slug = `${f.context.repo.owner}/${f.context.repo.repo}`;
    const answers = {[`repos/${slug}`]: {fork: false}, [`repos/${slug}/pulls?head=${f.context.repo.owner}:fix%2Fupload&state=open&per_page=100`]: [{number: 3}],
      [`repos/${slug}/issues/3/comments?per_page=100&page=1`]: comments};
    const warnings = [];
    const {findings, number} = await reviewHistory.priorFindings({local, repo: f.context.repo, branch: 'fix/upload', warn: text => warnings.push(text),
      execute: (program, args) => {assert.equal(program, 'gh'); assert.ok(Object.hasOwn(answers, args[5]), args[5]); return JSON.stringify(answers[args[5]]);}});
    assert.equal(number, 3);
    assert.ok(same(findings, L), 'In = L by construction');
    return {findings, warnings};
  };
  return {trusted, record, draft, issue, reconciled, sign, assess, gate, ledger, select, privateKey};
}

const ACCEPTED = {decision: 'owner_decision'};
const REFUSED = {decision: 'review_incomplete', cause: 'receipt_history_changed'};
const CHANGED = 'Acceptance history changed; reassess the current record';

// Each row: `build` signs the receipts and returns the forms {L, In, Out, Leg} (L null: no ledger). `assess` is the expected
// assessment after the owner's `/approve-intent`; `gate` the expected gate outcome for the record that assessment produced
// (only an accepted assessment produces one) and `publishes` the form it then publishes; `boundary` the expected outcome at
// the write boundary for a record assessed before the ledger was on the pull request (default: `gate`). `vsMain` compares the
// behaviour with main 80d4cfc, which accepts L ∈ {[], Out, Leg} only.
const ROWS = [
  {name: '1. no ledger', vsMain: 'same', assess: ACCEPTED, gate: 'approve', publishes: 'Out',
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const later = h.sign({history: first.Out, review: copy => report(copy, 'B')});
      return {...later, L: null};
    }},
  {name: '2. same receipt, second run (L = Out)', vsMain: 'same', assess: ACCEPTED, gate: 'approve', publishes: 'Out',
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const later = h.sign({history: first.Out, review: copy => report(copy, 'B')});
      return {...later, L: later.Out};
    }},
  {name: '3. later receipt, identical findings (In = Out = L)', vsMain: 'same', assess: ACCEPTED, gate: 'approve', publishes: 'Out',
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const later = h.sign({history: first.Out, review: copy => report(copy, 'A')});
      assert.ok(same(later.In, later.Out), 'the later review re-finds A unchanged');
      return {...later, L: first.Out};
    }},
  {name: '4. later receipt adds a finding (L = In, Out = In + B)', vsMain: 'better', assess: ACCEPTED, gate: 'approve', publishes: 'Out',
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const later = h.sign({history: first.Out, review: copy => {report(copy, 'A'); report(copy, 'B');}});
      assert.equal(later.Out.length, 2); assert.equal(later.Leg.length, 2);
      return {...later, L: first.Out};
    }},
  // A non-blocking re-find keeps A `advisory_closed` (row 3). The only other state a signable receipt gives a re-found A is a
  // blocking re-find: `repair_required`, signable only under `human_review: "signed"` as the owner-decision hold.
  {name: '5. later receipt re-finds A blocking (human_review: "signed")', vsMain: 'better', human: true, assess: ACCEPTED, gate: 'approve', publishes: 'Out',
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const later = h.sign({history: first.Out, review: copy => report(copy, 'A', {blocking: true})});
      assert.equal(later.copy.result.decision, 'repair_required');
      assert.deepEqual(later.Out.map(item => [item.id, item.state, item.blocking]), [[first.Out[0].id, 'confirmed', true]]);
      return {...later, L: first.Out};
    }},
  // A closed finding reopens only through a blocking re-find (a non-blocking one leaves it closed) with a reopening citing fresh
  // current-source evidence (reconcile, review_manifest_version), so again only under `human_review: "signed"`. History: review 1
  // found A blocking, review 2 dismissed it, both published; review 3 reopens it.
  {name: '6. later receipt reopens a dismissed finding (human_review: "signed")', vsMain: 'better', human: true, assess: ACCEPTED, gate: 'approve', publishes: 'Out',
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A', {blocking: true})});
      const id = first.Out[0].id;
      const second = h.sign({history: first.Out, review: copy => resolve(copy, id, 'dismissed')});
      assert.equal(second.Out[0].state, 'dismissed');
      // A non-blocking re-find leaves A dismissed; a blocking re-find without fresh evidence leaves it unresolved, unsignable.
      assert.equal(h.reconciled(h.draft(second.Out, copy => report(copy, 'A')), second.Out)[0].state, 'dismissed');
      assert.throws(() => h.issue(h.draft(second.Out, copy => report(copy, 'A', {blocking: true}))), /only a passing review can be signed/);
      const later = h.sign({history: second.Out, review: copy => {
        report(copy, 'A', {blocking: true});
        const item = copy.result.reviews[0].report;
        // Fresh current-source evidence: a quote whose bytes differ from the evidence the dismissal cited (the whole file).
        const source = `${copy.snapshot.head_sha}:src/upload.test.js`;
        item.evidence.push({id: 'reopen-proof', source, start: 10, end: 10, quote: copy.snapshot.sources[source].content.split('\n')[9]});
        item.reopenings.push({id, reason: 'The current revision reintroduces the dismissed defect.', evidence: ['reopen-proof']});
      }});
      assert.deepEqual(later.Out.map(item => [item.state, item.blocking]), [['confirmed', true]], 'review 3 reopens A');
      return {...later, L: second.Out};
    }},
  {name: '7. a hosted review changed the ledger in between (L = In + H)', vsMain: 'same', assess: REFUSED, gate: CHANGED,
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const later = h.sign({history: first.Out, review: copy => report(copy, 'B')});
      return {...later, L: [...first.Out, {...HOSTED}]};
    }},
  ...Object.entries({
    foreign: forms => [{...FOREIGN, id: 'c'.repeat(64)}],
    extra: forms => [...forms.In, {...FOREIGN, id: 'c'.repeat(64)}],
    'changed-state': forms => [{...forms.In[0], state: 'confirmed', blocking: true}, ...forms.In.slice(1)],
    missing: forms => forms.In.slice(0, 1),
  }).map(([variant, change]) => ({name: `8. ${variant} finding relative to In`, vsMain: 'same', assess: REFUSED, gate: CHANGED,
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const later = h.sign({history: [...first.Out, {...FOREIGN}], review: copy => report(copy, 'B')});
      return {...later, L: change(later)};
    }})),
  // Main's first condition: an existing but empty ledger equals the record's own signed `previous` (`[]`), so the assessment
  // accepts it and records the comment; the write boundary, for a record assessed without it, does not.
  {name: '8. EDGE: an existing but empty ledger (L = []) passes main\'s first condition', vsMain: 'same', assess: ACCEPTED, gate: 'approve', publishes: 'Out', boundary: CHANGED,
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const later = h.sign({history: [...first.Out, {...FOREIGN}], review: copy => report(copy, 'B')});
      return {...later, L: []};
    }},
  // 9. Receipt 1 had a non-empty local history; a gate published it in the legacy form, reconciled with `[]`. Receipt 2 is
  // reviewed against the local history `clouseau review` wrote after review 1 (without the key) or against the ledger (with it).
  {name: '9. without review_history — legacy-form ledger, then a later receipt', vsMain: 'same', assess: REFUSED, gate: CHANGED,
    build: h => {
      const first = h.sign({history: [{...FOREIGN}], review: copy => report(copy, 'A')});
      assert.notDeepEqual(first.Leg, first.Out);
      const later = h.sign({history: first.Out, review: copy => report(copy, 'B')});
      return {...later, L: first.Leg};
    }},
  {name: '9. with review_history — legacy-form ledger, then a later receipt', reviewHistory: true, vsMain: 'better', assess: ACCEPTED, gate: 'approve', publishes: 'Out',
    build: async h => {
      const first = h.sign({history: [{...FOREIGN}], review: copy => report(copy, 'A')});
      const In = await h.select(first.Leg, first.Out);
      assert.deepEqual(In.warnings, [], 'no local finding is a blocker');
      const later = h.sign({history: In.findings, review: copy => report(copy, 'B')});
      return {...later, L: first.Leg};
    }},
  {name: '10. three receipts in sequence, all published (L = Out2 = In3)', vsMain: 'better', assess: ACCEPTED, gate: 'approve', publishes: 'Out',
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const second = h.sign({history: first.Out, review: copy => report(copy, 'B')});
      const third = h.sign({history: second.Out, review: copy => report(copy, 'C')});
      return {...third, L: second.Out};
    }},
  // 11. Review 2 found blocking B; it was never signed nor published, but `clouseau review` wrote its local history.
  {name: '11. without review_history — an unpublished intermediate review (repair rounds)', vsMain: 'same', assess: REFUSED, gate: CHANGED,
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const second = h.draft(first.Out, copy => report(copy, 'B', {blocking: true}));
      assert.equal(second.result.decision, 'repair_required');
      const history = h.reconciled(second, first.Out);
      assert.deepEqual(history.map(item => item.state).sort(), ['advisory_closed', 'confirmed']);
      const id = history.find(item => item.blocking).id;
      const third = h.sign({history, review: copy => resolve(copy, id)});
      assert.deepEqual(third.Out.map(item => item.state).sort(), ['advisory_closed', 'corrected']);
      return {...third, L: first.Out};
    }},
  // With the key review 3 is reviewed against L = Out1: the unpublished B is not carried in, and the review names it. Its
  // forms are ones main's rule accepts too (Out3 = L); without the key no receipt of this pull request ever had them.
  {name: '11. with review_history — an unpublished intermediate review (repair rounds)', reviewHistory: true, vsMain: 'same', assess: ACCEPTED, gate: 'approve', publishes: 'Out',
    build: async h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const second = h.draft(first.Out, copy => report(copy, 'B', {blocking: true}));
      const history = h.reconciled(second, first.Out);
      const id = history.find(item => item.blocking).id;
      const In = await h.select(first.Out, history);
      assert.equal(In.warnings.length, 1);
      assert.ok(In.warnings[0].startsWith(`Local-only finding not on the pull request ledger: ${id} "Fictional finding B" (confirmed)`), In.warnings[0]);
      const third = h.sign({history: In.findings, review: () => {}});
      assert.ok(same(third.Out, first.Out), 'review 3 carries Out1 forward');
      return {...third, L: first.Out};
    }},
  // 13. Another machine, or a cleared state directory: `readHistory` finds nothing, so without the key In = [].
  {name: '13. without review_history — a second machine reviews a pull request that already has a ledger', vsMain: 'same', assess: REFUSED, gate: CHANGED,
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const later = h.sign({history: [], review: copy => report(copy, 'B')});
      return {...later, L: first.Out};
    }},
  {name: '13. with review_history — a second machine reviews a pull request that already has a ledger', reviewHistory: true, vsMain: 'better', assess: ACCEPTED, gate: 'approve', publishes: 'Out',
    build: async h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const In = await h.select(first.Out, []);
      const later = h.sign({history: In.findings, review: copy => report(copy, 'B')});
      return {...later, L: first.Out};
    }},
  // 14. A receipt whose history was built before the feature (an older CLI, or a review signed before the key was set) carries
  // the local history it had; CI judges it by the receipt alone, exactly as before this change.
  {name: '14. no worse: a history built before the feature that equals the ledger', vsMain: 'better', assess: ACCEPTED, gate: 'approve', publishes: 'Out',
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const later = h.sign({history: first.Out, review: copy => {report(copy, 'A'); report(copy, 'B');}});
      return {...later, L: first.Out};
    }},
  {name: '14. no worse: a history built before the feature that differs from the ledger', vsMain: 'same', assess: REFUSED, gate: CHANGED,
    build: h => {
      const first = h.sign({review: copy => report(copy, 'A')});
      const later = h.sign({history: [...first.Out, {...FOREIGN}], review: copy => report(copy, 'B')});
      return {...later, L: first.Out};
    }},
];

// Main 80d4cfc accepts, at the assessment, L ∈ {[], Out, Leg} (no ledger is no history). This change adds L = In.
const mainAccepts = forms => forms.L === null || [[], forms.Out, forms.Leg].some(form => same(forms.L, form));
const accepts = forms => mainAccepts(forms) || same(forms.L, forms.In);

for (const row of ROWS) {
  test(`ledger matrix — ${row.name}`, async () => {
    // The assessment after the owner's `/approve-intent`, then the gate for the record it produced.
    await fixture(async f => {
      const h = await harness(f, row);
      const forms = await row.build(h);
      assert.equal(accepts(forms), row.assess === ACCEPTED, 'the row states the rule');
      assert.equal(mainAccepts(forms) === accepts(forms) ? 'same' : 'better', row.vsMain, 'the row states the comparison with main');
      f.state.comments = [...forms.L === null ? [] : [bot(7101, h.ledger(forms.L))], confirmation(f)];
      const assessment = await h.assess();
      assert.equal(assessment.decision, row.assess.decision, assessment.reason);
      assert.equal(assessment.cause, row.assess.cause);
      if (row.assess !== ACCEPTED) {
        assert.equal(assessment.record_digest, undefined);
        await assert.rejects(h.gate(assessment), /produced no acceptance record/);
        assert.deepEqual(ledgerWrites(f), []);
        return;
      }
      assert.equal(assessment.review_source, 'authenticated_local');
      // The stored record keeps the signed `previous`; the gate re-derives the ledger from the signed local history.
      assert.deepEqual(JSON.parse(fs.readFileSync(f.recordPath)).previous, {comment: forms.L === null ? null : 7101, findings: []});
      await h.gate(assessment);
      assert.equal(approvals(f), 1, 'the exact-head confirmation approves');
      const written = ledgerWrites(f);
      assert.equal(written.length, 1);
      assert.equal(written[0].name, forms.L === null ? 'create-ledger' : 'update-ledger');
      assert.deepEqual(stateOf(written[0].args.body).findings, forms[row.publishes], `the gate publishes ${row.publishes}`);
    });
    // The write boundary: a record assessed before the ledger was on the pull request meets it at the gate.
    await fixture(async f => {
      const h = await harness(f, row);
      const forms = await row.build(h);
      if (forms.L === null) return;
      f.state.comments = [confirmation(f)];
      const assessment = await h.assess();
      assert.equal(assessment.decision, 'owner_decision', assessment.reason);
      f.state.comments = [bot(7101, h.ledger(forms.L)), confirmation(f)];
      const expected = row.boundary ?? row.gate;
      if (expected === 'approve') {
        await h.gate(assessment);
        assert.equal(approvals(f), 1);
        assert.deepEqual(stateOf(ledgerWrites(f)[0].args.body).findings, forms[row.publishes], `the write boundary publishes ${row.publishes}`);
      } else {
        await assert.rejects(h.gate(assessment), new RegExp(expected.replace(/[.;]/g, '\\$&')));
        assert.equal(approvals(f), 0);
        assert.deepEqual(ledgerWrites(f), []);
      }
    });
  });
}

// Main 80d4cfc's rule and this rule are the gate's; a `reviewHistory` row differs from its pair only in the receipt's In.
test('ledger matrix — no row is worse than main; without review_history rows 9, 11 and 13 stay refused, with it they are accepted, and row 14 is unchanged', () => {
  assert.ok(ROWS.every(row => ['better', 'same'].includes(row.vsMain)));
  assert.deepEqual(ROWS.filter(row => /KNOWN/.test(row.name)), [], 'no row is left as a known refusal');
  for (const number of ['9.', '11.', '13.']) {
    const pair = ROWS.filter(row => row.name.startsWith(`${number} `));
    assert.deepEqual(pair.map(row => Boolean(row.reviewHistory)), [false, true], number);
    const [without, keyed] = pair;
    assert.ok(without.name.includes('without review_history'), without.name);
    assert.equal(without.vsMain, 'same'); assert.equal(without.assess, REFUSED); assert.equal(without.gate, CHANGED);
    assert.ok(keyed.name.includes('with review_history'), keyed.name);
    assert.equal(keyed.assess, ACCEPTED); assert.equal(keyed.gate, 'approve');
  }
  // Only those three rows depend on the key; every other row, row 14 included, is the receipt as before.
  assert.deepEqual(ROWS.filter(row => row.reviewHistory).map(row => row.name.split(' ')[0]), ['9.', '11.', '13.']);
  const pinned = ROWS.filter(row => row.name.startsWith('14. '));
  assert.equal(pinned.length, 2);
  for (const row of pinned) assert.ok(row.name.includes('no worse') && !row.reviewHistory, row.name);
  assert.deepEqual(pinned.map(row => row.assess), [ACCEPTED, REFUSED]);
});

// The proof that CI ignores the key: a receipt whose accepted base recipe carries `"review_history": "pull_request"` is
// assessed and gated exactly as one whose recipe does not, and nothing on the CI side runs gh (a gh on PATH that records any
// invocation stays silent). Entry points of the recipe outside CI are in review-history-entry-points.test.cjs.
test('ledger matrix — CI assesses and gates a receipt whose accepted recipe sets review_history exactly as one whose recipe does not', async () => {
  const {silentGh} = require('../test/gh-recorder.cjs');
  const plain = {version: 2, base_branch: 'main', readme: 'README.md', repository_policy: '.github/clouseau.md', verification: [['npm', 'test']],
    coverage: [{format: 'istanbul', report: 'coverage/coverage-final.json', source_directory: 'src'}]};
  const outcomes = [];
  await silentGh(async () => {
    for (const recipe of [plain, {...plain, review_history: 'pull_request'}]) {
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

// 12. An earlier blocking finding the later review neither resolves nor re-finds can never stand behind a receipt. Enforced by:
// - reconcile (acceptance-ledger.cjs): `if (old.blocking && !resolutions.every(Boolean))` records it `outstanding` and pushes
//   it onto `unresolved`;
// - reviewDecision (local-receipt.cjs): `state.unresolved.length && combined === 'auto_approve' ? 'review_incomplete'`, and
//   `signable` refuses `review_incomplete`, and `repair_required` with `unresolved > 0`, even under `humanReview`;
// - issueReceipt: `requireReceipt(signable(...), 'only a passing review can be signed')`;
// - verifySignedRecord (verifyReceipt): `reject(result.decision === decision, 'claimed decision differs ...')` and
//   `reject(signable(result.decision, ...), 'review did not pass')`;
// - verifyRecord (acceptance-controller.cjs), independently in CI: `if (state.unresolved.length && ['auto_approve',
//   'owner_decision'].includes(result.decision)) result.decision = 'review_incomplete'`.
test('ledger matrix — 12. an unresolved blocking prior finding: the receipt can never be signed, and CI derives review_incomplete', () => fixture(async f => {
  const h = await harness(f, {human: true});
  const first = h.sign({review: copy => report(copy, 'A', {blocking: true})});
  assert.deepEqual(first.Out.map(item => [item.state, item.blocking]), [['confirmed', true]]);
  for (const review of [() => {}, copy => report(copy, 'B', {blocking: true})]) {
    const copy = h.draft(first.Out, review);
    const state = h.reconciled(copy, first.Out);
    assert.deepEqual(reconcile({...copy.result, reviews: reviewDecision(copy).reviews}, copy.snapshot, first.Out).unresolved, [first.Out[0].id]);
    assert.equal(state.find(item => item.id === first.Out[0].id).state, 'outstanding');
    const derived = reviewDecision(copy);
    assert.equal(derived.unresolved, 1);
    assert.ok(['review_incomplete', 'repair_required'].includes(derived.decision));
    // Not signable, even under human_review: "signed".
    assert.throws(() => h.issue(copy), /only a passing review can be signed/);
    // A receipt signed around issueReceipt (the same key, the payload issueReceipt builds) is refused by verifyReceipt.
    for (const claimed of [derived.decision, 'auto_approve']) {
      const forged = structuredClone(copy); forged.result.decision = claimed;
      const payload = {type: DOMAIN, key_id: 'fixture', issuer: 'fixture-runner', reviewer_sha: h.trusted.local_review.reviewer_sha,
        reviewer_digest: h.trusted.local_review.reviewer_digest, issued_at: Math.floor(Date.now() / 1000), expires_at: Math.floor(Date.now() / 1000) + 3600,
        nonce: 'a'.repeat(64), record_digest: digest(forged), record: forged};
      const bundle = {payload, signature: crypto.sign(null, Buffer.from(`${DOMAIN}\0${digest(payload)}`), crypto.createPrivateKey(h.privateKey)).toString('base64url')};
      assert.throws(() => verifyReceipt(bundle, {trust: h.trusted.local_review, repository: forged.snapshot.repository, author: 'contributor',
        headSha: forged.snapshot.head_sha, baseSha: forged.snapshot.base_sha, configDigest: digest(h.trusted),
        policyDigest: forged.snapshot.policy_digest, pullNumber: 3, humanReview: true}), claimed === 'auto_approve' ? /claimed decision differs/ : /review did not pass/);
    }
  }
  // CI's verifyRecord derives the decision itself: the hosted record of this pull request, reconciled with that same history
  // (a hosted record's history is its `previous`), is review_incomplete, so an assessment claiming a pass is a mismatch.
  const record = {...structuredClone(h.record), previous: {comment: 7101, findings: structuredClone(first.Out)}};
  const assessment = {version: 2, number: 3, head_sha: record.snapshot.head_sha, base_sha: record.snapshot.base_sha,
    decision: 'auto_approve', record_digest: digest(record)};
  assert.throws(() => verifyRecord(record, assessment, config), error => error.code === 'DECISION_MISMATCH' && error.derived === 'review_incomplete');
}));
