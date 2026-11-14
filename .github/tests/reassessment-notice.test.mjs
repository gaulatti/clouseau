import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createRequire} from 'node:module';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
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

// A confirmation comment's reassessment waits for an assessment run in progress (src/policy.cjs COMMENT_WAIT_GAPS). It must fit
// the job's timeout with the stated overhead and a margin for the notice, and only a newer command comment may supersede it.
const policy = createRequire(import.meta.url)('../../src/policy.cjs');
const WORKFLOWS = [['.github/workflows/ci.yml', 'clouseau-ci'], ['examples/consumer-ci.yml', 'ci']];
const NOTICE_MARGIN_SECONDS = 20;

test('a comment-triggered reassessment wait fits the request-reassessment timeout with its overhead and the notice margin', () => {
  const waited = policy.COMMENT_WAIT_GAPS.reduce((sum, ms) => sum + ms, 0) / 1000;
  assert.equal(waited, 130);
  for (const [path] of WORKFLOWS) {
    const minutes = read(path).jobs['request-reassessment']['timeout-minutes'];
    assert.ok(Number.isInteger(minutes), path);
    assert.ok(waited + policy.COMMENT_JOB_OVERHEAD_SECONDS + NOTICE_MARGIN_SECONDS <= minutes * 60,
      `${path}: ${waited} s wait + ${policy.COMMENT_JOB_OVERHEAD_SECONDS} s overhead + ${NOTICE_MARGIN_SECONDS} s margin exceeds ${minutes} min`);
  }
});

test('command comments share their pull request group and supersede a waiter; any other comment can never cancel it', () => {
  const typed = value => value === null || value === undefined ? new data.Null() : typeof value === 'string' ? new data.StringData(value) :
    typeof value === 'number' ? new data.NumberData(value) : typeof value === 'boolean' ? new data.BooleanData(value) :
      new data.Dictionary(...Object.entries(value).map(([key, item]) => ({key, value: typed(item)})));
  const evaluate = (expression, context) => new Evaluator(new Parser(new Lexer(expression).lex().tokens, Object.keys(context), []).parse(), typed(context)).evaluate();
  const head = 'a'.repeat(40);
  const event = (name, {number = 19, body = null, runId = 1000} = {}) => ({github: {event_name: name, ref: 'refs/heads/main', run_id: runId,
    event: {pull_request: name.startsWith('pull_request') ? {number} : null, issue: name === 'issue_comment' ? {number, pull_request: {}} : null,
      comment: name === 'issue_comment' ? {body} : null}},
  inputs: {pull_request: name === 'workflow_dispatch' ? String(number) : '', evaluate_acceptance: false, check_author: false}});
  for (const [path, prefix] of WORKFLOWS) {
    const workflow = read(path);
    const job = workflow.jobs['request-reassessment'];
    assert.equal(job.concurrency, undefined, `${path}: no job group of its own, so the workflow group decides`);
    assert.equal(workflow.concurrency['cancel-in-progress'], true, path);
    const group = context => workflow.concurrency.group.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) => evaluate(expression, context).coerceString());
    const approve = event('issue_comment', {body: `/approve-intent ${head}`, runId: 1001});
    const hosted = event('issue_comment', {body: `/hosted-review ${head}`, runId: 1002});
    assert.equal(evaluate(job.if, approve).value, true, path);
    assert.equal(evaluate(job.if, hosted).value, true, path);
    assert.equal(group(approve), `${prefix}-issue_comment-19`, path);
    assert.equal(group(hosted), group(approve), `${path}: a newer command comment supersedes the waiter`);
    assert.equal(group(event('issue_comment', {body: `/approve-intent ${head}\n\nAccepted purpose:\nShip it.`, runId: 1003})), group(approve), path);
    assert.notEqual(group(event('issue_comment', {number: 20, body: `/approve-intent ${head}`})), group(approve), `${path}: other pull requests are independent`);
    // A comment that starts no reassessment is alone in its group: it cannot cancel a waiter, nor another plain comment.
    for (const [body, runId] of [['looks good', 2001], ['/approve-intent', 2002], [`please /hosted-review ${head}`, 2003]]) {
      const plain = event('issue_comment', {body, runId});
      assert.equal(evaluate(job.if, plain).value, false, `${path}: ${body}`);
      assert.equal(group(plain), `${prefix}-issue_comment-19-${runId}`, `${path}: ${body}`);
    }
    assert.notEqual(group(event('issue_comment', {body: 'looks good', runId: 2001})), group(event('issue_comment', {body: 'looks good', runId: 2004})), path);
    // Every other event keeps its group byte for byte.
    assert.equal(group(event('pull_request_target')), `${prefix}-pull_request_target-19`, path);
    assert.equal(group(event('pull_request')), `${prefix}-pull_request-19`, path);
    assert.equal(group(event('workflow_dispatch')), `${prefix}-workflow_dispatch-19`, path);
    assert.equal(group({...event('push'), github: {...event('push').github, event_name: 'push'}}), `${prefix}-push-refs/heads/main`, path);
  }
});
