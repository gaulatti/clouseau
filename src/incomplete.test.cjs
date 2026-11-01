'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PHRASES, ReceiptRejected, noticeText, noticeLine} = require('./receipt-rejection.cjs');
const {classify, body, pendingBody, post, annotate, MARKER, NEXT_STEPS, GENERIC} = require('./incomplete.cjs');

const SECRET = 'sk-fictional-secret-value';

test('failures map to fixed, secret-free causes and never forward raw error text', () => {
  const keyError = Object.assign(new Error('DEEPSEEK_API_KEY contains whitespace or a line break'), {code: 'PROVIDER_KEY', cause_code: 'provider_key_invalid'});
  assert.deepEqual(classify(keyError), {cause: 'provider_key_invalid', reason: keyError.message});
  assert.deepEqual(classify(new Error('Acceptance provider unavailable: HTTP 401')),
    {cause: 'provider_rejected', reason: 'Acceptance provider rejected the credential (HTTP 401).'});
  assert.deepEqual(classify(new Error('Jev provider unavailable: HTTP 403')),
    {cause: 'provider_rejected', reason: 'Jev provider rejected the credential (HTTP 403).'});
  assert.deepEqual(classify(new Error('Acceptance provider unavailable: HTTP 503')),
    {cause: 'provider_unavailable', reason: 'Acceptance provider was unavailable (HTTP 503).'});
  for (const error of [new Error(`Headers.append: "Bearer ${SECRET}" is an invalid header value`), {}, null, undefined]) {
    assert.deepEqual(classify(error), {cause: 'evidence_incomplete', reason: GENERIC});
  }
});

test('every cause has a specific next step and unknown causes fall to the diagnostic step', () => {
  const assessment = {number: 5, head_sha: 'a'.repeat(40), reason: 'Reason @owner\nsecond   line'};
  for (const cause of Object.keys(NEXT_STEPS)) {
    const text = body({...assessment, cause}, 'https://github.com/example/product/actions/runs/9');
    assert.ok(text.startsWith(`${MARKER}\n`));
    assert.ok(text.includes(NEXT_STEPS[cause].replaceAll('{head}', assessment.head_sha)));
    assert.ok(text.includes('Reason owner second line'), 'mentions are neutralized and whitespace collapsed');
    assert.ok(text.includes('actions/runs/9') && text.includes('aaaaaaaaaaaa'));
    // Only the maintainer command carries the full revision.
    assert.equal(text.includes('a'.repeat(13)), cause === 'receipt_protected_controls');
    if (cause === 'receipt_protected_controls') assert.ok(text.includes(`\`/approve-intent ${assessment.head_sha}\``));
    assert.ok(!text.includes('artifact'), 'no incomplete notice names an artifact that may not exist in this transport');
    assert.match(text, /no secret values/);
  }
  assert.ok(body({...assessment, cause: 'unknown'}, 'u').includes(NEXT_STEPS.evidence_incomplete));
  assert.ok(body({...assessment}, 'u').includes(NEXT_STEPS.evidence_incomplete));
  assert.ok(body({...assessment, reason: 'x'.repeat(900)}, 'u').length < 1400);
});

test('an ignored-receipt notice is one fixed line on incomplete and pending comments, and nothing else is forwarded', () => {
  const assessment = {number: 5, head_sha: 'a'.repeat(40), reason: 'Reason', cause: 'evidence_incomplete', verification: 'pending'};
  const line = noticeText('engine', false);
  assert.equal(line, 'Local review receipt ignored because it predates the current Clouseau engine; CI reviewed this change itself.');
  assert.ok(body({...assessment, receipt_notice: 'engine'}, 'u').includes(`\n\n${line}\n\n`));
  assert.ok(pendingBody({...assessment, receipt_notice: 'engine'}, 'u').includes(`\n\n${line}\n\n`));
  assert.ok(!body(assessment, 'u').includes('ignored'));
  assert.ok(!pendingBody(assessment, 'u').includes('ignored'));
  for (const hostile of ['attacker text', 'toString', '__proto__', 7, null, {x: 1}]) {
    assert.ok(!body({...assessment, receipt_notice: hostile}, 'u').includes('ignored'));
    assert.equal(noticeLine({receipt_notice: hostile}), '');
  }
  // A repository that requires a receipt cannot be reviewed by CI instead, so the line says what to do.
  const required = body({...assessment, cause: 'local_receipt_required', receipt_notice: 'signature'}, 'u');
  assert.ok(required.includes('Local review receipt ignored because its signature is not from an enrolled, active key; this repository requires a valid receipt, so run the local review again.'));
  assert.ok(!required.includes('CI reviewed this change itself'));
  assert.ok(!NEXT_STEPS.engine_mismatch && !NEXT_STEPS.receipt_patch_mismatch);
});

test('every receipt rejection class has exactly one fixed single-line sentence', () => {
  assert.deepEqual(Object.keys(PHRASES).sort(), ['author', 'changed', 'engine', 'expired', 'held', 'malformed', 'not_passing', 'record',
    'revision', 'settings', 'signature', 'source', 'unavailable']);
  for (const reason of Object.keys(PHRASES)) for (const required of [false, true]) {
    const text = noticeText(reason, required);
    assert.match(text, /^Local review receipt ignored because [^\n]+\.$/);
    assert.equal(noticeLine({receipt_notice: reason, cause: required ? 'local_receipt_required' : 'evidence_incomplete'}), `\n\n${text}`);
  }
  const error = new ReceiptRejected('source', 'sentinel');
  assert.equal(error.reason, 'source');
  assert.equal(error.message, 'Invalid local review receipt: sentinel');
});

test('the notice is created once and then updated in place', async () => {
  const comments = []; const writes = [];
  const github = {rest: {issues: {
    listComments: async () => ({data: comments}),
    createComment: async args => {writes.push(['create', args]); comments.push({id: 77, user: {login: 'github-actions[bot]'}, body: args.body});},
    updateComment: async args => {writes.push(['update', args]);},
  }}, paginate: async (method, args) => (await method(args)).data};
  comments.push({id: 1, user: {login: 'someone'}, body: `${MARKER}\nforged by another user`});
  const context = {repo: {owner: 'example', repo: 'product'}, runId: 42};
  const assessment = {number: 5, head_sha: 'a'.repeat(40), cause: 'provider_key_invalid', reason: 'DEEPSEEK_API_KEY contains whitespace or a line break'};
  await post({github, context, assessment});
  await post({github, context, assessment: {...assessment, head_sha: 'b'.repeat(40)}});
  assert.deepEqual(writes.map(([kind]) => kind), ['create', 'update']);
  assert.equal(writes[1][1].comment_id, 77);
  assert.equal(writes[0][1].issue_number, 5);
  assert.ok(writes[0][1].body.includes('https://github.com/example/product/actions/runs/42'));
  assert.ok(writes[1][1].body.includes('bbbbbbbbbbbb'));
});

test('an annotation is raised only for an incomplete review', () => {
  const warnings = [];
  const core = {warning: line => warnings.push(line)};
  annotate({core, assessment: {decision: 'auto_approve'}});
  annotate({core, assessment: {decision: 'review_incomplete', cause: 'provider_key_invalid', reason: 'KEY problem'}});
  annotate({core, assessment: {decision: 'review_incomplete', reason: 'no cause'}});
  assert.deepEqual(warnings, ['Clouseau review incomplete (provider_key_invalid): KEY problem',
    'Clouseau review incomplete (evidence_incomplete): no cause']);
});

test('classification names the unreadable file, and shows validation detail only when it is a plain constant', () => {
  assert.match(classify(Object.assign(new Error('x'), {unavailable: true})).reason, /Changed file unknown cannot be read/);
  assert.match(classify(Object.assign(new Error('x'), {unavailable: true, path: 'src/a.ts'})).reason, /Changed file src\/a\.ts cannot/);
  assert.equal(classify(new Error('Invalid acceptance evidence: factor value')).reason.endsWith('attempts: factor value.'), true);
  assert.equal(classify(new Error('Invalid acceptance evidence: <script>alert(1)</script> $secret')).reason.endsWith('3 consecutive attempts.'), true);
});
