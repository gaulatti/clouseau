import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
import {parse} from 'yaml';

const workflow = parse(readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
const verify = workflow.jobs.verify;
const upload = verify.steps.find(step => step.name === 'Retain native verification traces');
const typed = value => value == null ? new data.Null() : typeof value === 'boolean' ? new data.BooleanData(value) :
  typeof value === 'string' ? new data.StringData(value) : new data.Dictionary(...Object.entries(value)
    .map(([key, value]) => ({key, value: typed(value)})));
function evaluate(expression, context, alwaysValue = true) {
  const always = {name: 'always', minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(alwaysValue)};
  const ast = new Parser(new Lexer(expression).lex().tokens, Object.keys(context), [always]).parse();
  return new Evaluator(ast, typed(context), new Map([['always', always]])).evaluate().value;
}

test('the actual retention guard follows every code-verification event and still runs after a failed check', () => {
  assert.match(upload.if.trim(), /^always\(\)\s*&&/);
  for (const [event, deleted, pullRequest, expected] of [
    ['push', false, '', true], ['push', true, '', false], ['pull_request', false, '', true],
    ['workflow_dispatch', false, '', true], ['workflow_dispatch', false, '19', false],
    ['pull_request_target', false, '', false], ['issue_comment', false, '', false],
  ]) {
    const context = {github: {event_name: event, event: {deleted}}, inputs: {pull_request: pullRequest},
      job: {status: 'failure'}};
    assert.equal(evaluate(verify.steps[0].if, context), expected);
    assert.equal(evaluate(upload.if, context), expected, `${event}/${deleted}/${pullRequest}`);
    assert.equal(evaluate(upload.if, context, false), false);
  }
});

test('the upload retains whole same-run traces without new permissions or replacing an earlier attempt', () => {
  assert.equal(upload.uses, 'actions/upload-artifact@v4');
  assert.deepEqual(upload.with, {name: 'native-verification-${{ github.run_id }}-${{ github.run_attempt }}',
    path: '.clouseau-work/verification-runs', 'include-hidden-files': true, 'if-no-files-found': 'warn'});
  assert.equal(Object.hasOwn(upload.with, 'overwrite'), false);
  assert.deepEqual(workflow.permissions, {contents: 'read'});
  assert.equal(verify.permissions, undefined);
  assert.equal(verify['timeout-minutes'], 10);
  assert.equal(verify['runs-on'], 'ubuntu-latest');
  assert.equal(verify.steps.at(-1), upload);
});

test('hosted archive execution uses the retained-report script while every independent native gate remains', () => {
  const archived = verify.steps.find(step => step.name === 'Test distributable action without Git metadata');
  assert.equal(archived.run, './scripts/verify-archive'); assert.equal(archived.shell, 'bash');
  assert.equal(archived.if, verify.steps[0].if);
  assert.equal(verify.steps.find(step => step.name === 'Enforce 100% line and branch coverage').run, './scripts/verify-coverage');
  assert.deepEqual(verify.steps.find(step => step.name === 'Test approval policy').with, {operation: 'test'});
  for (const name of ['Test workflow security', 'Build coverage contract fixtures', 'Accept complete application coverage',
    'Reject a missing branch', 'Verify rejection is enforced', 'Accept complete multi-artifact application coverage',
    'Reject an uncovered multi-artifact component', 'Verify multi-artifact rejection is enforced']) {
    const step = verify.steps.find(step => step.name === name); assert.ok(step, name); assert.equal(step.if, verify.steps[0].if);
  }
  assert.equal(verify.steps.find(step => step.id === 'gap')['continue-on-error'], true);
  assert.equal(verify.steps.find(step => step.id === 'multi-gap')['continue-on-error'], true);
  assert.equal(verify.steps.find(step => step.name === 'Verify rejection is enforced').run, 'test "$GAP_OUTCOME" = failure');
  assert.equal(verify.steps.find(step => step.name === 'Verify multi-artifact rejection is enforced').run, 'test "$MULTI_GAP_OUTCOME" = failure');
});
