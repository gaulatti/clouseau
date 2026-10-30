'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {classify, body, post, annotate, MARKER, NEXT_STEPS, GENERIC} = require('./incomplete.cjs');

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
    assert.ok(text.includes(NEXT_STEPS[cause]));
    assert.ok(text.includes('Reason owner second line'), 'mentions are neutralized and whitespace collapsed');
    assert.ok(text.includes('actions/runs/9') && text.includes('aaaaaaaaaaaa') && !text.includes('a'.repeat(13)));
    assert.match(text, /no secret values/);
  }
  assert.ok(body({...assessment, cause: 'unknown'}, 'u').includes(NEXT_STEPS.evidence_incomplete));
  assert.ok(body({...assessment}, 'u').includes(NEXT_STEPS.evidence_incomplete));
  assert.ok(body({...assessment, reason: 'x'.repeat(900)}, 'u').length < 1400);
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
