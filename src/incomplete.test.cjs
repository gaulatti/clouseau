'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ReceiptRejected, noticeText, noticeLine} = require('./receipt-rejection.cjs');
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
  // A refused payment is not an outage and not a bad key: it has its own cause and its own step.
  assert.deepEqual(classify(new Error('Acceptance provider unavailable: HTTP 402')),
    {cause: 'provider_payment_required', reason: 'Acceptance provider refused the request because the account has no credit or billing (the credential was accepted) (HTTP 402).'});
  for (const error of [new Error(`Headers.append: "Bearer ${SECRET}" is an invalid header value`), {}, null, undefined]) {
    assert.deepEqual(classify(error), {cause: 'evidence_incomplete', reason: GENERIC});
  }
});

test('every cause names its class and has numbered steps; unknown causes fall to the diagnostic steps', () => {
  const assessment = {number: 5, head_sha: 'a'.repeat(40), reason: 'Reason @owner\nsecond   line'};
  for (const cause of Object.keys(NEXT_STEPS)) {
    const text = body({...assessment, cause}, 'https://github.com/example/product/actions/runs/9');
    assert.ok(text.startsWith(`${MARKER}\n`));
    assert.ok(text.includes(`**Cause:** \`${cause}\``));
    const steps = NEXT_STEPS[cause];
    steps.forEach((step, index) => assert.ok(text.includes(`${index + 1}. ${step.replaceAll('{head}', assessment.head_sha).replaceAll('{repo}', 'example/product')
      .replaceAll('{run}', '9').replaceAll('{number}', '5').replaceAll('{secret}', 'SECRET_NAME')}`), `${cause}: step ${index + 1}`));
    assert.ok(!/\{[a-z]+\}/.test(text), `${cause}: every placeholder is filled`);
    assert.ok(text.includes('Reason owner second line'), 'mentions are neutralized and whitespace collapsed');
    assert.ok(text.includes('actions/runs/9') && text.includes('aaaaaaaaaaaa'));
    // Only the maintainer commands carry the full revision.
    assert.equal(text.includes('a'.repeat(13)), ['receipt_protected_controls', 'hosted_review_manual'].includes(cause));
    if (cause === 'receipt_protected_controls') assert.ok(text.includes(`\`/approve-intent ${assessment.head_sha}\``));
    if (cause === 'hosted_review_manual') assert.ok(text.includes(`\`/hosted-review ${assessment.head_sha}\``));
    assert.ok(!text.includes('artifact'), 'no incomplete notice names an artifact that may not exist in this transport');
    assert.match(text, /no secret values/);
  }
  const generic = body({...assessment, cause: 'unknown'}, 'u');
  assert.ok(generic.includes('**Cause:** `evidence_incomplete`'), 'a cause that is not in the table is never printed');
  assert.ok(generic.includes('1. Open the log of the failed assessment job'));
  assert.ok(body({...assessment}, 'u').includes('**Cause:** `evidence_incomplete`'));
  assert.ok(body({...assessment, cause: '<script>'}, 'u').includes('**Cause:** `evidence_incomplete`') && !body({...assessment, cause: '<script>'}, 'u').includes('<script>'));
  assert.ok(body({...assessment, reason: 'x'.repeat(900)}, 'u').length < 2200);
  // A run link that is not a GitHub run link keeps visible placeholders; they are never guessed.
  assert.ok(body({...assessment, cause: 'provider_unavailable'}, 'u').includes('gh run rerun RUN_ID --failed --repo OWNER/REPO'));
});

test('the secret named in the reason, and only a name, is the one the steps tell the customer to store', () => {
  const assessment = {number: 5, head_sha: 'a'.repeat(40)};
  const url = 'https://github.com/example/product/actions/runs/9';
  const missing = body({...assessment, cause: 'provider_key_missing', reason: 'DEEPSEEK_API_KEY is not configured'}, url);
  assert.ok(missing.includes('1. Add the provider key repository secret named in the reason: `gh secret set DEEPSEEK_API_KEY --repo example/product`.'));
  const invalid = body({...assessment, cause: 'provider_key_invalid', reason: 'TYPESAFE_API_KEY contains whitespace or a line break'}, url);
  assert.ok(invalid.includes('`gh secret set TYPESAFE_API_KEY --repo example/product`'));
  assert.ok(body({...assessment, cause: 'provider_key_invalid', reason: 'lower case'}, url).includes('`gh secret set SECRET_NAME --repo example/product`'));
});

test('each ignored-receipt cause is shown on incomplete and pending comments, and nothing else is forwarded', () => {
  const assessment = {number: 5, head_sha: 'a'.repeat(40), reason: 'Reason', cause: 'evidence_incomplete', verification: 'queued'};
  const line = noticeText('engine', {mode: 'optional', number: 5, detail: {receipt_engine: 'e'.repeat(40), current_engine: 'd'.repeat(40)}});
  assert.match(line, /^Local review receipt not used \(cause: `receipt_engine`\): it was issued by Clouseau engine `eeeeeeeeeeee` and this run uses engine `dddddddddddd`, which does not list that engine as review-compatible\. CI reviewed this change itself, so no action is needed\./);
  const detailed = {receipt_notice: 'engine', receipt_notice_detail: {receipt_engine: 'e'.repeat(40), current_engine: 'd'.repeat(40)}};
  assert.ok(body({...assessment, ...detailed}, 'u').includes(`\n\n${line}`));
  assert.ok(pendingBody({...assessment, ...detailed}, 'u').includes(`\n\n${line}`));
  assert.ok(!body(assessment, 'u').includes('not used'));
  assert.ok(!pendingBody(assessment, 'u').includes('not used'));
  for (const hostile of ['attacker text', 'toString', '__proto__', 7, null, {x: 1}]) {
    assert.ok(!body({...assessment, receipt_notice: hostile}, 'u').includes('not used'));
    assert.equal(noticeLine({receipt_notice: hostile}), '');
  }
  // A repository that requires a receipt cannot be reviewed by CI instead; its Cause and Next steps carry the receipt's own.
  const required = body({...assessment, cause: 'local_receipt_required', receipt_notice: 'signature', number: 5}, 'u');
  assert.ok(required.includes('**Cause:** `local_receipt_required` (`receipt_signature`)'));
  assert.ok(required.includes('This repository requires a valid receipt, so nothing is approved until you do the following.'));
  assert.ok(required.includes('1. Sign with an enrolled identity'));
  assert.ok(!required.includes('CI reviewed this change itself') && !required.includes('Local review receipt not used'));
  // An old assessment without a receipt class still gets the generic steps for its cause.
  assert.ok(body({...assessment, cause: 'local_receipt_required'}, 'u').includes('1. Run the local Clouseau review on this exact head'));
});

test('a patch rejection notice names the file and strips markup from it', () => {
  const line = noticeLine({receipt_notice: 'source', receipt_notice_detail: {file: 'tests/`a`@x\n.py', base_branch: 'main'}, cause: 'evidence_incomplete', number: 5});
  assert.match(line, /^\n\nLocal review receipt not used \(cause: `receipt_source`\): the reviewed sources or diff differ from the pull request \(file: `tests\/ax\.py`\)\. CI reviewed this change itself/);
  assert.equal(noticeLine({receipt_notice: 'source', receipt_notice_detail: {file: 7}}), noticeLine({receipt_notice: 'source'}));
  assert.equal(noticeLine({receipt_notice: 'source', receipt_notice_detail: {file: '`@\n'}}), noticeLine({receipt_notice: 'source'}));
  assert.ok(!noticeLine({receipt_notice: 'source'}).includes('file:'));
});

test('a rejection is a closed class and its detail is the receipt rejection\'s own', () => {
  const error = new ReceiptRejected('source', 'sentinel');
  assert.equal(error.reason, 'source');
  assert.equal(error.message, 'Invalid local review receipt: sentinel');
  assert.deepEqual(error.detail, {});
  assert.deepEqual(new ReceiptRejected('source', 'x', {file: 'a'}).detail, {file: 'a'});
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
  const named = classify(new Error('Invalid acceptance evidence: changed source cannot be excluded: src/a_b.py has content, so mark it inspected and cite a quote from it'));
  assert.equal(named.cause, 'review_output_invalid');
  assert.match(named.reason, /attempts: changed source cannot be excluded: src\/a_b\.py has content, so mark it inspected and cite a quote from it\.$/);
  assert.equal(classify(new Error('Invalid acceptance evidence: <script>alert(1)</script> $secret')).reason.endsWith('3 consecutive attempts.'), true);
});
