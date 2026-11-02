'use strict';

// Every refusal or hold notice a customer can see names its cause class and a numbered next step (docs/notices.md).
// One table per notice family; each row is one cause class, asserted on the text the pull request shows.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {CAUSES, describe, noticeText, noticeLine, numbered, modeOf} = require('./receipt-rejection.cjs');
const {NEXT_STEPS, PENDING_STEPS, body, pendingBody} = require('./incomplete.cjs');
const {INTENT, FAILURES, GENERIC, intentCause, intentBlock, failureBlock} = require('./gate-notice.cjs');
const {GAP_STEPS} = require('./merge-protection.cjs');
const conflict = require('./branch-conflict.cjs');

const SHA_A = 'a1b2c3d4e5f6'.padEnd(40, '0'); const SHA_B = 'f6e5d4c3b2a1'.padEnd(40, '9');
const URL = 'https://github.com/example/product/actions/runs/9';

// class, details a run can supply, the concrete values the sentence must show, and the first class-specific step.
const RECEIPT_ROWS = [
  ['absent', {}, ['carries no `clouseau-local-review:` marker'], null],
  ['unread', {}, ['does not read receipts'], null],
  ['malformed', {}, ['malformed or unsupported'], null],
  ['unavailable', {}, ['could not be read from the immutable commit'], 'Check that the commit named by the marker still exists'],
  ['signature', {}, ['not from an enrolled, active key'], 'Sign with an enrolled identity (`clouseau public-identity`'],
  ['author', {}, ['signer is not enrolled for the author'], 'Sign with an identity enrolled for the pull request author'],
  ['attestation', {}, ['not a maintainer attestation that the protected configuration permits'], 'allow `local_review.attest`'],
  ['expired', {expires: '2026-11-02T10:11:12.000Z'}, ['expired or not yet valid', '`2026-11-02T10:11:12.000Z`'], 'valid only for a limited time'],
  ['revision_repository', {}, ['different repository'], 'not a fork or another project'],
  ['revision_head', {receipt_head: SHA_A, current_head: SHA_B}, ['reviewed head `a1b2c3d4e5f6`', 'now at head `f6e5d4c3b2a1`'], 'Any push after a review needs a new review'],
  ['revision_base', {receipt_base: SHA_A, current_base: SHA_B}, ['against base `a1b2c3d4e5f6`', 'branch is now at `f6e5d4c3b2a1`'], 'gh pr update-branch 42'],
  ['changed', {changed: 'policy'}, ['protected policy changed after the receipt was issued'], 'git fetch origin && git merge origin/trunk'],
  ['source', {file: 'src/app.js'}, ['differ from the pull request (file: `src/app.js`)'], 'commit all changes, do not amend'],
  ['record', {}, ['incomplete or inconsistent'], 'Do not edit a receipt by hand'],
  ['engine', {receipt_engine: SHA_A, current_engine: SHA_B}, ['Clouseau engine `a1b2c3d4e5f6`', 'uses engine `f6e5d4c3b2a1`', 'does not list that engine as review-compatible'], '`--engine latest`'],
  ['not_passing', {}, ['did not pass'], 'repair the blockers'],
  ['settings', {}, ['chunked review configuration is invalid'], 'This is not fixable from the pull request'],
  ['untested', {file: 'src/a.js, src/b.js'}, ['no supplied test imports changed production code (file: `src/a.js, src/b.js`)'], 'Add or extend a test'],
  ['integrity', {file: 'src/a.test.js'}, ['test integrity is unresolved (file: `src/a.test.js`)'], 'real assertions'],
  ['completeness', {}, ['review completeness is unresolved'], 'Supply the evidence the reviewer could not read'],
];

test('the table covers exactly the receipt classes there are', () => {
  assert.deepEqual(RECEIPT_ROWS.map(([name]) => name).sort(), Object.keys(CAUSES).sort());
});

test('every receipt cause class names its cause, the safe concrete values, and numbered steps in every mode', () => {
  for (const [name, detail, shown, first] of RECEIPT_ROWS) for (const mode of ['required', 'receipt_only', 'optional']) {
    const found = describe(name, {mode, number: 42, detail: {...detail, base_branch: 'trunk'}});
    const text = noticeText(name, {mode, number: 42, detail: {...detail, base_branch: 'trunk'}});
    assert.equal(found.code, `receipt_${name}`);
    assert.ok(text.startsWith(`Local review receipt not used (cause: \`receipt_${name}\`): `), `${name}/${mode}: ${text}`);
    for (const fragment of shown) assert.ok(text.includes(fragment), `${name}/${mode}: shows ${fragment}`);
    assert.ok(text.includes(found.lead), `${name}/${mode}: says what this run did`);
    assert.match(text, /\n\n1\. /, `${name}/${mode}: numbered steps`);
    if (first) assert.ok(text.includes(`1. ${first}`) || text.includes(first), `${name}/${mode}: ${first}`);
    assert.ok(!/[{}]/.test(text), `${name}/${mode}: every placeholder is filled`);
    // A class that a fresh receipt fixes ends with the three commands of the fresh receipt; settings is the owner's alone.
    assert.equal(text.includes('clouseau publish --directory . --receipt RECEIPT_FILE'), name !== 'settings', name);
    assert.equal(text.includes('--base origin/trunk'), name !== 'settings', name);
  }
  assert.equal(numbered(['a', 'b']), '1. a\n2. b');
});

test('the lead says whether the run reviewed the change, and the mode follows the cause', () => {
  assert.match(describe('engine', {mode: 'required'}).lead, /requires a valid receipt/);
  assert.match(describe('engine', {mode: 'receipt_only'}).lead, /did not review the change itself/);
  assert.match(describe('engine', {mode: 'optional'}).lead, /CI reviewed this change itself/);
  assert.equal(describe('engine').lead, describe('engine', {mode: 'optional'}).lead);
  assert.equal(modeOf('local_receipt_required'), 'required');
  assert.equal(modeOf('local_receipt_unusable'), 'receipt_only');
  assert.equal(modeOf('evidence_incomplete'), 'optional');
});

test('values are shown only when they are safe: short ids, plain names, instants; never guessed when absent', () => {
  const hostile = describe('engine', {detail: {receipt_engine: 'not-a-sha', current_engine: SHA_B + 'x', base_branch: 'a b`c', file: 5, expires: 'later', changed: 'secrets'}});
  assert.ok(hostile.sentence.includes('an older Clouseau engine') && hostile.sentence.includes('the current protected engine'));
  assert.ok(hostile.steps.at(-3).includes('--base origin/BASE_BRANCH'), 'an unusable branch name stays a placeholder');
  for (const detail of [undefined, null, 'text', 7]) assert.equal(describe('engine', {detail}).sentence, hostile.sentence);
  assert.ok(describe('revision_head', {}).sentence.includes('an earlier head') && describe('revision_head', {}).sentence.includes('another head'));
  assert.ok(describe('revision_base', {}).sentence.includes('an earlier base') && describe('revision_base', {}).sentence.includes('a newer commit'));
  assert.ok(describe('expired', {detail: {expires: 'later'}}).sentence.endsWith('not yet valid'));
  assert.ok(describe('changed', {detail: {changed: 'secrets'}}).sentence.startsWith('the protected policy or configuration changed'));
  assert.ok(describe('changed', {detail: {changed: 'configuration'}}).sentence.startsWith('the protected configuration changed'));
  assert.ok(describe('source', {detail: {file: '`@\n'}}).sentence.endsWith('the pull request'));
  assert.ok(describe('source', {detail: {file: 'x'.repeat(300)}}).sentence.includes(`\`${'x'.repeat(200)}\``));
  // The pull request number is a number or a visible placeholder.
  assert.ok(describe('revision_base', {number: 7}).steps[0].includes('gh pr update-branch 7`'));
  for (const number of [undefined, 0, -3, 1.5, '7', null]) assert.ok(describe('revision_base', {number}).steps[0].includes('gh pr update-branch PR_NUMBER`'));
  for (const unknown of ['nope', 'toString', '__proto__', 7, null, undefined]) assert.equal(describe(unknown), null);
});

test('the receipt cause reaches the incomplete comment for both receipt holds, in the reason, cause line and steps', () => {
  for (const [name, detail] of RECEIPT_ROWS.map(([n, d]) => [n, d])) for (const cause of ['local_receipt_required', 'local_receipt_unusable']) {
    const found = describe(name, {mode: modeOf(cause), number: 42, detail: {...detail, base_branch: 'trunk'}});
    const text = body({number: 42, head_sha: SHA_A, cause, reason: `Held (${found.sentence}).`, receipt_notice: name, receipt_notice_detail: {...detail, base_branch: 'trunk'}}, URL);
    assert.ok(text.includes(`**Cause:** \`${cause}\` (\`receipt_${name}\`)`), `${name}/${cause}`);
    assert.ok(text.includes(`**Reason:** Held (${found.sentence}).`), `${name}/${cause}`);
    assert.ok(text.includes(`**Next steps:** ${found.lead}\n\n${numbered(found.steps)}`), `${name}/${cause}`);
  }
});

test('every incomplete cause class has a numbered, runnable first step and reads as one notice', () => {
  for (const [cause, steps] of Object.entries(NEXT_STEPS)) {
    assert.ok(steps.length >= 1, cause);
    const text = body({number: 42, head_sha: SHA_A, cause, reason: 'DEEPSEEK_API_KEY is not configured'}, URL);
    assert.ok(text.includes(`**Cause:** \`${cause}\``), cause);
    assert.match(text, /\*\*Next steps:\*\*\n\n1\. /, cause);
    assert.ok(!/[{}]/.test(text.replace(/`\/approve-intent [a-f0-9]{40}`/, '')), `${cause}: every placeholder is filled`);
  }
  assert.ok(Object.hasOwn(NEXT_STEPS, 'provider_payment_required') && Object.hasOwn(NEXT_STEPS, 'decision_mismatch'));
});

test('every pending state says why verification has not finished and what, if anything, the customer does', () => {
  for (const [state, steps] of Object.entries(PENDING_STEPS)) {
    const text = pendingBody({number: 42, head_sha: SHA_A, reason: 'Waiting', verification: state}, URL);
    assert.ok(text.includes(`**Cause:** \`verification_pending_${state}\``), state);
    assert.ok(text.includes(`state: ${state}`), state);
    assert.match(text, /\*\*Next steps:\*\*\n\n1\. /, state);
    assert.equal(steps.length > 1, state === 'absent', `${state}: only a run that never started needs the customer`);
  }
  const absent = pendingBody({number: 42, head_sha: SHA_A, reason: 'Waiting', verification: 'absent'}, URL);
  assert.ok(absent.includes('2. A pull request opened before that workflow was installed has no run: update the branch so one starts: `gh pr update-branch 42`.'));
  for (const hostile of ['toString', 'x', undefined, 4]) {
    const text = pendingBody({number: 42, head_sha: SHA_A, verification: hostile}, URL);
    assert.ok(text.includes('state: unknown') && text.includes('verification_pending_unknown'));
  }
});

test('every gate stop and every maintainer request names its cause class and a numbered step', () => {
  const context = {repo: 'example/product', run: '9', head: SHA_A, number: '42'};
  for (const [cause, steps] of Object.entries(INTENT)) {
    const text = intentBlock(cause, context);
    assert.ok(text.startsWith(`**Cause:** \`${cause}\`\n\n**Next steps:**\n\n1. `), cause);
    assert.ok(steps.every(step => text.includes(step.replaceAll('{head}', SHA_A).replaceAll('{repo}', 'example/product').replaceAll('{number}', '42'))), cause);
    assert.ok(!/[{}]/.test(text), cause);
  }
  assert.ok(intentBlock('intent_owner_decision', context).includes(`\`/approve-intent ${SHA_A}\``));
  const control = 'Protected review controls changed';
  assert.equal(intentCause({selfAuthored: true, scope: control, controlReason: control}), 'intent_bot_authored');
  assert.equal(intentCause({selfAuthored: false, scope: null, controlReason: control}), 'intent_owner_decision');
  assert.equal(intentCause({selfAuthored: false, scope: control, controlReason: control}), 'intent_protected_controls');
  assert.equal(intentCause({selfAuthored: false, scope: 'Incomplete patch', controlReason: control}), 'intent_incomplete_patch');
  const samples = {
    gate_verification_failed: 'PR verification concluded failure: job "verify" (https://example.test/job)',
    auto_merge_not_armed: 'Auto-merge was not enabled on the assessed revision',
    auto_merge_must_be_off: 'Automatic merge remains enabled for a PR that requires manual merge',
    assessment_pending: 'AI assessment must finish after successful verification before the native policy job can pass',
    intent_required: 'A maintainer intent confirmation is required',
    revision_changed: 'PR changed before approval',
    verification_not_finished: 'Verification is pending; authorize fork CI or rerun this controller after CI completes',
    confirmation_withdrawn: 'Maintainer confirmation was withdrawn',
    ownership_changed: 'Code ownership changed before automatic approval',
    code_owner_approval_required: 'A current-head code-owner approval is required; automatic merge is disabled',
    protection_mode_changed: 'Private-plan acceptance mode changed before approval',
  };
  assert.deepEqual(Object.keys(samples).sort(), FAILURES.map(([, cause]) => cause).sort(), 'one sample per failure class');
  for (const [, cause, steps] of FAILURES) {
    const text = failureBlock(samples[cause], context);
    assert.ok(text.startsWith(`${samples[cause]}\n\n**Cause:** \`${cause}\`\n\n**Next steps:**\n\n1. `), cause);
    assert.ok(text.includes(numbered(steps.map(step => step.replaceAll('{head}', SHA_A).replaceAll('{repo}', 'example/product').replaceAll('{run}', '9').replaceAll('{number}', '42')))), cause);
    assert.ok(!/[{}]/.test(text), cause);
  }
  assert.ok(failureBlock('PR changed while verification was running', context).includes('`revision_changed`'));
  assert.ok(failureBlock('Stale intent assessment: reassess the current PR revision', context).includes('`revision_changed`'));
  const unknown = failureBlock('Something the gate has never said', context);
  assert.ok(unknown.includes(`**Cause:** \`${GENERIC[0]}\``) && unknown.includes('gh run rerun 9 --failed --repo example/product'));
});

test('docs/notices.md lists every cause class a customer can see', () => {
  const docs = fs.readFileSync(path.join(__dirname, '../docs/notices.md'), 'utf8');
  const codes = [
    ...Object.keys(CAUSES).map(name => `receipt_${name}`),
    ...Object.keys(NEXT_STEPS), ...Object.keys(PENDING_STEPS).map(state => `verification_pending_${state}`),
    ...Object.keys(INTENT), ...FAILURES.map(([, cause]) => cause), GENERIC[0],
    'base_moved', 'merge_protection_insufficient', ...Object.keys(conflict.STEPS),
  ];
  for (const code of codes) assert.ok(docs.includes(`\`${code}\``), `docs/notices.md lists ${code}`);
  for (const gap of Object.keys(GAP_STEPS)) assert.ok(docs.includes(gap), `docs/notices.md lists the protection gap ${gap}`);
  assert.equal(new Set(codes).size, codes.length, 'cause classes never collide across notices');
});

test('an ignored receipt line is rendered from the assessment only for a known class', () => {
  const line = noticeLine({receipt_notice: 'revision_base', number: 42, cause: 'evidence_incomplete', receipt_notice_detail: {receipt_base: SHA_A, current_base: SHA_B, base_branch: 'trunk'}});
  assert.match(line, /^\n\nLocal review receipt not used \(cause: `receipt_revision_base`\): it was issued against base `a1b2c3d4e5f6` but the base branch is now at `f6e5d4c3b2a1`\./);
  assert.ok(line.includes('1. Update the branch with the base: `gh pr update-branch 42`'));
  assert.equal(noticeLine({receipt_notice: 'nope'}), '');
});

const localNotices = require('./local-notices.cjs');

test('local review names a missing verification tool and an edited recipe, with the install step for the tools it knows', () => {
  const cmd = (argv, extra = {}) => ({argv, exit_code: 0, stdout: '', stderr: '', ...extra});
  const enoent = argv => cmd(argv, {exit_code: null, error: {code: 'ENOENT', message: 'spawn ENOENT'}});
  const rows = [
    ['a program that cannot start', [enoent(['coverage', 'run'])], ['coverage'], 'Install coverage.py: `python3 -m pip install -r requirements-test.txt`'],
    ['a python module', [cmd(['python3', '-m', 'coverage'], {exit_code: 1, stderr: "/usr/bin/python3: No module named coverage"})], ['coverage'], 'Install coverage.py'],
    ['a dotted python module', [cmd(['python3'], {exit_code: 1, stderr: "No module named 'coverage.cmdline'"})], ['coverage'], 'Install coverage.py'],
    ['a shell tool', [cmd(['npm', 'run', 'cov'], {exit_code: 127, stdout: 'sh: 1: c8: not found'})], ['c8'], 'Install the repository\'s dev dependencies, which include c8: `npm ci`'],
    ['a command-not-found tool', [cmd(['npm'], {exit_code: 127, stderr: 'bash: go: command not found'})], ['go'], 'Install `go` and put it on PATH.'],
    ['node', [enoent(['node'])], ['node'], 'Install Node.js and make sure `node` is on PATH.'],
    ['an unnamed program', [enoent(['not a/plain name'])], [null], 'Install the missing program and put it on PATH.'],
  ];
  for (const [name, commands, tools, step] of rows) {
    assert.deepEqual(localNotices.missingTools({commands}), tools, name);
    const [notice] = localNotices.localNotices({paths: ['src/a.js'], technical: {commands}, baseBranch: 'main'});
    assert.equal(notice.cause, 'verification_tool_missing', name);
    const text = localNotices.render(notice);
    assert.ok(text.startsWith('Local review notice (cause: `verification_tool_missing`): '), name);
    assert.ok(text.includes(`\n\n1. ${step}`) && text.includes('\n2. Run the review again on the same commit'), `${name}: ${text}`);
  }
  assert.ok(localNotices.describeTool('python3').steps[0].includes('Install Python 3'));
  assert.ok(localNotices.describeTool('npm').steps[0].includes('provides `npm`'));
  // Nothing found: a passing command, a failure with no phrase, and evidence with no commands at all.
  for (const technical of [{commands: [cmd(['node'], {stderr: 'No module named x'})]}, {commands: [cmd(['node'], {exit_code: 1, stderr: 'boom'})]},
    {commands: [{argv: undefined, exit_code: 1}]}, {}, undefined, null]) assert.deepEqual(localNotices.missingTools(technical), []);
  // Each tool once, at most three.
  assert.deepEqual(localNotices.missingTools({commands: ['a', 'b', 'a', 'c', 'd'].map(name => enoent([name]))}), ['a', 'b', 'c']);
  const recipe = localNotices.localNotices({paths: ['.clouseau-local.json'], technical: {}, baseBranch: 'trunk'});
  assert.deepEqual(recipe.map(notice => notice.cause), ['local_recipe_edited']);
  const text = localNotices.render(recipe[0]);
  assert.ok(text.includes('this change edits `.clouseau-local.json`, so the local review verified the recipe from `trunk`, not your edit'));
  assert.match(text, /\n\n1\. If the edit is wanted, land it in its own pull request first/);
  assert.deepEqual(localNotices.localNotices({paths: ['src/a.js'], technical: {}, baseBranch: 'trunk'}), []);
});

test('the notices that were already specific are proven to name their condition, and say why they need no cause table', async () => {
  // Managed AGENTS.md hold: a stable sentence per decided change, followed by the protected-control cause when it holds.
  const managed = require('./managed-agents.cjs');
  const config = {managed_agents: {digests: []}};
  const held = await managed.exemptions({github: {}, repo: {}, pr: {head: {repo: null}}, config,
    files: [{filename: 'AGENTS.md', status: 'modified'}]});
  assert.deepEqual(held.notices, ['AGENTS.md stays a protected-control hold: the head repository is unavailable.']);
  const renamed = await managed.exemptions({github: {}, repo: {}, pr: {}, config, files: [{filename: 'AGENTS.md', status: 'renamed'}]});
  assert.deepEqual(renamed.notices, ['AGENTS.md stays a protected-control hold: only a modification of the existing file qualifies.']);
  assert.equal(managed.judge({baseText: 'none', headText: 'none', digests: []}).reason, 'the head file does not contain exactly one well-formed managed block');
  // The exact-revert hold: every verdict carries its reason, and a stale base says what to do.
  const exact = require('./exact-revert.cjs');
  const pr = {head: {sha: 'e'.repeat(40)}, base: {sha: 'b'.repeat(40)}};
  const world = (status, headSha) => ({rest: {repos: {
    getCommit: async () => ({data: {sha: headSha, commit: {tree: {sha: '1'.repeat(40)}}}}),
    compareCommitsWithBasehead: async () => ({data: {status, merge_base_commit: {sha: 'b'.repeat(40)}}}),
    listCommits: async () => ({data: []})}}});
  assert.equal((await exact.verify({github: world('ahead', 'f'.repeat(40)), repo: {}, pr, window: 5})).reason, 'the head commit tree is unavailable');
  assert.match((await exact.verify({github: world('diverged', pr.head.sha), repo: {}, pr, window: 5})).reason, /update the branch$/);
  assert.equal((await exact.verify({github: world('ahead', pr.head.sha), repo: {}, pr, window: 5})).reason, 'the base history is unavailable');
  // The installation settings notice names the condition and the way out.
  const {SETTINGS_NOTICE} = require('./installation-cli.cjs');
  assert.ok(SETTINGS_NOTICE.includes('unprotected private base branch or unreadable auto-merge setting') &&
    SETTINGS_NOTICE.includes('until a maintainer merges manually or protects the base branch'));
  const docs = fs.readFileSync(path.join(__dirname, '../docs/notices.md'), 'utf8');
  for (const heading of ['managed AGENTS.md hold', 'exact-revert hold', 'installation settings notice', 'repair-reservation comment', 'local_recipe_edited', 'verification_tool_missing']) {
    assert.ok(docs.includes(heading), `docs/notices.md covers ${heading}`);
  }
});
