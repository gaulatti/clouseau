'use strict';
// Gate behavior under the protected local_review.base_moved setting. Kept apart from acceptance-controller.test.cjs so a change here does not resend that file as review evidence.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createPolicy} = require('./policy.cjs');
const {modelTemplate} = require('./acceptance-review.cjs');
const {createAcceptancePolicy} = require('./acceptance-controller.cjs');
const {validateConfig} = require('./config.cjs');
const {CASES, prepareCase} = require('../test/acceptance-cases.cjs');
const {hostedFiles} = require('../test/hosted-files.cjs');

const base = {...require('../test/fixtures/config.json'), version: 2, repository_policy: '.github/clouseau.md', readme: 'README.md', acceptance: {
  examiner: 'deepseek-flash', challenger: 'deepseek-flash', grader: 'deepseek', grading_model: 'deepseek-flash', repair_attempts: 2,
}};
const keys = crypto.generateKeyPairSync('ed25519');
const trust = extra => ({mode: 'optional', reviewer_digest: require('./local-version.cjs').engineDigest(), max_age_seconds: 172800,
  keys: [{id: 'fixture', issuer: 'fixture-runner', github_actor: 'contributor', revoked: false,
    public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}], ...extra});
const configured = extra => ({...base, local_review: trust(extra)});
const MOVED = 'e'.repeat(40);
const UPDATED = 'd'.repeat(40);

// Today's needs-branch-update notice and error, copied literally from the engine before base_moved existed. Under "hold" or
// absent the gate must post exactly this, byte for byte.
const todayNotice = ({head, from, to, number}) => `<!-- clouseau-needs-branch-update:${head}:${to} -->\n## Clouseau: branch update needed\n\n` +
  `**Cause:** \`base_moved\`: \`main\` moved from \`${from.slice(0, 12)}\` to \`${to.slice(0, 12)}\` after revision \`${head.slice(0, 12)}\` was assessed, ` +
  'so it was not merged. The assessment and the exact-head approval are bound to the old base and cannot be reused; neither is a local review ' +
  'receipt, unless the protected `local_review.binding` is `"diff"` and the update leaves its diff unchanged. Re-running the failed job cannot succeed.\n\n' +
  `**Next steps:**\n\n1. Update this branch with the latest \`main\` using your own credentials so verification starts: \`gh pr update-branch ${number}\` ` +
  '(or the "Update branch" button, or `git fetch origin && git merge origin/main` and push; never rebase).\n' +
  '2. Wait: Clouseau re-verifies and re-reviews the new revision automatically.\n' +
  `3. Only if this repository requires a local review receipt: run \`clouseau refresh --pr ${number}\`, which merges the base and, unless a ` +
  '`binding: "diff"` receipt still covers the unchanged diff, reviews and publishes the new head and updates the marker in the pull request description.';
const TODAY_ERROR = 'Needs branch update: main moved after approval; update this PR branch so the new revision is verified and reviewed';

// The hosted-review fixture of acceptance-controller-binding.test.cjs, with the protected configuration as a parameter and a
// stub update credential whose updateBranch is recorded and, like GitHub, moves the head of the pull request.
async function fixture(config, run, {legacyGate = null, gateState = 'satisfied'} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-base-moved-'));
  const old = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional';
  try {
    const {github, repo, snapshot} = await prepareCase(CASES[0]);
    let policy = createPolicy(config);
    if (legacyGate) {
      // The private-merge boundary: the legacy gate calls verifyAcceptance at its atomic write; legacyGate runs first.
      const {local_review, merge_mode, exact_revert, hosted_review, ...legacyConfig} = validateConfig(config);
      const legacy = createPolicy({...legacyConfig, version: 1}, {codeownersRequired: true});
      policy = createAcceptancePolicy(validateConfig(config), {...legacy, gate: async options => {
        if (!options.verifyAcceptance) return legacy.gate(options);
        await legacyGate(); await options.verifyAcceptance(); state.merged = true;
      }});
    }
    const context = {repo, runId: 7, eventName: 'pull_request_target', payload: {pull_request: {number: 3}}};
    const state = {comments: [], reviews: [], writes: [], updates: [], updateError: null, merged: false,
      pr: {number: 3, node_id: 'PR_3', state: 'open', draft: false, changed_files: 1, user: {login: 'contributor', type: 'User'},
        head: {sha: snapshot.head_sha, ref: 'fix/upload', repo: {id: 7, full_name: `${repo.owner}/${repo.repo}`, owner: {login: repo.owner}, name: repo.repo}},
        base: {sha: snapshot.base_sha, ref: 'main'}, auto_merge: {enabled_by: {login: 'github-actions[bot]'}}}};
    const graphql = github.graphql;
    github.graphql = async (query, args) => {
      if (query.startsWith('mutation')) {state.writes.push({name: 'auto'}); state.pr.auto_merge = query.includes('disable') ? null : {}; return {};}
      return graphql(query, args);
    };
    const endpoint = (name, fn) => Object.assign(fn, {endpointName: name});
    const write = name => endpoint(name, async args => {
      state.writes.push({name, args});
      if (name === 'create-comment') state.comments.push({id: 100 + state.writes.length, user: {login: 'github-actions[bot]'}, body: args.body});
      return {data: {id: 100 + state.writes.length}};
    });
    github.rest.pulls = {
      get: async () => ({data: structuredClone(state.pr)}),
      listFiles: endpoint('files', async () => ({data: hostedFiles(snapshot)})),
      listReviews: endpoint('reviews', async () => ({data: state.reviews})),
      createReview: write('approve'), requestReviewers: write('request-review'),
    };
    github.rest.issues = {
      listComments: endpoint('comments', async () => ({data: state.comments})),
      createComment: write('create-comment'), updateComment: write('update-comment'), addAssignees: write('assign'),
    };
    github.rest.actions = {
      listWorkflowRuns: async () => ({data: {workflow_runs: [{id: 9, run_attempt: 1, head_sha: state.pr.head.sha,
        event: 'pull_request', pull_requests: [{number: 3}], status: 'completed', conclusion: 'success',
        html_url: 'https://github.com/example/gateway/actions/runs/9'}]}}),
      listJobsForWorkflowRun: endpoint('jobs', async () => ({data: [{id: 10, name: 'verify', conclusion: 'success',
        steps: config.verification.steps.map(name => ({name, conclusion: 'success'}))}]})),
    };
    const readContent = github.rest.repos.getContent;
    github.rest.repos.getContent = args => args.path === '.github/CODEOWNERS' ? Promise.resolve({data: {
      encoding: 'base64', content: Buffer.from('* @contributor').toString('base64'), size: 14}}) : readContent(args);
    Object.assign(github.rest.repos, {
      get: async () => ({data: {allow_auto_merge: true}}), getBranch: async () => ({data: {protected: true, commit: {sha: state.pr.base.sha}}}),
      getCollaboratorPermissionLevel: async () => ({data: {permission: 'write'}}),
    });
    github.paginate = async (method, args) => (await method(args)).data;
    github.request = async () => ({data: [
      {type: 'required_status_checks', parameters: {strict_required_status_checks_policy: true,
        required_status_checks: ['verify', 'approve-and-merge'].map(context => ({context, integration_id: 15368}))}},
      {type: 'pull_request', parameters: {required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true}},
      {type: 'non_fast_forward'}, {type: 'deletion'},
    ]});
    // Like GitHub: the server-side merge of the base gives the pull request a new head; the base itself never moves.
    const updateGithub = {rest: {pulls: {updateBranch: async args => {
      state.updates.push(args);
      if (state.updateError) throw Object.assign(new Error('refused'), {status: state.updateError});
      state.pr.head.sha = UPDATED;
      return {data: {message: 'Updating pull request branch.'}};
    }}}};
    const core = {info() {}, summary: {addRaw() {return this;}, async write() {}}};
    const recordPath = path.join(directory, 'record.json');
    const fetchImpl = async (_, options) => {
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
      if (gateState !== 'satisfied') report.gates[0].state = gateState;
      return {ok: true, json: async () => ({choices: [{finish_reason: 'tool_calls', message: {tool_calls:
        [{function: {name: 'acceptance_report', arguments: JSON.stringify(report)}}]}}]})};
    };
    const assess = () => policy.assess({github, context, recordPath, fetchImpl});
    const gate = (assessment, token = updateGithub) => policy.gate({github, context, core, recordPath, assessment, nativeGate: true,
      wait: async () => {}, updateGithub: token});
    const notices = () => state.writes.filter(item => ['create-comment', 'update-comment'].includes(item.name) && item.args.body.includes('clouseau-needs-branch-update'));
    await run({state, assess, gate, notices, updateGithub, snapshot, repo});
  } finally {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;
    fs.rmSync(directory, {recursive: true});
  }
}

test('base_moved is valid only as "hold" or "update" together with binding "diff"', () => {
  for (const value of ['hold', 'update']) {
    assert.equal(validateConfig(configured({binding: 'diff', base_moved: value})).local_review.base_moved, value);
    assert.throws(() => validateConfig(configured({base_moved: value})), /base_moved must be "hold" or "update" when set, and only together with binding "diff"/);
  }
  for (const value of ['merge', 'Update', '', null, true, 1]) {
    assert.throws(() => validateConfig(configured({binding: 'diff', base_moved: value})), /base_moved must be "hold" or "update"/, String(value));
  }
  assert.equal(validateConfig(configured({binding: 'diff'})).local_review.base_moved, undefined, 'absent stays absent');
});

for (const [label, extra] of [['absent', {}], ['absent with binding "diff"', {binding: 'diff'}], ['"hold"', {binding: 'diff', base_moved: 'hold'}]]) {
  test(`base_moved ${label}: a base-only move holds with today's notice and error byte for byte, and the update-token is never used`, () =>
    fixture(configured(extra), async f => {
      const assessment = await f.assess();
      assert.equal(assessment.decision, 'auto_approve', assessment.reason);
      const from = f.state.pr.base.sha; f.state.pr.base.sha = MOVED;
      await assert.rejects(f.gate(assessment), error => error.message === TODAY_ERROR && error.code === undefined);
      assert.equal(f.state.updates.length, 0, 'a consumer that did not opt in is unaffected even with the token present');
      assert.deepEqual(f.notices().map(item => item.args.body), [todayNotice({head: assessment.head_sha, from, to: MOVED, number: 3})]);
      assert.equal(f.state.pr.head.sha, assessment.head_sha);
    }));
}

test('base_moved "update" with the update-token: a base-only move updates the branch once with expected_head_sha, posts no notice and ends as base_update_requested', () =>
  fixture(configured({binding: 'diff', base_moved: 'update'}), async f => {
    const assessment = await f.assess();
    assert.equal(assessment.decision, 'auto_approve', assessment.reason);
    f.state.pr.base.sha = MOVED;
    const error = await f.gate(assessment).then(() => null, value => value);
    assert.equal(error.code, 'BASE_UPDATE_REQUESTED'); assert.equal(error.cause_code, 'base_update_requested');
    assert.match(error.message, /^Branch updated server-side \(cause: `base_update_requested`\): `main` moved after revision/);
    assert.match(error.message, /merged `main` into this pull request branch with the `update-token` credential/);
    assert.match(error.message, /neither approved nor merged; the new head's own run continues/);
    assert.deepEqual(f.state.updates, [{...f.repo, pull_number: 3, expected_head_sha: assessment.head_sha}]);
    assert.equal(f.notices().length, 0, 'no branch update needed notice');
    assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 0, 'nothing is approved');
  }));

test('base_moved "update": a 422 (a conflict or a moved head) falls back to the notice saying so, and does not succeed', () =>
  fixture(configured({binding: 'diff', base_moved: 'update'}), async f => {
    const assessment = await f.assess();
    f.state.pr.base.sha = MOVED; f.state.updateError = 422;
    await assert.rejects(f.gate(assessment), error => error.message === TODAY_ERROR);
    assert.equal(f.state.updates.length, 1);
    const [notice] = f.notices();
    assert.match(notice.args.body, /\*\*Cause:\*\* `base_moved`/);
    assert.match(notice.args.body, /Re-running the failed job cannot succeed\. The protected `local_review\.base_moved` is `"update"`, but GitHub refused the automatic update \(HTTP 422\): a merge conflict with the base, or a head that moved, prevented it, so you must update this branch by hand\.\n\n\*\*Next steps:\*\*/);
    assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 0);
  }));

test('base_moved "update": any other updateBranch error surfaces as it is, with no notice', () =>
  fixture(configured({binding: 'diff', base_moved: 'update'}), async f => {
    const assessment = await f.assess();
    f.state.pr.base.sha = MOVED; f.state.updateError = 403;
    await assert.rejects(f.gate(assessment), error => error.message === 'refused' && error.status === 403);
    assert.equal(f.notices().length, 0);
  }));

test('base_moved "update" without the update-token holds as today, with the notice naming the missing input', () =>
  fixture(configured({binding: 'diff', base_moved: 'update'}), async f => {
    const assessment = await f.assess();
    const from = f.state.pr.base.sha; f.state.pr.base.sha = MOVED;
    await assert.rejects(f.gate(assessment, null), error => error.message === TODAY_ERROR);
    const [notice] = f.notices();
    assert.ok(notice.args.body.includes('set the `update-token` input of the gate step'));
    // Everything else is today's notice; only the one sentence naming the missing input is added.
    const today = todayNotice({head: assessment.head_sha, from, to: MOVED, number: 3});
    const added = ' The protected `local_review.base_moved` is `"update"`, but no update credential was supplied, so Clouseau could not update the ' +
      'branch itself: set the `update-token` input of the gate step to a token that starts workflows and has contents: write on this repository.';
    assert.equal(notice.args.body, today.replace('cannot succeed.\n\n', `cannot succeed.${added}\n\n`));
  }));

test('base_moved "update": a fork head is never updated and receives the notice saying so', () =>
  fixture(configured({binding: 'diff', base_moved: 'update'}), async f => {
    const assessment = await f.assess();
    f.state.pr.head.repo = {...f.state.pr.head.repo, full_name: 'someone/gateway'}; f.state.pr.base.sha = MOVED;
    await assert.rejects(f.gate(assessment), error => error.message === TODAY_ERROR);
    assert.equal(f.state.updates.length, 0);
    assert.ok(f.notices()[0].args.body.includes('the head branch lives in a fork, which Clouseau never updates'));
  }));

test('loop bound: the updated head assessed against the unchanged base requests no update, and the same (head, base) is updated at most once', () =>
  fixture(configured({binding: 'diff', base_moved: 'update'}), async f => {
    const assessment = await f.assess();
    f.state.pr.base.sha = MOVED;
    await assert.rejects(f.gate(assessment), {code: 'BASE_UPDATE_REQUESTED'});
    assert.equal(f.state.updates.length, 1);
    // A rerun of the old head's gate sees the head GitHub created, so it is not a base-only move and requests nothing.
    await assert.rejects(f.gate(assessment), /^Error: PR changed after acceptance investigation/);
    assert.equal(f.state.updates.length, 1, 'repeated runs on the same (head, base) request at most one update');
    // The new head's own run carries the new base: the gate passes it and never asks for another update.
    assert.equal(f.state.pr.head.sha, UPDATED); assert.equal(f.state.pr.base.sha, MOVED);
    const next = await f.assess();
    assert.deepEqual([next.decision, next.head_sha, next.base_sha], ['auto_approve', UPDATED, MOVED], next.reason);
    await f.gate(next);
    assert.equal(f.state.writes.filter(item => item.name === 'approve').length, 1, 'the new head is approved by its own run');
    assert.equal(f.state.updates.length, 1, 'the updated head with an unchanged base requests no update');
    assert.equal(f.notices().length, 0);
  }));

test('the private-merge boundary applies the same rule: opted in it updates once, otherwise it posts today\'s notice', async () => {
  for (const [extra, updated] of [[{binding: 'diff', base_moved: 'update'}, true], [{binding: 'diff', base_moved: 'hold'}, false], [{}, false]]) {
    let state;
    await fixture(configured(extra), async f => {
      state = f.state;
      const assessment = await f.assess();
      // The base moves after the gate's first check, just before the atomic write.
      const from = f.state.pr.base.sha;
      const error = await f.gate(assessment).then(() => null, value => value);
      assert.equal(f.state.merged, false, 'nothing merges after the base moved');
      if (updated) {
        assert.equal(error.code, 'BASE_UPDATE_REQUESTED');
        // At this boundary the gate's approval was already submitted: the outcome says so, never "neither approved nor merged".
        assert.match(error.message, /This revision was approved before the base moved but was not merged; that approval does not carry to the new head/);
        assert.doesNotMatch(error.message, /neither approved/);
        assert.deepEqual(f.state.updates.map(item => item.expected_head_sha), [assessment.head_sha]);
        assert.equal(f.notices().length, 0);
        // The updated head, assessed against the moved base, merges by the atomic fast-forward with no further update.
        const next = await f.assess();
        assert.deepEqual([next.decision, next.head_sha, next.base_sha], ['auto_approve', UPDATED, MOVED], next.reason);
        await f.gate(next);
        assert.equal(f.state.merged, true, 'the updated head merges at the private-merge boundary');
        assert.equal(f.state.updates.length, 1, 'the updated head requests no update');
        assert.equal(f.notices().length, 0);
      } else {
        assert.equal(error.message, TODAY_ERROR);
        assert.equal(f.state.updates.length, 0);
        assert.deepEqual(f.notices().map(item => item.args.body), [todayNotice({head: assessment.head_sha, from, to: MOVED, number: 3})]);
      }
    }, {legacyGate: async () => {state.pr.base.sha = MOVED;}});
  }
});

test('base_moved "update" never updates a branch whose decision does not approve it: it posts today\'s notice instead', () =>
  fixture(configured({binding: 'diff', base_moved: 'update'}), async f => {
    const assessment = await f.assess();
    assert.ok(!['auto_approve', 'owner_decision'].includes(assessment.decision), assessment.decision);
    const from = f.state.pr.base.sha; f.state.pr.base.sha = MOVED;
    await assert.rejects(f.gate(assessment), error => error.message === TODAY_ERROR && error.code === undefined);
    assert.equal(f.state.updates.length, 0, 'a blocked pull request is never merged with its base by Clouseau');
    assert.deepEqual(f.notices().map(item => item.args.body), [todayNotice({head: assessment.head_sha, from, to: MOVED, number: 3})]);
    assert.equal(f.state.pr.head.sha, assessment.head_sha);
  }, {gateState: 'violated'}));

test('base_moved "update" never updates a revision still awaiting a required maintainer confirmation; once confirmed it does', () =>
  fixture(configured({binding: 'diff', base_moved: 'update'}), async f => {
    const assessment = await f.assess();
    assert.equal(assessment.decision, 'auto_approve', assessment.reason);
    // A bot-authored pull request always needs a maintainer's approving review of this exact head (the gate's same rule).
    f.state.pr.user = {login: 'github-actions[bot]', type: 'Bot'};
    const from = f.state.pr.base.sha; f.state.pr.base.sha = MOVED;
    await assert.rejects(f.gate(assessment), error => error.message === TODAY_ERROR && error.code === undefined);
    assert.equal(f.state.updates.length, 0, 'nothing is merged into a branch whose acceptance still waits on a maintainer');
    assert.deepEqual(f.notices().map(item => item.args.body), [todayNotice({head: assessment.head_sha, from, to: MOVED, number: 3})]);
    // The maintainer approves this exact head: the same base-only move is now updated.
    f.state.reviews.push({user: {login: 'gaulatti', type: 'User'}, state: 'APPROVED', commit_id: assessment.head_sha});
    await assert.rejects(f.gate(assessment), {code: 'BASE_UPDATE_REQUESTED'});
    assert.deepEqual(f.state.updates.map(item => item.expected_head_sha), [assessment.head_sha]);
  }));
