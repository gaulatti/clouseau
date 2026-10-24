import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {parse} from 'yaml';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
import {assertFrozenWorkflow} from '../../test/automatic-upgrade-contract.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const action = parse(readFileSync(path.join(root, 'action.yml'), 'utf8'));
const workflow = parse(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
const typed = value => typeof value === 'string' ? new data.StringData(value) :
  new data.Dictionary(...Object.entries(value).map(([key, value]) => ({key, value: typed(value)})));
const evaluate = (expression, context) => new Evaluator(
  new Parser(new Lexer(expression.slice(3, -2)).lex().tokens, Object.keys(context), []).parse(), typed(context)).evaluate();

test('the actual job expressions keep the original engine after main advances and reject missing resolver output', () => {
  assertFrozenWorkflow(workflow, evaluate);
  const substituted = structuredClone(workflow);
  substituted.jobs['assess-intent'].steps.find(step => step.with?.repository === 'gaulatti/clouseau').with.ref = 'main';
  assert.throws(() => assertFrozenWorkflow(substituted, evaluate));
  const independent = structuredClone(workflow);
  independent.jobs['assess-intent'].needs = [];
  assert.throws(() => assertFrozenWorkflow(independent, evaluate), /directly consumes/);
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
  assert.ok(action.runs.steps[0].with.script.includes('environmentEngine'));
});
