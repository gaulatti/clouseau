'use strict';

// Partition scheme clouseau-partition/2: the controller gives each unit the other ends of its seams as context. The
// regression shape is a real change whose units listed each other as missing under /1 (test/chunked-shape.cjs).

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {digest} = require('./acceptance.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {reviewDecision} = require('./local-receipt.cjs');
const {ChunkedRecordError, SCHEMES} = require('./chunked-record.cjs');
const {SCHEME} = require('./review-partition.cjs');
const wiring = require('./chunked-wiring.cjs');
const hosted = require('./hosted-chunked.cjs');
const {shapeSnapshot, linksOf, PARAMS, HEAD, BASE} = require('../test/chunked-shape.cjs');
// Produced by the engine of main 6d5e3d2, before clouseau-partition/2 existed, from shapeSnapshot() with C = 1.
const RECORDED = require('../test/fixtures/chunked-partition-1-record.json');

const SCHEME_2 = 'clouseau-partition/2';
const verifier = (extra = {}) => wiring.verifierOptions({chunked: {params: PARAMS, ...extra}});
const pathsOf = (snapshot, ids) => ids.map(id => snapshot.sources[id].path).sort();

// A reviewer that needs every changed file its owned files are linked to by an import, in either direction, and records
// one as missing exactly when the unit's evidence does not hold that file's head source.
function harness(snapshot) {
  const links = linksOf(snapshot);
  const stats = {calls: 0, missing: [], prompts: []};
  const ask = async task => {
    stats.calls++;
    const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
    let value;
    if (task.phase === 'investigation') {
      stats.prompts.push(task.prompt);
      const report = packet.template;
      report.gates.forEach(gate => {gate.state = 'satisfied';});
      const byIndex = new Map(Object.values(packet.evidence.sources).map(item => [item.source_index, item]));
      const held = new Map(report.coverage.sources.filter(item => byIndex.get(item.source).ref === HEAD)
        .map(item => [byIndex.get(item.source).path, item]));
      const owned = new Set(packet.evidence.unit.owned);
      const needed = [...new Set([...owned].flatMap(path => [...links.get(path)]))].filter(path => !owned.has(path)).sort();
      report.coverage.dependencies = needed.map(path => (held.has(path)
        ? {path, state: 'inspected', reason: 'Read the linked changed file.', evidence: held.get(path).evidence}
        : {path, state: 'missing', reason: 'The linked changed file is not in this unit.', evidence: []}));
      if (report.coverage.dependencies.some(item => item.state === 'missing')) {
        stats.missing.push(...report.coverage.dependencies.filter(item => item.state === 'missing').map(item => `${task.unit}:${item.path}`));
        report.gates.find(gate => gate.name === 'review_completeness').state = 'unresolved';
      }
      value = {kind: 'report', report, request_sources: []};
    } else if (task.phase === 'integration') {
      value = {dispositions: packet.seams.map(seam => ({seam: seam.id, state: 'checked', reason: 'Both ends were examined.'}))};
    } else throw new Error(`unexpected ${task.phase} session`);
    return {value, provenance: {harness: 'codex', role: task.role, phase: task.phase, session: `fictional-session-${stats.calls}`,
      request_digest: digest(task.prompt), response_digest: digest(value), transport_digest: digest({fixture_only: stats.calls})}};
  };
  return {ask, stats};
}

async function reviewShape(partition) {
  const snapshot = shapeSnapshot();
  const fake = harness(snapshot);
  const active = wiring.settings({chunked: {force: true, params: PARAMS, ...(partition ? {partition} : {})}});
  const {record} = await wiring.review({snapshot, active, ask: fake.ask, agent: true, technical: {fixture: true}, priorFindings: []});
  return {snapshot, record, stats: fake.stats};
}

function rejects(record, chunked, pattern) {
  assert.throws(() => reviewDecision(record, {chunked}), error => {
    assert.ok(error instanceof ChunkedRecordError, error.stack);
    assert.match(error.message, pattern);
    return true;
  });
}

test('a clouseau-partition/1 record produced before scheme 2 existed still verifies, recomputed byte for byte', () => {
  const record = structuredClone(RECORDED);
  assert.deepEqual(record.snapshot, shapeSnapshot(), 'the fixture is the regression shape');
  assert.equal(record.partition.scheme, SCHEME);
  const hooks = wiring.hooksFor(PARAMS);
  assert.equal(JSON.stringify(hooks.partition({snapshot: record.snapshot, scheme: SCHEME})), JSON.stringify(record.partition));
  assert.equal(JSON.stringify(hooks.partition({snapshot: record.snapshot})), JSON.stringify(record.partition), '/1 is the default');
  assert.equal(JSON.stringify(hooks.seams({snapshot: record.snapshot, plan: record.partition})), JSON.stringify(record.seams));
  assert.equal(reviewDecision(record, {chunked: verifier()}).decision, 'auto_approve');
  // Turning scheme 2 on in the protected configuration leaves outstanding /1 receipts verifiable.
  assert.equal(reviewDecision(record, {chunked: verifier({partition: 2})}).decision, 'auto_approve');
});

test('under /1 the regression shape keeps today\'s partition, and its units still report each other as missing', async () => {
  const {record, stats} = await reviewShape(undefined);
  assert.equal(JSON.stringify(record.partition), JSON.stringify(RECORDED.partition), 'the same partition the engine produced before');
  assert.ok(record.partition.units.every(unit => unit.context_ids.length === 0));
  assert.deepEqual([...new Set(stats.missing)].sort(), [
    'u0:src/local-cli.cjs', 'u0:src/policy.cjs',
    'u1:src/acceptance-controller.cjs', 'u1:src/policy.cjs',
    'u2:src/acceptance-controller.cjs', 'u2:src/local-cli.cjs', 'u2:src/local-cli.test.cjs']);
  assert.ok(stats.prompts.every(prompt => !prompt.includes('evidence.unit.context_ids names')), 'a /1 unit is told nothing new');
});

test('under /2 every unit sees the other changed files its seams reach, and no unit reports missing', async () => {
  const {snapshot, record, stats} = await reviewShape(2);
  assert.equal(record.partition.scheme, SCHEME_2);
  assert.deepEqual(record.partition.units.map(unit => unit.owned), RECORDED.partition.units.map(unit => unit.owned), 'the same units, with context');
  const links = linksOf(snapshot);
  for (const unit of record.partition.units) {
    const reached = [...new Set(unit.owned.flatMap(path => [...links.get(path)]))].filter(path => !unit.owned.includes(path)).sort();
    assert.deepEqual(pathsOf(snapshot, unit.context_ids), reached, `${unit.id} sees every changed file its seams reach`);
    assert.ok(unit.context_ids.every(id => snapshot.files.some(file => file.head_source === id)), 'only changed sources of the snapshot');
  }
  assert.deepEqual(stats.missing, [], 'no unit reports a missing dependency');
  assert.ok(stats.prompts.every(prompt => prompt.includes('evidence.unit.context_ids names')));
  const {decision, reviews} = reviewDecision(record, {chunked: verifier()});
  assert.equal(decision, 'auto_approve');
  for (const {report} of reviews) {
    assert.equal(report.gates.find(gate => gate.name === 'review_completeness').state, 'satisfied');
    assert.ok([...report.coverage.sources, ...report.coverage.dependencies].every(item => item.state !== 'missing'));
  }
  // The verifier recomputes the scheme the record names, whatever scheme the protected configuration produces.
  assert.equal(reviewDecision(record, {chunked: verifier({partition: 2})}).decision, 'auto_approve');
});

test('the verifier refuses an unknown scheme and any /2 context that differs from the recomputation', async () => {
  const {snapshot, record} = await reviewShape(2);
  assert.deepEqual(SCHEMES, [SCHEME, SCHEME_2]);
  const edit = change => {const copy = structuredClone(record); change(copy.partition); return copy;};
  rejects(edit(partition => {partition.scheme = 'clouseau-partition/3';}), verifier(), /unknown or malformed partition scheme/);
  rejects(edit(partition => {partition.units[0].context_ids.pop();}), verifier(), /context of unit u0 differs from the clouseau-partition\/2 context recomputed/);
  rejects(edit(partition => {partition.units[2].context_ids.reverse();}), verifier(), /context of unit u2 differs/);
  rejects(edit(partition => {partition.units[1].context_ids = [];}), verifier(), /context of unit u1 differs/);
  const foreign = Object.keys(snapshot.sources).find(id => !record.partition.units[1].context_ids.includes(id) && snapshot.sources[id].kind === 'source');
  rejects(edit(partition => {partition.units[1].context_ids.push(foreign);}), verifier(), /context of unit u1 differs/);
  // A /2 record relabelled /1 (or the reverse) is recomputed under the label it carries and refused.
  rejects(edit(partition => {partition.scheme = SCHEME;}), verifier(), /context of unit u\d differs from the clouseau-partition\/1 context/);
  const relabelled = structuredClone(RECORDED); relabelled.partition.scheme = SCHEME_2;
  rejects(relabelled, verifier(), /context of unit u\d differs from the clouseau-partition\/2 context/);
});

// u0 imports three large changed files and a removed one. Only two large ends fit its 900,000-character view.
function wide(order = x => x) {
  const big = (name, size) => `// ${name}\n${'x'.repeat(size)}\nmodule.exports = 1;\n`;
  const sources = {
    contract: {path: '.github/clouseau.md', ref: BASE, authority: 'trusted', kind: 'contract', content: '# Contract\n'},
    'local-request': {path: 'local-request', ref: 'r', authority: 'untrusted', kind: 'requirement', content: 'Change it.'},
    'user.head': {path: 'src/user.cjs', ref: HEAD, authority: 'untrusted', kind: 'source',
      content: "require('./b1.cjs');\nrequire('./b2.cjs');\nrequire('./b3.cjs');\nrequire('./gone.cjs');\n"},
    'gone.base': {path: 'src/gone.cjs', ref: BASE, authority: 'untrusted', kind: 'source', content: 'module.exports = 0;\n'},
  };
  const files = [
    {path: 'src/user.cjs', status: 'added', patch: '+x\n', head_source: 'user.head'},
    {path: 'src/gone.cjs', status: 'removed', patch: '-module.exports = 0;\n', base_source: 'gone.base'},
  ];
  for (const name of ['b1', 'b2', 'b3']) {
    sources[`${name}.head`] = {path: `src/${name}.cjs`, ref: HEAD, authority: 'untrusted', kind: 'source', content: big(name, 340000)};
    files.push({path: `src/${name}.cjs`, status: 'added', patch: '+module.exports = 1;\n', head_source: `${name}.head`});
  }
  const snapshot = {version: 2, review_manifest_version: 1, repository: 'o/r', number: 0, base_sha: BASE, head_sha: HEAD,
    head_repository: {owner: 'o', repo: 'r'}, paths: files.map(file => file.path).sort(), config_digest: 'c', policy_digest: 'p',
    sources: Object.fromEntries(order(Object.entries(sources))), files: order(files), history: [], tickets: [], intent_confirmation: null,
    prior_findings: [], claims: {title: 'change', description: 'Change it.'}, covering_tests: {}};
  return refresh(snapshot, Number.MAX_SAFE_INTEGER);
}

test('/2 context is deterministic, independent of input order, within the unit cap and read at base for a removed file', () => {
  const snapshot = wide();
  const plan = snapshot => wiring.hooksFor(PARAMS, SCHEME_2).partition({snapshot});
  const first = plan(snapshot);
  const shape = partition => partition.units.map(({id, owned, context_ids: context}) => ({id, owned, context}));
  assert.deepEqual(shape(plan(wide(list => [...list].reverse()))), shape(first), 'the same context in any input order');
  assert.equal(JSON.stringify(plan(wide())), JSON.stringify(first), 'the same plan on every run');
  const user = first.units.find(unit => unit.owned.includes('src/user.cjs'));
  assert.ok(user.context_ids.includes('gone.base'), 'a removed end is read at base, as its importer still names it');
  assert.equal(user.context_ids.filter(id => /^b\d\.head$/.test(id)).length, 2, 'the third large end does not fit and is left out, not cut');
  const gone = first.units.find(unit => unit.owned.includes('src/gone.cjs'));
  assert.deepEqual(gone.context_ids, ['user.head'], 'the importer of a removed file is context of its unit');
  const hooks = wiring.hooksFor(PARAMS, SCHEME_2);
  for (const unit of first.units) {
    const view = hooks.unitView(snapshot, unit);
    const {digest: _, ...value} = view;
    assert.ok(JSON.stringify(value).length <= 900000, `${unit.id} fits its cap`);
    assert.ok(unit.context_ids.every(id => Object.hasOwn(snapshot.sources, id) && view.sources[id] === snapshot.sources[id]));
  }
  // /1 recomputes the same snapshot with no context at all.
  assert.ok(wiring.hooksFor(PARAMS).partition({snapshot}).units.every(unit => unit.context_ids.length === 0));
});

test('the protected setting selects the scheme; hosted preflight counts /2 context toward its token cap', () => {
  assert.equal(wiring.settings(undefined).partition, 1);
  assert.equal(wiring.SCHEME_OF[wiring.settings({chunked: {partition: 2}}).partition], SCHEME_2);
  assert.equal(hosted.settings({chunked_hosted: {enabled: true, partition: 2}}).partition, 2);
  assert.ok(hosted.problem({enabled: true, partition: 5}));
  const snapshot = shapeSnapshot();
  const plan = wiring.hooksFor(PARAMS, SCHEME_2).plan(snapshot);
  const context = plan.units.reduce((sum, unit) => sum + unit.context_ids.reduce((total, id) => total + snapshot.sources[id].content.length, 0), 0);
  assert.ok(context > 0);
  const cost = plan.units.reduce((sum, unit) => sum + unit.cost, 0);
  assert.equal(hosted.preflight(plan, {max_units: 32, max_input_tokens: 6000000}, snapshot), Math.ceil(2 * (cost + context) / 4));
  const flat = wiring.hooksFor(PARAMS).plan(snapshot);
  assert.equal(hosted.preflight(flat, {max_units: 32, max_input_tokens: 6000000}), Math.ceil(2 * cost / 4), '/1 is estimated as before');
});

test('an end whose measured view still exceeds the budget is skipped, smaller ends are still tried, and any other error surfaces', () => {
  const {seamContext} = require('./seam-context.cjs');
  const snapshot = {files: [{path: 'a.js', head_source: 'h:a'}, {path: 'b.js', head_source: 'h:b'}, {path: 'c.js', head_source: 'h:c'}],
    sources: {'h:a': {content: 'a'}, 'h:b': {content: 'b'}, 'h:c': {content: 'c'}}};
  const specs = [{id: 'u0', owned: ['a.js']}, {id: 'u1', owned: ['b.js']}, {id: 'u2', owned: ['c.js']}];
  const seams = [{id: 's1', kind: 'import', a: {path: 'a.js'}, b: {path: 'b.js'}}, {id: 's2', kind: 'import', a: {path: 'a.js'}, b: {path: 'c.js'}}];
  // The source's own size fits the cap, but the real view with it does not (`unit_exceeds_budget`): it is skipped, not cut.
  const view = (spec, _units, refuse = id => id === 'h:b' && spec.id === 'u0') => {
    if ((spec.context_ids || []).some(refuse)) throw Object.assign(new Error('too large'), {code: 'unit_exceeds_budget'});
    return {sources: Object.fromEntries(spec.owned.map(name => [`h:${name[0]}`, {}]))};
  };
  const [u0] = seamContext({snapshot, specs, seams, view, cap: 1000});
  assert.deepEqual(u0.context_ids, ['h:c'], 'b did not fit u0; the smaller end c is still added');
  // Any other failure of the view is not a budget decision: it surfaces as itself.
  const failing = spec => {if ((spec.context_ids || []).length) throw new Error('view failed'); return {sources: {}};};
  assert.throws(() => seamContext({snapshot, specs, seams, view: failing, cap: 1000}), /view failed/);
});

test('an unknown partition scheme is refused by the planner itself', () => {
  const {partition} = require('./review-partition.cjs');
  assert.throws(() => partition([], {}, {scheme: 'clouseau-partition/3'}), TypeError);
});
