'use strict';
// A synthetic large pull request and a fake hosted provider, for end-to-end tests of the hosted chunked review. Nothing here
// calls the network or a model: the GitHub client and the provider are in-memory fakes that answer from the controller's own
// templates, and every file is deterministic fictional filler.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createPolicy} = require('../src/policy.cjs');
const {digest, FACTORS} = require('../src/acceptance.cjs');
const {modelTemplate} = require('../src/acceptance-review.cjs');

const CONTRACT = '# Fictional gateway contract\nKeep the fictional modules consistent; every module has a test.\n';
const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const CONFIG = {...require('./fixtures/config.json'), version: 2, repository_policy: '.github/clouseau.md', readme: 'README.md', acceptance: {
  examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'deepseek', grading_model: 'deepseek-flash', repair_attempts: 2,
}};

// `count` modules of about `size` characters each, every one with a test, each requiring the previous one so that units
// split across the chain have seams between them.
function sources({count, size}) {
  const content = {'.github/clouseau.md': CONTRACT, 'README.md': CONTRACT};
  for (let index = 0; index < count; index++) {
    const name = String(index).padStart(3, '0');
    const head = [index ? `const previous = require('./mod-${String(index - 1).padStart(3, '0')}.cjs');` : 'const previous = () => 0;'];
    for (let line = 0; head.join('\n').length < size; line++) head.push(`exports.f${name}_${line} = value => previous(value) + ${line};`);
    content[`src/mod-${name}.cjs`] = `${head.join('\n')}\n`;
    content[`src/mod-${name}.test.cjs`] = `const mod = require('./mod-${name}.cjs');\nmod.f${name}_0(1);\n`;
  }
  return content;
}

const patchOf = text => {
  const lines = text.replace(/\n$/, '').split('\n');
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}`;
};

// Runs `run(f)` with a complete assess/gate fixture. `config` overrides the acceptance configuration.
async function largeFixture(run, {count = 40, size = 30000, config = CONFIG, provider = {}} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-hosted-chunked-'));
  const old = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional';
  try {
    const content = sources({count, size});
    const changed = Object.keys(content).filter(name => name.startsWith('src/'));
    const files = changed.map(name => ({filename: name, status: 'added', patch: patchOf(content[name])}));
    const state = {comments: [], reviews: [], writes: [], failed: false, calls: [], contents: content, provider,
      pr: {number: 3, node_id: 'PR_3', state: 'open', draft: false, changed_files: files.length, user: {login: 'contributor', type: 'User'},
        title: 'feat: add the fictional modules', body: 'Adds the fictional modules with tests.',
        head: {sha: HEAD, ref: 'feat/modules', repo: {id: 7, owner: {login: 'example'}, name: 'gateway'}},
        base: {sha: BASE, ref: 'main'}, auto_merge: {enabled_by: {login: 'github-actions[bot]'}}}};
    const repo = {owner: 'example', repo: 'gateway'};
    const endpoint = (name, fn) => Object.assign(fn, {endpointName: name});
    const write = name => endpoint(name, async args => {state.writes.push({name, args}); return {data: {id: 100 + state.writes.length}};});
    const github = {
      rest: {
        git: {getTree: async () => ({data: {truncated: false, tree: []}})},
        repos: {
          getContent: async ({path: name, ref}) => {
            const text = ref === BASE && name.startsWith('src/') ? null : state.contents[name];
            if (text === undefined || text === null) throw Object.assign(new Error('Not Found'), {status: 404});
            return {data: {encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text)}};
          },
          listCommits: async () => ({data: []}),
          get: async () => ({data: {allow_auto_merge: true}}), getBranch: async () => ({data: {protected: true}}),
          getCollaboratorPermissionLevel: async () => ({data: {permission: 'write'}}),
        },
        pulls: {
          get: async () => ({data: structuredClone(state.pr)}),
          listFiles: endpoint('files', async () => ({data: files})),
          listReviews: endpoint('reviews', async () => ({data: state.reviews})),
          createReview: write('approve'), requestReviewers: write('request-review'),
        },
        issues: {
          listComments: endpoint('comments', async () => ({data: state.comments})),
          createComment: write('create-ledger'), updateComment: write('update-ledger'), addAssignees: write('assign'),
        },
        actions: {
          listWorkflowRuns: async () => ({data: {workflow_runs: [{id: 9, run_attempt: 1, head_sha: HEAD, event: 'pull_request',
            pull_requests: [{number: state.pr.number}], status: 'completed', conclusion: state.failed ? 'failure' : 'success',
            html_url: 'https://github.com/example/gateway/actions/runs/9'}]}}),
          listJobsForWorkflowRun: endpoint('jobs', async () => ({data: [{id: 10, name: 'verify', conclusion: 'success',
            steps: config.verification.steps.map(name => ({name, conclusion: 'success'}))}]})),
        },
      },
      graphql: async query => {
        if (query.startsWith('mutation')) {const disable = query.includes('disablePullRequestAutoMerge'); state.writes.push({name: disable ? 'disable-auto' : 'enable-auto'}); state.pr.auto_merge = disable ? null : {}; return {};}
        return {repository: {pullRequest: {closingIssuesReferences: {nodes: [], pageInfo: {hasNextPage: false}}}}};
      },
      paginate: async (method, args) => (await method(args)).data,
      request: async () => ({data: [
        {type: 'required_status_checks', parameters: {strict_required_status_checks_policy: true,
          required_status_checks: ['verify', 'approve-and-merge'].map(context => ({context, integration_id: 15368}))}},
        {type: 'pull_request', parameters: {required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true}},
        {type: 'non_fast_forward'}, {type: 'deletion'},
      ]}),
    };
    const readContent = github.rest.repos.getContent;
    github.rest.repos.getContent = args => args.path === '.github/CODEOWNERS' ?
      Promise.resolve({data: {encoding: 'base64', content: Buffer.from('* @contributor').toString('base64'), size: 14}}) : readContent(args);
    const context = {repo, runId: 7, eventName: 'pull_request_target', payload: {pull_request: {number: 3}}};
    const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
    const recordPath = path.join(directory, 'record.json');
    const fetchImpl = fakeProvider(state);
    const policy = createPolicy(config);
    const assess = extra => policy.assess({github, context, recordPath, fetchImpl, retryWait: async () => {}, ...extra});
    const gate = (assessment, extra) => policy.gate({github, context, core, recordPath, assessment, nativeGate: true, wait: async () => {}, ...extra});
    await run({directory, recordPath, config, policy, github, context, state, assess, gate, fetchImpl, files, content, repo,
      read: () => JSON.parse(fs.readFileSync(recordPath, 'utf8')),
      write: record => fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n'),
      rebind: (assessment, record) => ({...assessment, record_digest: digest(record)})});
  } finally {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

// The fake hosted provider. It answers a tool call from the prompt itself: the investigation template, the integration
// seams, the grading questions. `state.provider` may change an answer: {report(report, task), dispositions(ids, task), answers(ids, task),
// fail(task)}.
function fakeProvider(state) {
  return async (_, options) => {
    const body = JSON.parse(options.body);
    // The single-snapshot reviewer: an `acceptance_report` tool call, or the plain-JSON grading request.
    if (!body.tools || body.tools[0].function.name === 'acceptance_report') {
      state.calls.push({single: true, model: body.model});
      const content = JSON.parse(body.messages[1].content);
      if (!body.tools) {
        return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers:
          Object.fromEntries(Object.keys(content.questions).map(id => [id, 'level4']))})}}]})};
      }
      for (const source of Object.values(content.sources)) source.content = source.numbered_lines.replace(/^L[0-9]+: /gm, '');
      const report = modelTemplate(content);
      report.gates.forEach(gate => {gate.state = 'satisfied';});
      return {ok: true, json: async () => ({choices: [{finish_reason: 'tool_calls', message: {tool_calls:
        [{function: {name: 'acceptance_report', arguments: JSON.stringify(report)}}]}}]})};
    }
    const tool = body.tools[0].function;
    const prompt = body.messages[0].content;
    const task = {tool: tool.name, model: body.model, prompt, chars: prompt.length, state};
    state.calls.push(task);
    const input = () => JSON.parse(prompt.slice(prompt.lastIndexOf('\n{"') + 1));
    const reply = value => ({ok: true, json: async () => ({model: body.model, usage: {prompt_tokens: Math.ceil(prompt.length / 4), prompt_cache_hit_tokens: 0, completion_tokens: task.phase === 'investigation' ? 4000 : 500},
      choices: [{finish_reason: 'tool_calls', message: {tool_calls: [{function: {name: tool.name, arguments: JSON.stringify(value)}}]}}]})});
    const properties = tool.parameters.properties;
    if (state.provider.fail?.(task)) {task.failed = true; return {ok: false, status: 400};}
    if (properties.kind) {
      task.phase = 'investigation';
      const view = input();
      const report = view.template;
      report.gates.forEach(gate => {gate.state = 'satisfied';});
      state.provider.report?.(report, task, view);
      return reply(state.provider.respond?.(task) ?? {kind: 'report', report, request_sources: []});
    }
    if (properties.dispositions) {
      task.phase = 'integration';
      const ids = input().seams.map(seam => seam.id);
      const rows = state.provider.dispositions?.(ids, task) ?? ids.map(seam => ({seam, state: 'checked', reason: 'Both ends examined.'}));
      return reply({dispositions: rows});
    }
    task.phase = 'grading';
    const ids = Object.keys(input().questions);
    return reply({answers: state.provider.answers?.(ids, task) ?? Object.fromEntries(ids.map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))});
  };
}

// A defect in a raw model answer: the model anchors on a controller proof id; the controller derives path and citations.
const finding = (report, name) => {
  const [anchor] = report.accounting[0].evidence;
  report.findings.push({id: `fictional-${name}`, title: 'Fictional defect', anchor,
    cause: 'The changed path no longer preserves the accepted contract.', trigger: 'A fictional input.', consequence: 'A fictional regression.',
    obligation: 'Restore the accepted contract.', evidence: [anchor],
    factors: Object.fromEntries(FACTORS.defect.map(factor => [factor, {evidence: [anchor], reason: 'Established by the cited source.'}])),
    blast_radius: 1, opportunity: {mechanical: false, beneficial: false, within_scope: false, verified: false},
    repair_paths: [report.accounting[0].path]});
};


// Trust for a signed local review of the fixture: one enrolled fictional key for the PR author. `config` is the acceptance
// configuration the hosted review ran under, so the receipt binds the same configuration digest the live repository has.
function signedTrust(config = CONFIG) {
  const crypto = require('node:crypto');
  const keys = crypto.generateKeyPairSync('ed25519');
  return {privateKey: keys.privateKey.export({type: 'pkcs8', format: 'pem'}), config: {...config, local_review: {mode: 'optional',
    reviewer_sha: 'e'.repeat(40), reviewer_digest: require('../src/local-version.cjs').engineDigest(), max_age_seconds: 172800,
    keys: [{id: 'fixture', issuer: 'fixture-runner', github_actor: 'contributor', revoked: false,
      public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}]}}};
}

// Signs the complete chunked record a hosted run stored as if a local review had produced it (fictional harness sessions),
// and serves the signed envelope and its parts from the fake repository the way an immutable receipt commit would.
function signLargeReceipt(f, {privateKey, config}) {
  const {issueReceipt} = require('../src/local-receipt.cjs');
  const {partName} = require('../src/receipt-parts.cjs');
  const wiring = require('../src/chunked-wiring.cjs');
  const stored = f.read();
  const usage = stored.result.usage.map((item, index) => ({...item, harness: 'codex', session: `fictional-session-${index}`, transport_digest: digest({index})}));
  // A local review is made before the pull request exists: its snapshot has number 0 (`f.state.pr.number = 0` while the hosted
  // fixture review runs), no owner confirmation and no protected controls.
  const record = {version: 3, snapshot: stored.snapshot, controls: false, partition: stored.partition, seams: stored.seams, previous: stored.previous,
    result: {...stored.result, usage, execution_digest: digest(usage)}};
  const bundle = issueReceipt({record, privateKey, keyId: 'fixture', issuer: 'fixture-runner', reviewerSha: 'e'.repeat(40),
    chunked: wiring.verifierOptions(config.local_review)});
  const {parts = [], ...envelope} = bundle;
  const files = new Map([['clouseau-review.json', Buffer.from(JSON.stringify(envelope))],
    ...parts.map((part, index) => [partName(index), Buffer.from(part, 'base64')])]);
  return {record, bundle, files, ref: 'c'.repeat(40)};
}

module.exports = {largeFixture, fakeProvider, sources, finding, signedTrust, signLargeReceipt, CONFIG, HEAD, BASE};
