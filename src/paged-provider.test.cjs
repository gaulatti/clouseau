'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pagedFixture, responder} = require('../test/paged-review-fixture.cjs');
const {pageSchema} = require('./paged-review.cjs');
const {pageFunctions, providerAsk} = require('./paged-provider.cjs');
const {reviewChange, investigateChange} = require('./acceptance-review.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {JEV_MODEL} = require('./review-provider.cjs');

function credentials(run) {return async () => {
  const names = ['DEEPSEEK_API_KEY', 'TYPESAFE_API_KEY']; const old = names.map(name => process.env[name]);
  names.forEach(name => {process.env[name] = 'fictional-only';});
  try {await run();} finally {names.forEach((name, i) => {if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i];});}
};}
const reply = body => ({ok: true, json: async () => body});
const branchFor = value => value.kind === 'report' ? 'acceptance_report' : value.kind;
function encoded(value) {
  const active = value.kind === 'source_request' ? 'request_sources' : value.kind;
  return {kind: value.kind, observations: value.observations, concerns: value.concerns, [active]: value[active]};
}

test('paged strict tools preserve typed facts without null or unsupported schema limits', async () => {
  const f = await pagedFixture(); const tools = pageFunctions(pageSchema(f.snapshot));
  assert.deepEqual(Object.keys(tools), ['acceptance_report', 'page_request', 'source_request']);
  const check = value => {
    if (!value || typeof value !== 'object') return;
    assert.ok(!['minLength', 'maxLength', 'minItems', 'maxItems'].some(key => Object.hasOwn(value, key)));
    assert.notEqual(value.type, 'null'); Object.values(value).forEach(check);
  };
  Object.values(tools).forEach(check);
});

test('central roles page independently and keep exposure in routed literal grading', credentials(async () => {
  const f = await pagedFixture(); const model = responder(f); const audits = [];
  const result = await reviewChange({snapshot: f.snapshot,
    config: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash'},
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.tools) {
        assert.equal(body.tools.length, 3); assert.equal(body.parallel_tool_calls, false);
        const prompt = body.messages[1].content;
        const packet = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
        const response = await model.ask({role: packet.review_context.role, phase: 'investigation', schema: pageSchema(f.snapshot), prompt});
        return reply({choices: [{finish_reason: 'tool_calls', message: {tool_calls: [{function: {
          name: branchFor(response.value), arguments: JSON.stringify(encoded(response.value)),
        }}]}}]});
      }
      const packet = body.questions ? body : JSON.parse(body.messages[1].content);
      const questions = packet.questions;
      const state = packet.state;
      if (questions.review_completeness) {
        const exposure = state.factors.review_completeness.context.source_exposure;
        assert.ok(exposure.sources.rows.length > 0); audits.push(exposure.role);
      }
      if (body.questions) return reply({model: JEV_MODEL, answers: Object.fromEntries(Object.keys(questions).map(id => {
        const choice = id.includes('_excess_') ? 'level0' : 'level4';
        return [id, {type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(
          ['level0', 'level1', 'level2', 'level3', 'level4', 'unknown'].map(level => [level, level === choice ? 1 : 0]))}];
      }))});
      return reply({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers: Object.fromEntries(
        Object.keys(questions).map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))})}}]});
    }});
  assert.equal(result.decision, 'auto_approve');
  assert.deepEqual(audits, ['examiner', 'challenger']);
  for (const review of result.reviews) {
    assert.ok(review.page_progress.every(frame => frame.role === review.role));
    assert.equal(review.source_bank.snapshot_digest, f.snapshot.digest);
  }
}));

test('typed transport restores only reserved fields and rejects conflicting submitted branches', credentials(async () => {
  const f = await pagedFixture(); const schemas = pageFunctions(pageSchema(f.snapshot));
  const task = {role: 'examiner', phase: 'investigation', schema: pageSchema(f.snapshot), prompt: 'Frozen controller fixture.'};
  for (const [name, submitted, valid] of [
    ['source_request', {kind: 'source_request', request_sources: ['src/dependency.js'], observations: '', concerns: []}, true],
    ['source_request', {kind: 'report', request_sources: ['src/dependency.js'], observations: '', concerns: []}, false],
    ['source_request', {kind: 'source_request', request_sources: ['src/dependency.js'], observations: '', concerns: [], report: {}}, false],
  ]) {
    const ask = providerAsk({snapshot: f.snapshot, model: 'deepseek-flash', fetchImpl: async () => reply({choices: [
      {finish_reason: 'tool_calls', message: {tool_calls: [{function: {name, arguments: JSON.stringify(submitted)}}]}},
    ]})});
    if (!valid) await assert.rejects(ask(task), /mismatched typed branch/);
    else {
      const response = await ask(task);
      assert.deepEqual(response.value, {...submitted, report: null, page_request: null});
      assert.equal(response.provenance.role, task.role);
      assert.equal(response.provider_usage[0].provider, 'deepseek');
      assert.ok(schemas.source_request.required.includes('request_sources'));
    }
  }
}));

test('central source growth and a legacy-to-paged transition preserve independent cycles and remaining budgets', credentials(async () => {
  for (const initialPaged of [true, false]) {
    const f = await pagedFixture(); let requested = false;
    if (!initialPaged) {delete f.snapshot.source_bank_version; refresh(f.snapshot);}
    const model = responder(f, (value, {task}) => {
      if (initialPaged && task.role === 'challenger' && value.kind === 'report' && !requested) {
        requested = true; return {...value, kind: 'source_request', report: null, request_sources: ['src/added.js']};
      }
      return value;
    });
    const content = initialPaged ? 'module.exports = "required additional context";\n' : 'module.exports = true;\n'.repeat(17000);
    const result = await investigateChange({snapshot: f.snapshot,
      config: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro'}, repo: f.repo,
      github: {rest: {repos: {getContent: async () => ({data: {
        encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content),
      }})}}}, fetchImpl: async (_, options) => {
        const body = JSON.parse(options.body);
        if (body.tools.length === 2) return reply({choices: [{finish_reason: 'tool_calls', message: {tool_calls: [
          {function: {name: 'source_request', arguments: JSON.stringify({request_sources: ['src/large-dependency.js']})}},
        ]}}]});
        const prompt = body.messages[1].content; const packet = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
        const response = await model.ask({role: packet.review_context.role, phase: 'investigation', schema: pageSchema(f.snapshot), prompt});
        return reply({choices: [{finish_reason: 'tool_calls', message: {tool_calls: [{function: {
          name: branchFor(response.value), arguments: JSON.stringify(encoded(response.value)),
        }}]}}]});
      }});
    assert.equal(f.snapshot.source_bank_version, 1);
    assert.ok(result.inspections.every(item => item.report.snapshot === f.snapshot.digest));
    assert.equal(result.inspections[0].page_progress.filter(frame => frame.cycle_start).length, initialPaged ? 2 : 1);
    assert.equal(result.inspections[0].page_progress.at(-1).source_batch_limit, initialPaged ? 8 : 7);
  }
}));
