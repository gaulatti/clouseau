'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {template, inspect, combine, reviewChange} = require('./acceptance-review.cjs');
const {fixture, finding, factor} = require('../test/fixtures/acceptance.cjs');

function withKey(run) {return async () => {
  const old = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional';
  try {await run();} finally {if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;}
};}
const response = value => ({ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(value)}}]})});

test('review syntax includes all gates and uses actual immutable nonblank source lines', () => {
  const {snapshot} = fixture();
  const value = template(snapshot);
  assert.equal(value.snapshot, snapshot.digest);
  assert.equal(value.evidence[0].quote, 'Validate every upload before durable acceptance.');
  assert.equal(value.evidence[1].quote, 'validate(input)?;');
  assert.ok(value.gates.every(gate => gate.state === 'unresolved'));
  snapshot.files[0].base_source = 'head'; delete snapshot.files[0].head_source;
  assert.equal(template(snapshot).evidence[1].source, 'head');
});

test('complete independent source reports are graded and combined without exposing either verdict to the other', withKey(async () => {
  const f = fixture(); const reports = []; const requests = [];
  const config = {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'deepseek', grading_model: 'deepseek-flash'};
  const result = await reviewChange({...f, config, diagnostic: result => reports.push(result), fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (body.messages[0].content.includes('Role:')) return response(f.report);
    const packet = JSON.parse(body.messages[1].content);
    return response({answers: Object.fromEntries(Object.keys(packet.questions).map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))});
  }});
  assert.equal(result.decision, 'auto_approve'); assert.equal(result.reviews.length, 2); assert.equal(result.usage.length, 4);
  assert.deepEqual(requests.slice(0, 2).map(request => request.model), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(requests[0].messages[1].content, requests[1].messages[1].content);
  assert.ok(!JSON.parse(requests[1].messages[1].content).reviews);
  assert.equal(reports[0], result);
  const quiet = await reviewChange({...f, config, fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body);
    if (body.messages[0].content.includes('Role:')) return response(f.report);
    const packet = JSON.parse(body.messages[1].content);
    return response({answers: Object.fromEntries(Object.keys(packet.questions).map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))});
  }});
  assert.equal(quiet.decision, 'auto_approve', 'optional telemetry cannot be a prerequisite for the decision');
}));

test('independent negative findings retain their decision and cannot be voted away', () => {
  for (const decision of ['blocked_integrity', 'repair_required', 'review_incomplete', 'owner_decision', 'auto_approve']) {
    assert.equal(combine([{scores: {decision: 'auto_approve'}}, {scores: {decision}}]), decision);
  }
});

test('bounded source requests read only immutable repository evidence before completing review', withKey(async () => {
  const f = fixture(); const requests = [];
  f.snapshot.head_sha = 'a'.repeat(40);
  const github = {rest: {repos: {getContent: async args => {
    requests.push(args); return {data: {encoding: 'base64', content: Buffer.from('pub fn validate() {}').toString('base64')}};
  }}}};
  let calls = 0;
  const result = await inspect({...f, github, repo: {owner: 'example', repo: 'gateway'}, role: 'examiner', model: 'deepseek-flash', fetchImpl: async () => {
    calls++; return calls === 1 ? response({request_sources: ['src/validation.rs']}) : response({...f.report, snapshot: f.snapshot.digest});
  }});
  assert.equal(calls, 2); assert.equal(result.report.snapshot, f.snapshot.digest);
  assert.equal(requests[0].path, 'src/validation.rs'); assert.equal(requests[0].ref, 'a'.repeat(40));
}));

test('no-progress, over-budget, malformed and invalid source reports fail instead of escalating ordinary uncertainty to humans', withKey(async () => {
  for (const value of [{request_sources: ['src/upload.rs'], extra: true}, {request_sources: []}, {}]) {
    const f = fixture(); await assert.rejects(inspect({...f, role: 'examiner', model: 'deepseek-flash', fetchImpl: async () => response(value)}));
  }
  const f = fixture(); f.snapshot.head_sha = 'head';
  f.snapshot.sources['head:src/upload.rs'] = f.snapshot.sources.head;
  const github = {rest: {repos: {getContent: async () => ({data: {encoding: 'base64', content: Buffer.from('source').toString('base64')}})}}};
  await assert.rejects(inspect({...f, github, role: 'examiner', model: 'deepseek-flash', fetchImpl: async () => response({request_sources: ['src/upload.rs']})}), /no new evidence/);
  let call = 0;
  await assert.rejects(inspect({...fixture(), github, role: 'examiner', model: 'deepseek-flash', fetchImpl: async () => response({request_sources: [`src/new-${++call}.rs`]})}), /exhausted/);
  assert.equal(call, 3);
}));

test('new challenger context invalidates an earlier source assessment before any approval', withKey(async () => {
  const f = fixture(); let calls = 0;
  const github = {rest: {repos: {getContent: async () => ({data: {encoding: 'base64', content: Buffer.from('new source').toString('base64')}})}}};
  await assert.rejects(reviewChange({...f, github, config: {examiner: 'deepseek-flash', challenger: 'deepseek-flash', grader: 'deepseek', grading_model: 'deepseek-flash'}, fetchImpl: async () => {
    calls++; return calls === 2 ? response({request_sources: ['src/new.rs']}) : response({...f.report, snapshot: f.snapshot.digest});
  }}), /fresh examination/);
}));
