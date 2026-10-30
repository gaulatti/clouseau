'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {template, modelTemplate, modelEvidence, inspect, combine, reviewChange, canonicalReferences, materialize, changedAnchor, investigateChange, validateInspection} = require('./acceptance-review.cjs');
const {proofCatalog} = require('./acceptance-sources.cjs');
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
  }
  for (const finding of value.findings || []) {
    const evidence = value.evidence.find(entry => finding.evidence.includes(entry.id) && entry.source !== 'contract');
    finding.anchor = {source: evidence.source, start: evidence.start, end: evidence.end}; delete finding.path;
    for (const factor of Object.values(finding.factors)) delete factor.value;
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
  const concern = finding();
  concern.anchor = {source: 'head', start: 1, end: 1}; delete concern.path;
  concern.factors = Object.fromEntries(Object.entries(concern.factors).map(([key, value]) => [key, {reason: value.reason, evidence: value.evidence}]));
  facts.findings.push(concern);
  assert.equal(materialize(facts, fresh).findings[0].factors.necessity.value, 0);
  assert.equal(materialize(facts, fresh).findings[0].path, 'src/upload.rs');
  const outside = structuredClone(facts); outside.findings[0].anchor.source = 'contract';
  const reanchored = materialize(outside, fresh).findings[0];
  assert.equal(reanchored.path, 'src/upload.rs', 'a finding anchored in supporting source is kept and re-anchored to the changed file');
  assert.ok(reanchored.evidence.some(id => id.startsWith('clouseau-cause-')));
  const unnamed = structuredClone(facts); unnamed.findings[0].anchor.source = 'missing-source';
  assert.equal(materialize(unnamed, fresh).findings[0].path, 'src/upload.rs');
  fresh.files[0].patch = '@@ -1,2 +1,2 @@\n-a\n+b'; fresh.files[0].head_source = 'head';
  assert.deepEqual(changedAnchor(fresh.files[0], new Map(proofCatalog(fresh).map(entry => [entry.id, entry]))), {source: 'head', start: 1, end: 3});
  fresh.files[0].patch = '@@ -1 +900 @@\n+x';
  assert.equal(changedAnchor(fresh.files[0], new Map(proofCatalog(fresh).map(entry => [entry.id, entry]))).start, 1, 'a line outside the supplied spans uses the first span');
  fresh.files[0].head_source = undefined; fresh.files[0].base_source = 'head';
  assert.equal(changedAnchor(fresh.files[0], new Map(proofCatalog(fresh).map(entry => [entry.id, entry]))).source, 'head');
  for (const mutate of [finding => {delete finding.anchor;}, finding => {finding.path = 'invented';}, finding => {finding.anchor.extra = true;}]) {
    const invalid = structuredClone(facts); mutate(invalid.findings[0]);
    assert.throws(() => materialize(invalid, fresh), /concrete changed-source anchor/);
  }
  const conflicting = template(fresh); conflicting.units[0].paths = ['invented'];
  assert.throws(() => materialize(conflicting, fresh), /exclusively from complete file accounting/);
  facts.findings[0].factors.necessity.extra = 'unrecognized';
  assert.throws(() => materialize(facts, fresh), /observations and citations only/);
  facts.findings[0].factors.necessity = null;
  assert.throws(() => materialize(facts, fresh), /observations and citations only/);
  for (const mutate of [
    entry => {entry.quote = 'Fabricated quote';}, entry => {entry.source = 'invented';},
    entry => {entry.start = 1.2;}, entry => {entry.end = '2';},
  ]) {
    const invalid = template(fresh); mutate(invalid.evidence[0]);
    assert.throws(() => materialize(invalid, fresh), /immutable source and integer/);
  }
  for (const [start, end] of [[0, 1], [2, 1], [1, 4]]) {
    const invalid = template(fresh); Object.assign(invalid.evidence[1], {start, end});
    assert.throws(() => materialize(invalid, fresh), /outside its immutable source/);
  }
});

test('the native inspection selects controller proofs without generating source coordinates or aliases', withKey(async () => {
  const f = fixture(); const facts = modelTemplate(f.snapshot);
  facts.gates.forEach(gate => {gate.state = 'satisfied';});
  assert.equal(facts.evidence, undefined);
  let calls = 0;
  const wire = value => ({ok: true, json: async () => ({choices: [{finish_reason: 'tool_calls', message: {tool_calls:
    [{function: {name: 'acceptance_report', arguments: JSON.stringify(value)}}]}}]})});
  const result = await inspect({...f, role: 'examiner', model: 'deepseek-flash', fetchImpl: async (_, options) => {
    calls++;
    const request = JSON.parse(options.body); const view = JSON.parse(request.messages[1].content);
    const schema = request.tools[0].function.parameters;
    assert.deepEqual(schema.properties.findings.items.properties.factors.properties.necessity.properties.evidence.items.enum,
      view.proofs.map(proof => proof.id));
    return wire(facts);
  }});
  assert.equal(calls, 1); assert.doesNotThrow(() => validateInspection(result.report, f.snapshot));
  assert.ok(result.report.evidence.every(proof => proof.quote === f.snapshot.sources[proof.source].content.split('\n').slice(proof.start - 1, proof.end).join('\n')));
  const anchor = modelEvidence(f.snapshot).proofs.find(proof => proof.source === 'head').id;
  const concern = finding(); delete concern.path; concern.anchor = anchor; concern.evidence = [anchor];
  concern.factors = Object.fromEntries(Object.keys(concern.factors).map(name => [name, {reason: 'Observable changed production path.', evidence: [anchor]}]));
  facts.findings.push(concern);
  const causal = materialize(facts, f.snapshot);
  assert.equal(causal.findings[0].path, 'src/upload.rs');
  assert.doesNotThrow(() => validateInspection(causal, f.snapshot));
  const unknown = structuredClone(facts); unknown.gates[0].evidence = ['invented-alias'];
  assert.throws(() => materialize(unknown, f.snapshot), /Unknown controller-supplied source proof/);
  const malformed = structuredClone(facts); malformed.gates[0].reason = null;
  assert.throws(() => validateInspection(materialize(malformed, f.snapshot), f.snapshot), /invalid gate/);
  const old = template(f.snapshot); old.findings = [concern]; old.findings[0].anchor = 'unknown';
  assert.throws(() => materialize(old, f.snapshot), /Unknown controller-supplied causal proof/);
}));

test('native source-line citations normalize to existing catalog blocks without another model request', withKey(async () => {
  const f = fixture();
  f.snapshot.sources.head.content = Array.from({length: 81}, (_, i) => `production statement ${i + 1}`).join('\n');
  require('./acceptance-sources.cjs').refresh(f.snapshot);
  const facts = modelTemplate(f.snapshot);
  facts.gates.forEach(gate => {gate.state = 'satisfied';});
  facts.gates[0].evidence = ['proof-1-53', 'proof-1-41', 'proof-1-69'];
  facts.accounting[0].evidence = ['proof-1-53'];
  const concern = finding(); delete concern.path;
  concern.anchor = 'proof-1-69'; concern.evidence = ['proof-1-53'];
  concern.factors = Object.fromEntries(Object.keys(concern.factors).map(name =>
    [name, {reason: 'Observable changed production behavior.', evidence: ['proof-1-53']} ]));
  facts.findings.push(concern);
  const original = structuredClone(facts);
  let calls = 0;
  const result = await inspect({...f, role: 'examiner', model: 'deepseek-flash', fetchImpl: async () => {
    calls++;
    return {ok: true, json: async () => ({choices: [{finish_reason: 'tool_calls', message: {tool_calls:
      [{function: {name: 'acceptance_report', arguments: JSON.stringify(facts)}}]}}]})};
  }});
  assert.equal(calls, 1);
  assert.deepEqual(facts, original, 'the original observations and causal finding remain intact');
  assert.doesNotThrow(() => validateInspection(result.report, f.snapshot));
  assert.deepEqual(result.report.gates[0].evidence, ['proof-1-41']);
  assert.deepEqual(result.report.accounting[0].evidence, ['proof-1-41']);
  const proof = result.report.evidence.find(entry => entry.id === 'proof-1-41');
  assert.deepEqual({source: proof.source, start: proof.start, end: proof.end}, {source: 'head', start: 41, end: 80});
  assert.equal(proof.quote, f.snapshot.sources.head.content.split('\n').slice(40, 80).join('\n'));
  assert.equal(result.report.evidence.filter(entry => entry.id === proof.id).length, 1);
  assert.equal(result.report.findings[0].cause, concern.cause);
  assert.equal(result.report.findings[0].obligation, concern.obligation);
  assert.equal(result.report.findings[0].path, 'src/upload.rs');
}));

test('line normalization rejects unknown sources, out-of-range offsets and unsupplied empty blocks', () => {
  const {snapshot} = fixture();
  for (const id of ['proof-2-1', 'proof-1-99', 'proof-01-2', 'proof-1-0', 'proof-1-1.5', 'invented-alias']) {
    const facts = modelTemplate(snapshot); facts.gates[0].evidence = [id];
    assert.throws(() => materialize(facts, snapshot), /Unknown controller-supplied source proof/);
  }
  snapshot.sources.head.content = 'validate(input)?;\n' + '\n'.repeat(80);
  require('./acceptance-sources.cjs').refresh(snapshot);
  const facts = modelTemplate(snapshot); facts.gates[0].evidence = ['proof-1-53'];
  assert.throws(() => materialize(facts, snapshot), /Unknown controller-supplied source proof/);
});

test('complete independent source reports are graded and combined without exposing either verdict to the other', withKey(async () => {
  const f = fixture(); const reports = []; const requests = [];
  f.snapshot.sources.test = {authority: 'untrusted', kind: 'source', ref: f.snapshot.head_sha, path: 'src/upload.test.rs', content: 'use upload;\n'};
  const config = {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'deepseek', grading_model: 'deepseek-flash'};
  const result = await reviewChange({...f, config, diagnostic: result => reports.push(result), fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (body.messages[0].content.includes('Role:')) return response(f.report);
    const packet = JSON.parse(body.messages[1].content);
    return response({answers: Object.fromEntries(Object.keys(packet.questions).map(id => [id, 'level4']))});
  }});
  assert.equal(result.decision, 'auto_approve'); assert.equal(result.reviews.length, 2); assert.equal(result.usage.length, 2, 'a change without findings needs no grading');
  assert.deepEqual(requests.slice(0, 2).map(request => request.model), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(requests[0].messages[1].content, requests[1].messages[1].content);
  const native = requests[0].tools.find(item => item.function.name === 'acceptance_report').function.parameters;
  assert.equal(native.properties.evidence, undefined, 'source bookkeeping is not delegated to the model');
  assert.deepEqual(native.properties.gates.items.properties.evidence.items.enum, modelEvidence(f.snapshot).proofs.map(proof => proof.id));
  assert.deepEqual(native.properties.snapshot.enum, [f.snapshot.digest]);
  assert.ok(!JSON.parse(requests[1].messages[1].content).reviews);
  assert.equal(reports[0], result);
  const quiet = await reviewChange({...f, config, fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body);
    if (body.messages[0].content.includes('Role:')) return response(f.report);
    const packet = JSON.parse(body.messages[1].content);
    return response({answers: Object.fromEntries(Object.keys(packet.questions).map(id => [id, 'level4']))});
  }});
  assert.equal(quiet.decision, 'auto_approve', 'optional telemetry cannot be a prerequisite for the decision');
}));

test('independent negative findings retain their decision and cannot be voted away', () => {
  for (const decision of ['blocked_integrity', 'repair_required', 'review_incomplete', 'owner_decision', 'auto_approve']) {
    assert.equal(combine([{scores: {decision: 'auto_approve'}}, {scores: {decision}}]), decision);
  }
});

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

test('fact validation produces no approval score and rejects unknown citations', () => {
  const {snapshot} = fixture();
  const materialized = materialize(template(snapshot), snapshot);
  const {validateFacts} = require('./acceptance.cjs');
  assert.equal(validateFacts(materialized, snapshot), undefined, 'fact validation cannot provide an approval score');
  assert.doesNotThrow(() => validateInspection(materialized, snapshot));
  materialized.accounting[0].evidence = ['undeclared'];
  assert.throws(() => validateFacts(materialized, snapshot), /missing or unknown citation/);
});

test('the real inspection transport losslessly partitions valid long citations without resampling', withKey(async () => {
  for (const end of [40, 41, 79, 80]) {
    const f = fixture();
    f.snapshot.sources.verification = {authority: 'trusted', kind: 'verification', content:
      Array.from({length: 79}, (_, index) => `Step ${index + 1}: success`).join('\n')};
    require('./acceptance-sources.cjs').refresh(f.snapshot);
    f.report.snapshot = f.snapshot.digest;
    f.report.evidence.push({id: 'receipt', source: 'verification', start: 1, end});
    f.report.gates.at(-1).evidence = ['receipt'];
    let calls = 0;
    const result = inspect({...f, role: 'examiner', model: 'deepseek-flash', fetchImpl: async (_, options) => {
      calls++;
      const request = JSON.parse(options.body);
      assert.match(request.messages[0].content, /at most 40 inclusive\s+lines/);
      const schema = request.tools.find(item => item.function.name === 'acceptance_report').function.parameters;
      assert.equal(schema.properties.evidence, undefined);
      assert.ok(schema.properties.findings.items.properties.anchor.enum.every(id => modelEvidence(f.snapshot).proofs.some(proof => proof.id === id)));
      return response(f.report);
    }});
    if (end <= 79) {
      const accepted = await result;
      const refs = accepted.report.gates.at(-1).evidence;
      const parts = refs.map(id => accepted.report.evidence.find(entry => entry.id === id));
      assert.equal(parts.map(part => part.quote).join('\n'), f.snapshot.sources.verification.content.split('\n').slice(0, end).join('\n'));
      assert.ok(parts.every(part => part.end - part.start < 40));
      assert.equal(parts[0].id, 'receipt');
      assert.equal(parts.at(-1).end, end);
    } else await assert.rejects(result, /outside its immutable source/);
    assert.equal(calls, 1, 'format normalization never resamples a completed judgment');
  }
}));

test('long source and causal-anchor proofs preserve all lines, references and blocking scores', async () => {
  const {snapshot, report} = fixture();
  snapshot.sources.head.content = Array.from({length: 81}, (_, i) => `production statement ${i + 1}`).join('\n');
  require('./acceptance-sources.cjs').refresh(snapshot); report.snapshot = snapshot.digest;
  report.evidence[1] = {id: 'source', source: 'head', start: 1, end: 81, quote: snapshot.sources.head.content};
  report.findings.push(finding());
  const {validateReport, scoreReport} = require('./acceptance.cjs');
  assert.throws(() => validateInspection(report, snapshot), /citation source or lines/, 'the stored-proof validator keeps its 40-line limit');
  const payload = await response(report).json();
  const facts = JSON.parse(payload.choices[0].message.tool_calls[0].function.arguments);
  const original = structuredClone(facts);
  const value = materialize(facts, snapshot);
  assert.deepEqual(facts, original, 'the captured model response stays immutable');
  for (const refs of [value.accounting[0].evidence, value.gates[0].evidence]) {
    assert.equal(refs.map(id => value.evidence.find(entry => entry.id === id).quote).join('\n'), snapshot.sources.head.content);
  }
  const causal = value.findings[0].evidence.filter(id => id.startsWith('clouseau-'));
  // The finding also retains its original source proof, plus its complete anchor.
  assert.ok(causal.length >= 3);
  assert.equal(value.findings[0].path, report.findings[0].path);
  for (const [key, factor] of Object.entries(value.findings[0].factors)) factor.value = report.findings[0].factors[key].value;
  assert.deepEqual(validateReport(value, snapshot), scoreReport(report));
  assert.equal(validateReport(value, snapshot).decision, 'repair_required');
  value.findings[0].evidence.push('invented');
  assert.throws(() => validateReport(value, snapshot), /missing or unknown citation/);
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
  f.snapshot.sources['head:src/upload.rs'] = f.snapshot.sources.head; require('./acceptance-sources.cjs').refresh(f.snapshot);
  const github = {rest: {repos: {getContent: async () => ({data: {encoding: 'base64', content: Buffer.from('source').toString('base64')}})}}};
  // A request that fetches nothing is told so, loses the right to ask again and must conclude.
  const tools = []; let turn = 0;
  const concluded = await inspect({...f, github, role: 'examiner', model: 'deepseek-flash', fetchImpl: async (_, options) => {
    tools.push(JSON.parse(options.body).tools.map(item => item.function.name));
    return ++turn === 1 ? response({request_sources: ['src/upload.rs']}) : response({...f.report, snapshot: f.snapshot.digest});
  }});
  assert.deepEqual(tools, [['acceptance_report', 'source_request'], ['acceptance_report']]);
  assert.match(f.snapshot.evidence_notice, /no further source request is accepted/);
  assert.equal(concluded.report.snapshot, f.snapshot.digest);
  let call = 0;
  await assert.rejects(inspect({...fixture(), github, role: 'examiner', model: 'deepseek-flash', fetchImpl: async () => response({request_sources: [`src/new-${++call}.rs`]})}), /invalid structured result/);
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

test('a change with no executable code treats an invalid inapplicable test gate as not required', () => {
  const {snapshot} = fixture();
  snapshot.files = [{path: 'README.md', status: 'modified'}];
  const gate = state => ({units: [], accounting: [], evidence: [], findings: [], gates: [{name: 'test_integrity', state, reason: 'Nothing to test.'}, {name: 'scope_authority', state: 'inapplicable', reason: 'x'}]});
  const converted = materialize(gate('inapplicable'), snapshot);
  assert.equal(converted.gates[0].state, 'satisfied');
  assert.match(converted.gates[0].reason, /No executable code changed/);
  assert.equal(converted.gates[1].state, 'inapplicable', 'other required gates are not rewritten');
  assert.equal(materialize(gate('unresolved'), snapshot).gates[0].state, 'unresolved');
  snapshot.files = [{path: 'src/app.ts', status: 'modified'}];
  assert.equal(materialize(gate('inapplicable'), snapshot).gates[0].state, 'inapplicable', 'code changes keep the invalid state visible');
});
