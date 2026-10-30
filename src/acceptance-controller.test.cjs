'use strict';

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
const config = {...require('../test/fixtures/config.json'), version: 2, repository_policy: '.github/clouseau.md', readme: 'README.md', acceptance: {
  examiner: 'deepseek-flash', challenger: 'deepseek-flash', grader: 'deepseek', grading_model: 'deepseek-flash', repair_attempts: 2,
}};

test('absent protected-base CODEOWNERS leaves ownership inactive without waiving CI or protection', () => fixture(async f => {
  const original = f.github.rest.repos.getContent; const reads = [];
  f.github.rest.repos.getContent = async args => {
    if (['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].includes(args.path)) {
      reads.push(args); throw Object.assign(new Error('Absent'), {status: 404});
    }
    return original(args);
  };
  const assessment = await f.assess();
  f.state.failed = true; await assert.rejects(f.gate(assessment), /Verification changed/);
  f.state.failed = false;
  const branch = f.github.rest.repos.getBranch;
  f.github.rest.repos.getBranch = async () => ({data: {protected: false}});
  await assert.rejects(f.gate(assessment), /protection/);
  assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 0);
  f.github.rest.repos.getBranch = branch; f.state.pr.auto_merge = null;
  f.github.rest.repos.getCollaboratorPermissionLevel = async () => {throw new Error('Do not infer ownership from permission');};
  const messages = [];
  const core = {info(message) {messages.push(message);}, summary: {addRaw() {return this;}, async write() {}}};
  await f.policy.gate({github: f.github, context: f.context, core, assessment, recordPath: f.recordPath, nativeGate: true});
  assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 1);
  assert.equal(f.state.writes.filter(item => item.name === 'enable-auto').length, 1);
  assert.ok(messages.some(message => message.includes('optional code-owner gate is inactive')));
  assert.deepEqual(reads.slice(0, 3).map(read => read.path), ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']);
  assert.ok(reads.every(read => read.ref === assessment.base_sha));
}));

test('explicit manual mode approves independently verified owner work without ever arming auto-merge or deployment', () => fixture(async f => {
  const policy = createPolicy({...config, merge_mode: 'manual'});
  f.github.rest.repos.get = async () => ({data: {private: true, allow_auto_merge: false}});
  f.github.rest.repos.getBranch = async () => ({data: {protected: false}});
  f.github.request = async () => {throw Object.assign(new Error('Upgrade to GitHub Pro or make this repository public to enable this feature.'), {status: 403});};
  const assessment = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
  assert.equal(assessment.decision, 'auto_approve');
  const messages = [];
  const core = {info(message) {messages.push(message);}, summary: {addRaw(message) {messages.push(message); return this;}, async write() {}}};
  await policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment, nativeGate: true});
  assert.equal(f.state.writes.filter(w => w.name === 'approve').length, 1);
  assert.equal(f.state.writes.filter(w => w.name === 'disable-auto').length, 1);
  assert.equal(f.state.writes.filter(w => w.name === 'enable-auto').length, 0);
  assert.equal(f.state.pr.auto_merge, null);
  assert.ok(messages.some(message => message.includes('GitHub cannot enforce protection')));
  await policy.finalize({github: f.github, context: f.context, core, assessment});
  assert.ok(messages.some(message => message.includes('never arms auto-merge or dispatches deployment')));
  f.state.pr.auto_merge = {};
  await policy.finalize({github: f.github, context: f.context, core, assessment});
  assert.equal(f.state.pr.auto_merge, null);
}));

test('manual mode still refuses failed tests, stale revisions and an unsuccessful auto-merge disable', () => fixture(async f => {
  const policy = createPolicy({...config, merge_mode: 'manual'});
  f.state.pr.auto_merge = null;
  f.github.rest.repos.get = async () => ({data: {allow_auto_merge: false}});
  const assessment = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
  const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
  const gate = () => policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment, nativeGate: true});
  f.state.failed = true;
  await assert.rejects(gate(), /Verification changed/);
  f.state.failed = false;
  f.state.pr.head.sha = 'd'.repeat(40);
  await assert.rejects(gate(), /PR changed/);
  f.state.pr.head.sha = assessment.head_sha;
  f.state.pr.auto_merge = {};
  f.github.graphql = async () => ({});
  await assert.rejects(gate(), /Automatic merge remains enabled/);
  assert.equal(f.state.writes.filter(w => w.name === 'approve').length, 0);
}));

test('manual mode preserves available protection and denies newly enabled auto-merge or revoked ownership before approval', async () => {
  for (const failure of [null, 'settings', 'owner']) await fixture(async f => {
    const policy = createPolicy({...config, merge_mode: 'manual'});
    f.state.pr.auto_merge = null;
    const assessment = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
    let settingsReads = 0; let ownerReads = 0;
    f.github.rest.repos.get = async () => ({data: {private: false, allow_auto_merge: failure === 'settings' && ++settingsReads > 1}});
    f.github.rest.repos.getCollaboratorPermissionLevel = async () => ({data: {permission: failure === 'owner' && ++ownerReads > 1 ? 'read' : 'write'}});
    const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
    const gate = () => policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment, nativeGate: true});
    if (failure) {
      await assert.rejects(gate(), failure === 'settings' ? /auto-merge to be disabled/ : /ownership changed/);
      assert.equal(f.state.writes.filter(w => w.name === 'approve').length, 0);
    } else {
      await gate();
      assert.equal(f.state.writes.filter(w => w.name === 'approve').length, 1);
    }
    assert.equal(f.state.writes.filter(w => w.name === 'enable-auto').length, 0);
  });
});

test('manual-only external work retains the exact-head code-owner approval requirement even on an unsupported private plan', () => fixture(async f => {
  const policy = createPolicy({...config, merge_mode: 'manual'});
  const assessment = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
  const original = f.github.rest.repos.getContent;
  f.github.rest.repos.getContent = args => args.path === '.github/CODEOWNERS' ? Promise.resolve({data: {
    encoding: 'base64', content: Buffer.from('* @maintainer').toString('base64')}}) : original(args);
  f.github.rest.repos.get = async () => ({data: {private: true, allow_auto_merge: false}});
  f.github.rest.repos.getBranch = async () => ({data: {protected: false}});
  f.github.request = async () => {throw Object.assign(new Error('Upgrade to GitHub Pro or make this repository public to enable this feature.'), {status: 403});};
  const messages = [];
  const core = {info() {}, summary: {addRaw(value) {messages.push(value); return this;}, async write() {}}};
  const gate = () => policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment, nativeGate: true});
  await assert.rejects(gate(), /current-head code-owner approval/);
  f.state.reviews = [{user: {login: 'maintainer', type: 'User'}, state: 'APPROVED', commit_id: f.state.pr.head.sha}];
  await gate();
  assert.ok(messages.some(value => value.includes('GitHub cannot enforce protection')));
  assert.equal(f.state.writes.filter(w => w.name === 'enable-auto').length, 0);
  assert.equal(f.state.pr.auto_merge, null);
}));

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
      listFiles: endpoint('files', async () => ({data: [{filename: 'src/upload.test.js', status: 'modified', patch: '+meaningful tests'}]})),
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

test('v2 assessment and native approval exchange a complete source-bound record and retain all existing protection checks', () => fixture(async f => {
  const assessment = await f.assess();
  assert.equal(assessment.decision, 'auto_approve'); assert.equal(f.state.calls, 2, 'a change without findings needs no grading');
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  assert.equal(assessment.record_digest, digest(record));
  assert.equal(record.technical.attempt, 1); assert.equal(record.technical.job.id, 10);
  assert.equal(record.snapshot.config_digest, digest(config));
  await f.gate(assessment);
  assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 1);
  assert.equal(f.state.writes.filter(item => item.name === 'create-ledger').length, 1);
  assert.equal(f.state.writes.some(item => item.name === 'assign'), false);
  assert.throws(() => numberFor({payload: {}}), /PR number/);
  assert.equal(numberFor({payload: {issue: {number: 4, pull_request: {}}}}), 4);
  assert.equal(decided({decision: 'repair_required'}, true), 'repair_required');
  assert.equal(decided({decision: 'auto_approve'}, true), 'owner_decision');
}));

test('optional local review rejects every malformed receipt claim without paid fallback while unstamped changes receive CI review', () => fixture(async f => {
  const keys = require('node:crypto').generateKeyPairSync('ed25519');
  const trusted = {...config, local_review: {mode: 'optional', reviewer_digest: require('./local-version.cjs').engineDigest(),
    max_age_seconds: 172800, keys: [{id: 'marker-fixture', issuer: 'ephemeral-fixture-runner', github_actor: 'contributor', revoked: false,
      public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}]}};
  const policy = createPolicy(trusted);
  const local = `<!-- clouseau-local-review:v1 ${'a'.repeat(40)} -->`;
  const unknown = `<!-- clouseau-local-review:v2 ${'b'.repeat(40)} -->`;
  const installation = `<!-- clouseau-installation-review:v1 ${'c'.repeat(40)} -->`;
  const readContent = f.github.rest.repos.getContent;
  let artifactReads = 0;
  f.github.rest.repos.getContent = async args => {
    if (args.path === 'clouseau-review.json') artifactReads++;
    return readContent(args);
  };
  for (const body of [`<!-- clouseau-local-review:v1 malformed-sha -->`, unknown,
    `${local}\n${unknown}`, `${local}\n${local}`, installation, `${local}\n${installation}`]) {
    f.state.pr.body = body;
    const result = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
    assert.equal(result.decision, 'review_incomplete', body);
    assert.equal(f.state.calls, 0, 'a claimed but invalid local review cannot become a paid CI fallback');
    assert.equal(artifactReads, 0, 'ambiguous or unsupported claims are rejected before fetching an artifact');
    assert.equal(f.state.writes.length, 0, 'invalid claims cannot write an approval or acceptance ledger');
  }
  f.state.pr.body = 'Useful application regression fix with no local receipt.';
  const ordinary = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
  assert.equal(ordinary.decision, 'auto_approve', ordinary.reason);
  assert.ok(f.state.calls > 0, 'a genuinely unstamped change receives the configured independent CI AI review');
  assert.equal(artifactReads, 0);
  assert.equal(f.state.writes.length, 0, 'assessment itself does not grant a GitHub approval');
}));

test('job-output data still requires the complete scored record and fresh head/base and CI before approval', () => fixture(async f => {
  const transport = require('./record-transport.cjs');
  const assessment = await f.assess();
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  const payload = transport.encode({assessment, record, repair: null, context: f.context, runAttempt: '1'});
  fs.rmSync(f.recordPath);
  transport.receive({mode: 'job-output', payload, assessment, context: f.context, runAttempt: '1', recordPath: f.recordPath});
  assert.equal(verifyRecord(JSON.parse(fs.readFileSync(f.recordPath)), assessment, config).state.unresolved.length, 0);
  const head = f.state.pr.head.sha; f.state.pr.head.sha = 'e'.repeat(40);
  await assert.rejects(f.gate(assessment), /PR changed/);
  f.state.pr.head.sha = head;
  const base = f.state.pr.base.sha; f.state.pr.base.sha = 'e'.repeat(40);
  const getBranch = f.github.rest.repos.getBranch;
  f.github.rest.repos.getBranch = async () => ({data: {protected: true, commit: {sha: 'e'.repeat(40)}}});
  await assert.rejects(f.gate(assessment), /Needs branch update/);
  assert.equal(f.state.writes.filter(item => item.name === 'create-ledger').length, 1, 'the PR receives one explicit branch-update notice');
  assert.match(f.state.writes[0].args.body, /clouseau-needs-branch-update/);
  f.state.writes.length = 0;
  f.github.rest.repos.getBranch = getBranch; f.state.pr.base.sha = base;
  f.state.failed = true;
  await assert.rejects(f.gate(assessment), /Verification changed/);
  assert.equal(f.state.writes.length, 0);
  f.state.failed = false;
  await f.gate(assessment);
  assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 1);
}));

for (const central of [false, true, 'controls']) test(`central=${central}: authenticated local receipt reaches native approval with zero CI AI calls and rejects altered or absent receipts`, () => fixture(async f => {
  const crypto = require('node:crypto');
  const {issueReceipt} = require('./local-receipt.cjs');
  const {refresh} = require('./acceptance-sources.cjs');
  const seed = await f.assess();
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  const keys = crypto.generateKeyPairSync('ed25519');
  const trusted = {...config, local_review: {mode: 'required', reviewer_sha: 'e'.repeat(40),
    reviewer_digest: require('./local-version.cjs').engineDigest(), max_age_seconds: 172800,
    keys: [{id: 'fixture', issuer: 'fixture-runner', github_actor: 'contributor', revoked: false,
      public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}]}};
  const engine = central ? {...require('./central-version.cjs').SOURCE, sha: trusted.local_review.reviewer_sha, digest: trusted.local_review.reviewer_digest} : null;
  if (central) {delete trusted.local_review.reviewer_digest; trusted.local_review.central_source = {...require('./central-version.cjs').SOURCE};}
  if (central === 'controls') trusted.sensitive_paths = [...trusted.sensitive_paths, 'src/upload.test.js'];
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
  const contentReads = [];
  let served = bundle;
  f.github.rest.repos.getContent = async args => {
    contentReads.push(args);
    return args.path === 'clouseau-review.json' ? {data: {
      encoding: 'base64', content: Buffer.from(JSON.stringify(served)).toString('base64'), size: JSON.stringify(served).length,
    }} : original(args);
  };
  const policy = createPolicy(trusted, {engine});
  f.state.pr.body = `Ready change.\n<!-- clouseau-local-review:v1 ${'f'.repeat(40)} -->`;
  if (central === 'controls') f.state.comments = [{id: 87, user: {login: 'gaulatti', type: 'User'}, body: `/approve-intent ${f.state.pr.head.sha}`}];
  let providerCalls = 0;
  const reports = [];
  const assess = () => policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, report: line => reports.push(line),
    fetchImpl: async () => {providerCalls++; throw new Error('CI AI must not be called');}});
  const assessment = await assess();
  assert.equal(seed.decision, 'auto_approve');
  assert.equal(assessment.decision, central === 'controls' ? 'owner_decision' : 'auto_approve', assessment.reason);
  assert.ok(reports.some(line => line.includes('CI AI calls: 0')));
  assert.equal(providerCalls, 0);
  if (central === false) {
    // The pre-PR stage tolerates an unresolved completeness gate; hosted CI never reuses that as approval.
    const unresolved = structuredClone(record);
    for (const item of unresolved.result.reviews) {
      item.report.gates.find(gate => gate.name === 'review_completeness').state = 'unresolved';
      item.report.coverage.dependencies = [{path: 'src/dependency.js', state: 'missing', reason: 'The dependency was not supplied.', evidence: []}];
    }
    served = issueReceipt({record: unresolved, privateKey: keys.privateKey.export({type: 'pkcs8', format: 'pem'}),
      keyId: 'fixture', issuer: 'fixture-runner', reviewerSha: trusted.local_review.reviewer_sha});
    const kept = fs.readFileSync(f.recordPath); fs.rmSync(f.recordPath);
    const holdAssessment = await assess();
    assert.equal(holdAssessment.decision, 'review_incomplete');
    assert.match(holdAssessment.reason, /Authenticated local review held: review completeness is unresolved/);
    assert.equal(fs.existsSync(f.recordPath), false);
    served = bundle; fs.writeFileSync(f.recordPath, kept);
  }
  const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
  const approvedRecord = fs.readFileSync(f.recordPath);
  fs.rmSync(f.recordPath);
  for (const pending of [true, false]) {
    f.state.pending = pending; f.state.failed = !pending; contentReads.length = 0;
    const held = await assess();
    assert.equal(held.decision, pending ? 'pending_technical' : 'blocked_technical', 'a valid local quality receipt cannot replace independent CI');
    assert.equal(held.review_source, 'authenticated_local');
    assert.equal(held.provider_api_calls, 0);
    assert.equal(Object.hasOwn(held, 'record_digest'), false, 'blocked quality reuse cannot authorize the write-capable gate');
    assert.equal(fs.existsSync(f.recordPath), false, 'blocked quality reuse does not publish an approval record');
    assert.ok(contentReads.some(read => read.path === 'clouseau-review.json'));
    assert.ok(contentReads.some(read => read.path === 'src/upload.test.js' && read.ref === assessment.head_sha), 'immutable reviewed source is independently checked even while CI is blocked');
    await assert.rejects(policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath,
      assessment: held, nativeGate: true}), /independent CI acceptance remains blocked/);
    assert.equal(f.state.writes.filter(item => ['approve', 'atomic'].includes(item.name)).length, 0);
    assert.equal(providerCalls, 0);
  }
  const validSignature = bundle.signature;
  bundle.signature = `${validSignature[0] === 'a' ? 'b' : 'a'}${validSignature.slice(1)}`;
  assert.equal((await assess()).decision, 'review_incomplete', 'failed CI cannot conceal a bad signed review or cause paid fallback');
  bundle.signature = validSignature;
  const author = f.state.pr.user.login;
  f.state.pr.user.login = 'another-author';
  assert.equal((await assess()).decision, 'review_incomplete', 'failed CI cannot conceal a receipt from another author');
  f.state.pr.user.login = author;
  fs.writeFileSync(f.recordPath, approvedRecord);
  await assert.rejects(policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath,
    assessment, nativeGate: true}), /Verification changed/);
  assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 0);
  assert.equal(providerCalls, 0);
  f.state.failed = false;
  await policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment, nativeGate: true,
    wait: async () => {}});
  assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 1);
  assert.equal(providerCalls, 0);
  if (central === 'controls') {
    const owner = f.state.comments;
    f.state.comments = [];
    await assert.rejects(policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment}), /owner authorization changed/);
    const held = await assess();
    assert.equal(held.decision, 'review_incomplete', 'a signature cannot supply protected-control authority');
    f.state.comments = owner;
  }
  if (central === true) {
    const list = f.github.rest.pulls.listFiles;
    f.github.rest.pulls.listFiles = async (...args) => {
      const result = await list(...args);
      return {data: result.data.map(({patch, ...file}) => file)};
    };
    f.state.comments = [{id: 88, user: {login: 'gaulatti', type: 'User'}, body: `/approve-intent ${f.state.pr.head.sha}`}];
    assert.equal((await assess()).decision, 'review_incomplete', 'owner intent cannot waive incomplete GitHub patch evidence');
    f.state.comments = [];
    f.github.rest.pulls.listFiles = list;
  }
  if (central === true) {
    const newer = createPolicy(trusted, {engine: {...engine, sha: 'd'.repeat(40)}});
    const mismatch = await newer.assess({github: f.github, context: f.context, recordPath: f.recordPath,
      fetchImpl: async () => {providerCalls++; throw new Error('No paid mismatch fallback');}});
    assert.equal(mismatch.decision, 'review_incomplete');
    assert.equal(mismatch.provider_api_calls, 0);
    assert.equal(mismatch.review_source, 'authenticated_local_rejected');
    assert.match(mismatch.reason, /engine mismatch.*refresh.*fresh CI run.*No paid fallback/);
  }
  const compact = JSON.parse(fs.readFileSync(f.recordPath));
  assert.equal(compact.local_receipt_reference, true);
  assert.ok(!('snapshot' in compact) && !('result' in compact) && !('local_receipt' in compact), 'the signed record is not transported twice');
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(bundle)) / 2);
  const jobOutput = require('./record-transport.cjs');
  const carried = jobOutput.encode({assessment, record: compact, repair: null, context: f.context, runAttempt: '1'});
  assert.deepEqual(jobOutput.decode({assessment, payload: carried, context: f.context, runAttempt: '1'}).record, compact);
  const verifiedRecord = await policy.rehydrate(compact, assessment, {github: f.github, repo: f.context.repo});
  assert.equal(digest(verifiedRecord), assessment.record_digest, 'rehydration reproduces the assessed complete record');
  assert.equal(verifiedRecord.local_receipt.signature, bundle.signature);
  const bind = record => ({...assessment, record_reference_digest: digest(record)});
  const where = {github: f.github, repo: f.context.repo};
  for (const broken of [{...compact, snapshot: verifiedRecord.snapshot}, {...compact, local_receipt: bundle},
    {...compact, local_receipt_reference: 1}, {...compact, unexpected: true}, (({technical, ...rest}) => rest)(compact)]) {
    await assert.rejects(policy.rehydrate(broken, bind(broken), where), /Invalid compact local review record/);
    await assert.rejects(policy.rehydrate(broken, assessment, where), /Stale or altered/, 'an unbound shape is rejected first');
  }
  const unsigned = {...compact, local_artifact: 'not-a-sha'};
  await assert.rejects(policy.rehydrate(unsigned, bind(unsigned), where), /immutable receipt reference/);
  const forged = {...compact, previous: {...compact.previous, findings: [{id: 'substituted'}]}};
  await assert.rejects(policy.rehydrate(forged, bind(forged), where).then(record =>
    verifyRecord(record, assessment, trusted, engine)), /Stale or altered|substituted/);
  const { record_reference_digest, ...legacyAssessment } = assessment;
  assert.equal(await policy.rehydrate(verifiedRecord, legacyAssessment, where), verifiedRecord, 'complete legacy records remain accepted');
  await assert.rejects(policy.rehydrate(verifiedRecord, assessment, where), /Stale or altered/, 'a complete record cannot answer a compact assessment');
  const swapped = structuredClone(verifiedRecord); swapped.controls = true;
  assert.throws(() => verifyRecord(swapped, {...assessment, record_digest: digest(swapped)}, trusted, engine), /substituted/);
  const history = structuredClone(verifiedRecord); history.previous.findings.push({id: 'fake'});
  assert.throws(() => verifyRecord(history, {...assessment, record_digest: digest(history)}, trusted, engine), /history was substituted/);
  f.state.pr.user.login = 'another-author';
  await assert.rejects(policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment}), /author changed/);
  f.state.pr.user.login = 'contributor';
  const prior = {version: 2, repository: record.snapshot.repository, number: 3, head_sha: f.state.pr.head.sha,
    findings: [{id: 'a'.repeat(64), blocking: true, state: 'confirmed', title: 'Boundary failure',
      path: 'src/upload.test.js', cause: 'Lost input guard', obligation: 'Reject missing input'}]};
  f.state.comments = [{id: 9, user: {login: 'github-actions[bot]'},
    body: `<!-- clouseau-acceptance:v2 -->\n<!-- clouseau-state:${Buffer.from(JSON.stringify(prior)).toString('base64')} -->`}];
  assert.equal((await assess()).decision, 'review_incomplete');
  f.state.comments = [];
  bundle.payload.record.result.summary = 'tampered';
  assert.equal((await assess()).decision, 'review_incomplete');
  assert.equal(providerCalls, 0);
  f.state.pr.body = 'No receipt';
  assert.equal((await assess()).decision, 'review_incomplete');
  const optional = createPolicy({...trusted, local_review: {...trusted.local_review, mode: 'optional'}}, {engine});
  assert.equal((await optional.assess({github: f.github, context: f.context, recordPath: f.recordPath, receiptOnly: true})).decision,
    'review_incomplete');
  assert.equal(providerCalls, 0);
  await policy.finalize({github: f.github, context: f.context, core, assessment, mergePolls: 0});
  const saved = process.env.ASSESSMENT; process.env.ASSESSMENT = JSON.stringify(assessment);
  try {await policy.finalize({github: f.github, context: f.context, core, mergePolls: 0});}
  finally {if (saved === undefined) delete process.env.ASSESSMENT; else process.env.ASSESSMENT = saved;}
}));

test('authenticated accepted purpose reaches both independent investigations as literal citable evidence', () => fixture(async f => {
  const purpose = 'Preserve durable upload acceptance with meaningful production-path regression tests.';
  const comment = {id: 51, user: {login: 'gaulatti', type: 'User'},
    body: `/approve-intent ${f.state.pr.head.sha}\n\nAccepted purpose:\n${purpose}`};
  f.state.comments.push(comment);
  let investigations = 0;
  const assessment = await f.assess({fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); const packet = JSON.parse(body.messages[1].content);
    if (body.tools) {
      investigations++;
      const source = Object.values(packet.sources).find(item => item.path === 'pulls/3/intent/51');
      assert.equal(source.authority, 'trusted'); assert.equal(source.kind, 'contract');
      assert.match(source.numbered_lines, /approve-intent/);
      assert.equal(packet.intent_confirmation.accepted_purpose, purpose);
      assert.ok(source.numbered_lines.includes(purpose));
      assert.ok(packet.proofs.some(item => packet.sources[item.source].path === source.path));
    }
    return f.fetchImpl(url, options);
  }});
  assert.equal(assessment.decision, 'auto_approve');
  assert.equal(investigations, 2);
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  assert.equal(record.snapshot.intent_confirmation.actor, 'gaulatti');
  assert.equal(record.snapshot.intent_confirmation.head_sha, f.state.pr.head.sha);
  assert.equal(record.snapshot.claims.description, undefined, 'the PR description has not been promoted into the receipt');
  await f.gate(assessment);
  assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 1);
}));

test('deleted, altered or revoked purpose evidence holds approval before any publication write', async () => {
  for (const change of ['delete', 'edit', 'revoke', 'purpose']) await fixture(async f => {
    f.state.comments.push({id: 51, user: {login: 'gaulatti', type: 'User'},
      body: `/approve-intent ${f.state.pr.head.sha}\n\nAccepted purpose:\nPreserve durable upload acceptance.`});
    const assessment = await f.assess();
    if (change === 'delete') f.state.comments = [];
    if (change === 'edit') f.state.comments[0].body = 'Confirmation withdrawn.';
    if (change === 'purpose') f.state.comments[0].body += '\nIntroduce an unrelated capability.';
    if (change === 'revoke') f.github.rest.repos.getCollaboratorPermissionLevel = async () => ({data: {permission: 'read'}});
    await assert.rejects(f.gate(assessment), /purpose confirmation changed/);
    assert.equal(f.state.writes.length, 0);
  });
});

test('a citable owner purpose receipt cannot waive an integrity veto', async () => {
  for (const failure of ['integrity']) await fixture(async f => {
    f.state.comments.push({id: 51, user: {login: 'gaulatti', type: 'User'},
      body: `/approve-intent ${f.state.pr.head.sha}\n\nAccepted purpose:\nPreserve durable upload acceptance.`});
    if (failure === 'integrity') f.state.alter = report => {report.gates.find(item => item.name === 'test_integrity').state = 'violated';};
    const assessment = await f.assess({fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.tools || failure === 'integrity') return f.fetchImpl(url, options);
      const {questions} = JSON.parse(body.messages[1].content);
      return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers:
        Object.fromEntries(Object.keys(questions).map(id => [id,
          id.includes('_need_') || id.includes('_excess_') ? 'level0' : 'level4']))})}}]})};
    }});
    assert.equal(assessment.decision, 'blocked_integrity');
    assert.ok(JSON.parse(fs.readFileSync(f.recordPath)).snapshot.intent_confirmation);
    await assert.rejects(f.gate(assessment), /cannot waive/);
    assert.equal(f.state.writes.some(item => item.name === 'approve'), false);
  });
});

test('all evidence pages must publish before native approval, and a partial publication is safely resumed without new model calls', () => fixture(async f => {
  f.state.alter = report => {
    // Enough register rows that the rendered evidence needs more than one comment page.
    for (let i = 0; i < 1800; i++) report.evidence.push({...report.evidence[1], id: `repeat-${i}-${'r'.repeat(40)}`});
  };
  const assessment = await f.assess();
  assert.equal(assessment.decision, 'auto_approve');
  const originalRecord = fs.readFileSync(f.recordPath, 'utf8');
  const calls = f.state.calls;
  const create = f.github.rest.issues.createComment;
  let fail = true;
  f.github.rest.issues.createComment = async args => {
    if (fail && args.body.includes('### Acceptance evidence 2/')) throw new Error('GitHub publication interrupted');
    const response = await create(args);
    f.state.comments.push({id: response.data.id, user: {login: 'github-actions[bot]'}, body: args.body});
    return response;
  };
  await assert.rejects(f.gate(assessment), /publication interrupted/);
  assert.equal(f.state.writes.some(item => item.name === 'approve'), false);
  assert.equal(f.state.comments.some(item => item.body.includes('<!-- clouseau-acceptance:v2 -->')), false);
  fail = false;
  await f.gate(assessment);
  assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 1);
  assert.equal(f.state.writes.filter(item => item.name === 'update-ledger').length, 1, 'the first complete page is reused in place');
  const primary = f.state.comments.find(item => item.body.includes('<!-- clouseau-acceptance:v2 -->'));
  assert.match(primary.body, /Complete factor inputs and evidence citations: \[Evidence 1\//);
  for (const comment of f.state.comments) assert.ok(comment.body.length < 64000);
  assert.equal(fs.readFileSync(f.recordPath, 'utf8'), originalRecord);
  assert.equal(f.state.calls, calls, 'publishing or retrying publication never calls a model');
}));

test('a model failure or pending/failed verification cannot reach an approval or default to owner review', () => fixture(async f => {
  f.state.pending = true;
  assert.equal((await f.assess()).decision, 'pending_technical'); assert.equal(f.state.calls, 0);
  let waited = 0;
  await assert.rejects(f.policy.assessWhenReady({github: f.github, context: f.context, maxPolls: 1, wait: async () => waited++}), /deadline/);
  assert.equal(waited, 1);
  f.state.pending = false; f.state.failed = true;
  assert.equal((await f.assess()).decision, 'blocked_technical'); assert.equal(f.state.calls, 0);
  f.state.failed = false; f.state.pr.draft = true;
  assert.equal((await f.assess()).decision, 'not_ready');
  f.state.pr.draft = false;
  const logs = [];
  const incomplete = await f.assess({fetchImpl: async () => {throw new Error('provider offline');}, report: line => logs.push(line)});
  assert.equal(incomplete.decision, 'review_incomplete'); assert.match(logs[0], /provider offline/);
  await assert.rejects(f.gate(incomplete), /incomplete/);
  const quiet = await f.assess({fetchImpl: async () => {throw new Error('offline');}});
  assert.equal(quiet.decision, 'review_incomplete');
  const ready = await f.policy.assessWhenReady({github: f.github, context: f.context, recordPath: f.recordPath,
    fetchImpl: async () => {throw new Error('still offline');}});
  assert.equal(ready.decision, 'review_incomplete');
  assert.deepEqual(f.state.writes.map(item => item.name), ['create-ledger'], 'only the visible incomplete notice is written');
  assert.match(f.state.writes[0].args.body, /Clouseau review incomplete/);
  assert.equal(incomplete.cause, 'evidence_incomplete');
}));

test('a malformed provider key stops before any request and every incomplete outcome is announced on the PR without the secret', async () => {
  for (const [value, cause, problem] of [['sk-fictional-secret\n', 'provider_key_invalid', /contains whitespace/], ['', 'provider_key_missing', /not configured/]]) {
    await fixture(async f => {
      process.env.DEEPSEEK_API_KEY = value;
      const logs = [];
      const assessment = await f.assess({report: line => logs.push(line)});
      assert.equal(f.state.calls, 0, 'no provider request is made with a malformed credential');
      assert.equal(assessment.decision, 'review_incomplete'); assert.equal(assessment.cause, cause);
      assert.match(assessment.reason, /^DEEPSEEK_API_KEY /); assert.match(assessment.reason, problem);
      assert.ok(!JSON.stringify([assessment, logs]).includes('sk-fictional-secret'));
      const warnings = [];
      require('./incomplete.cjs').annotate({core: {warning: line => warnings.push(line)}, assessment});
      assert.match(warnings[0], new RegExp(cause));
      await assert.rejects(f.gate(assessment), /DEEPSEEK_API_KEY/);
      const [notice] = f.state.writes;
      assert.equal(f.state.writes.length, 1); assert.equal(notice.name, 'create-ledger');
      assert.match(notice.args.body, /Clouseau review incomplete/); assert.match(notice.args.body, /DEEPSEEK_API_KEY/);
      assert.match(notice.args.body, /Next step:/); assert.ok(!notice.args.body.includes('sk-fictional-secret'));
      f.state.comments.push({id: 55, user: {login: 'github-actions[bot]'}, body: notice.args.body});
      await assert.rejects(f.gate(assessment), /DEEPSEEK_API_KEY/);
      assert.equal(f.state.writes[1].name, 'update-ledger', 'a rerun updates the one notice');
      assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 0);
    });
  }
});

test('a provider that rejects the credential is reported as a specific cause, not a generic failure', () => fixture(async f => {
  const assessment = await f.assess({fetchImpl: async () => ({ok: false, status: 401})});
  assert.equal(assessment.cause, 'provider_rejected'); assert.match(assessment.reason, /rejected the credential \(HTTP 401\)/);
}));

test('a repository that requires local receipts announces the missing receipt on the PR', () => fixture(async f => {
  const assessment = await f.assess({receiptOnly: true});
  assert.equal(assessment.cause, 'local_receipt_required');
  await assert.rejects(f.gate(assessment), /authenticated local Clouseau review receipt/);
  assert.match(f.state.writes[0].args.body, /Run the local Clouseau review/);
}));

test('malformed provider JSON retains the exact undecodable response and cannot reach approval', () => fixture(async f => {
  const raw = '{"units":[';
  const assessment = await f.assess({fetchImpl: async () => ({ok: true, json: async () => ({choices:
    [{finish_reason: 'tool_calls', message: {tool_calls: [{function: {name: 'acceptance_report', arguments: raw}}]}}]})})});
  assert.equal(assessment.decision, 'review_incomplete');
  const trace = JSON.parse(fs.readFileSync(`${f.recordPath}.diagnostic.json`));
  assert.equal(trace.details.raw_response, raw); assert.equal(trace.details.canonical_response, raw);
  assert.equal(trace.details.model, 'deepseek-flash'); assert.equal(trace.details.usage.length, 1);
  await assert.rejects(f.gate(assessment), /incomplete/);
  assert.deepEqual(f.state.writes.map(item => item.name), ['create-ledger']);
}));

test('failure before source collection is retained without fabricating a snapshot', () => fixture(async f => {
  f.github.rest.repos.getContent = async () => {throw new Error('immutable source unavailable');};
  assert.equal((await f.assess()).decision, 'review_incomplete');
  const trace = JSON.parse(fs.readFileSync(`${f.recordPath}.diagnostic.json`));
  assert.equal(trace.failure, 'immutable source unavailable');
  assert.deepEqual(trace.snapshots, {});
  assert.equal(f.state.calls, 0);
  assert.equal(f.state.writes.length, 0);
}));

test('source records, scores, independent roles, base, policy and verification identity are revalidated before the write boundary', () => fixture(async f => {
  const assessment = await f.assess(); const record = JSON.parse(fs.readFileSync(f.recordPath));
  for (const mutate of [
    a => {a.version = 1;}, a => {a.record_digest = 'altered';}, a => {a.head_sha = 'c'.repeat(40);},
    a => {a.base_sha = 'd'.repeat(40);}, a => {a.number = 99;}, a => {a.decision = 'owner_decision';},
  ]) {
    const changed = structuredClone(assessment); mutate(changed);
    assert.throws(() => verifyRecord(structuredClone(record), changed, config));
  }
  for (const mutate of [
    r => {r.snapshot.config_digest = 'changed';}, r => {r.snapshot.policy_digest = 'changed';},
    r => {r.snapshot.claims.title = 'changed';}, r => {r.result.reviews.pop();},
    r => {r.result.reviews[1].role = 'examiner';},
  ]) {
    const changed = structuredClone(record); mutate(changed);
    assert.throws(() => verifyRecord(changed, {...assessment, record_digest: digest(changed)}, config));
  }
  const save = value => fs.writeFileSync(f.recordPath, JSON.stringify(value));
  const other = structuredClone(record); other.snapshot.repository = 'another/repo';
  const {refresh} = require('./acceptance-sources.cjs'); refresh(other.snapshot);
  for (const review of other.result.reviews) review.report.snapshot = other.snapshot.digest;
  save(other); await assert.rejects(f.gate({...assessment, record_digest: digest(other)}), /different repository/);
  save(record); f.state.pr.head.sha = 'e'.repeat(40);
  await assert.rejects(f.gate(assessment), /PR changed/);
  f.state.pr.head.sha = assessment.head_sha; f.state.failed = true;
  await assert.rejects(f.gate(assessment), /Verification changed/);
  assert.equal(f.state.writes.length, 0);
}));

test('technical or integrity defects cannot be waived by an owner comment and an existing ledger is updated in place', () => fixture(async f => {
  f.state.pr.auto_merge = null;
  f.state.alter = report => {report.gates.find(gate => gate.name === 'test_integrity').state = 'violated';};
  const assessment = await f.assess();
  assert.equal(assessment.decision, 'blocked_integrity');
  assert.ok(assessment.repair_digest); assert.ok(fs.existsSync(`${f.recordPath}.repair.json`));
  f.state.comments.push({id: 5, user: {login: 'owner', type: 'User'}, body: `/approve-intent ${assessment.head_sha}`});
  await assert.rejects(f.gate(assessment), /cannot waive/);
  assert.ok(f.state.pr.auto_merge); assert.ok(f.state.writes.some(item => item.name === 'enable-auto'));
  assert.equal(f.state.writes.some(item => item.name === 'approve'), false);
  const ledger = f.state.writes.find(item => item.name === 'create-ledger');
  f.state.comments.push({id: 6, user: {login: 'github-actions[bot]', type: 'Bot'}, body: ledger.args.body});
  const next = await f.assess(); await assert.rejects(f.gate(next), /cannot waive/);
  assert.equal(f.state.writes.filter(item => item.name === 'update-ledger').length, 1);
  const old = JSON.parse(fs.readFileSync(f.recordPath));
  const currentBody = f.state.writes.find(item => item.name === 'update-ledger').args.body;
  f.state.comments.push({id: 7, user: {login: 'github-actions[bot]'}, body: currentBody});
  await assert.rejects(f.gate({...next, record_digest: digest(old)}), /history changed/);
}));

test('protected control installation uses exact-revision owner authority without waiving the scored technical review', () => fixture(async f => {
  const filename = '.github/clouseau.json';
  f.github.rest.pulls.listFiles = async () => ({data: [{filename, status: 'modified', patch: '+protected control'}]});
  const content = f.github.rest.repos.getContent;
  f.github.rest.repos.getContent = args => content({...args, path: args.path === filename ? 'src/upload.test.js' : args.path});
  const assessment = await f.assess();
  assert.equal(assessment.decision, 'owner_decision'); assert.match(assessment.reason, /Review controls/);
  f.state.comments.push({id: 1, user: {login: 'owner', type: 'User'}, body: `/approve-intent ${assessment.head_sha}`});
  const old = process.env.ASSESSMENT; process.env.ASSESSMENT = JSON.stringify(assessment);
  try {await f.gate(undefined);} finally {if (old === undefined) delete process.env.ASSESSMENT; else process.env.ASSESSMENT = old;}
  assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 1);
}));

test('an unresolved prior causal blocker survives a new positive report and invalidates merge eligibility', () => fixture(async f => {
  const {MARKER} = require('./acceptance-ledger.cjs');
  const state = {version: 2, repository: `${f.context.repo.owner}/${f.context.repo.repo}`, number: 3, head_sha: f.state.pr.head.sha,
    findings: [{id: 'f'.repeat(64), title: 'Missing persistence', path: 'src/upload.test.js', cause: 'Acceptance precedes storage.',
      obligation: 'Durability before acknowledgment.', blocking: true, state: 'confirmed'}]};
  f.state.comments.push({id: 1, user: {login: 'github-actions[bot]'}, body: `${MARKER}\n<!-- clouseau-state:${Buffer.from(JSON.stringify(state)).toString('base64')} -->`});
  const assessment = await f.assess(); assert.equal(assessment.decision, 'review_incomplete');
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  assert.equal(verifyRecord(record, assessment, config).state.unresolved.length, 1);
  await assert.rejects(f.gate(assessment), /cannot waive/);
  f.state.alter = report => {report.gates.find(gate => gate.name === 'test_integrity').state = 'violated';};
  const integrity = await f.assess(); assert.equal(integrity.decision, 'blocked_integrity');
  assert.equal(verifyRecord(JSON.parse(fs.readFileSync(f.recordPath)), integrity, config).state.unresolved.length, 1);
}));

test('the production polling clock remains bounded while waiting for real verification', () => fixture(async f => {
  f.state.pending = true;
  const original = global.setTimeout; const times = [];
  global.setTimeout = (callback, milliseconds) => {times.push(milliseconds); callback();};
  try {
    await assert.rejects(f.policy.assessWhenReady({github: f.github, context: f.context, maxPolls: 1}), /deadline/);
  } finally {global.setTimeout = original;}
  assert.deepEqual(times, [15000]);
}));

test('failed repair generation retains the blocking review and an inspectable cause without spending author authority', () => fixture(async f => {
  f.state.alter = report => {report.gates.find(gate => gate.name === 'test_integrity').state = 'violated';};
  const assessment = await f.assess({fetchImpl: async (url, options) => {
    if (JSON.parse(options.body).tools?.[0].function.name === 'repair_proposal') throw new Error('repair provider offline');
    return f.fetchImpl(url, options);
  }});
  assert.equal(assessment.decision, 'blocked_integrity'); assert.equal(assessment.repair_digest, undefined);
  assert.match(JSON.parse(fs.readFileSync(`${f.recordPath}.diagnostic.json`)).repair_unavailable, /repair provider offline/);
  assert.equal(f.state.writes.length, 0);
}));

test('ordinary CI AI assessment and approval bind the frozen engine without a local receipt', () => fixture(async f => {
  const engine = {...require('./central-version.cjs').SOURCE, sha: 'e'.repeat(40), digest: require('./local-version.cjs').engineDigest()};
  const policy = createPolicy(config, {engine});
  const assessment = await policy.assess({github: f.github, context: f.context, fetchImpl: f.fetchImpl, recordPath: f.recordPath});
  assert.equal(assessment.decision, 'auto_approve');
  assert.deepEqual(assessment.engine, engine);
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  assert.deepEqual(record.engine, engine);
  assert.ok(f.state.calls > 0);
  verifyRecord(record, assessment, config, engine);
  const substituted = {...engine, sha: 'f'.repeat(40)};
  await assert.rejects(createPolicy(config, {engine: substituted}).gate({github: f.github, context: f.context,
    recordPath: f.recordPath, assessment, core: {info() {}}}), /different frozen engine/);
}));

test('a green AI-approved external PR is approved but never armed for merge and waits for a current code owner', () => fixture(async f => {
  f.state.pr.user = {login: 'external', type: 'User'};
  const assessment = await f.assess();
  assert.equal(assessment.decision, 'auto_approve');
  await assert.rejects(f.gate(assessment), /code-owner approval/);
  assert.equal(f.state.writes.some(item => item.name === 'approve'), true);
  assert.equal(f.state.writes.some(item => item.name === 'enable-auto'), false);
  assert.equal(f.state.writes.some(item => item.name === 'disable-auto'), true);
  assert.equal(f.state.pr.auto_merge, null);
}));

test('a fresh code-owner review permits manual merge of an external contribution without enabling auto-merge', () => fixture(async f => {
  f.state.pr.user = {login: 'external', type: 'User'};
  f.state.pr.auto_merge = null;
  f.state.reviews = [{user: {login: 'contributor', type: 'User'}, state: 'APPROVED', commit_id: f.state.pr.head.sha}];
  const assessment = await f.assess();
  await f.gate(assessment);
  assert.equal(f.state.writes.some(item => item.name === 'approve'), true);
  assert.equal(f.state.writes.some(item => item.name === 'enable-auto'), false);
  assert.equal(f.state.pr.auto_merge, null);
  await f.policy.finalize({github: f.github, context: f.context, core: {info() {}}, assessment});
  assert.equal(f.state.writes.some(item => item.name === 'enable-auto'), false);
}));


test('revoked author ownership at the final write boundary cannot release an automatic merge', () => fixture(async f => {
  const assessment = await f.assess();
  let permissions = 0;
  f.github.rest.repos.getCollaboratorPermissionLevel = async () => ({data: {permission: ++permissions === 1 ? 'write' : 'read'}});
  await assert.rejects(f.gate(assessment), /ownership changed/);
}));

test('non-native checks also hold an external PR and finalization rechecks owner authorship', () => fixture(async f => {
  const assessment = await f.assess();
  f.state.pr.user = {login: 'external', type: 'User'};
  const request = f.github.request;
  f.github.request = async (...args) => {
    const value = await request(...args);
    value.data.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks.push({context: 'approval-policy', integration_id: 15368});
    return value;
  };
  f.github.rest.checks = {create: async () => ({data: {id: 1}}), update: async () => ({data: {}})};
  const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
  await f.policy.gate({github: f.github, context: f.context, core, assessment, recordPath: f.recordPath, nativeGate: false, wait: async () => {}});
  assert.equal(f.state.pr.auto_merge, null);
  f.state.pr.user.login = 'contributor';
  await f.policy.finalize({github: f.github, context: f.context, core, assessment, mergePolls: 0, files: [{filename: 'src/upload.test.js'}]});
  await f.policy.finalize({github: f.github, context: f.context, core, assessment, mergePolls: 0, pr: {...f.state.pr, merged: true}, files: []});
}));

async function privateOwnerFixture(f, controls = false) {
  if (controls) {
    const filename = '.github/clouseau.json';
    f.github.rest.pulls.listFiles = async () => ({data: [{filename, status: 'modified', patch: '+protected control'}]});
    const content = f.github.rest.repos.getContent;
    f.github.rest.repos.getContent = args => content({...args, path: args.path === filename ? 'src/upload.test.js' : args.path});
  }
  const policy = createPolicy({...config, merge_mode: 'automatic'});
  const assessment = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
  f.state.pr.auto_merge = null;
  f.state.pr.head.repo.node_id = 'R_private'; f.state.pr.base.repo = {node_id: 'R_private'};
  f.github.rest.repos.get = async () => ({data: {private: true, allow_auto_merge: false, node_id: 'R_private'}});
  f.github.rest.repos.getBranch = async () => ({data: {protected: false,
    commit: {sha: f.state.pr.merged ? assessment.head_sha : assessment.base_sha}}});
  f.github.rest.repos.compareCommits = async () => ({data: {status: 'ahead', merge_base_commit: {sha: assessment.base_sha}}});
  f.github.request = async () => {throw Object.assign(new Error('Upgrade to GitHub Pro or make this repository public to enable this feature.'), {status: 403});};
  f.github.rest.pulls.createReview = async args => {f.state.writes.push({name: 'approve', args});
    f.state.reviews.push({user: {login: 'github-actions[bot]', type: 'Bot'}, state: 'APPROVED', commit_id: args.commit_id}); return {data: {}};};
  f.github.rest.checks = {create: async () => ({data: {id: 71}}), update: async () => ({data: {}})};
  f.github.rest.actions.createWorkflowDispatch = async args => {f.state.writes.push({name: 'dispatch', args}); return {data: {}};};
  const graphql = f.github.graphql;
  f.github.graphql = async (query, args) => {
    if (!query.includes('updateRefs')) return graphql(query, args);
    f.state.writes.push({name: 'atomic', args});
    f.state.pr.merged = true; f.state.pr.state = 'closed'; f.state.pr.merge_commit_sha = assessment.head_sha;
    return {updateRefs: {clientMutationId: null}};
  };
  const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
  return {policy, assessment, core, run: nativeGate => policy.gate({github: f.github, context: f.context,
    core, recordPath: f.recordPath, assessment, nativeGate, wait: async () => {}})};
}

test('explicit private owner automation merges only after recomputed acceptance, all technical steps and fresh bot approval', async () => {
  for (const native of [true, false]) await fixture(async f => {
    const p = await privateOwnerFixture(f);
    await p.run(native);
    assert.deepEqual(f.state.writes.filter(w => ['approve', 'atomic', 'enable-auto'].includes(w.name)).map(w => w.name), ['approve', 'atomic']);
    assert.equal(f.state.pr.merge_commit_sha, p.assessment.head_sha);
    await p.policy.finalize({github: f.github, context: f.context, core: p.core, assessment: p.assessment});
    assert.equal(f.state.writes.filter(w => w.name === 'atomic').length, 1);
  });
});

test('failed complete verification, coverage, altered acceptance, missing owners and outsiders cannot use private owner automation', async () => {
  for (const failure of ['tests', 'coverage', 'acceptance', 'missing-owner', 'outsider', 'withdrawn-tests', 'changed-mode']) await fixture(async f => {
    const p = await privateOwnerFixture(f);
    if (failure === 'tests') f.state.failed = true;
    if (failure === 'coverage') {
      const jobs = f.github.rest.actions.listJobsForWorkflowRun;
      f.github.rest.actions.listJobsForWorkflowRun = async args => {const value = await jobs(args);
        value.data[0].steps.find(step => step.name === 'Enforce 100% line and branch coverage').conclusion = 'failure'; return value;};
    }
    if (failure === 'acceptance') {const value = JSON.parse(fs.readFileSync(f.recordPath)); value.result.decision = 'repair_required'; fs.writeFileSync(f.recordPath, JSON.stringify(value));}
    if (failure === 'missing-owner') {
      const content = f.github.rest.repos.getContent;
      f.github.rest.repos.getContent = async args => {if (['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].includes(args.path)) throw Object.assign(new Error('Absent'), {status: 404}); return content(args);};
    }
    if (failure === 'outsider') f.github.rest.repos.getCollaboratorPermissionLevel = async () => ({data: {permission: 'read'}});
    if (failure === 'withdrawn-tests') {
      const approval = f.github.rest.pulls.createReview;
      f.github.rest.pulls.createReview = async args => {const result = await approval(args); f.state.failed = true; return result;};
    }
    if (failure === 'changed-mode') {let calls = 0; f.github.rest.repos.get = async () => ({data: {private: true, allow_auto_merge: ++calls > 1, node_id: 'R_private'}});}
    await assert.rejects(p.run(true));
    assert.equal(f.state.writes.filter(w => ['atomic', 'enable-auto'].includes(w.name)).length, 0, failure);
    assert.equal(f.state.pr.merged, undefined, failure);
  });
});

test('private automatic finalization cannot authorize an unmerged candidate outside the validated acceptance gate', () => fixture(async f => {
  const p = await privateOwnerFixture(f);
  await assert.rejects(p.policy.finalize({github: f.github, context: f.context, core: p.core, assessment: p.assessment}), /validated acceptance gate/);
  assert.equal(f.state.writes.filter(w => w.name === 'atomic').length, 0);
}));

test('explicit automatic mode requires configured ownership on the normal protected native path too', () => fixture(async f => {
  const policy = createPolicy({...config, merge_mode: 'automatic'});
  const assessment = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
  const content = f.github.rest.repos.getContent;
  f.github.rest.repos.getContent = async args => {if (['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].includes(args.path)) throw Object.assign(new Error('Absent'), {status: 404}); return content(args);};
  const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
  await assert.rejects(policy.gate({github: f.github, context: f.context, core, assessment, recordPath: f.recordPath, nativeGate: true}), /code-owner approval/);
  await policy.finalize({github: f.github, context: f.context, core, assessment});
  assert.equal(f.state.writes.filter(w => w.name === 'enable-auto').length, 0);
}));


test('private controller control changes retain exact-head purpose authority through the final write', async () => {
  for (const withdraw of [false, true]) await fixture(async f => {
    const p = await privateOwnerFixture(f, true);
    assert.equal(p.assessment.decision, 'owner_decision');
    f.state.comments.push({id: 1, user: {login: 'owner', type: 'User'}, body: `/approve-intent ${p.assessment.head_sha}`});
    if (withdraw) {
      const approve = f.github.rest.pulls.createReview;
      f.github.rest.pulls.createReview = async args => {const value = await approve(args); f.state.comments = []; return value;};
      await assert.rejects(p.run(true), /confirmation was withdrawn/);
    } else await p.run(true);
    assert.equal(f.state.writes.filter(w => w.name === 'atomic').length, withdraw ? 0 : 1);
  });
});

test('explicit automatic mode keeps verified owner work on the protected native path', () => fixture(async f => {
  const policy = createPolicy({...config, merge_mode: 'automatic'});
  const assessment = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
  const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
  await policy.gate({github: f.github, context: f.context, core, assessment, recordPath: f.recordPath, nativeGate: true});
  assert.equal(f.state.writes.filter(w => w.name === 'approve').length, 1);
  assert.equal(f.state.writes.filter(w => w.name === 'atomic').length, 0);
}));

test('a private-plan transition to available native protection stops the old acceptance path before writing', async () => {
  for (const transition of [2, 4]) await fixture(async f => {
    const nativeRules = f.github.request;
    const p = await privateOwnerFixture(f);
    let reads = 0;
    f.github.rest.repos.get = async () => ({data: {private: true, allow_auto_merge: ++reads >= transition, node_id: 'R_private'}});
    f.github.rest.repos.getBranch = async () => ({data: {protected: reads >= transition, commit: {sha: p.assessment.base_sha}}});
    f.github.request = async (...args) => {
      if (reads >= transition) return nativeRules(...args);
      throw Object.assign(new Error('Upgrade to GitHub Pro or make this repository public to enable this feature.'), {status: 403});
    };
    await assert.rejects(p.run(true), /acceptance mode changed/);
    assert.equal(f.state.writes.filter(w => w.name === 'atomic').length, 0);
  });
});

test('same-head purpose edits and removals invalidate private merge even when another maintainer approval remains', async () => {
  for (const change of ['edit', 'remove']) await fixture(async f => {
    const confirmation = {id: 71, user: {login: config.manual_reviewer, type: 'User'},
      body: `/approve-intent ${f.state.pr.head.sha}\n\nAccepted purpose:\nPreserve the supported private owner acceptance boundary.`};
    f.state.comments.push(confirmation);
    const p = await privateOwnerFixture(f, true);
    const approve = f.github.rest.pulls.createReview;
    f.github.rest.pulls.createReview = async args => {
      const value = await approve(args);
      f.state.reviews.push({user: {login: 'other-maintainer', type: 'User'}, state: 'APPROVED', commit_id: args.commit_id});
      if (change === 'edit') confirmation.body += ' New purpose after assessment.';
      else f.state.comments = [];
      return value;
    };
    await assert.rejects(p.run(true), /Exact recorded purpose authorization changed/);
    assert.equal(f.state.writes.filter(w => w.name === 'atomic').length, 0);
  });
});

async function privateReceiptFixture(f, controls = false, localTechnical = null) {
  const p = await privateOwnerFixture(f);
  const crypto = require('node:crypto');
  const receipts = require('./local-receipt.cjs');
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  const keys = crypto.generateKeyPairSync('ed25519');
  const trusted = {...config, merge_mode: 'automatic', local_review: {mode: 'required',
    reviewer_sha: 'e'.repeat(40), central_source: {...require('./central-version.cjs').SOURCE}, max_age_seconds: 172800,
    keys: [{id: 'fixture', issuer: 'fixture-runner', github_actor: 'contributor', revoked: false,
      public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}]}};
  if (controls) trusted.sensitive_paths = [...trusted.sensitive_paths, 'src/upload.test.js'];
  const engine = {...require('./central-version.cjs').SOURCE, sha: trusted.local_review.reviewer_sha,
    digest: require('./local-version.cjs').engineDigest()};
  record.snapshot.number = 0; record.snapshot.config_digest = digest(trusted);
  require('./acceptance-sources.cjs').refresh(record.snapshot);
  record.result.snapshot = record.snapshot.digest; record.result.config_digest = record.snapshot.config_digest;
  record.result.usage = ['examiner', 'challenger'].flatMap(role => ['investigation', 'grading'].map(phase =>
    ({role, phase, harness: 'codex', session: `fictional-private-${role}-${phase}`, request_digest: digest(role),
      response_digest: digest(phase), transport_digest: digest({fixture_only: true})})));
  record.result.execution_digest = digest(record.result.usage);
  for (const item of record.result.reviews) item.report.snapshot = record.snapshot.digest;
  if (localTechnical) {
    record.technical = localTechnical;
    record.snapshot.sources.verification.content = JSON.stringify(localTechnical);
    require('./acceptance-sources.cjs').refresh(record.snapshot);
    const local = await require('../test/local-review-fixture.cjs').fixture();
    local.snapshot = record.snapshot;
    record.result = await require('./local-review.cjs').localReview({snapshot: local.snapshot, ask: local.ask});
  }
  const bundle = receipts.issueReceipt({record, privateKey: keys.privateKey.export({type: 'pkcs8', format: 'pem'}),
    keyId: 'fixture', issuer: 'fixture-runner', reviewerSha: trusted.local_review.reviewer_sha});
  const content = f.github.rest.repos.getContent;
  f.github.rest.repos.getContent = async args => args.path === 'clouseau-review.json' ? {data: {
    encoding: 'base64', content: Buffer.from(JSON.stringify(bundle)).toString('base64'), size: JSON.stringify(bundle).length,
  }} : content(args);
  f.state.pr.body = `<!-- clouseau-local-review:v1 ${'f'.repeat(40)} -->`;
  if (controls) f.state.comments.push({id: 87, user: {login: config.manual_reviewer, type: 'User'}, body: `/approve-intent ${f.state.pr.head.sha}`});
  const policy = createPolicy(trusted, {engine}); let providerCalls = 0;
  const assessment = await policy.assess({github: f.github, context: f.context, recordPath: f.recordPath,
    fetchImpl: async () => {providerCalls++; throw new Error('No paid local receipt fallback');}});
  assert.equal(assessment.decision, controls ? 'owner_decision' : 'auto_approve', assessment.reason);
  assert.equal(providerCalls, 0);
  return {...p, trusted, engine, assessment, policy, bundle, run: () => policy.gate({github: f.github,
    context: f.context, core: p.core, assessment, recordPath: f.recordPath, nativeGate: true})};
}

test('signed local quality with incomplete coverage is reused on red CI without approving or hiding invalid evidence', async () => {
  await fixture(async f => {
    const localTechnical = {commands: [{argv: ['npm', 'run', 'test:coverage'], exit_code: 1,
      stdout_digest: digest('fixture suite passed; exact coverage threshold failed'), stderr_digest: digest('')}],
    exact_coverage: {lines: [20, 19], branches: [8, 6]}, coverage_status: 'incomplete'};
    const p = await privateReceiptFixture(f, false, localTechnical);
    assert.deepEqual(p.bundle.payload.record.technical, localTechnical);
    const current = JSON.parse(fs.readFileSync(f.recordPath));
    assert.equal(current.local_receipt_reference, true);
    assert.equal(current.local_receipt, undefined);
    assert.equal(current.technical.pending, undefined, 'green acceptance uses independent CI instead of claiming local coverage passed');
    fs.rmSync(f.recordPath);
    f.state.failed = true;
    let providerCalls = 0;
    const assess = (policy = p.policy) => policy.assess({github: f.github, context: f.context, recordPath: f.recordPath,
      fetchImpl: async () => {providerCalls++; throw new Error('No paid fallback from signed quality evidence');}});
    const held = await assess();
    assert.equal(held.decision, 'blocked_technical');
    assert.equal(held.review_source, 'authenticated_local');
    assert.equal(held.provider_api_calls, 0);
    assert.equal(Object.hasOwn(held, 'record_digest'), false);
    assert.equal(fs.existsSync(f.recordPath), false);
    const signature = p.bundle.signature;
    p.bundle.signature = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    assert.equal((await assess()).decision, 'review_incomplete');
    p.bundle.signature = signature;
    const revoked = structuredClone(p.trusted); revoked.local_review.keys[0].revoked = true;
    assert.equal((await assess(createPolicy(revoked, {engine: p.engine}))).decision, 'review_incomplete');
    const head = f.state.pr.head.sha;
    f.state.pr.head.sha = (head[0] === 'd' ? 'c' : 'd').repeat(40);
    assert.equal((await assess()).decision, 'review_incomplete');
    f.state.pr.head.sha = head;
    const content = f.github.rest.repos.getContent;
    f.github.rest.repos.getContent = args => args.path === 'src/upload.test.js' && args.ref === head ? Promise.resolve({data: {
      encoding: 'base64', content: Buffer.from('substituted immutable source').toString('base64'), size: 29}}) : content(args);
    assert.equal((await assess()).decision, 'review_incomplete');
    f.github.rest.repos.getContent = content;
    assert.equal(providerCalls, 0);
    assert.equal(f.state.writes.filter(item => ['approve', 'atomic', 'enable-auto'].includes(item.name)).length, 0);
  });
});

test('private signed receipt reuse is revalidated immediately before merge with zero CI AI calls', async () => {
  for (const controls of [false, true]) await fixture(async f => {
    const p = await privateReceiptFixture(f, controls);
    await p.run();
    assert.equal(f.state.writes.filter(w => w.name === 'atomic').length, 1);
  });
});

test('expired, revoked, wrong-engine or changed immutable source receipts never release a private owner merge', async t => {
  for (const failure of ['expired', 'revoked', 'engine', 'source']) await fixture(async f => {
    const p = await privateReceiptFixture(f);
    if (failure === 'revoked') {
      const revoked = structuredClone(p.trusted); revoked.local_review.keys[0].revoked = true;
      const policy = createPolicy(revoked, {engine: p.engine});
      await assert.rejects(policy.gate({github: f.github, context: f.context, core: p.core,
        assessment: p.assessment, recordPath: f.recordPath, nativeGate: true}), /signature/);
    } else if (failure === 'engine') {
      const policy = createPolicy(p.trusted, {engine: {...p.engine, sha: 'd'.repeat(40)}});
      await assert.rejects(policy.gate({github: f.github, context: f.context, core: p.core,
        assessment: p.assessment, recordPath: f.recordPath, nativeGate: true}), /frozen engine/);
    } else {
      const approve = f.github.rest.pulls.createReview;
      f.github.rest.pulls.createReview = async args => {
        const value = await approve(args);
        if (failure === 'expired') {const expired = Date.now() + 172800001; t.mock.method(Date, 'now', () => expired);}
        else {
          const content = f.github.rest.repos.getContent;
          f.github.rest.repos.getContent = async args => {
            const value = await content(args);
            if (args.path === 'src/upload.test.js') value.data.content = Buffer.from('changed immutable evidence').toString('base64');
            return value;
          };
        }
        return value;
      };
      await assert.rejects(p.run(), failure === 'expired' ? /expired/ : /signed evidence differs/);
      t.mock.restoreAll();
    }
    assert.equal(f.state.writes.filter(w => w.name === 'atomic').length, 0, failure);
  });
});


test('a receipt author, purpose, finding ledger or record changing after bot approval cannot reach the private merge write', async () => {
  for (const failure of ['author', 'head', 'base', 'purpose', 'findings', 'record']) await fixture(async f => {
    const p = await privateReceiptFixture(f, failure === 'purpose');
    const approve = f.github.rest.pulls.createReview;
    f.github.rest.pulls.createReview = async args => {
      const value = await approve(args);
      if (failure === 'author') f.state.pr.user.login = 'different-author';
      if (failure === 'head') f.state.pr.head.sha = 'd'.repeat(40);
      if (failure === 'base') f.state.pr.base.sha = 'd'.repeat(40);
      if (failure === 'purpose') f.state.comments[0].body += '\nChanged purpose';
      if (failure === 'record') {
        const record = JSON.parse(fs.readFileSync(f.recordPath)); record.snapshot.head_sha = 'd'.repeat(40);
        fs.writeFileSync(f.recordPath, JSON.stringify(record));
      }
      if (failure === 'findings') {
        const state = {version: 2, repository: `${f.context.repo.owner}/${f.context.repo.repo}`, number: 3,
          head_sha: p.assessment.head_sha, findings: [{id: 'f'.repeat(64), blocking: true, state: 'confirmed',
            title: 'New acceptance blocker', path: 'src/upload.test.js', cause: 'Persistence missing', obligation: 'Durable acceptance'}]};
        f.state.comments.push({id: 999, user: {login: 'github-actions[bot]', type: 'Bot'},
          body: `<!-- clouseau-acceptance:v2 -->\n<!-- clouseau-state:${Buffer.from(JSON.stringify(state)).toString('base64')} -->`});
      }
      return value;
    };
    await assert.rejects(p.run());
    assert.equal(f.state.writes.filter(w => w.name === 'atomic').length, 0, failure);
  });
});

test('an acceptance review waiting on queued verification ends pending instead of holding a single-slot runner', () => fixture(async f => {
  const list = f.github.rest.actions.listWorkflowRuns;
  f.github.rest.actions.listWorkflowRuns = async args => {
    const result = await list(args); result.data.workflow_runs[0].status = 'queued'; return result;
  };
  let waits = 0;
  const held = await f.policy.assessWhenReady({github: f.github, context: f.context, recordPath: f.recordPath,
    queuedGraceSeconds: 45, wait: async () => waits++});
  assert.equal(held.decision, 'pending_technical'); assert.equal(held.verification, 'queued');
  assert.match(held.reason, /without holding a runner.*reassessed automatically/s);
  assert.ok(!held.record_digest);
  assert.equal(waits, 3);
  assert.equal(f.state.calls, 0);
  const pending = await f.assess();
  assert.equal(pending.decision, 'pending_technical'); assert.equal(pending.verification, 'queued');
  assert.equal(f.state.calls, 0);
}));

test('a rerun that produced no acceptance record fails with its own reason and recovery, not a missing protocol-two record', async () => {
  for (const [pending, reason] of [[true, /Waiting for all tests/], [false, /PR verification concluded failure/]]) await fixture(async f => {
    const p = await privateOwnerFixture(f);
    f.state.pending = pending; f.state.failed = !pending;
    const held = await p.policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: f.fetchImpl});
    assert.ok(!held.record_digest);
    await assert.rejects(p.policy.gate({github: f.github, context: f.context, core: p.core, recordPath: f.recordPath,
      assessment: held, nativeGate: true, wait: async () => {}}),
    error => reason.test(error.message) && /produced no acceptance record/.test(error.message) &&
      /reassessed automatically when PR verification completes.*push a new head/s.test(error.message) && !/protocol-two/.test(error.message));
    assert.ok(!f.state.writes.some(write => ['approve', 'atomic'].includes(write.name)));
  });
});
