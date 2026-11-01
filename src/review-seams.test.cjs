'use strict';

// Cross-unit seams. Snapshots and plans below are local fixtures of the pinned shapes (snapshot files/sources,
// partition plan units); the real partition planner and the unit runner are separate modules.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {approvalHold} = require('./acceptance.cjs');
const {partition} = require('./review-partition.cjs');
const {DEFAULTS, KINDS, STATES, SeamRefusal, exportsOf, seamsOf, unitSummary, integrationInputs, dispositionSeams, holdMissingSeams} = require('./review-seams.cjs');

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const refusal = (code, run) => assert.throws(run, error => error instanceof SeamRefusal && error.code === code && error.message.startsWith(`${code}: `));

// files: [{path, status?, base?, head?, previous?, patch?, unit}], sources are built from their contents.
function change(files) {
  const sources = {};
  const entries = files.map((file, index) => {
    const entry = {path: file.path, status: file.status || 'modified', patch: file.patch ?? '@@ -1 +1 @@\n-old\n+new\n'};
    if (file.base !== undefined) {sources[`b${index}`] = {path: file.previous || file.path, ref: BASE, kind: 'source', authority: 'untrusted', content: file.base}; entry.base_source = `b${index}`;}
    if (file.head !== undefined) {sources[`h${index}`] = {path: file.path, ref: HEAD, kind: 'source', authority: 'untrusted', content: file.head}; entry.head_source = `h${index}`;}
    if (file.patch_body) entry.patch_body = file.patch_body;
    return entry;
  });
  const owner = {};
  for (const file of files) (owner[file.unit] ||= []).push(file.path);
  const plan = {scheme: 'clouseau-partition/1', units: Object.entries(owner).map(([id, owned]) => ({id, owned, context_ids: []}))};
  return {snapshot: {head_sha: HEAD, base_sha: BASE, paths: files.map(file => file.path).sort(), files: entries, sources}, plan};
}
const kinds = seams => seams.map(seam => `${seam.kind}:${seam.a.path}>${seam.b.path}`);

test('a changed export and its caller in another unit form one export_consumer seam, with both hunks', () => {
  const {snapshot, plan} = change([
    {path: 'lib/store.ts', unit: 'u0', base: 'export function read() {}\n', head: 'export function read(id: string) {}\n',
      patch: '@@ -1 +1 @@\n-export function read() {}\n+export function read(id: string) {}\n'},
    {path: 'app/page.ts', unit: 'u1', base: "import {read} from '../lib/store';\nread();\n", head: "import {read} from '../lib/store';\nread();\n"},
  ]);
  const seams = seamsOf({snapshot, plan});
  assert.deepEqual(kinds(seams), ['export_consumer:app/page.ts>lib/store.ts']);
  const [seam] = seams;
  assert.deepEqual(seam.exports, ['read']);
  assert.deepEqual(seam.a, {path: 'app/page.ts', unit: 'u1'});
  assert.deepEqual(seam.b, {path: 'lib/store.ts', unit: 'u0'});
  assert.deepEqual(seam.excerpts.map(item => [item.path, item.unit, item.truncated]), [['app/page.ts', 'u1', false], ['lib/store.ts', 'u0', false]]);
  assert.match(seam.excerpts[1].patch, /\+export function read\(id: string\)/);
  assert.match(seam.id, /^s[0-9a-f]{12}$/);
  assert.ok(KINDS.includes(seam.kind));
});

test('an import of a changed file whose changed exports are not used is a plain import seam; same-unit edges are not seams', () => {
  const {snapshot, plan} = change([
    {path: 'lib/store.ts', unit: 'u0', head: 'export const limit = 1;\n', patch: '@@ -1 +1 @@\n-export const limit = 2;\n+export const limit = 1;\n'},
    {path: 'lib/helper.ts', unit: 'u0', head: "import {limit} from './store';\n"},
    {path: 'app/page.ts', unit: 'u1', head: "import './store';\nimport x from '../lib/store.ts';\nconst other = 1;\n"},
    {path: 'app/note.md', unit: 'u1', head: "import '../lib/store';\n"},
    {path: 'app/self.ts', unit: 'u1', head: "import './self';\n"},
  ]);
  assert.deepEqual(kinds(seamsOf({snapshot, plan})), ['import:app/page.ts>lib/store.ts']);
});

test('a rename across files: a file in another unit still imports the old path (removed_import); the new path is an import', () => {
  const {snapshot, plan} = change([
    {path: 'lib/new-name.ts', unit: 'u0', status: 'renamed', previous: 'lib/old-name.ts', base: 'export const y = 1;\n', head: 'export const y = 1;\n'},
    {path: 'lib/gone.ts', unit: 'u0', status: 'removed', base: 'export const z = 1;\n', patch: '-export const z = 1;\n'},
    {path: 'app/stale.ts', unit: 'u1', head: "import {y} from '../lib/old-name';\nimport {z} from '../lib/gone';\n"},
    {path: 'app/fresh.ts', unit: 'u1', head: "import {y} from '../lib/new-name';\n"},
    {path: 'lib/inside.ts', unit: 'u0', head: "import {y} from './old-name';\n"},
  ]);
  const found = kinds(seamsOf({snapshot, plan}));
  assert.equal(found.length, 3);
  for (const expected of ['removed_import:app/stale.ts>lib/gone.ts', 'removed_import:app/stale.ts>lib/new-name.ts', 'import:app/fresh.ts>lib/new-name.ts']) {
    assert.ok(found.includes(expected), expected);
  }
});

test('a test deleted in one unit whose subject is changed in another is a test_subject seam (by stem)', () => {
  const {snapshot, plan} = change([
    {path: '__tests__/engine.spec.ts', unit: 'u0', status: 'removed', base: "test('engine', () => {});\n", patch: "-test('engine', () => {});\n"},
    {path: 'src/engine.ts', unit: 'u1', head: 'export const run = 1;\n', patch: '@@ -1 +1 @@\n-export const run = 0;\n+export const run = 1;\n'},
    {path: 'src/unrelated.ts', unit: 'u1', head: 'export const x = 1;\n'},
  ]);
  const seams = seamsOf({snapshot, plan});
  assert.deepEqual(kinds(seams), ['test_subject:__tests__/engine.spec.ts>src/engine.ts']);
  assert.deepEqual(seams[0].excerpts.map(item => item.path), ['__tests__/engine.spec.ts', 'src/engine.ts']);
});

test('a test that loses lines is linked to its subject by import, from head source; an added-only test is not a test seam', () => {
  const {snapshot, plan} = change([
    {path: 'tests/check.test.ts', unit: 'u0', head: "import {run} from '../src/engine';\n", patch: '@@ -1,2 +1 @@\n-expect(run()).toBe(1);\n import\n'},
    {path: 'tests/added.test.ts', unit: 'u0', status: 'added', head: "import {run} from '../src/engine';\n", patch: '+only added\n'},
    {path: 'tests/py_check.py', unit: 'u0', head: 'import engine\n', patch: '-assert 1\n'},
    {path: 'src/engine.ts', unit: 'u1', head: 'export const run = 1;\n', patch: '+x\n'},
    {path: 'src/py_check.py', unit: 'u1', head: 'x = 1\n', patch: '+x\n'},
  ]);
  assert.deepEqual(kinds(seamsOf({snapshot, plan})), ['import:tests/added.test.ts>src/engine.ts', 'import:tests/check.test.ts>src/engine.ts',
    'test_subject:tests/check.test.ts>src/engine.ts', 'test_subject:tests/py_check.py>src/py_check.py']);
});

test('a non-JavaScript test is linked to its subject by stem only', () => {
  const {snapshot, plan} = change([
    {path: 'tests/test_engine.py', unit: 'u0', base: 'assert 1\n', patch: '-assert 1\n', status: 'removed'},
    {path: 'tests/engine_test.py', unit: 'u0', base: 'assert 1\n', patch: '-assert 1\n', status: 'removed'},
    {path: 'pkg/engine.py', unit: 'u1', head: 'x = 1\n', patch: '+x\n'},
  ]);
  assert.deepEqual(kinds(seamsOf({snapshot, plan})), []);
  const stem = change([
    {path: 'tests/engine.spec.py', unit: 'u0', base: 'assert 1\n', patch: '-assert 1\n', status: 'removed'},
    {path: 'pkg/engine.py', unit: 'u1', head: 'x = 1\n', patch: '+x\n'},
  ]);
  assert.deepEqual(kinds(seamsOf(stem)), ['test_subject:tests/engine.spec.py>pkg/engine.py']);
});

test('seams are deterministic, deduplicated and ordered whatever the order of files', () => {
  const files = [
    {path: 'a/one.ts', unit: 'u0', head: "import './two';\nimport '../b/three';\nimport '../b/three.ts';\n"},
    {path: 'a/two.ts', unit: 'u0', head: 'export const t = 1;\n'},
    {path: 'b/three.ts', unit: 'u1', head: 'export const r = 1;\n'},
    {path: 'b/four.ts', unit: 'u1', head: "import '../a/one';\nimport '../a/two';\n"},
  ];
  const forward = change(files);
  const backward = change([...files].reverse());
  const seams = seamsOf(forward);
  assert.deepEqual(seams, seamsOf(backward));
  assert.deepEqual(kinds(seams), ['import:a/one.ts>b/three.ts', 'import:b/four.ts>a/one.ts', 'import:b/four.ts>a/two.ts']);
  assert.equal(new Set(seams.map(seam => seam.id)).size, 3);
});

test('seam computation works on a real partition plan and uses restored patches', () => {
  const files = [
    {path: 'a/one.ts', head: "import '../b/two';\n"},
    {path: 'b/two.ts', head: 'export const t = 1;\n', patch_body: 'head_source', patch: '@@ -0,0 +1 @@\n'},
  ];
  const {snapshot} = change(files.map(file => ({...file, unit: 'x'})));
  const plan = partition(files.map(file => ({path: file.path, base_size: 0, head_size: 600, patch_chars: 0})), {unit_ceiling: 1000, shared: 100, budget: 2000, file_ceiling: 5000});
  assert.equal(plan.units.length, 2);
  const [seam] = seamsOf({snapshot, plan});
  assert.equal(seam.kind, 'import');
  assert.match(seam.excerpts[1].patch, /\+export const t = 1;/);
});

test('an excerpt over the cap is cut and says so, and the cap is validated', () => {
  const {snapshot, plan} = change([
    {path: 'a/one.ts', unit: 'u0', head: "import '../b/two';\n", patch: 'x'.repeat(50)},
    {path: 'b/two.ts', unit: 'u1', head: 'export const t = 1;\n', patch: 'y'.repeat(10)},
  ]);
  const [seam] = seamsOf({snapshot, plan}, {excerptCap: 20});
  assert.deepEqual(seam.excerpts.map(item => [item.patch.length, item.truncated]), [[20, true], [10, false]]);
  for (const bad of [0, -1, 1.5, NaN, Infinity, '9']) refusal('limit_invalid', () => seamsOf({snapshot, plan}, {excerptCap: bad}));
  assert.equal(DEFAULTS.integrationCap, 250000);
});

test('a changed path with no owning unit is refused', () => {
  const {snapshot, plan} = change([{path: 'a.ts', unit: 'u0', head: ''}, {path: 'b.ts', unit: 'u1', head: ''}]);
  plan.units.pop();
  assert.throws(() => seamsOf({snapshot, plan}), error => error.code === 'unowned_path' && error.paths.join() === 'b.ts');
});

test('exportsOf reads declared, listed, assigned and object exports from added and removed lines only', () => {
  const patch = [
    '--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@',
    ' export const context = 1;',
    '+export async function load() {}',
    '-export default class Widget {}',
    '+export type {Shape as Form, Other};',
    '+export {alpha as beta, gamma}',
    '+exports.legacy = 1;',
    '+module.exports.named = 2;',
    '+module.exports = {first, second: 2, "bad key": 3}',
    '+export const $money = 1;',
    '+export {};',
    '+const notExported = 1;',
  ].join('\n');
  assert.deepEqual(exportsOf(patch), ['$money', 'Form', 'Other', 'Widget', 'beta', 'default', 'first', 'gamma', 'legacy', 'load', 'named', 'second']);
  assert.deepEqual(exportsOf('+export default function () {}\n'), ['default']);
});

test('a default export is consumed by any importer; a named export must appear as a whole word', () => {
  const {snapshot, plan} = change([
    {path: 'a/lib.ts', unit: 'u0', head: 'export default 1;\n', patch: '+export default 1;\n'},
    {path: 'a/lib2.ts', unit: 'u0', head: 'export const $x = 1;\n', patch: '+export const $x = 1;\n'},
    {path: 'b/uses.ts', unit: 'u1', head: "import lib from '../a/lib';\n"},
    {path: 'b/lookalike.ts', unit: 'u1', head: "import '../a/lib2';\nconst money$xx = 1; const a$x_ = 2;\n"},
    {path: 'b/exact.ts', unit: 'u1', head: "import {$x} from '../a/lib2';\n"},
  ]);
  assert.deepEqual(seamsOf({snapshot, plan}).map(seam => [seam.kind, seam.a.path, seam.exports]), [
    ['export_consumer', 'b/exact.ts', ['$x']], ['import', 'b/lookalike.ts', undefined], ['export_consumer', 'b/uses.ts', ['default']]]);
});

// Integration input

const summaryReport = (extra = {}) => ({summary: 'S'.repeat(5000), units: [{id: 'unit-1', title: 'Title', obligation: 'Obligation', kind: 'capability'}],
  findings: [{id: 'f1', title: 'Defect', path: 'a.ts', cause: 'because', trigger: 'private trigger', evidence: ['e1']}],
  gates: [{name: 'review_completeness', state: 'satisfied', reason: 'free text'}], accounting: [{path: 'a.ts', units: ['unit-1'], reason: 'free text'}], ...extra});

test('a unit summary forwards only bounded structured fields', () => {
  const summary = unitSummary('u0', summaryReport(), {textCap: 100});
  assert.equal(summary.summary.length, 100);
  assert.deepEqual(summary.units, [{id: 'unit-1', title: 'Title', obligation: 'Obligation'}]);
  assert.deepEqual(summary.findings, [{id: 'f1', title: 'Defect', path: 'a.ts', cause: 'because'}]);
  assert.deepEqual(summary.gates, [{name: 'review_completeness', state: 'satisfied'}]);
  assert.deepEqual(summary.accounting, [{path: 'a.ts', units: ['unit-1']}]);
  assert.equal(JSON.stringify(summary).includes('private trigger'), false);
  assert.equal(unitSummary('u0', summaryReport()).summary.length, 2000);
});

function manySeams(count, weight) {
  const files = [];
  for (let index = 0; index < count; index++) {
    files.push({path: `a/f${index}.ts`, unit: 'u0', head: `import '../b/g${index}';\n`, patch: 'p'.repeat(weight)});
    files.push({path: `b/g${index}.ts`, unit: 'u1', head: 'export const t = 1;\n', patch: 'q'.repeat(weight)});
  }
  return change(files);
}
const summariesOf = plan => plan.units.map(unit => unitSummary(unit.id, summaryReport()));

test('integration input: everything fits one shard when it can; the whole change is covered once, in order', () => {
  const {snapshot, plan} = manySeams(6, 400);
  const seams = seamsOf({snapshot, plan});
  assert.equal(seams.length, 6);
  const whole = integrationInputs({role: 'examiner', snapshot, plan, seams, summaries: summariesOf(plan)});
  assert.equal(whole.length, 1);
  assert.deepEqual([whole[0].shard, whole[0].of, whole[0].role], [0, 1, 'examiner']);
  assert.equal(whole[0].manifest.length, 12);
  assert.deepEqual(whole[0].manifest[0], {path: 'a/f0.ts', status: 'modified', unit: 'u0'});
  assert.deepEqual(whole[0].units.map(item => item.unit), ['u0', 'u1']);
  assert.match(whole[0].untrusted, /untrusted/);
});

test('integration input scales by adding shards, never by refusing or cutting', () => {
  const {snapshot, plan} = manySeams(6, 400);
  const seams = seamsOf({snapshot, plan});
  const summaries = summariesOf(plan);
  const size = JSON.stringify(integrationInputs({role: 'examiner', snapshot, plan, seams, summaries})[0]).length;
  const cap = Math.floor(size * 0.4);
  const shards = integrationInputs({role: 'challenger', snapshot, plan, seams, summaries}, {integrationCap: cap});
  assert.ok(shards.length > 2);
  assert.deepEqual(shards.flatMap(shard => shard.seams.map(seam => seam.id)), seams.map(seam => seam.id));
  assert.equal(shards.flatMap(shard => shard.manifest).length, 12);
  assert.deepEqual(shards.flatMap(shard => shard.units.map(item => item.unit)), ['u0', 'u1']);
  shards.forEach((shard, index) => {
    assert.deepEqual([shard.shard, shard.of], [index, shards.length]);
    assert.ok(JSON.stringify(shard).length <= cap || shard.seams.length + shard.units.length + shard.manifest.length === 1, `shard ${index}`);
  });
  // A cap smaller than any item still shards: one item per shard.
  const tiny = integrationInputs({role: 'examiner', snapshot, plan, seams, summaries}, {integrationCap: 10});
  assert.equal(tiny.length, 12 + 2 + 6);
});

test('integration input: no seams still yields one obliged pass', () => {
  const {snapshot, plan} = manySeams(2, 400);
  const none = integrationInputs({role: 'examiner', snapshot, plan, seams: [], summaries: summariesOf(plan)});
  assert.equal(none.length, 1);
  assert.deepEqual(none[0].seams, []);
  const empty = integrationInputs({role: 'examiner', snapshot: {files: []}, plan, seams: [], summaries: []});
  assert.equal(empty.length, 1);
});

// Dispositions

const twoSeams = () => {
  const {snapshot, plan} = manySeams(2, 10);
  return {snapshot, plan, seams: seamsOf({snapshot, plan})};
};

test('every seam gets exactly one disposition; an unanswered seam is missing', () => {
  const {seams} = twoSeams();
  const result = dispositionSeams({seams, answers: [{id: seams[0].id, state: 'checked', reason: 'Callers updated.'}]});
  assert.deepEqual(result.dispositions[0], {id: seams[0].id, state: 'checked', reason: 'Callers updated.'});
  assert.deepEqual(result.dispositions[1], {id: seams[1].id, state: 'missing', reason: 'No integration pass dispositioned this seam.'});
  assert.deepEqual(result.missing, [seams[1].id]);
  const none = dispositionSeams({seams, answers: []});
  assert.deepEqual(none.missing, seams.map(seam => seam.id));
  assert.deepEqual(dispositionSeams({seams: [], answers: []}), {dispositions: [], missing: []});
  assert.deepEqual(STATES, ['checked', 'finding', 'missing']);
});

test('a finding disposition must name a finding the pass raised; an explicit missing counts as missing', () => {
  const {seams} = twoSeams();
  const answers = [{id: seams[0].id, state: 'finding', reason: 'Caller breaks.', finding: 'p1:f1'}, {id: seams[1].id, state: 'missing', reason: 'Could not follow it.'}];
  const result = dispositionSeams({seams, answers, findingIds: ['p1:f1']});
  assert.deepEqual(result.dispositions[0].finding, 'p1:f1');
  assert.deepEqual(result.missing, [seams[1].id]);
  refusal('seam_finding_unknown', () => dispositionSeams({seams, answers}));
  refusal('seam_finding_unknown', () => dispositionSeams({seams, answers, findingIds: ['other']}));
});

test('malformed, unknown and duplicate answers are refused', () => {
  const {seams} = twoSeams();
  const good = {id: seams[0].id, state: 'checked', reason: 'ok'};
  for (const bad of [null, 'x', {...good, state: 'fine'}, {...good, reason: 5}, {...good, reason: '  '}, {...good, reason: 'r'.repeat(2001)},
    {...good, finding: 'f'}, {id: seams[0].id, state: 'finding', reason: 'ok'}]) {
    refusal('seam_answer_invalid', () => dispositionSeams({seams, answers: [bad], findingIds: ['f']}));
  }
  refusal('seam_unknown', () => dispositionSeams({seams, answers: [{...good, id: 'sffffffffffff'}]}));
  refusal('seam_duplicate', () => dispositionSeams({seams, answers: [good, {...good, reason: 'again'}]}));
  refusal('limit_invalid', () => dispositionSeams({seams, answers: [good]}, {textCap: 0}));
});

// Hold

function mergedReport(coverage = true) {
  return {gates: [{name: 'test_integrity', state: 'satisfied', reason: 'ok', evidence: ['e']}, {name: 'review_completeness', state: 'satisfied', reason: 'ok', evidence: ['e']}],
    ...(coverage ? {coverage: {sources: [], dependencies: [{path: 'b/g0.ts', state: 'inspected', reason: 'read', evidence: ['e']}, {path: 'x.ts', state: 'inspected', reason: 'read', evidence: ['e']}]}} : {})};
}

test('an undispositioned seam records a missing dependency and an unresolved completeness gate', () => {
  const {seams} = twoSeams();
  const report = mergedReport();
  const dispositions = dispositionSeams({seams, answers: [{id: seams[1].id, state: 'checked', reason: 'ok'}]});
  const held = holdMissingSeams({report, seams, dispositions});
  assert.notEqual(held, report);
  assert.equal(report.gates[1].state, 'satisfied');
  assert.equal(held.gates[1].state, 'unresolved');
  assert.match(held.gates[1].reason, /seams were not all checked/);
  const missing = held.coverage.dependencies.find(item => item.path === seams[0].b.path);
  assert.deepEqual([missing.state, missing.evidence], ['missing', []]);
  assert.match(missing.reason, new RegExp(seams[0].id));
  assert.equal(held.coverage.dependencies.length, 2);
  const fresh = holdMissingSeams({report: mergedReport(), seams, dispositions: dispositionSeams({seams, answers: []})});
  assert.equal(fresh.coverage.dependencies.length, 3);
});

test('holding makes the existing approval derivation hold; with every seam dispositioned the report is returned unchanged', () => {
  const {snapshot, seams} = twoSeams();
  const report = mergedReport();
  const clear = dispositionSeams({seams, answers: seams.map(seam => ({id: seam.id, state: 'checked', reason: 'ok'}))});
  assert.equal(holdMissingSeams({report, seams, dispositions: clear}), report);
  const held = holdMissingSeams({report, seams, dispositions: dispositionSeams({seams, answers: []})});
  assert.match(approvalHold(held, snapshot), /review completeness is unresolved/);
});

test('a missing seam on a report without a coverage register is refused rather than silently dropped', () => {
  const {seams} = twoSeams();
  const dispositions = dispositionSeams({seams, answers: []});
  refusal('seam_hold_unrepresentable', () => holdMissingSeams({report: mergedReport(false), seams, dispositions}));
  assert.doesNotThrow(() => holdMissingSeams({report: mergedReport(false), seams: [], dispositions: dispositionSeams({seams: [], answers: []})}));
  refusal('limit_invalid', () => holdMissingSeams({report: mergedReport(), seams, dispositions}, {textCap: -1}));
});
