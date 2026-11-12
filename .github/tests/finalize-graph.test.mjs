import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {data, Evaluator, Lexer, Parser} from '@actions/expressions';
import {truthy} from '@actions/expressions/result';
import {parse} from 'yaml';

// The reference consumer workflow's job graph, evaluated the way GitHub schedules it: a job whose `if` calls no status
// function gets an implicit `success()`, so any skipped, failed or cancelled need skips it.
const {jobs} = parse(readFileSync(new URL('../../examples/consumer-ci.yml', import.meta.url), 'utf8'));
const STATUS = /\b(always|success|failure|cancelled)\s*\(/;
const typed = value => value === null ? new data.Null() : typeof value === 'boolean' ? new data.BooleanData(value) :
  typeof value === 'number' ? new data.NumberData(value) : typeof value === 'string' ? new data.StringData(value) :
    Array.isArray(value) ? new data.Array(...value.map(typed)) :
      new data.Dictionary(...Object.entries(value).map(([key, item]) => ({key, value: typed(item)})));

function runs(name, {github, results, cancelled = false}) {
  const job = jobs[name];
  const needs = [job.needs ?? []].flat();
  const source = String(job.if ?? '').trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const succeeded = needs.every(need => results[need] === 'success');
  const fn = (fname, value) => ({name: fname, minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(value)});
  const functions = [fn('always', true), fn('success', succeeded && !cancelled), fn('cancelled', cancelled),
    fn('failure', needs.some(need => results[need] === 'failure'))];
  const expression = STATUS.test(source) ? source : source ? `success() && (${source})` : 'success()';
  const context = {github, needs: Object.fromEntries(needs.map(need => [need, {result: results[need], outputs: {}}]))};
  const ast = new Parser(new Lexer(expression).lex().tokens, Object.keys(context), functions).parse();
  return truthy(new Evaluator(ast, typed(context), new Map(functions.map(f => [f.name, f]))).evaluate());
}

const READY_PR = {event_name: 'pull_request_target', ref: 'refs/pull/7/merge', event: {deleted: false, pull_request: {draft: false}}};
const DRAFT_PR = {...READY_PR, event: {deleted: false, pull_request: {draft: true}}};
const INSTALL_PUSH = {event_name: 'push', ref: 'refs/heads/policy-install/x', event: {deleted: false}};
const COMMENT = {event_name: 'issue_comment', ref: 'refs/heads/main', event: {deleted: false}};
const receipt = approve => ({'resolve-clouseau': 'success', 'assess-intent': 'success', 'assess-hosted': 'skipped', 'approve-and-merge': approve});

test('finalize-merge runs after a successful approve-and-merge although a receipt skipped the hosted review', () => {
  assert.deepEqual(jobs['finalize-merge'].needs, ['assess-intent', 'assess-hosted', 'approve-and-merge', 'resolve-clouseau']);
  for (const github of [READY_PR, INSTALL_PUSH]) {
    assert.equal(runs('finalize-merge', {github, results: receipt('success')}), true, github.event_name);
    assert.equal(runs('finalize-merge', {github, results: {...receipt('success'), 'assess-hosted': 'success'}}), true, `${github.event_name} hosted`);
  }
});

test('finalize-merge never runs when approve-and-merge failed, was skipped or was cancelled, or the run was cancelled', () => {
  for (const approve of ['failure', 'skipped', 'cancelled']) {
    assert.equal(runs('finalize-merge', {github: READY_PR, results: receipt(approve)}), false, approve);
  }
  assert.equal(runs('finalize-merge', {github: READY_PR, results: receipt('success'), cancelled: true}), false, 'cancelled run');
});

test('finalize-merge never runs outside a review event, where approve-and-merge succeeds as metadata only', () => {
  for (const github of [DRAFT_PR, COMMENT, {...INSTALL_PUSH, event: {deleted: true}}, {...INSTALL_PUSH, ref: 'refs/heads/main'}]) {
    assert.equal(runs('finalize-merge', {github, results: receipt('success')}), false, JSON.stringify(github));
  }
});

test('the old guard is what skipped it: without a status function a skipped hosted review starves finalize-merge', () => {
  const guard = jobs['finalize-merge'].if;
  try {
    jobs['finalize-merge'].if = jobs['assess-intent'].if;
    assert.equal(runs('finalize-merge', {github: READY_PR, results: receipt('success')}), false);
  } finally {jobs['finalize-merge'].if = guard;}
});

test('no job that consumes the review decision can be starved by a skipped hosted review', () => {
  for (const [name, job] of Object.entries(jobs)) {
    if (![job.needs ?? []].flat().includes('assess-hosted')) continue;
    assert.match(String(job.if), STATUS, `${name} must decide on explicit results, not GitHub's implicit success()`);
  }
});
