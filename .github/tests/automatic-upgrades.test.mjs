import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {parse} from 'yaml';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
import {assertFrozenWorkflow, assertBoundedVerificationWait, assertReassessmentOnVerification} from '../../test/automatic-upgrade-contract.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const action = parse(readFileSync(path.join(root, 'action.yml'), 'utf8'));
const workflow = parse(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
const typed = value => value === null ? new data.Null() : typeof value === 'boolean' ? new data.BooleanData(value) :
  typeof value === 'string' ? new data.StringData(value) :
  new data.Dictionary(...Object.entries(value).map(([key, value]) => ({key, value: typed(value)})));
const evaluate = (expression, context) => new Evaluator(
  new Parser(new Lexer(expression.startsWith('${{') ? expression.slice(3, -2) : expression).lex().tokens, Object.keys(context), []).parse(), typed(context)).evaluate();

test('the actual job expressions keep the original engine after main advances and reject missing resolver output', () => {
  assertFrozenWorkflow(workflow, evaluate);
  const substituted = structuredClone(workflow);
  substituted.jobs['assess-intent'].steps.find(step => step.with?.repository === 'gaulatti/clouseau').with.ref = 'main';
  assert.throws(() => assertFrozenWorkflow(substituted, evaluate));
  const independent = structuredClone(workflow);
  independent.jobs['assess-intent'].needs = [];
  assert.throws(() => assertFrozenWorkflow(independent, evaluate), /directly consumes/);
  const overwritten = structuredClone(workflow);
  overwritten.jobs['assess-intent'].steps.push({uses: 'actions/checkout@v4', with: {
    repository: 'gaulatti/clouseau', ref: 'c88bb23a03c35f703f86ad1c419b80e390a07f03', path: '.clouseau-ci'}});
  assert.throws(() => assertFrozenWorkflow(overwritten, evaluate), /cannot overwrite/);
  const redirected = structuredClone(workflow);
  redirected.jobs['assess-intent'].steps.find(step => step.with?.repository === 'gaulatti/clouseau').with.repository = 'attacker/engine';
  assert.throws(() => assertFrozenWorkflow(redirected, evaluate), /authorized repository/);
});

test('protected self review uses one frozen engine while candidate tests and explicit installation retain their own boundaries', () => {
  const resolver = workflow.jobs['resolve-clouseau'];
  assert.match(resolver.steps[0].uses, /^gaulatti\/clouseau\/scripts\/resolve@[a-f0-9]{40}$/);
  for (const name of ['assess-intent', 'approve-and-merge', 'apply-repair', 'finalize-merge', 'request-reassessment']) {
    const job = workflow.jobs[name];
    assert.ok([job.needs].flat().includes('resolve-clouseau'), name);
    assert.equal(job.steps.find(s => s.with?.repository === 'gaulatti/clouseau').with.ref, "${{ needs.resolve-clouseau.outputs.sha || '0000000000000000000000000000000000000000' }}");
    assert.ok(job.steps.some(s => s.uses === './.clouseau-ci'), name);
  }
  assert.ok(workflow.jobs.verify.steps.some(s => s.uses === './' && s.with.operation === 'test'));
  assert.equal(workflow.jobs['assess-installation'].steps[0].with.ref, '${{ needs.prepare-installation.outputs.head }}');
  const repair = action.runs.steps.find(s => s.name === 'Apply bounded repair with an independent author');
  assert.match(repair.with.script, /verifyRecord\(record, assessment, config,.*environmentEngine/);
  assert.ok(action.runs.steps.find(s => s.name === 'Verify and record this run frozen engine').with.script.includes('environmentEngine'));
});


test('explicit controller installation freezes its own candidate without publishing an unused automatic selection', () => {
  const condition = workflow.jobs['resolve-clouseau'].if;
  for (const event_name of ['pull_request', 'pull_request_target', 'issue_comment', 'workflow_dispatch']) {
    assert.equal(evaluate(condition, {github: {event_name, ref: 'refs/heads/main'}}).value, true);
  }
  assert.equal(evaluate(condition, {github: {event_name: 'pull_request_target', ref: 'refs/heads/policy-install/pr-43'}}).value, true);
  assert.equal(evaluate(condition, {github: {event_name: 'push', ref: 'refs/heads/main'}}).value, true);
  assert.equal(evaluate(condition, {github: {event_name: 'push', ref: 'refs/heads/policy-install/pr-43'}}).value, false);
  assert.equal(workflow.jobs['assess-installation'].steps[0].with.ref, '${{ needs.prepare-installation.outputs.head }}');
});

test('resolver failures keep the required approval check red while an authorized candidate installation remains independent', () => {
  const gate = workflow.jobs['approve-and-merge'];
  assert.equal(gate.if, 'always()');
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const context = {github: {event_name: 'pull_request_target', event: {pull_request: {draft: false}}},
      needs: {'resolve-clouseau': {result, outputs: {}}, 'assess-intent': {result: 'skipped'}, 'assess-installation': {result: 'skipped'}}};
    assert.equal(evaluate(gate.name, context).coerceString(), 'approve-and-merge');
    assert.equal(evaluate(gate.steps[0].if, context).value, true);
    assert.equal(gate.steps[0].run, 'exit 1');
  }
  const installation = {github: {event_name: 'push', event: {deleted: false}, ref: 'refs/heads/policy-install/pr-43'},
    needs: {'resolve-clouseau': {result: 'skipped'}, 'assess-intent': {result: 'skipped'}, 'assess-installation': {result: 'success'}}};
  assert.equal(evaluate(gate.steps[0].if, installation).value, false);
});

test('review workflows wait for verification through the bounded engine operation, never an inline polling loop', () => {
  assert.equal(assertBoundedVerificationWait(workflow), 0, 'the self review uses assess with the guarded engine wait');
  assert.ok(action.runs.steps.some(step => step.if === "inputs.operation == 'await-verification'"));
  assert.match(action.inputs.operation.description, /await-verification/);
  const consumer = structuredClone(workflow);
  consumer.jobs['assess-intent'].steps.splice(1, 0, {name: 'Wait for tests', uses: 'actions/github-script@v7',
    with: {script: 'const result = await policy.technicalRun(github, context.repo, pr);'}});
  assert.throws(() => assertBoundedVerificationWait(consumer), /use operation: await-verification/);
});

test('a pending review is reassessed when verification completes, and later steps wait for the bounded step', () => {
  const wait = {id: 'wait', uses: './.clouseau-ci', with: {operation: 'await-verification'}};
  const assess = {uses: './.clouseau-ci', if: "steps.wait.outputs.verified == 'true'", with: {operation: 'assess'}};
  const consumer = {on: {workflow_run: {workflows: ['CI'], types: ['completed']}}, jobs: {
    'assess-intent': {steps: [wait, assess]},
    'request-reassessment': {if: "github.event_name == 'workflow_run' && github.event.workflow_run.event == 'pull_request'",
      permissions: {actions: 'write'}, steps: [{uses: './.clouseau-ci', with: {operation: 'request-reassessment'}}]}}};
  assert.equal(assertBoundedVerificationWait(consumer), 1);
  assert.equal(assertReassessmentOnVerification(consumer), 1);
  const ungated = structuredClone(consumer); delete ungated.jobs['assess-intent'].steps[1].if;
  assert.throws(() => assertBoundedVerificationWait(ungated), /skip assessment/);
  const anonymous = structuredClone(consumer); delete anonymous.jobs['assess-intent'].steps[0].id;
  assert.throws(() => assertBoundedVerificationWait(anonymous), /identify/);
  const untriggered = structuredClone(consumer); delete untriggered.on.workflow_run;
  assert.throws(() => assertReassessmentOnVerification(untriggered), /trigger on completed/);
  const unnamed = structuredClone(consumer); unnamed.on.workflow_run.types = ['requested'];
  assert.throws(() => assertReassessmentOnVerification(unnamed), /completed type/);
  const unrouted = structuredClone(consumer); unrouted.jobs['request-reassessment'].permissions = {actions: 'read'};
  assert.throws(() => assertReassessmentOnVerification(unrouted), /workflow_run events/);
});
