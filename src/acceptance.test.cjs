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

const {approvalHold, validateApproval, isTestPath, resolveSpecifier, specifiersOf, moduleStem} = require('./acceptance.cjs');

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
  Object.assign(f.snapshot.sources.test, {path: 'tests/unit/feed.test.ts', content: 'import {a} from "../../src/feed-grid";\nimport {b} from "../../src/ui";\n'});
  f.snapshot.files = [{path: 'src/feed-grid.tsx', status: 'modified'}, {path: 'src/ui/index.ts', status: 'added'}];
  assert.equal(approvalHold(f.report, f.snapshot), null, 'an index module is named by its directory');
  f.snapshot.files = [{path: 'src/format.ts', status: 'modified'}, {path: 'src/gone.ts', status: 'removed'}, {path: 'README.md', status: 'modified'},
    {path: 'src/types.d.ts', status: 'modified'}, {path: 'pkg/server.go', status: 'modified'}, {path: 'vitest.config.ts', status: 'modified'}, {path: 'src/x.test.ts', status: 'modified'}];
  assert.equal(approvalHold(f.report, f.snapshot), 'no supplied test imports changed production code: src/format.ts');
});

test('coverage is transitive through supplied files only (changed callers and barrels)', () => {
  const f = fixture();
  const source = (path, content) => ({authority: 'untrusted', kind: 'source', ref: f.snapshot.head_sha, path, content});
  f.snapshot.sources = {...f.snapshot.sources,
    test: source('tests/unit/nav.test.tsx', "import { FeedItem } from '../../src/components/feed-item';\nimport type { Barrel } from '../../src';\n"),
    caller: source('src/components/feed-item.tsx', "import { resolve } from '../utils/helper.js';\nexport const FeedItem = 1;\n"),
    cycle: source('src/utils/helper.ts', "import '../components/feed-item';\nimport '../components/feed-item.tsx';\n"),
    barrel: source('src/index.ts', "export * from './widgets/clock';\nexport { x } from \"./components/button\";\n")};
  f.snapshot.test_imports = [{path: 'tests/unit/utils.test.ts', specifiers: ['../../src/utils/attention-color', 'vitest', '../../src/nowhere']}];
  f.snapshot.files = ['src/components/feed-item.tsx', 'src/utils/helper.ts', 'src/utils/attention-color.ts', 'src/widgets/clock.ts', 'src/components/button.tsx'].map(path => ({path, status: 'added'}));
  assert.equal(approvalHold(f.report, f.snapshot), null, 'caller, its helper, a name-unrelated test, and a barrel chain are all covered');
  f.snapshot.files.push({path: 'src/utils/orphan.ts', status: 'added'}, {path: 'src/utils/format.ts', status: 'modified'});
  assert.equal(approvalHold(f.report, f.snapshot), 'no supplied test imports changed production code: src/utils/orphan.ts, src/utils/format.ts');
  assert.deepEqual(resolveSpecifier('tests/a.test.ts', 'react', ['src/react.ts']), [], 'a bare package is never a project file');
  assert.deepEqual(specifiersOf("const m = await import('./a');\nfoo(require('./b'));\n// import './c';\nimport './d';"), ['./a', './d']);
});


test('unresolved integrity or completeness evidence holds approval, and a hold never masks a stricter outcome', () => {
  for (const name of ['test_integrity', 'review_completeness']) {
    const {report, snapshot} = withTest();
    snapshot.omitted_sources = [{path: 'tests/x.test.rs', reason: 'not found at the head revision'}];
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
    '.github/workflows/ci.yml', '.github/clouseau.md', '.github/CODEOWNERS', 'NOTICE.txt', 'LICENSE', 'config/app.yaml', 'CHANGELOG', 'assets/logo.svg', '.gitignore', 'vitest.config.ts', 'src/types.d.ts'].map(path => ({path, status: 'modified'}));
  assert.equal(approvalHold(f.report, f.snapshot), null);
  assert.equal(validateApproval(f.report, f.snapshot).decision, 'auto_approve');
  f.snapshot.files.push({path: 'src/app.ts', status: 'modified'});
  assert.match(approvalHold(f.report, f.snapshot), /src\/app\.ts$/);
  f.report.gates.find(gate => gate.name === 'test_integrity').state = 'unresolved';
  f.snapshot.files = [{path: 'README.md', status: 'modified'}];
  assert.equal(approvalHold(f.report, f.snapshot), null);
  for (const path of ['src/docs/render.ts', '.github/scripts/x.js', 'src/noticeService.ts', 'src/licenseCheck.ts', 'README.ts', 'pkg/server.go', 'src/Main.java', 'scripts/deploy.sh', 'db/query.sql', 'src/styles.css', 'Makefile']) {
    f.snapshot.files = [{path, status: 'modified'}];
    assert.equal(approvalHold(f.report, f.snapshot), 'test integrity is unresolved', path);
  }
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
  f.snapshot.files = [{path: 'tests/unit/format.test.ts', status: 'modified', patch: '@@ -1,2 +1 @@\n-  expect(a).toBe(1);\n+  // skipped'}];
  assert.equal(approvalHold(f.report, f.snapshot), 'test integrity is unresolved', 'weakening a test is held');
  f.snapshot.files[0].patch = '@@ -1 +1,2 @@\n+  expect(a).toBe(1);\n+  expect(b).toBe(2);';
  assert.equal(approvalHold(f.report, f.snapshot), null, 'an added assertion that may duplicate coverage is not held (issue 123)');
  f.snapshot.files[0].patch = '--- a/x\n+++ b/x';
  assert.equal(approvalHold(f.report, f.snapshot), null);
  f.snapshot.files = [{path: 'tests/fixtures/sample.json', status: 'added'}, {path: 'tests/fixtures/helper.ts', status: 'added'}];
  assert.equal(approvalHold(f.report, f.snapshot), null);
});

test('a root-level index module is named by itself, a nested one by its directory', () => {
  assert.equal(moduleStem('index.ts'), 'index');
  assert.equal(moduleStem('src/ui/index.ts'), 'ui');
  assert.equal(moduleStem('src/ui/button.tsx'), 'button');
});

test('only blank, comment-only, anchored type-only lines and identical normalized import sets are non-behavioural', () => {
  const {nonBehavioural} = require('./acceptance.cjs');
  const inert = patch => nonBehavioural(`@@\n${patch}`);
  // Inert: splitting, merging, re-ordering and re-wrapping the SAME value specifiers from the SAME module.
  assert.equal(inert('-import { A, type B } from "./x";\n+import type { B } from "./x";\n+import { A } from "./x";'), true);
  assert.equal(inert("-import {a, b} from './x';\n+import {\n+  b,\n+  a,\n+} from './x';"), true);
  assert.equal(inert("-import X, { a } from './x';\n+import { a } from './x';\n+import X from './x';"), true);
  assert.equal(inert("-import * as ns from './x';\n+import * as ns from './x'"), true);
  assert.equal(inert("-export { a } from './x';\n+export {\n+  a\n+} from './x';"), true);
  // Inert: type-only statements, anchored declarations, comments, blanks.
  assert.equal(inert("+import type { A } from './a';\n+import type B from './b';\n+import { type C, type D as E } from './c';\n+export type { F } from './f';\n+export type * from './g';"), true);
  assert.equal(inert('+export type Posted = Date | string;\n+type Local<T> = Array<T>;\n+declare type Q = typeof value;\n+interface Props { a: string; b?: number }\n+export interface Empty {}'), true);
  assert.equal(inert('+// note\n+/* one line */\n+/** doc\n+ * more words\n+ */\n+\n+;'), true);
  assert.equal(inert('--- a/x\n+++ b/x'), true);
  // Behavioural: a changed module path, a new or removed value import, a side-effect import.
  assert.equal(inert("-import {clamp} from './safe';\n+import {clamp} from './evil';"), false);
  assert.equal(inert("+import './side-effect';"), false);
  assert.equal(inert("+import { clamp } from './safe';"), false);
  assert.equal(inert("-import { clamp } from './safe';"), false);
  assert.equal(inert("-import {a} from './x';\n+import {a, b} from './x';"), false);
  assert.equal(inert("-import {a} from './x';\n+import {a as b} from './x';"), false);
  assert.equal(inert("-export * from './a';\n+export * from './b';"), false);
  assert.equal(inert("-} from './safe'\n+} from './evil'"), false);
  assert.equal(inert("-  A,\n+  B,"), false);
  // Behavioural: any trailing code after an otherwise inert statement or declaration.
  assert.equal(inert("+import x from 'y'; doEvil()"), false);
  assert.equal(inert("+import type { X } from 'y'; doEvil()"), false);
  assert.equal(inert("+import type { X } from 'y'\n+doEvil()"), false);
  assert.equal(inert('+type A = B; doEvil()'), false);
  assert.equal(inert('+type A = B\n+doEvil()'), false);
  assert.equal(inert('+type A = f();'), false);
  assert.equal(inert('+type A = { evil: 1 };'), false);
  assert.equal(inert('+/* c */ doEvil()'), false);
  assert.equal(inert('+// c\n+doEvil()'), false);
  assert.equal(inert("+interface P { a: string } doEvil()"), false);
  assert.equal(inert('+interface P {\n+  a: string;\n+}'), false);
  // Behavioural: code-shaped ` * ` lines, comment markers inside strings, comments split across hunks.
  assert.equal(inert('+  a\n+  * b'), false);
  assert.equal(inert('+ * more words'), false);
  assert.equal(inert('+x = "/*"; evil(); y = "*/"'), false);
  assert.equal(inert('+/* start\n@@\n+evil();\n+*/'), false);
  assert.equal(inert('+/* c\n+*/ evil()'), false);
  assert.equal(inert('-  author.trim().slice(0, 1)\n+  author.trim().slice(0, 2)'), false);
  assert.equal(inert('+export const behaviour = 1;'), false);
  assert.equal(nonBehavioural(undefined), false);
});

