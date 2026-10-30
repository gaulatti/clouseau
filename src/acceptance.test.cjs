'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {digest, findingScore, validateReport, RULES} = require('./acceptance.cjs');
const {factor, fixture, finding} = require('../test/fixtures/acceptance.cjs');

test('a change with no findings and satisfied gates is approved on its own evidence', () => {
  const {report, snapshot} = fixture();
  const result = validateReport(report, snapshot);
  assert.equal(result.decision, 'auto_approve');
  assert.deepEqual(result.findings, []);
  assert.equal(digest({a: 1}), digest({a: 1}));
  assert.notEqual(digest({a: 1}), digest({a: 2}));
  report.units[0].kind = 'mechanism';
  report.gates[2].state = 'inapplicable';
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve');
});

test('only a violated gate stops approval; an unresolved gate is advisory', () => {
  const {report, snapshot} = fixture();
  report.gates[0].state = 'violated';
  assert.equal(validateReport(report, snapshot).decision, 'repair_required');
  report.gates[0].state = 'unresolved';
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve');
  report.gates.find(gate => gate.name === 'test_integrity').state = 'violated';
  assert.equal(validateReport(report, snapshot).decision, 'blocked_integrity');
});

test('the nine-factor defect score preserves necessity and all five consequence amplifiers', () => {
  const item = finding();
  item.factors.necessity = factor(0.5); item.factors.severity = factor(0.5);
  item.factors.reach = factor(0.5); item.factors.propagation = factor(0.5);
  assert.equal(findingScore(item), 90);
  item.factors.activation = factor(0);
  assert.equal(findingScore(item), 50, 'inactive consequences cannot cancel an established obligation');
  item.factors.necessity = factor(0.7);
  assert.equal(findingScore(item), RULES.defect_threshold);
  item.factors.confidence = factor(0.5);
  assert.equal(findingScore(item), 35);
});

test('a finding blocks only when its single score reaches the threshold', () => {
  const {report, snapshot} = fixture();
  const item = finding(); report.findings.push(item);
  assert.equal(validateReport(report, snapshot).decision, 'repair_required');
  item.factors.confidence = factor(0.5);
  const result = validateReport(report, snapshot);
  assert.equal(result.decision, 'auto_approve');
  assert.equal(result.findings[0].score, 50);
  item.factors.confidence = factor(1); item.factors.activation = factor(0); item.factors.necessity = factor(0.5);
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve');
  assert.equal(validateReport(report, snapshot).findings[0].disposition, 'nonblocking');
});

test('blast radius damps optional opportunity only and xG never creates a merge veto', () => {
  const {report, snapshot} = fixture();
  const item = finding(); report.findings.push(item);
  item.factors.necessity = factor(0.6); item.factors.activation = factor(0);
  for (const key of Object.keys(item.opportunity)) item.opportunity[key] = true;
  let result = validateReport(report, snapshot);
  assert.equal(result.findings[0].priority, 80);
  assert.equal(result.decision, 'auto_approve');
  item.blast_radius = 2;
  result = validateReport(report, snapshot);
  assert.equal(result.findings[0].priority, 65);
  item.factors.necessity = factor(1);
  assert.equal(validateReport(report, snapshot).decision, 'repair_required');
  assert.equal(validateReport(report, snapshot).findings[0].priority, 100);
});

test('prior findings close only with valid current-revision counterevidence', () => {
  const {report, snapshot} = fixture();
  snapshot.prior_findings = [{id: 'prior-cause'}];
  report.resolutions = [{id: 'prior-cause', state: 'corrected', reason: 'Current source rejects the invalid request.', evidence: ['source']}];
  assert.equal(validateReport(report, snapshot).decision, 'auto_approve');
  for (const mutate of [
    r => {r.resolutions = null;}, r => {r.resolutions[0].id = 'unknown';},
    r => {r.resolutions[0].state = 'waived';}, r => {r.resolutions[0].evidence = ['contract'];},
    r => {r.resolutions.push(r.resolutions[0]);}, r => {r.accounting[0].evidence = ['contract'];},
  ]) {
    const bad = structuredClone(report); mutate(bad);
    assert.throws(() => validateReport(bad, snapshot), /Invalid acceptance/);
  }
  snapshot.sources.head.path = 'src/previous-name.rs';
  report.findings = [finding()];
  assert.equal(validateReport(report, snapshot).decision, 'repair_required', 'rename aliases preserve changed-path evidence');
});

test('all boundaries are strict and no evidence, accounting, or empty-plan escape exists', () => {
  const invalid = [
    r => {r.extra = true;}, r => {r.version = 1;}, r => {r.snapshot = 'stale';}, r => {r.summary = '';},
    r => {r.evidence = [];}, r => {r.evidence = null;}, r => {r.evidence.push(r.evidence[0]);},
    r => {r.evidence[0].source = 'invented';}, r => {r.evidence[0].start = 0;},
    r => {r.evidence[0].start = 0.5;}, r => {r.evidence[0].end = 50;}, r => {r.evidence[0].end = 3;},
    r => {r.evidence[0].quote = 'not in source';}, r => {r.evidence[0].quote = ' ';},
    r => {r.units = [];}, r => {r.units.push(r.units[0]);}, r => {r.units[0].kind = 'anything';},
    r => {r.units[0].paths = [];}, r => {r.units[0].paths = ['outside.rs'];},
    r => {r.findings = [finding()]; r.findings[0].factors.severity.value = -1;}, r => {r.findings = [finding()]; r.findings[0].factors.severity.value = 2;},
    r => {r.findings = [finding()]; r.findings[0].factors.severity.value = 1.1;}, r => {r.findings = [finding()]; r.findings[0].factors.severity.value = NaN;},
    r => {r.findings = [finding()]; r.findings[0].factors.severity.evidence = [];}, r => {r.findings = [finding()]; r.findings[0].factors.severity.evidence = ['unknown'];},
    r => {r.findings = [finding()]; r.findings[0].factors.severity.evidence = ['source', 'source'];}, r => {r.findings = [finding()]; r.findings[0].factors.severity.reason = '';},
    r => {r.findings = null;},
    r => {r.findings = [finding(), finding()];}, r => {r.findings = [{...finding(), path: 'outside.rs'}];},
    r => {r.findings = [{...finding(), trigger: ''}];}, r => {r.findings = [{...finding(), blast_radius: 0}];},
    r => {r.findings = [{...finding(), evidence: ['contract']}];},
    r => {r.findings = [{...finding(), blast_radius: Infinity}];},
    r => {r.findings = [{...finding(), opportunity: {mechanical: 1, beneficial: true, within_scope: true, verified: true}}];},
    r => {r.findings = [{...finding(), repair_paths: []}];}, r => {r.findings = [{...finding(), repair_paths: ['elsewhere.rs']}];},
    r => {r.gates = [];}, r => {r.gates[0] = r.gates[1];}, r => {r.gates[0].name = 'unknown';},
    r => {r.gates[0].state = 'pass';}, r => {r.accounting = [];},
    r => {r.gates[0].state = 'inapplicable';},
    r => {r.accounting[0].path = 'elsewhere.rs';}, r => {r.accounting[0].units = [];},
    r => {r.accounting[0].units = ['invented'];}, r => {r.decisions = [];},
  ];
  for (const mutate of invalid) {
    const {report, snapshot} = fixture(); mutate(report);
    assert.throws(() => validateReport(report, snapshot), /Invalid acceptance evidence/, mutate.toString());
  }
  const {report, snapshot} = fixture();
  for (const value of [null, [], 'text', {}]) assert.throws(() => validateReport(value, snapshot));
  report.evidence[1] = {id: 'source', source: 'head', start: 3, end: 3, quote: ' '};
  assert.throws(() => validateReport(report, snapshot), /citation does not match/);
});

const {approvalHold, validateApproval, isTestPath} = require('./acceptance.cjs');

function withTest(content = 'use upload;\n') {
  const f = fixture();
  f.snapshot.sources.test = {authority: 'untrusted', kind: 'source', ref: f.snapshot.head_sha, path: 'src/upload.test.rs', content};
  return f;
}

test('CI approval needs a supplied test that imports each changed production file', () => {
  const {report, snapshot} = withTest();
  assert.equal(approvalHold(report, snapshot), null);
  assert.equal(validateApproval(report, snapshot).decision, 'auto_approve');
  const bare = fixture();
  const held = validateApproval(bare.report, bare.snapshot);
  assert.equal(held.decision, 'review_incomplete');
  assert.match(held.hold, /no supplied test imports changed production code: src\/upload\.rs/);
  for (const content of ['// upload is mentioned in a comment\n', 'describe("upload", () => {});\n', 'use uploader;\n', 'use upload_gateway;\n', 'test("loads from upload", () => {});\n', 'describe("import upload", () => {});\n']) {
    const other = withTest(content);
    assert.match(approvalHold(other.report, other.snapshot), /no supplied test imports/, content);
  }
  for (const line of ["import {accept} from './upload.js';", "const x = require('../upload');", 'from pkg.upload import accept', 'use crate::upload;']) {
    const other = withTest(line + '\n');
    assert.equal(approvalHold(other.report, other.snapshot), null, line);
  }
});

test('a test for one changed file never covers a different changed file', () => {
  assert.equal(isTestPath('internal/upload_test.go'), true);
  const f = withTest('import {a} from "./feed-grid";\n');
  f.snapshot.files.push({path: 'src/format.ts', status: 'modified', head_source: 'head'});
  assert.match(approvalHold(f.report, f.snapshot), /src\/upload\.rs, src\/format\.ts|src\/upload\.rs/);
  f.snapshot.files = [{path: 'src/feed-grid.tsx', status: 'modified'}, {path: 'src/ui/index.ts', status: 'added'}];
  f.snapshot.sources.test.content = 'import {a} from "./feed-grid";\nimport {b} from "./ui";\n';
  assert.equal(approvalHold(f.report, f.snapshot), null, 'an index module is named by its directory');
  f.snapshot.files = [{path: 'src/format.ts', status: 'modified'}, {path: 'src/gone.ts', status: 'removed'}, {path: 'README.md', status: 'modified'},
    {path: 'src/types.d.ts', status: 'modified'}, {path: 'pkg/server.go', status: 'modified'}, {path: 'vitest.config.ts', status: 'modified'}, {path: 'src/x.test.ts', status: 'modified'}];
  assert.equal(approvalHold(f.report, f.snapshot), 'no supplied test imports changed production code: src/format.ts');
});

test('unresolved integrity or completeness evidence holds approval, and a hold never masks a stricter outcome', () => {
  for (const name of ['test_integrity', 'review_completeness']) {
    const {report, snapshot} = withTest();
    report.gates.find(gate => gate.name === name).state = 'unresolved';
    const held = validateApproval(report, snapshot);
    assert.equal(held.decision, 'review_incomplete');
    assert.equal(held.hold, `${name.replace('_', ' ')} is unresolved`);
  }
  const {report, snapshot} = fixture();
  report.gates.find(gate => gate.name === 'scope_authority').state = 'violated';
  assert.equal(validateApproval(report, snapshot).decision, 'repair_required');
  const local = fixture();
  local.report.gates.find(gate => gate.name === 'test_integrity').state = 'unresolved';
  assert.equal(validateReport(local.report, local.snapshot).decision, 'auto_approve', 'the pre-PR local stage keeps unresolved evidence advisory');
  assert.equal(validateApproval(local.report, local.snapshot).decision, 'review_incomplete', 'hosted approval does not');
  assert.ok(isTestPath('tests/unit/format.test.ts') && isTestPath('src/a/feed-grid.stories.tsx') && isTestPath('pkg/test_x.py') && isTestPath('x_test.go'));
  assert.ok(!isTestPath('src/utils/format.ts'));
});

test('documentation, fixtures, configuration, lockfiles and workflows are never held for a missing test', () => {
  const f = fixture();
  f.snapshot.files = ['README.md', 'docs/guide.md', 'test/fixtures/sample.json', 'package-lock.json', 'tsconfig.json',
    '.github/workflows/ci.yml', '.github/clouseau.md', 'config/app.yaml', 'Makefile', 'src/styles.css', 'src/schema.sql'].map(path => ({path, status: 'modified'}));
  assert.equal(approvalHold(f.report, f.snapshot), null);
  assert.equal(validateApproval(f.report, f.snapshot).decision, 'auto_approve');
  f.snapshot.files.push({path: 'src/app.ts', status: 'modified'});
  assert.match(approvalHold(f.report, f.snapshot), /src\/app\.ts$/);
});

test('only an import statement links a module: comments and quoted titles do not', () => {
  const stem = (content, files = [{path: 'src/utils/format.ts', status: 'modified'}]) => {
    const f = withTest(content); f.snapshot.sources.test.path = 'tests/unit/format.test.ts'; f.snapshot.files = files; return approvalHold(f.report, f.snapshot);
  };
  assert.equal(stem("import {\n  a,\n} from '../../src/utils/format';\n"), null);
  assert.equal(stem("import '../../src/utils/format';\n"), null);
  assert.equal(stem("export * from '../../src/utils/format';\n"), null);
  assert.equal(stem("const { a } = require('../../src/utils/format');\n"), null);
  assert.equal(stem("const m = await import('../../src/utils/format.js');\n"), null);
  assert.equal(stem("require('../../src/utils/format');\n"), null);
  for (const content of ["// import {a} from '../../src/utils/format';\n", "/* import {a} from '../../src/utils/format';\n*/\n",
    "test('import {a} from \"../../src/utils/format\"', () => {});\n", "const s = 'x';\nfoo(require('../../src/utils/format'));\n"]) {
    assert.match(stem(content), /no supplied test imports/, content);
  }
});

test('a test-only change is executable: unresolved test integrity still holds it, a fixture-only change does not', () => {
  const f = fixture();
  f.report.gates.find(gate => gate.name === 'test_integrity').state = 'unresolved';
  f.snapshot.files = [{path: 'tests/unit/format.test.ts', status: 'modified'}];
  assert.equal(approvalHold(f.report, f.snapshot), 'test integrity is unresolved');
  f.snapshot.files = [{path: 'tests/fixtures/sample.json', status: 'added'}, {path: 'tests/fixtures/helper.ts', status: 'added'}];
  assert.equal(approvalHold(f.report, f.snapshot), null);
});
