'use strict';

// A file too large for one unit, split into segments owned by different units: the views, the merge, the typed errors.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {digest, GATES, scoreReport} = require('./acceptance.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {template, validateInspection} = require('./acceptance-review.cjs');
const {partition} = require('./review-partition.cjs');
const {changeTable, segmentLimit} = require('./change-table.cjs');
const {unitView, mergeUnitReports} = require('./review-units.cjs');

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const PARAMS = {unit_ceiling: 4000, shared: 400, budget: 10000, reserve: 3000, file_overhead: 10};
const source = (path, content, ref = HEAD) => ({path, ref, authority: 'untrusted', kind: 'source', content});

// A 400-line file edited every ninth line, with a patch of single-line hunks, and two small files beside it.
function combined({manifest = true} = {}) {
  const old = Array.from({length: 400}, (_, index) => `line ${index + 1}`);
  const edited = old.map((line, index) => (index % 9 === 0 ? `${line} edited` : line));
  let patch = 'diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n';
  old.forEach((line, index) => {if (index % 9 === 0) patch += `@@ -${index + 1},1 +${index + 1},1 @@\n-${line}\n+${edited[index]}\n`;});
  const sources = {
    contract: {path: '.github/clouseau.md', ref: BASE, authority: 'trusted', kind: 'contract', content: '# Contract\n'},
    verification: {path: 'verification', ref: HEAD, authority: 'trusted', kind: 'verification', content: '{"ok":true}'},
    'local-request': {path: 'local-request', ref: 'r', authority: 'untrusted', kind: 'requirement', content: 'Change it.'},
    'big.base': source('big.txt', old.join('\n') + '\n', BASE), 'big.head': source('big.txt', edited.join('\n') + '\n'),
    'a.head': source('a.txt', 'alpha\n'), 'z.head': source('z.txt', 'zulu\n'),
  };
  const files = [
    {path: 'a.txt', status: 'added', patch: '@@ -0,0 +1,1 @@\n+alpha\n', head_source: 'a.head'},
    {path: 'big.txt', status: 'modified', patch, base_source: 'big.base', head_source: 'big.head'},
    {path: 'z.txt', status: 'added', patch: '@@ -0,0 +1,1 @@\n+zulu\n', head_source: 'z.head'},
  ];
  return refresh({version: 2, ...(manifest ? {review_manifest_version: 1} : {}), repository: 'o/r', number: 0, base_sha: BASE, head_sha: HEAD,
    head_repository: {owner: 'o', repo: 'r'}, paths: files.map(file => file.path).sort(), config_digest: 'c', policy_digest: 'p', sources, files,
    history: [{path: 'big.txt', commits: 'x'}], tickets: [], intent_confirmation: null, prior_findings: [], claims: {title: 't', description: 'Describe.'}}, 3000000);
}

const plan = snapshot => partition(changeTable(snapshot, PARAMS), PARAMS);
const specsOf = snapshot => plan(snapshot).units.map(({id, owned, parts}) => ({id, owned, context_ids: [], ...(parts ? {parts} : {})}));
const options = (units, extra = {}) => ({units, segmentLimit: segmentLimit(PARAMS), ...extra});

function report(view, edit = () => {}) {
  const value = template(view);
  for (const item of value.evidence) item.quote = view.sources[item.source].content.split('\n')[item.start - 1];
  for (const unit of value.units) unit.paths = value.accounting.filter(item => item.units.includes(unit.id)).map(item => item.path);
  for (const gate of value.gates) gate.state = 'satisfied';
  edit(value, view);
  return value;
}
const factors = (level, evidence) => Object.fromEntries(['necessity', 'confidence', 'severity', 'activation', 'irreversibility', 'reach', 'detection', 'propagation', 'recurrence']
  .map(name => [name, {value: name === 'confidence' ? level : 1, evidence: [evidence], reason: 'Observed.'}]));
function addFinding(value, view, id, level = 0.3) {
  const evidence = value.evidence.find(item => view.sources[item.source].path === 'big.txt').id;
  value.findings.push({id, title: 'Defect', path: 'big.txt', cause: `cause ${id}`, trigger: 't', consequence: 'c', obligation: 'o', evidence: [evidence],
    factors: factors(level, evidence), blast_radius: 1, opportunity: {mechanical: false, beneficial: false, within_scope: false, verified: false},
    repair_paths: ['big.txt']});
}
const viewsOf = (snapshot, units) => units.map(unit => unitView(snapshot, unit, options(units)));
const merge = (snapshot, units, edits = []) => mergeUnitReports(viewsOf(snapshot, units).map((view, index) => ({view, report: report(view, edits[index])})), snapshot);

test('the plan splits the large file and every segment unit sees only its own segment of it', () => {
  const snapshot = combined();
  const units = specsOf(snapshot);
  const holders = units.filter(unit => unit.owned.includes('big.txt'));
  assert.ok(holders.length >= 3);
  const views = viewsOf(snapshot, units);
  for (const view of views.filter(item => item.paths.includes('big.txt'))) {
    const file = view.files.find(item => item.path === 'big.txt');
    assert.equal(file.segment.count, holders.length);
    assert.ok(file.base_source.startsWith('big.base#s') && file.head_source.startsWith('big.head#s'));
    assert.ok(!view.sources['big.base'] && !view.sources['big.head'], 'the whole file is not in the view');
    assert.equal(view.sources[file.head_source].segment.source, 'big.head');
    assert.deepEqual(view.unit.parts['big.txt'], {index: file.segment.index, count: holders.length});
    assert.ok(file.patch.length < snapshot.files[1].patch.length);
    validateInspection(report(view), view);
  }
  // Together the segment patches carry every changed row of the file exactly once.
  const rows = views.flatMap(view => view.files.filter(file => file.path === 'big.txt').map(file => file.patch)).join('')
    .split('\n').filter(line => /^[+-]line/.test(line));
  assert.deepEqual(rows, snapshot.files[1].patch.split('\n').filter(line => /^[+-]line/.test(line)));
  // The manifest names every owner of the split file.
  assert.equal(views[0].change_manifest.find(row => row.path === 'big.txt').units.length, holders.length);
  // A unit that does not hold the file sees its whole patch as a foreign hunk only when it imports it; the others see nothing of it.
  assert.ok(views.filter(view => !view.paths.includes('big.txt')).every(view => !view.files.some(file => file.path === 'big.txt')));
});

test('the merged report covers the split file once and cites combined lines', () => {
  const snapshot = combined();
  const units = specsOf(snapshot);
  const {report: merged} = merge(snapshot, units);
  validateInspection(merged, snapshot);
  assert.equal(merged.accounting.length, snapshot.paths.length);
  const big = merged.accounting.find(item => item.path === 'big.txt');
  assert.equal(big.units.length, units.filter(unit => unit.owned.includes('big.txt')).length);
  assert.ok(big.reason.includes(' | ') && big.evidence.length >= big.units.length);
  // Every citation names a source of the combined snapshot, with its lines.
  assert.ok(merged.evidence.every(item => Object.hasOwn(snapshot.sources, item.source)));
  assert.equal(merged.coverage.sources.length, Object.keys(snapshot.sources).length);
  assert.ok(merged.coverage.sources.every(item => Object.hasOwn(snapshot.sources, item.source) && item.state === 'inspected'));
  assert.equal(scoreReport(merged).decision, 'auto_approve');
});

test('a citation of a segment window is the same lines of the whole source', () => {
  const snapshot = combined();
  const units = specsOf(snapshot);
  const index = units.findIndex(unit => unit.parts?.['big.txt']?.index === 2);
  const views = viewsOf(snapshot, units);
  const view = views[index];
  const window = view.sources[view.files.find(file => file.path === 'big.txt').head_source];
  const edited = window.content.split('\n').findIndex(line => line.endsWith('edited'));
  const {report: merged} = merge(snapshot, units, units.map((_, at) => (at === index ? (value, current) => {
    const id = `cite-${at}`;
    value.evidence.push({id, source: current.files.find(file => file.path === 'big.txt').head_source, start: edited + 1, end: edited + 1,
      quote: window.content.split('\n')[edited]});
    addFinding(value, current, 'f1');
    value.findings[0].evidence.push(id);
  } : undefined)));
  const lifted = merged.evidence.find(item => item.id === `u${index}:cite-${index}`);
  assert.equal(lifted.source, 'big.head');
  assert.equal(lifted.start, window.segment.start_line + edited);
  assert.equal(snapshot.sources['big.head'].content.split('\n')[lifted.start - 1], lifted.quote);
  validateInspection(merged, snapshot);
});

test('two units reviewing one file may name a finding alike; their identities stay apart', () => {
  const snapshot = combined();
  const units = specsOf(snapshot);
  const holders = units.map((unit, index) => (unit.owned.includes('big.txt') ? index : -1)).filter(index => index >= 0);
  const edits = units.map((_, index) => (holders.slice(0, 2).includes(index) ? (value, view) => addFinding(value, view, 'f1') : undefined));
  const {report: merged} = merge(snapshot, units, edits);
  const hash = digest('big.txt').slice(0, 8);
  assert.deepEqual(merged.findings.map(item => item.id), holders.slice(0, 2).map(index => `p${hash}.u${index}:f1`));
  validateInspection(merged, snapshot);
  // A whole file keeps the identity it always had.
  const whole = merge(combined(), specsOf(combined()), specsOf(combined()).map(unit => (unit.owned.includes('a.txt') ? (value, view) => {
    const id = value.evidence.find(item => view.sources[item.source].path === 'a.txt').id;
    value.findings.push({id: 'g1', title: 'T', path: 'a.txt', cause: 'c', trigger: 't', consequence: 'c', obligation: 'o', evidence: [id],
      factors: factors(0.3, id), blast_radius: 1, opportunity: {mechanical: false, beneficial: false, within_scope: false, verified: false}, repair_paths: ['a.txt']});
  } : undefined)));
  assert.equal(whole.report.findings[0].id, `p${digest('a.txt').slice(0, 8)}:g1`);
});

test('drafts of a unit that holds a segment are lifted like its report', () => {
  const snapshot = combined();
  const units = specsOf(snapshot);
  const views = viewsOf(snapshot, units);
  const at = units.findIndex(unit => unit.owned.includes('big.txt'));
  const first = report(views[at], (value, view) => addFinding(value, view, 'kept'));
  const second = report(views[at], (value, view) => addFinding(value, view, 'kept'));
  const reports = views.map((view, index) => ({view, report: index === at ? second : report(view), drafts: index === at ? [first] : []}));
  const {drafts} = mergeUnitReports(reports, snapshot);
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].evidence.every(item => Object.hasOwn(snapshot.sources, item.source)));
  assert.equal(drafts[0].findings[0].id, `p${digest('big.txt').slice(0, 8)}.u${at}:kept`);
});

test('a snapshot without a completeness manifest merges a split file too', () => {
  const snapshot = combined({manifest: false});
  const units = specsOf(snapshot);
  const {report: merged} = merge(snapshot, units);
  assert.equal(merged.coverage, undefined);
  validateInspection(merged, snapshot);
});

test('unit specs that do not cover the split file once per segment are refused', () => {
  const snapshot = combined();
  const units = specsOf(snapshot);
  const at = units.findIndex(unit => unit.parts?.['big.txt']?.index === 0);
  const bad = (unit, list, code = 'partition_invalid') => assert.throws(() => unitView(snapshot, unit, options(list)), error => error.code === code);
  const without = units.filter((_, index) => index !== units.findIndex(unit => unit.parts?.['big.txt']?.index === 1));
  bad(units[at], without);
  const twice = units.map((unit, index) => (index === at ? {...unit, parts: {'big.txt': {...unit.parts['big.txt'], index: 1}}} : unit));
  bad(twice[at], twice);
  const mixed = units.map((unit, index) => (index === at ? {...unit, parts: undefined} : unit));
  bad(mixed[at], mixed);
  for (const parts of ['x', [], {'a.txt': {index: 0, count: 1}}, {'big.txt': {index: 3, count: 2}}, {'big.txt': {index: 0.5, count: 1}}, {'big.txt': null}]) {
    const list = units.map((unit, index) => (index === at ? {...unit, parts} : unit));
    bad(list[at], list);
  }
  // A consistent cover whose segment count differs from the file's own segments is refused (the last segment dropped, count lowered).
  const last = Math.max(...units.map(unit => unit.parts?.['big.txt']?.index ?? -1));
  const shrunk = units.map(unit => {
    if (!unit.parts) return unit;
    const keep = unit.parts['big.txt'].index !== last;
    const owned = keep ? unit.owned : unit.owned.filter(name => name !== 'big.txt');
    return owned.length ? {...unit, owned, ...(keep ? {parts: {'big.txt': {index: unit.parts['big.txt'].index, count: last}}} : {parts: undefined})} : null;
  }).filter(Boolean).map(unit => (unit.parts === undefined ? (({parts, ...rest}) => rest)(unit) : unit));
  assert.throws(() => unitView(snapshot, shrunk.find(unit => unit.parts), options(shrunk)), error => error.code === 'partition_invalid' && /segment count/.test(error.message));
  // A segment the file does not have cannot be viewed.
  const extended = [...units.map(unit => (unit.parts ? {...unit, parts: {'big.txt': {...unit.parts['big.txt'], count: last + 2}}} : unit)),
    {id: 'ux', owned: ['big.txt'], context_ids: [], parts: {'big.txt': {index: last + 1, count: last + 2}}}];
  assert.throws(() => unitView(snapshot, extended.at(-1), options(extended)), error => error.code === 'segment_unknown');
});

test('the merge needs a report of every segment unit, each bound to its own view', () => {
  const snapshot = combined();
  const units = specsOf(snapshot);
  const views = viewsOf(snapshot, units);
  const reports = views.map(view => ({view, report: report(view)}));
  const missing = reports.filter(item => item.view.unit.parts?.['big.txt']?.index !== 1);
  assert.throws(() => mergeUnitReports(missing, snapshot), error => error.code === 'merge_invalid');
  assert.throws(() => mergeUnitReports([...reports, reports[0]], snapshot), error => error.code === 'merge_invalid');
  assert.equal(mergeUnitReports(reports, snapshot).report.gates.length, GATES.length);
});

test('a plan sized for the whole change builds a view for any file, whatever its segments', () => {
  // A one-line file and a patch-only change are one segment each; a change with no big file has no parts.
  const snapshot = combined();
  const small = {...snapshot, files: snapshot.files.filter(file => file.path !== 'big.txt'), paths: ['a.txt', 'z.txt']};
  delete small.digest;
  refresh(small, 3000000);
  const units = specsOf(small);
  assert.ok(units.every(unit => unit.parts === undefined));
  assert.equal(viewsOf(small, units)[0].files[0].segment, undefined);
});
