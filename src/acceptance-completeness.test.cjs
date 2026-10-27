'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture, finding} = require('../test/fixtures/acceptance.cjs');
const {validateFacts, validateReport, digest} = require('./acceptance.cjs');
const {template, modelTemplate, modelEvidence, materialize, inspect} = require('./acceptance-review.cjs');
const {schemas} = require('./acceptance-schema.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {reconcile, render, priorState} = require('./acceptance-ledger.cjs');

function complete() {
  const f = fixture(); f.snapshot.review_manifest_version = 1; refresh(f.snapshot); f.report.snapshot = f.snapshot.digest;
  f.report.coverage = {sources: [
    {source: 'contract', state: 'inspected', reason: 'Checked the accepted upload boundary.', evidence: ['contract']},
    {source: 'head', state: 'inspected', reason: 'Inspected validation and durable acceptance.', evidence: ['source']},
  ], dependencies: []};
  f.report.reopenings = [];
  return f;
}
function result(f) {
  return {decision: 'auto_approve', reviews: ['examiner', 'challenger'].map(role => ({role, report: structuredClone(f.report), scores: validateReport(f.report, f.snapshot)}))};
}
function advance(f, content) {
  f.snapshot.head_sha = digest(content).slice(0, 40); f.snapshot.sources.head.ref = f.snapshot.head_sha;
  f.snapshot.sources.head.content = content; refresh(f.snapshot); f.report.snapshot = f.snapshot.digest;
  f.report.evidence.find(item => item.id === 'source').quote = content.split('\n')[0];
}

test('a material missing dependency cannot be hidden behind green tests or a satisfied completeness gate', () => {
  const f = complete();
  f.report.coverage.dependencies.push({path: 'src/store.rs', state: 'missing', reason: 'Durable acknowledgement depends on this implementation.', evidence: []});
  assert.throws(() => validateReport(f.report, f.snapshot), /missing material source/);
  f.report.gates.find(gate => gate.name === 'review_completeness').state = 'unresolved';
  assert.equal(validateReport(f.report, f.snapshot).decision, 'auto_approve');
  f.snapshot.sources.store = {path: 'src/store.rs', kind: 'source', ref: f.snapshot.head_sha, content: 'persist_then_ack();'};
  f.report.evidence.push({id: 'store', source: 'store', start: 1, end: 1, quote: 'persist_then_ack();'});
  f.report.coverage.sources.push({source: 'store', state: 'inspected', reason: 'Storage persists before acknowledgement.', evidence: ['store']});
  Object.assign(f.report.coverage.dependencies[0], {state: 'inspected', evidence: ['store']});
  f.report.gates.find(gate => gate.name === 'review_completeness').state = 'satisfied';
  refresh(f.snapshot); f.report.snapshot = f.snapshot.digest;
  assert.equal(validateReport(f.report, f.snapshot).decision, 'auto_approve');
  f.snapshot.sources.store.ref = 'b'.repeat(40); refresh(f.snapshot); f.report.snapshot = f.snapshot.digest;
  assert.throws(() => validateReport(f.report, f.snapshot), /direct immutable evidence/);
});

test('all supplied context is inventoried and exclusions require reasons and real citations', () => {
  const f = complete();
  for (const mutate of [
    r => r.coverage.sources.pop(), r => r.coverage.sources.push(r.coverage.sources[0]),
    r => {r.coverage.sources[0].source = 'invented';}, r => {r.coverage.sources[0].state = 'invented';},
    r => {r.coverage.sources[0].reason = '';}, r => {r.coverage.sources[0].evidence = ['source'];},
    r => {r.coverage.sources[1].state = 'excluded';}, r => {r.coverage.sources[0].evidence = [];},
    r => {r.coverage.sources[0].state = 'missing';}, r => {delete r.coverage;},
  ]) {const report = structuredClone(f.report); mutate(report); assert.throws(() => validateReport(report, f.snapshot));}
  f.report.coverage.sources[0].state = 'excluded';
  assert.equal(validateReport(f.report, f.snapshot).decision, 'auto_approve');
  f.report.coverage.sources[0].state = 'missing'; f.report.coverage.sources[0].evidence = [];
  f.report.gates.find(gate => gate.name === 'review_completeness').state = 'unresolved';
  assert.equal(validateReport(f.report, f.snapshot).decision, 'auto_approve');
});

test('dependency exclusions are explicit and material paths cannot be invented or repeated', () => {
  const f = complete();
  f.report.coverage.dependencies = [{path: 'generated/catalog.json', state: 'excluded', reason: 'The changed path never reads this generated catalog.', evidence: ['source']}];
  assert.equal(validateReport(f.report, f.snapshot).decision, 'auto_approve');
  for (const path of ['', '/private/key', '../key', 'src/./key', '.git/config', 'a//b', 'a\\b', 12]) {
    f.report.coverage.dependencies[0].path = path;
    assert.throws(() => validateReport(f.report, f.snapshot), /dependency path/);
  }
  f.report.coverage.dependencies[0].path = 'generated/catalog.json';
  f.report.coverage.dependencies.push(f.report.coverage.dependencies[0]);
  assert.throws(() => validateReport(f.report, f.snapshot), /dependency inventory/);
  f.report.coverage.dependencies = null;
  assert.throws(() => validateReport(f.report, f.snapshot), /dependency inventory/);
});

test('the native response schema requires a selected proof for inspected and excluded coverage, and none for missing', () => {
  const f = complete();
  const schema = schemas(f.snapshot).acceptance_report;
  const ordinary = schema.properties.units.items.properties.fit.properties.outcome.properties.evidence;
  assert.equal(ordinary.type, 'array', 'factor and gate citation formats remain unchanged');
  for (const name of ['sources', 'dependencies']) {
    const choices = schema.properties.coverage.properties[name].items.anyOf;
    for (const state of ['inspected', 'excluded', 'missing']) {
      const selected = choices.filter(choice => choice.properties.state.enum.includes(state));
      assert.equal(selected.length, 1, `${name}/${state} has one evidence rule`);
      const evidence = selected[0].properties.evidence;
      if (state === 'missing') {
        assert.equal(evidence, undefined, 'missing context cannot claim inspection proof');
        assert.ok(!selected[0].required.includes('evidence'));
      } else {
        assert.equal(evidence.type, 'object', `${name}/${state} must select real supplied proof`);
        assert.deepEqual(evidence.required, ['primary', 'additional']);
        assert.equal(evidence.additionalProperties, false);
        assert.deepEqual(evidence.properties.primary.enum, ordinary.items.enum);
        assert.deepEqual(evidence.properties.additional.items.enum, ordinary.items.enum);
      }
    }
  }
  const facts = modelTemplate(f.snapshot);
  const source = schema.properties.coverage.properties.sources.items.anyOf[0].properties.source;
  assert.deepEqual(source.enum, facts.coverage.sources.map(item => item.source), 'numeric inventory IDs remain unchanged');
  for (const name of ['sources', 'dependencies']) {
    const excluded = structuredClone(facts);
    const item = name === 'sources' ? excluded.coverage.sources[0] :
      {path: 'src/acceptance.cjs', reason: 'This upload change does not depend on the acceptance engine.'};
    Object.assign(item, {state: 'excluded', evidence: []});
    if (name === 'dependencies') excluded.coverage.dependencies.push(item);
    assert.throws(() => validateFacts(materialize(excluded, f.snapshot), f.snapshot), /missing or unknown citation/,
      'the pre-existing semantic validator still rejects the failed PR40 disposition');
    item.evidence = structuredClone(facts.coverage.sources[0].evidence);
    assert.doesNotThrow(() => validateFacts(materialize(excluded, f.snapshot), f.snapshot));
    item.state = 'missing'; delete item.evidence;
    assert.doesNotThrow(() => validateFacts(materialize(excluded, f.snapshot), f.snapshot));
    item.evidence = [facts.coverage.sources[0].evidence.primary];
    assert.throws(() => validateFacts(materialize(excluded, f.snapshot), f.snapshot), /missing source cannot claim inspection evidence/);
  }
  const serialized = JSON.stringify(schema);
  assert.ok(!serialized.includes('minItems') && !serialized.includes('maxItems'), 'strict provider does not support array cardinality keywords');
});

test('native inspection sends the cited-exclusion schema and preserves an invalid completed claim without resampling', async () => {
  const f = complete(); const facts = modelTemplate(f.snapshot);
  facts.coverage.dependencies.push({path: 'src/acceptance.cjs', state: 'excluded',
    reason: 'The upload change does not depend on this engine.', evidence: []});
  const original = structuredClone(facts); const observations = []; let calls = 0;
  const previous = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional';
  try {
    await assert.rejects(inspect({...f, role: 'examiner', model: 'deepseek-flash', observe: value => observations.push(value),
      fetchImpl: async (_, options) => {
        calls++;
        const request = JSON.parse(options.body);
        assert.match(request.messages[0].content, /coverage evidence selects \{primary,additional\}/);
        const tool = request.tools.find(item => item.function.name === 'acceptance_report').function;
        assert.equal(tool.strict, true);
        for (const name of ['sources', 'dependencies']) {
          const excluded = tool.parameters.properties.coverage.properties[name].items.anyOf
            .find(choice => choice.properties.state.enum.includes('excluded'));
          assert.deepEqual(excluded.properties.evidence.required, ['primary', 'additional']);
          assert.ok(excluded.properties.evidence.properties.primary.enum.length > 0);
        }
        return {ok: true, json: async () => ({choices: [{finish_reason: 'tool_calls', message: {tool_calls:
          [{function: {name: 'acceptance_report', arguments: JSON.stringify(facts)}}]}}]})};
      }}), /missing or unknown citation/);
    assert.equal(calls, 1, 'a completed invalid review is never retried for a different judgment');
    assert.deepEqual(facts, original);
    assert.deepEqual(observations[0].report, original, 'negative diagnostic retains the uncited claim exactly');
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test('coverage proof objects materialize exactly without changing captured facts or other citation formats', () => {
  const f = complete(); const facts = modelTemplate(f.snapshot);
  const first = facts.coverage.sources[0].evidence.primary;
  const second = facts.coverage.sources[1].evidence.primary;
  facts.coverage.sources[0].state = 'excluded';
  facts.coverage.sources[0].evidence.additional.push(second);
  facts.coverage.dependencies.push({path: f.snapshot.sources.head.path, state: 'inspected',
    reason: 'Inspected the actual current-head implementation.', evidence: {primary: second, additional: [first]}});
  const original = structuredClone(facts);
  const report = materialize(facts, f.snapshot);
  assert.deepEqual(facts, original);
  assert.deepEqual(report.coverage.sources[0].evidence, [first, second]);
  assert.deepEqual(report.coverage.dependencies[0].evidence, [second, first]);
  assert.deepEqual(report.units[0].fit.outcome.evidence, facts.units[0].fit.outcome.evidence);
  assert.deepEqual(report.gates[0].evidence, facts.gates[0].evidence);
  assert.doesNotThrow(() => validateFacts(report, f.snapshot));
  assert.deepEqual(report.coverage.sources.map(item => item.source), Object.keys(f.snapshot.sources));
  for (const evidence of [null, [], {}, {primary: first}, {additional: []}, {primary: first, additional: null},
    {primary: first, additional: [3]}, {primary: 3, additional: []},
    {primary: first, additional: [], extra: true}, {primary: '', additional: []},
    {primary: 'invented', additional: []}, {primary: first, additional: ['invented']},
    {primary: first, additional: [first]}, {primary: first, additional: [second, second]}]) {
    const invalid = structuredClone(facts); invalid.coverage.sources[0].evidence = evidence;
    assert.throws(() => validateFacts(materialize(invalid, f.snapshot), f.snapshot), undefined, JSON.stringify(evidence));
  }
  const absent = structuredClone(facts); delete absent.coverage.sources[0].evidence;
  assert.throws(() => validateFacts(materialize(absent, f.snapshot), f.snapshot));
  const wrong = structuredClone(facts); wrong.coverage.sources[1].evidence.primary = first;
  assert.throws(() => validateFacts(materialize(wrong, f.snapshot), f.snapshot), /direct immutable evidence/);
  wrong.coverage.sources[0].state = 'missing';
  assert.throws(() => materialize(wrong, f.snapshot), /primary proof/);
});

test('the actual model template and materializer preserve the complete immutable source inventory', () => {
  const f = complete();
  f.snapshot.sources.blank = {content: '\n', path: 'empty.txt'}; refresh(f.snapshot);
  const sample = template(f.snapshot);
  assert.equal(sample.coverage.sources.length, 3);
  assert.equal(sample.coverage.sources.at(-1).state, 'excluded');
  const facts = modelTemplate(f.snapshot);
  assert.deepEqual(facts.coverage.sources.map(item => item.source), [0, 1, 2]);
  assert.deepEqual(Object.values(modelEvidence(f.snapshot).sources).map(item => item.source_index), [0, 1, 2]);
  const selection = schemas(f.snapshot).acceptance_report.properties.coverage.properties.sources.items.anyOf[0].properties.source;
  assert.equal(selection.type, 'integer');
  assert.deepEqual(selection.enum, [0, 1, 2]);
  const dependencies = schemas(f.snapshot).acceptance_report.properties.coverage.properties.dependencies.items;
  assert.deepEqual(dependencies.anyOf[0].properties.state.enum, ['excluded']);
  assert.deepEqual(dependencies.anyOf[1].properties.state.enum, ['missing']);
  assert.ok(!dependencies.anyOf[2].properties.path.enum.includes('unseen-dependency.cjs'));
  assert.ok(dependencies.anyOf[2].properties.path.enum.includes(f.snapshot.sources.head.path));
  const noHead = structuredClone(f.snapshot); Object.values(noHead.sources).forEach(source => {source.ref = 'base';});
  assert.equal(schemas(noHead).acceptance_report.properties.coverage.properties.dependencies.items.anyOf.length, 2);
  const report = materialize(facts, f.snapshot);
  assert.equal(report.coverage.sources.length, 3);
  assert.equal(report.coverage.sources[0].source, 'contract');
  assert.ok(report.coverage.sources[1].evidence.length);
  // A real new review is fail-closed until its observed gates and grades exist.
  assert.equal(validateReport(report, f.snapshot).decision, 'auto_approve');
  for (const source of [-1, 3, 'truncated-sha:src/upload.rs']) {
    const invalid = structuredClone(facts); invalid.coverage.sources[1].source = source;
    assert.throws(() => validateReport(materialize(invalid, f.snapshot), f.snapshot), /unknown inventoried source/);
  }
  const duplicate = structuredClone(facts); duplicate.coverage.sources[1].source = 0;
  assert.throws(() => validateReport(materialize(duplicate, f.snapshot), f.snapshot), /incomplete source inventory/);
  const substituted = structuredClone(facts); substituted.coverage.sources[1].source = 2; substituted.coverage.sources[2].source = 1;
  assert.throws(() => validateReport(materialize(substituted, f.snapshot), f.snapshot), /inspection lacks direct immutable evidence/);
  f.snapshot.sources.added = {content: 'supporting source', path: 'helper.rs', ref: f.snapshot.head_sha}; refresh(f.snapshot);
  assert.equal(template(f.snapshot).coverage.sources.find(item => item.source === 'added').state, 'inspected');
  const empty = structuredClone(report); empty.coverage.sources[2].state = 'excluded';
  f.snapshot.sources.blank.path = 'src/blank.rs'; f.snapshot.files.push({path: 'src/blank.rs', head_source: 'blank'});
  // Empty changed source remains explicitly excludable; nonempty changed source does not.
  const fresh = template(f.snapshot); assert.equal(fresh.coverage.sources.find(item => item.source === 'blank').state, 'excluded');
});

test('finding history survives repair, unrelated pushes, paraphrases, rename, and an evidenced regression', () => {
  const f = complete();
  advance(f, 'accept_durably(input)\n// validation missing\n');
  f.report.findings = [finding()];
  let state = reconcile(result(f), f.snapshot);
  const id = state.findings[0].id;
  assert.equal(state.findings[0].events.length, 1);
  f.snapshot.prior_findings = state.findings;
  advance(f, 'validate(input)?;\naccept_durably(input)\n');
  f.report.findings = []; f.report.resolutions = [{id, state: 'corrected', reason: 'Rejection is restored before storage.', evidence: ['source']}];
  state = reconcile(result(f), f.snapshot, state.findings);
  assert.equal(state.findings[0].state, 'corrected');
  assert.equal(state.findings[0].events.length, 2);
  const closed = structuredClone(state.findings);
  f.snapshot.prior_findings = closed;
  advance(f, 'validate(input)?;\naccept_durably(input)\n// unrelated comment\n'); f.report.resolutions = [];
  state = reconcile(result(f), f.snapshot, closed);
  assert.equal(state.findings[0].state, 'corrected');
  assert.equal(state.findings[0].events.length, 2);
  f.report.findings = [{...finding(), id, title: 'A paraphrased accusation', cause: 'Different words for the same rejected claim.'}];
  state = reconcile(result(f), f.snapshot, closed);
  assert.deepEqual(state.unresolved, [id]); assert.equal(state.findings[0].state, 'corrected');
  f.report.reopenings = [{id, reason: 'The validation allegedly disappeared.', evidence: ['source']}];
  state = reconcile(result(f), f.snapshot, closed);
  assert.deepEqual(state.unresolved, [id], 'a reason without changed evidence cannot reverse the accepted repair');
  // Restore the actual defect. Its bytes match the original defect, but differ
  // from the closure evidence, so this is a valid evidenced reopening.
  advance(f, 'accept_durably(input)\n// validation missing\n');
  state = reconcile(result(f), f.snapshot, closed);
  assert.deepEqual(state.unresolved, []); assert.equal(state.findings[0].blocking, true);
  assert.equal(state.findings[0].events.length, 3);
  assert.equal(state.findings[0].events[2].reason, f.report.reopenings[0].reason);
  // Rename a still-open path: identity follows the base path, not its title.
  f.snapshot.files[0].base_source = 'old'; f.snapshot.sources.old = {...f.snapshot.sources.head, path: 'src/upload.rs'};
  f.snapshot.paths = ['src/renamed.rs']; f.snapshot.files[0].path = 'src/renamed.rs'; f.snapshot.sources.head.path = 'src/renamed.rs';
  f.snapshot.prior_findings = state.findings; f.report.findings[0].id = id; f.report.reopenings = [];
  f.report.evidence.push({id: 'old-proof', source: 'old', start: 1, end: 1, quote: 'accept_durably(input)'});
  f.report.coverage.sources.push({source: 'old', state: 'inspected', reason: 'Checked the pre-rename source.', evidence: ['old-proof']});
  const raw = resultForRename(f); const renamed = reconcile(raw, f.snapshot, state.findings);
  assert.equal(renamed.findings[0].id, id); assert.equal(renamed.findings[0].path, 'src/renamed.rs');
  const body = render(raw, f.snapshot, renamed);
  assert.match(body, /History/);
  assert.equal(priorState([{id: 9, user: {login: 'github-actions[bot]'}, body}], f.snapshot.repository, f.snapshot.number).findings[0].events.length, 4);
});

test('distinct causes sharing one path and obligation cannot overwrite each other', () => {
  const f = complete();
  f.report.findings = [finding()];
  const prior = reconcile(result(f), f.snapshot).findings;
  f.snapshot.prior_findings = prior;
  f.report.findings = [{...finding(), id: prior[0].id},
    {...finding(), id: 'second-cause', cause: 'A separate storage exception is swallowed before acceptance.'}];
  const active = reconcile(result(f), f.snapshot, prior);
  assert.equal(active.findings.length, 2);
  assert.equal(new Set(active.findings.map(item => item.id)).size, 2);
  f.snapshot.prior_findings = active.findings;
  f.report.findings = [f.report.findings[1]];
  f.report.resolutions = [{id: prior[0].id, state: 'corrected', reason: 'Input validation was restored; storage still needs its own repair.', evidence: ['source']}];
  const repaired = reconcile(result(f), f.snapshot, active.findings);
  assert.equal(repaired.findings.find(item => item.id === prior[0].id).state, 'corrected');
  assert.equal(repaired.findings.filter(item => item.blocking).length, 1);
});

test('case and string whitespace remain meaningful evidence when reopening a defect', () => {
  for (const content of ["accept('ADMIN')", "accept('ad  min')"]) {
    const f = complete(); advance(f, "accept('admin')\n"); f.report.findings = [finding()];
    const prior = reconcile(result(f), f.snapshot).findings;
    f.snapshot.prior_findings = prior; f.report.findings = [];
    f.report.resolutions = [{id: prior[0].id, state: 'dismissed', reason: 'The literal is currently valid.', evidence: ['source']}];
    const closed = reconcile(result(f), f.snapshot, prior).findings;
    f.snapshot.prior_findings = closed; advance(f, content + '\n');
    f.report.findings = [{...finding(), id: prior[0].id}]; f.report.resolutions = [];
    f.report.reopenings = [{id: prior[0].id, reason: 'The accepted literal changed.', evidence: ['source']}];
    const reopened = reconcile(result(f), f.snapshot, closed);
    assert.deepEqual(reopened.unresolved, []);
    assert.equal(reopened.findings[0].blocking, true);
  }
});
function resultForRename(f) {
  f.report.findings[0].path = 'src/renamed.rs'; f.report.findings[0].repair_paths = ['src/renamed.rs'];
  f.report.accounting[0].path = 'src/renamed.rs'; f.report.units[0].paths = ['src/renamed.rs'];
  refresh(f.snapshot); f.report.snapshot = f.snapshot.digest;
  return result(f);
}

test('a dismissed claim stays dismissed and unsupported reopening metadata fails closed', () => {
  const f = complete(); f.report.findings = [finding()];
  const previous = reconcile(result(f), f.snapshot).findings;
  const id = previous[0].id; f.snapshot.prior_findings = previous;
  f.report.findings = []; f.report.resolutions = [{id, state: 'dismissed', reason: 'Current source already rejects invalid input.', evidence: ['source']}];
  let state = reconcile(result(f), f.snapshot, previous);
  assert.equal(state.findings[0].state, 'dismissed');
  f.snapshot.prior_findings = state.findings; f.report.resolutions = [];
  assert.equal(reconcile(result(f), f.snapshot, state.findings).findings[0].state, 'dismissed');
  for (const reopenings of [null, [{id: 'invented', reason: 'A claim', evidence: ['source']}],
    [{id, reason: '', evidence: ['source']}], [{id, reason: 'A change', evidence: ['contract']}],
    [{id, reason: 'A change', evidence: ['source']}, {id, reason: 'Duplicate', evidence: ['source']}]]) {
    f.report.reopenings = reopenings; assert.throws(() => validateReport(f.report, f.snapshot));
  }
  f.report.reopenings = [];
  state.findings[0].events = Array.from({length: 32}, () => ({state: 'confirmed'})); state.findings[0].state = 'confirmed'; state.findings[0].blocking = true;
  f.report.resolutions = [{id, state: 'corrected', reason: 'Now restored.', evidence: ['source']}];
  assert.throws(() => reconcile(result(f), f.snapshot, state.findings), /history exceeds/);
});


test('legacy closures without evidence cannot be reopened', () => {
  const g = complete(); g.report.findings = [finding()];
  const prior = reconcile(result(g), g.snapshot).findings;
  prior[0].blocking = false; prior[0].state = 'dismissed'; delete prior[0].basis;
  g.report.findings[0].id = prior[0].id; g.snapshot.prior_findings = prior;
  let state = reconcile(result(g), g.snapshot, prior);
  assert.deepEqual(state.unresolved, [prior[0].id]);
  prior[0].basis = ['different'];
  g.report.reopenings = [{id: prior[0].id, reason: 'A changed source now supports the claim.', evidence: ['source']}];
  state = reconcile(result(g), g.snapshot, prior);
  assert.equal(state.findings[0].state, 'confirmed');
});


test('a newly generated verification receipt cannot reopen a closed source allegation', () => {
  const f = complete(); f.report.findings = [finding()];
  const previous = reconcile(result(f), f.snapshot).findings;
  previous[0].blocking = false; previous[0].state = 'dismissed';
  f.snapshot.prior_findings = previous;
  f.snapshot.sources.verification = {kind: 'verification', authority: 'trusted', path: 'verification', ref: f.snapshot.head_sha, content: 'A fresh successful test run.'};
  f.report.evidence.push({id: 'run', source: 'verification', start: 1, end: 1, quote: 'A fresh successful test run.'});
  f.report.coverage.sources.push({source: 'verification', state: 'inspected', reason: 'Verified the execution receipt.', evidence: ['run']});
  f.report.reopenings = [{id: previous[0].id, reason: 'Another CI run completed.', evidence: ['run']}];
  refresh(f.snapshot); f.report.snapshot = f.snapshot.digest;
  assert.throws(() => validateReport(f.report, f.snapshot), /repository evidence/);
  f.report.reopenings[0].evidence.push('source');
  assert.equal(validateReport(f.report, f.snapshot).decision, 'repair_required');
  const mixed = reconcile(result(f), f.snapshot, previous);
  assert.deepEqual(mixed.unresolved, [previous[0].id], 'an unchanged source plus a new receipt is not fresh repository evidence');
  assert.equal(mixed.findings[0].state, 'dismissed');
});

test('an optional repetition cannot erase a closure and bypass the next revision reopening guard', () => {
  for (const disposition of ['corrected', 'dismissed']) {
    const f = complete(); f.report.findings = [finding()];
    const original = reconcile(result(f), f.snapshot).findings;
    f.snapshot.prior_findings = original; f.report.findings = [];
    f.report.resolutions = [{id: original[0].id, state: disposition, reason: 'Source proves the concern is closed.', evidence: ['source']}];
    const closed = reconcile(result(f), f.snapshot, original).findings;
    f.snapshot.prior_findings = closed; f.report.resolutions = [];
    f.report.findings = [{...finding(), id: original[0].id}];
    for (const factor of Object.values(f.report.findings[0].factors)) factor.value = 0;
    const optional = reconcile(result(f), f.snapshot, closed).findings;
    assert.deepEqual(optional, closed, 'optional observations retain the accepted closure and evidence');
    f.snapshot.prior_findings = optional;
    f.report.findings = [{...finding(), id: original[0].id}];
    const repeated = reconcile(result(f), f.snapshot, optional);
    assert.equal(repeated.findings[0].state, disposition);
    assert.deepEqual(repeated.unresolved, [original[0].id]);
  }
});
