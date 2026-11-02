import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
import {truthy} from '@actions/expressions/result';
import {parse} from 'yaml';

// The reference consumer workflow: a receipt marker routes to a job without provider secrets; an unusable receipt
// then hands the SAME run to a separate secret-bearing hosted review that never reads the receipt.
const text = readFileSync(new URL('../../examples/consumer-ci.yml', import.meta.url), 'utf8');
const workflow = parse(text);
const {jobs} = workflow;
const intent = jobs['assess-intent'];
const hosted = jobs['assess-hosted'];
const typed = value => value === null ? new data.Null() : typeof value === 'boolean' ? new data.BooleanData(value) :
  typeof value === 'number' ? new data.NumberData(value) : typeof value === 'string' ? new data.StringData(value) :
    Array.isArray(value) ? new data.Array(...value.map(typed)) :
      new data.Dictionary(...Object.entries(value).map(([key, item]) => ({key, value: typed(item)})));
const always = {name: 'always', minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(true)};
function evaluate(source, context) {
  const expression = source.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const ast = new Parser(new Lexer(expression).lex().tokens, Object.keys(context), [always]).parse();
  return new Evaluator(ast, typed(context), new Map([['always', always]])).evaluate();
}
const REVIEW_EVENT = {github: {event_name: 'pull_request_target', ref: 'refs/heads/x', event: {deleted: false, pull_request: {draft: false}}}};
const unusable = {decision: 'review_incomplete', cause: 'local_receipt_unusable', receipt_notice: 'revision'};
const trusted = {decision: 'auto_approve', record_digest: 'a'.repeat(64), review_source: 'authenticated_local', provider_api_calls: 0};
const hostedDecision = {decision: 'auto_approve', record_digest: 'b'.repeat(64)};

async function fallbackOutput(assessment) {
  const step = intent.steps.find(item => item.id === 'fallback');
  const outputs = {};
  await runInNewContext(`(async () => {${step.with.script}\n})()`, {
    process: {env: {ASSESSMENT: JSON.stringify(assessment)}}, core: {setOutput: (key, value) => {outputs[key] = value;}}});
  return outputs.hosted;
}

test('the fallback runs only for an unusable optional receipt, never for a trusted, absent or required one', async () => {
  assert.equal(await fallbackOutput(unusable), 'true');
  for (const assessment of [trusted, {decision: 'review_incomplete', cause: 'local_receipt_required'},
    {decision: 'review_incomplete', cause: 'provider_rejected'}, {decision: 'blocked_technical'},
    {decision: 'auto_approve', cause: 'local_receipt_unusable'}]) assert.equal(await fallbackOutput(assessment), 'false');
  assert.equal(intent.outputs.hosted, '${{ steps.fallback.outputs.hosted }}');
  const route = intent.steps.find(step => step.id === 'review-route');
  assert.equal(intent.steps.find(step => step.id === 'fallback').if, "steps.review-route.outputs.local == 'true'");
  assert.ok(route, 'the marker still selects the receipt-only route');
  for (const [hostedOutput, runs] of [['true', true], ['false', false], ['', false]]) {
    const context = {needs: {'assess-intent': {result: 'success', outputs: {hosted: hostedOutput}}}};
    assert.equal(truthy(evaluate(hosted.if, context)), runs, `hosted output ${JSON.stringify(hostedOutput)}`);
  }
});

test('a valid receipt stays on the receipt-only route: no hosted job, no provider credential, the receipt-only assessment is used', () => {
  const verifyLocal = intent.steps.find(step => step.id === 'local-review');
  assert.equal(verifyLocal.with.operation, 'verify-local');
  assert.ok(!JSON.stringify([intent.env, intent.steps.filter(step => step.id !== 'assess')]).includes('secrets.'),
    'only the unstamped-route step of the receipt-only job references a secret');
  assert.equal(intent.steps.find(step => step.id === 'assess').if, "steps.review-route.outputs.local != 'true'");
  assert.equal(truthy(evaluate(hosted.if, {needs: {'assess-intent': {result: 'success', outputs: {hosted: 'false'}}}})), false);
  const select = source => evaluate(source, {needs: {'assess-hosted': {result: 'skipped', outputs: {assessment: '', 'review-record': ''}},
    'assess-intent': {outputs: {assessment: JSON.stringify(trusted), 'review-record': 'intent-record'}}}}).coerceString();
  const gate = jobs['approve-and-merge'].steps.find(step => step.with?.operation === 'gate');
  assert.deepEqual(JSON.parse(select(gate.with.assessment)), trusted);
  assert.equal(select(gate.with['review-record']), 'intent-record');
});

test('an unusable receipt runs the hosted review in a separate secret-bearing job whose decision and record are the ones used', () => {
  const secretJobs = Object.entries(jobs).filter(([, job]) => JSON.stringify(job).includes('secrets.DEEPSEEK_API_KEY')).map(([name]) => name);
  assert.deepEqual(secretJobs.sort(), ['assess-hosted', 'assess-intent'], 'the two reviewers are the only provider-secret holders');
  const review = hosted.steps.find(step => step.id === 'assess');
  assert.equal(review.with.operation, 'assess'); assert.equal(review.with['ignore-receipt'], 'true');
  assert.equal(review.with['provider-key'], '${{ secrets.DEEPSEEK_API_KEY }}');
  assert.equal(review.with['record-transport'], 'job-output');
  assert.deepEqual(hosted.needs, ['assess-intent', 'resolve-clouseau']);
  const context = {needs: {'assess-hosted': {result: 'success', outputs: {assessment: JSON.stringify(hostedDecision), 'review-record': 'hosted-record'}},
    'assess-intent': {outputs: {assessment: JSON.stringify(unusable), 'review-record': 'intent-record'}}}};
  const select = source => evaluate(source, context).coerceString();
  const gate = jobs['approve-and-merge'].steps.find(step => step.with?.operation === 'gate');
  assert.deepEqual(JSON.parse(select(gate.with.assessment)), hostedDecision);
  assert.equal(select(gate.with['review-record']), 'hosted-record');
  // The completion guard fails the required approval when the hosted review itself did not complete.
  const guard = jobs['approve-and-merge'].steps.find(step => step.name === 'Require a completed assessment').if;
  for (const [intentResult, hostedResult, fails] of [['success', 'success', false], ['success', 'skipped', false], ['failure', 'skipped', true],
    ['success', 'failure', true], ['success', 'cancelled', true]]) {
    assert.equal(truthy(evaluate(guard, {...REVIEW_EVENT, needs: {'assess-intent': {result: intentResult}, 'assess-hosted': {result: hostedResult}}})),
      fails, `${intentResult}/${hostedResult}`);
  }
});

test('the secret-bearing job receives no receipt-derived data: only the PR number and the frozen engine', () => {
  const body = JSON.stringify({...hosted, if: undefined});
  const reads = [...body.matchAll(/needs\.([a-z-]+)\.outputs\.([a-z-]+)/g)].map(match => `${match[1]}.${match[2]}`);
  assert.deepEqual([...new Set(reads)].sort(), ['assess-intent.number', 'resolve-clouseau.digest', 'resolve-clouseau.sha']);
  assert.equal(hosted.if, "needs.assess-intent.outputs.hosted == 'true'", 'the only receipt-route signal is the job gate');
  assert.ok(!/steps\.(local-review|review-route|fallback)|assessment|review-record|receipt-notice/.test(
    JSON.stringify(hosted.steps.map(step => step.with ?? {})).replace('ignore-receipt', '')), 'no step input carries a prior assessment or record');
  assert.equal(hosted.steps[0].with.ref, 'main', 'the controller and configuration come from the base branch, never the PR');
  assert.ok(hosted.steps.every(step => step.with?.['persist-credentials'] !== true));
  assert.equal(hosted.steps.at(-1).with['wait-for-verification'], 'false');
  assert.ok(!hosted.steps.some(step => /clouseau-local-review|body/.test(JSON.stringify(step))), 'the PR description is not consulted');
});

test('every consumer of the review decision uses the same single selection, so one record is consumed per head', () => {
  const selected = 'needs.assess-hosted.outputs.assessment || needs.assess-intent.outputs.assessment';
  const record = 'needs.assess-hosted.outputs.review-record || needs.assess-intent.outputs.review-record';
  let uses = 0;
  for (const name of ['approve-and-merge', 'apply-repair', 'finalize-merge']) {
    for (const step of jobs[name].steps) {
      for (const [key, value] of Object.entries(step.with ?? {})) {
        if (key === 'assessment') {uses++; assert.ok(value.includes(selected), `${name} assessment`);}
        if (key === 'review-record') {uses++; assert.ok(value.includes(record), `${name} review-record`);}
      }
    }
    assert.ok(jobs[name].needs.includes('assess-hosted'), `${name} waits for the hosted review`);
  }
  assert.equal(uses, 5);
  // Never mixes the sources: the repair job reads its digest from the same selection.
  const repair = evaluate(jobs['apply-repair'].if, {...REVIEW_EVENT, github: {...REVIEW_EVENT.github, repository: 'o/r',
    event: {...REVIEW_EVENT.github.event, pull_request: {draft: false, head: {repo: {full_name: 'o/r'}}}}},
  needs: {'assess-intent': {result: 'success', outputs: {assessment: JSON.stringify({repair_digest: ''})}},
    'assess-hosted': {result: 'success', outputs: {assessment: JSON.stringify({repair_digest: 'c'.repeat(64)})}},
    'approve-and-merge': {result: 'failure'}}});
  assert.equal(truthy(repair), true, 'a repair proposed by the hosted review is applied');
});
