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
  assert.equal(assessment.decision, 'auto_approve'); assert.equal(f.state.calls, 4);
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

test('authenticated local receipt reaches native approval with zero CI AI calls and rejects altered or absent receipts', () => fixture(async f => {
  const crypto = require('node:crypto');
  const {issueReceipt} = require('./local-receipt.cjs');
  const {refresh} = require('./acceptance-sources.cjs');
  const seed = await f.assess();
  const record = JSON.parse(fs.readFileSync(f.recordPath));
  const keys = crypto.generateKeyPairSync('ed25519');
  const trusted = {...config, local_review: {mode: 'required', reviewer_sha: 'e'.repeat(40),
    reviewer_digest: require('./local-version.cjs').engineDigest(), max_age_seconds: 3600,
    keys: [{id: 'fixture', issuer: 'fixture-runner', github_actor: 'contributor', revoked: false,
      public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}]}};
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
  f.github.rest.repos.getContent = async args => args.path === 'clouseau-review.json' ? {data: {
    encoding: 'base64', content: Buffer.from(JSON.stringify(bundle)).toString('base64'), size: JSON.stringify(bundle).length,
  }} : original(args);
  const policy = createPolicy(trusted);
  f.state.pr.body = `Ready change.\n<!-- clouseau-local-review:v1 ${'f'.repeat(40)} -->`;
  let providerCalls = 0;
  const reports = [];
  const assess = () => policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, report: line => reports.push(line),
    fetchImpl: async () => {providerCalls++; throw new Error('CI AI must not be called');}});
  const assessment = await assess();
  assert.equal(seed.decision, 'auto_approve');
  assert.equal(assessment.decision, 'auto_approve', assessment.reason);
  assert.ok(reports.some(line => line.includes('CI AI calls: 0')));
  assert.equal(providerCalls, 0);
  const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
  f.state.pending = true;
  assert.equal((await assess()).decision, 'pending_technical', 'a valid local receipt cannot replace pending CI');
  f.state.pending = false; f.state.failed = true;
  assert.equal((await assess()).decision, 'blocked_technical', 'a valid local receipt cannot replace failed CI');
  await assert.rejects(policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath,
    assessment, nativeGate: true}), /Verification changed/);
  assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 0);
  assert.equal(providerCalls, 0);
  f.state.failed = false;
  await policy.gate({github: f.github, context: f.context, core, recordPath: f.recordPath, assessment, nativeGate: true,
    wait: async () => {}});
  assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 1);
  assert.equal(providerCalls, 0);
  const verifiedRecord = JSON.parse(fs.readFileSync(f.recordPath));
  const swapped = structuredClone(verifiedRecord); swapped.controls = true;
  assert.throws(() => verifyRecord(swapped, {...assessment, record_digest: digest(swapped)}, trusted), /substituted/);
  const history = structuredClone(verifiedRecord); history.previous.findings.push({id: 'fake'});
  assert.throws(() => verifyRecord(history, {...assessment, record_digest: digest(history)}, trusted), /history was substituted/);
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
  const optional = createPolicy({...trusted, local_review: {...trusted.local_review, mode: 'optional'}});
  assert.equal((await optional.assess({github: f.github, context: f.context, recordPath: f.recordPath, receiptOnly: true})).decision,
    'review_incomplete');
  assert.equal(providerCalls, 0);
}));

test('authenticated accepted purpose reaches both independent investigations and atomic grading as literal citable evidence', () => fixture(async f => {
  const purpose = 'Preserve durable upload acceptance with meaningful production-path regression tests.';
  const comment = {id: 51, user: {login: 'gaulatti', type: 'User'},
    body: `/approve-intent ${f.state.pr.head.sha}\n\nAccepted purpose:\n${purpose}`};
  f.state.comments.push(comment);
  let investigations = 0; let graders = 0;
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
    } else {
      graders++;
      const contract = packet.state.accepted_contract.find(item => item.path === 'pulls/3/intent/51');
      assert.equal(JSON.parse(contract.content).body, comment.body);
      assert.equal(JSON.parse(contract.content).accepted_purpose, purpose);
    }
    return f.fetchImpl(url, options);
  }});
  assert.equal(assessment.decision, 'auto_approve');
  assert.equal(investigations, 2); assert.equal(graders, 2);
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

test('a citable owner purpose receipt cannot waive low product scores or an integrity veto', async () => {
  for (const failure of ['need', 'integrity']) await fixture(async f => {
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
    assert.equal(assessment.decision, failure === 'need' ? 'repair_required' : 'blocked_integrity');
    assert.ok(JSON.parse(fs.readFileSync(f.recordPath)).snapshot.intent_confirmation);
    await assert.rejects(f.gate(assessment), /cannot waive/);
    assert.equal(f.state.writes.some(item => item.name === 'approve'), false);
  });
});

test('all evidence pages must publish before native approval, and a partial publication is safely resumed without new model calls', () => fixture(async f => {
  f.state.alter = report => {
    for (const group of ['fit', 'need', 'excess']) for (const factor of Object.values(report.units[0][group])) {
      factor.reason = 'Unchanged cited source evidence. '.repeat(60);
    }
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
  assert.match(primary.body, /Complete factor inputs and literal evidence: \[Evidence 1\//);
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
  assert.equal(f.state.writes.length, 0);
}));

test('incomplete grading retains exact replay inputs and still cannot approve or waive a missing alternative', () => fixture(async f => {
  const assessment = await f.assess({fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.tools) return f.fetchImpl(url, options);
    const {questions} = JSON.parse(body.messages[1].content);
    const answers = Object.fromEntries(Object.keys(questions).map(id => [id,
      id === 'u0_excess_abstraction' ? 'level1' : id.includes('_excess_') ? 'level0' : 'level4']));
    return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers})}}]})};
  }});
  assert.equal(assessment.decision, 'review_incomplete');
  const trace = JSON.parse(fs.readFileSync(`${f.recordPath}.diagnostic.json`));
  assert.equal(trace.failure, undefined, 'missing repair detail is incomplete analysis, not invalid source evidence');
  const response = trace.observations.find(item => item.phase === 'grading_response');
  const graded = trace.observations.find(item => item.phase === 'graded_report');
  const snapshot = trace.snapshots[graded.snapshot];
  assert.equal(response.value.answers.u0_excess_abstraction, 'level1');
  assert.equal(response.packet.state.factors.u0_excess_abstraction.context.narrower_alternative, '');
  assert.equal(graded.report.units[0].excess.abstraction.min, 0.25);
  assert.equal(snapshot.digest, graded.report.snapshot);
  assert.equal(require('./acceptance.cjs').validateReport(graded.report, snapshot).decision,
    'review_incomplete', 'the retained inputs reproduce the exact hold without calling a provider');
  await assert.rejects(f.gate(assessment), /incomplete/);
  assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 0);
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
  assert.equal(f.state.writes.length, 0);
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
