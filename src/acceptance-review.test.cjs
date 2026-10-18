'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {template, inspect, combine, reviewChange, canonicalReferences, materialize, investigateChange, validateInspection} = require('./acceptance-review.cjs');
const {fixture, finding, factor} = require('../test/fixtures/acceptance.cjs');

function withKey(run) {return async () => {
  const old = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional';
  try {await run();} finally {if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;}
};}
const response = value => {
  value = structuredClone(value);
  for (const entry of value.evidence || []) delete entry.quote;
  for (const unit of value.units || []) {
    delete unit.paths;
    for (const group of ['fit', 'need', 'excess']) for (const factor of Object.values(unit[group])) {delete factor.min; delete factor.max;}
  }
  for (const finding of value.findings || []) {
    const evidence = value.evidence.find(entry => finding.evidence.includes(entry.id) && entry.source !== 'contract');
    finding.anchor = {source: evidence.source, start: evidence.start, end: evidence.end}; delete finding.path;
    for (const factor of Object.values(finding.factors)) {delete factor.min; delete factor.max;}
  }
  return {ok: true, json: async () => ({choices: [value.answers ? {finish_reason: 'stop', message: {content: JSON.stringify(value)}} :
  {finish_reason: 'tool_calls', message: {tool_calls: [{function: {name: value.request_sources ? 'source_request' : 'acceptance_report', arguments: JSON.stringify(value)}}]}}]})};
};

test('review syntax includes all gates and uses actual immutable nonblank source lines', () => {
  const {snapshot} = fixture();
  const value = template(snapshot);
  assert.equal(value.snapshot, snapshot.digest);
  assert.equal(materialize(value, snapshot).evidence[0].quote, 'Validate every upload before durable acceptance.');
  assert.equal(materialize(value, snapshot).evidence[1].quote, 'validate(input)?;');
  assert.ok(value.gates.every(gate => gate.state === 'unresolved'));
  snapshot.files[0].base_source = 'head'; delete snapshot.files[0].head_source;
  assert.equal(template(snapshot).evidence[1].source, 'head');
  const original = {evidence: ['same', 'same'], nested: [{evidence: ['a', 'a'], other: null}], malformed: {evidence: [null]}, scalar: 'value'};
  assert.deepEqual(canonicalReferences(original), {evidence: ['same'], nested: [{evidence: ['a'], other: null}], malformed: {evidence: [null]}, scalar: 'value'});
  assert.equal(original.evidence.length, 2);
  const fresh = fixture().snapshot;
  const facts = template(fresh);
  assert.equal(materialize(facts, fresh).units[0].fit.outcome.max, 1);
  const concern = finding();
  concern.anchor = {source: 'head', start: 1, end: 1}; delete concern.path;
  concern.factors = Object.fromEntries(Object.entries(concern.factors).map(([key, value]) => [key, {reason: value.reason, evidence: value.evidence}]));
  facts.findings.push(concern);
  assert.equal(materialize(facts, fresh).findings[0].factors.necessity.max, 1);
  assert.equal(materialize(facts, fresh).findings[0].path, 'src/upload.rs');
  const outside = structuredClone(facts); outside.findings[0].anchor.source = 'contract';
  assert.throws(() => materialize(outside, fresh), /outside changed source/);
  for (const mutate of [finding => {delete finding.anchor;}, finding => {finding.path = 'invented';}, finding => {finding.anchor.extra = true;}]) {
    const invalid = structuredClone(facts); mutate(invalid.findings[0]);
    assert.throws(() => materialize(invalid, fresh), /concrete changed-source anchor/);
  }
  const conflicting = template(fresh); conflicting.units[0].paths = ['invented'];
  assert.throws(() => materialize(conflicting, fresh), /exclusively from complete file accounting/);
  facts.units[0].fit.outcome.extra = 'unrecognized';
  assert.throws(() => materialize(facts, fresh), /observations and citations only/);
  facts.units[0].fit.outcome = null;
  assert.throws(() => materialize(facts, fresh), /observations and citations only/);
  for (const mutate of [
    entry => {entry.quote = 'Fabricated quote';}, entry => {entry.source = 'invented';},
    entry => {entry.start = 1.2;}, entry => {entry.end = '2';},
  ]) {
    const invalid = template(fresh); mutate(invalid.evidence[0]);
    assert.throws(() => materialize(invalid, fresh), /immutable source and integer/);
  }
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
  const native = requests[0].tools.find(item => item.function.name === 'acceptance_report').function.parameters;
  assert.deepEqual(native.properties.evidence.items.properties.source.enum, Object.keys(f.snapshot.sources));
  assert.deepEqual(native.properties.snapshot.enum, [f.snapshot.digest]);
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

test('new challenger source triggers a bounded fresh examination while the final independent reviews share one complete snapshot', withKey(async () => {
  const f = fixture(); let calls = 0;
  const github = {rest: {repos: {getContent: async () => ({data: {encoding: 'base64', content: Buffer.from('new source').toString('base64')}})}}};
  const result = await investigateChange({...f, github, config: {examiner: 'deepseek-flash', challenger: 'deepseek-flash'}, fetchImpl: async () => {
    calls++; return calls === 2 ? response({request_sources: ['src/new.rs']}) : response({...f.report, snapshot: f.snapshot.digest});
  }});
  assert.equal(calls, 4);
  assert.equal(result.inspections[0].drafts.length, 1);
  assert.equal(result.inspections[1].drafts.length, 0);
  assert.ok(result.inspections.every(item => item.report.snapshot === f.snapshot.digest));
}));

test('source investigation cannot run indefinitely or discard a causal concern while refreshing its evidence', withKey(async () => {
  const f = fixture(); let calls = 0;
  const github = {rest: {repos: {getContent: async () => ({data: {encoding: 'base64', content: Buffer.from('new source').toString('base64')}})}}};
  await assert.rejects(investigateChange({...f, github, config: {examiner: 'deepseek-flash', challenger: 'deepseek-flash'}, fetchImpl: async () => {
    calls++; return calls % 2 ? response({request_sources: [`src/new-${calls}.rs`]}) : response({...f.report, snapshot: f.snapshot.digest});
  }}), /two complete examination cycles/);
  assert.equal(calls, 8);
  f.report.snapshot = f.snapshot.digest;
  const draft = structuredClone(f.report); draft.findings.push(finding());
  assert.throws(() => validateInspection(f.report, f.snapshot, [draft]), /prior investigation concern/);
  assert.ok(validateInspection(f.report, f.snapshot));
  const retained = structuredClone(draft);
  assert.ok(validateInspection(retained, f.snapshot, [draft]));
  retained.findings[0].cause = 'A different root cannot silently reuse the identifier.';
  assert.throws(() => validateInspection(retained, f.snapshot, [draft]), /prior investigation concern/);
  const closed = structuredClone(f.report);
  closed.resolutions = [{id: draft.findings[0].id, state: 'dismissed', reason: 'The current source proves rejection before durable acceptance.', evidence: ['source']}];
  assert.ok(validateInspection(closed, f.snapshot, [draft]));
  const inspected = await inspect({...f, drafts: [draft], role: 'examiner', model: 'deepseek-flash', fetchImpl: async (_, options) => {
    const supplied = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.equal(supplied.earlier_concerns_by_this_role[0].id, draft.findings[0].id);
    assert.deepEqual(supplied.earlier_concerns_by_this_role[0].sources[0], {source: 'head', start: 1, end: 2});
    assert.equal(supplied.earlier_concerns_by_this_role[0].factors, undefined);
    return response(closed);
  }});
  assert.equal(inspected.report.resolutions[0].id, draft.findings[0].id);
}));

test('multi-file syntax gives every accounting entry its own changed-source proof and uses trusted contract authority', () => {
  const {snapshot} = fixture();
  snapshot.sources.readme = {authority: 'trusted', kind: 'readme', content: 'Repository introduction.'};
  snapshot.sources = {readme: snapshot.sources.readme, ...snapshot.sources};
  snapshot.paths.push('src/helper.rs', 'src/removed.rs');
  snapshot.files.push({path: 'src/helper.rs', head_source: 'helper'}, {path: 'src/removed.rs', base_source: 'removed'});
  snapshot.files.reverse();
  snapshot.sources.helper = {authority: 'untrusted', kind: 'source', content: 'pub fn helper() {}'};
  snapshot.sources.removed = {authority: 'untrusted', kind: 'source', content: 'pub fn obsolete() {}'};
  require('./acceptance-sources.cjs').refresh(snapshot);
  const facts = template(snapshot);
  const report = materialize(facts, snapshot);
  assert.equal(report.evidence[0].source, 'contract', 'noncontract evidence cannot stand in for trusted contract authority');
  assert.equal(report.accounting.length, 3);
  assert.doesNotThrow(() => validateInspection(report, snapshot));
  for (const path of snapshot.paths) {
    const file = snapshot.files.find(item => item.path === path);
    const entry = report.accounting.find(item => item.path === path);
    const proof = report.evidence.find(item => entry.evidence.includes(item.id));
    assert.equal(proof.source, file.head_source || file.base_source);
  }
});
