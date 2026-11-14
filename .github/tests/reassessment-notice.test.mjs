import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parse} from 'yaml';

// A reassessment that cannot be requested must be able to say so on the pull request, and the gate must be able to tell
// an assessment made before an owner confirmation (src/stale-assessment.cjs).
const read = path => parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));

test('request-reassessment may comment on the pull request, and nothing more than that is added', () => {
  for (const path of ['examples/consumer-ci.yml', '.github/workflows/ci.yml']) {
    const job = read(path).jobs['request-reassessment'];
    assert.deepEqual(job.permissions, {contents: 'read', 'pull-requests': 'write', issues: 'write', actions: 'write'}, path);
    // It still runs only trusted main and the frozen engine, never pull request code.
    const checkouts = job.steps.filter(step => String(step.uses).startsWith('actions/checkout@'));
    assert.equal(checkouts[0].with.ref, 'main', path);
    assert.equal(checkouts[1].with.repository, 'gaulatti/clouseau', path);
    assert.ok(checkouts.every(step => step.with['persist-credentials'] === false), path);
  }
});

test('the packaged assess step watches the comment reads before the assessment runs, and emits when it last read them', () => {
  const step = read('action.yml').runs.steps.find(item => item.id === 'assess');
  const script = step.with.script;
  const watch = script.indexOf("const assessedAt = require(path.join(root, 'src/stale-assessment.cjs')).watchCommentReads(github);");
  assert.ok(watch > 0 && watch < script.indexOf('await assess('), 'watching before the assessment runs');
  const emit = script.indexOf('if (assessedAt()) assessment = {...assessment, assessed_at: assessedAt()};');
  assert.ok(emit > 0 && emit < script.indexOf("core.setOutput('assessment'"));
});

// A confirmation comment's reassessment waits up to 550 s (10 + 20 + 40 + 80 + 160 + 240) for an assessment run in progress.
// A newer comment on the same pull request must supersede that waiter, never run beside it, and the job must outlive the wait.
test('a comment-triggered reassessment runs in its pull request issue_comment group, which cancels an older waiter', async () => {
  const {Evaluator, Lexer, Parser, data} = await import('@actions/expressions');
  const typed = value => value === null ? new data.Null() : typeof value === 'string' ? new data.StringData(value) :
    typeof value === 'number' ? new data.NumberData(value) : new data.Dictionary(...Object.entries(value).map(([key, item]) => ({key, value: typed(item)})));
  const evaluate = (expression, context) => new Evaluator(new Parser(new Lexer(expression).lex().tokens, Object.keys(context), []).parse(), typed(context)).evaluate();
  const comment = (number, body) => ({github: {event_name: 'issue_comment', ref: 'refs/heads/main',
    event: {pull_request: null, issue: {number, pull_request: {}}, comment: {body}}}, inputs: {pull_request: '', evaluate_acceptance: false}});
  for (const [path, prefix] of [['.github/workflows/ci.yml', 'clouseau-ci'], ['examples/consumer-ci.yml', 'ci']]) {
    const workflow = read(path);
    const job = workflow.jobs['request-reassessment'];
    assert.equal(job.concurrency, undefined, `${path}: no job group of its own, so the workflow group decides`);
    assert.equal(workflow.concurrency['cancel-in-progress'], true, path);
    const group = context => workflow.concurrency.group.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) => evaluate(expression, context).coerceString());
    const head = 'a'.repeat(40);
    assert.equal(evaluate(job.if, comment(19, `/approve-intent ${head}`)).value, true, path);
    assert.equal(group(comment(19, `/approve-intent ${head}`)), `${prefix}-issue_comment-19`, path);
    assert.equal(group(comment(19, `/approve-intent ${head}`)), group(comment(19, `/hosted-review ${head}`)), `${path}: a newer request supersedes the waiter`);
    assert.notEqual(group(comment(19, `/approve-intent ${head}`)), group(comment(20, `/approve-intent ${head}`)), `${path}: other pull requests are independent`);
    assert.ok(job['timeout-minutes'] * 60 > 550 + 60, `${path}: the job outlives the 550 s wait`);
  }
});
