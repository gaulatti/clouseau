import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
import {parse} from 'yaml';

const workflow = parse(readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
const verify = workflow.jobs.verify;
const selfTests = workflow.jobs['self-tests'];
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
      job: {status: 'failure'}, needs: {attested: {outputs: {attested: ''}}}};
    assert.equal(evaluate(verify.steps[0].if, context), expected);
    assert.equal(evaluate(selfTests.steps[0].if, context), expected);
    // A receipt that attests the verification skips the receipt-covered steps only; the self-tests and the upload still run.
    const attested = {...context, needs: {attested: {outputs: {attested: 'true'}}}};
    assert.equal(evaluate(verify.steps[0].if, attested), false);
    assert.equal(evaluate(selfTests.steps[0].if, attested), expected);
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
  // Measured verify steps total 576-590 s on the shared runner, which a 10 minute cap cancelled; 20 minutes is the margin.
  assert.equal(verify['timeout-minutes'], 20);
  assert.equal(verify['runs-on'], 'ubuntu-latest');
  assert.equal(verify.steps.at(-1), upload);
});

test('hosted archive execution uses the retained-report script while every independent native gate remains', () => {
  const archived = verify.steps.find(step => step.name === 'Test distributable action without Git metadata');
  assert.equal(archived.run, './scripts/verify-archive'); assert.equal(archived.shell, 'bash');
  assert.equal(archived.if, verify.steps[0].if);
  assert.equal(verify.steps.find(step => step.name === 'Enforce 100% line and branch coverage').run, './scripts/verify-coverage');
  assert.deepEqual(verify.steps.find(step => step.name === 'Test approval policy').with, {operation: 'test'});
  const step = verify.steps.find(step => step.name === 'Test workflow security'); assert.equal(step.if, verify.steps[0].if);
  // The engine's own contract self-tests run in their own job, which no receipt skips.
  for (const name of ['Build coverage contract fixtures', 'Accept complete application coverage',
    'Reject a missing branch', 'Verify rejection is enforced', 'Accept complete multi-artifact application coverage',
    'Reject an uncovered multi-artifact component', 'Verify multi-artifact rejection is enforced']) {
    const step = selfTests.steps.find(step => step.name === name); assert.ok(step, name); assert.equal(step.if, selfTests.steps[0].if);
    assert.equal(verify.steps.some(step => step.name === name), false, name);
  }
  assert.equal(selfTests.steps.find(step => step.id === 'gap')['continue-on-error'], true);
  assert.equal(selfTests.steps.find(step => step.id === 'multi-gap')['continue-on-error'], true);
  assert.equal(selfTests.steps.find(step => step.name === 'Verify rejection is enforced').run, 'test "$GAP_OUTCOME" = failure');
  assert.equal(selfTests.steps.find(step => step.name === 'Verify multi-artifact rejection is enforced').run, 'test "$MULTI_GAP_OUTCOME" = failure');
});

test('a receipt skips exactly the receipt-covered steps; the self-tests and the declaration check run for every verified tree', () => {
  const config = JSON.parse(readFileSync(new URL('../clouseau.json', import.meta.url), 'utf8'));
  assert.equal(config.verification.job, 'verify');
  // Every step the gate requires (and a receipt may attest) is a verify step under the attested guard, and nothing else is.
  const covered = verify.steps.filter(step => step.name && step.if === verify.steps[0].if && step.uses !== 'actions/setup-node@v4' &&
    step.uses !== 'actions/setup-python@v5' && step.name !== 'Install coverage.py for the real-report integration test').map(step => step.name);
  assert.deepEqual(covered, config.verification.steps);
  assert.match(verify.steps[0].if, /needs\.attested\.outputs\.attested != 'true'/);
  assert.equal(verify.needs, 'attested'); assert.equal(verify.if, '${{ !cancelled() }}');
  // The self-tests never depend on a receipt, and they check the declarations against the tree this run verifies.
  assert.equal(JSON.stringify(selfTests).includes('attested'), false);
  assert.equal(selfTests.steps.find(step => step.name === 'Check review-semantics declarations against the verified tree').run,
    'node scripts/review-compatibility verify');
  assert.equal(selfTests.permissions, undefined);
  // The decision runs the frozen engine on the base revision, never pull request code, and cannot fail the run.
  const attested = workflow.jobs.attested;
  assert.equal(attested.needs, 'resolve-clouseau');
  assert.equal(attested.if, "${{ !cancelled() && github.event_name == 'pull_request' }}");
  assert.equal(attested['continue-on-error'], true, 'an error in the decision never fails the run the gate requires');
  assert.equal(attested.steps[0].with.ref, '${{ github.event.pull_request.base.sha }}');
  assert.equal(attested.steps[1].with.repository, 'gaulatti/clouseau');
  const decide = attested.steps.find(step => step.id === 'decide');
  assert.equal(decide.uses, './.clouseau-ci'); assert.equal(decide['continue-on-error'], true);
  assert.deepEqual(decide.with, {operation: 'attested', config: '.github/clouseau.json'});
  assert.deepEqual(attested.permissions, {contents: 'read', 'pull-requests': 'read'});
});
