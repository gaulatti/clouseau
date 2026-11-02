'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gate = require('./coverage-gate.cjs');
const changed = require('./coverage-changed.cjs');
const {validateConfig} = require('./config.cjs');
const valid = require('../examples/colombo.json');

const sh = (cwd, ...argv) => cp.execFileSync(argv[0], argv.slice(1), {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

// A git repository whose `main` holds `base` and whose HEAD holds `head` (file name -> text).
function repository(base, head, run) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-changed-')));
  try {
    sh(directory, 'git', 'init', '-q', '-b', 'main');
    sh(directory, 'git', 'config', 'user.email', 'a@example.test');
    sh(directory, 'git', 'config', 'user.name', 'A');
    const apply = files => {
      for (const [name, text] of Object.entries(files)) {
        if (text === null) fs.rmSync(path.join(directory, name));
        else {
          fs.mkdirSync(path.dirname(path.join(directory, name)), {recursive: true});
          fs.writeFileSync(path.join(directory, name), text);
        }
      }
      sh(directory, 'git', 'add', '-A');
      sh(directory, 'git', 'commit', '-q', '-m', 'x');
    };
    apply(base);
    apply(head);
    return run(directory);
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
}

test('the mode defaults to exact, is validated, and selects wording without altering the default text', () => {
  assert.equal(changed.modeOf(undefined), 'exact');
  assert.equal(changed.modeOf({}), 'exact');
  assert.equal(changed.modeOf({coverage: {mode: 'changed_lines'}}), 'changed_lines');
  assert.equal(changed.requirement({}).full, 'exact 100% line and branch coverage');
  assert.equal(changed.requirement({}).waiting, 'exact 100% coverage');
  assert.equal(changed.requirement({}).brief, 'exact coverage');
  assert.match(changed.requirement({coverage: {mode: 'changed_lines'}}).full, /changed lines and branches/);
  for (const mode of ['exact', 'changed_lines']) assert.deepEqual(validateConfig({...valid, coverage: {mode}}).coverage, {mode});
  assert.equal(validateConfig(valid).coverage, undefined);
  for (const coverage of [null, [], 'changed_lines', {}, {mode: 'all'}, {mode: 'exact', extra: 1}, {mode: 7}]) {
    assert.throws(() => validateConfig({...valid, coverage}), /coverage\.mode/);
  }
});

test('diffs yield added and modified lines only and reject what cannot be read exactly', () => {
  const text = ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -1,2 +3,2 @@', '-x', '-w', '+y', '+v', '@@ -9 +11 @@', '-a', '+z', '@@ -20,2 +20,0 @@', '-p', '-o',
    'diff --git a/gone.js b/gone.js', '--- a/gone.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-q', ''].join('\n');
  assert.deepEqual([...changed.parseDiff(text)], [['a.js', new Set([3, 4, 11])]]);
  assert.deepEqual([...changed.parseDiff('')], []);
  // A path with a space carries a trailing tab; an added line that looks like a header stays content.
  const spaced = ['--- a/my file.ts\t', '+++ b/my file.ts\t', '@@ -1,2 +1,3 @@', '-old', '-x', '++ b/sneaky.ts', '+++ b/other.ts', '\\ No newline at end of file',
    '+more', '@@ -9,0 +12,1 @@', '+last', ''].join('\n');
  assert.deepEqual([...changed.parseDiff(spaced)], [['my file.ts', new Set([1, 2, 3, 12])]]);
  assert.throws(() => changed.parseDiff('+++ "b/odd\\tname.js"\n@@ -1 +1 @@\n'), /quoted path/);
  assert.throws(() => changed.parseDiff('+++ b/a.js\n@@ nonsense @@\n'), /Malformed diff hunk/);
});

test('changed lines come from the real diff against the base revision and bad references fail', () => repository(
  {'a.js': 'one\ntwo\nthree\n', 'drop.js': 'x\n', 'my file.js': 'a\n'}, {'a.js': 'one\nTWO\nthree\nfour\n', 'drop.js': null, 'b/n.js': 'n\n', 'my file.js': 'b\n'}, directory => {
    sh(directory, 'git', 'branch', 'base', 'HEAD~1');
    const result = changed.changedLines(directory, 'base');
    assert.deepEqual([...result].sort(), [[path.join(directory, 'a.js'), new Set([2, 4])],
      [path.join(directory, 'b/n.js'), new Set([1])], [path.join(directory, 'my file.js'), new Set([1])]]);
    assert.equal(changed.changedLines(directory, sh(directory, 'git', 'rev-parse', 'HEAD~1').trim()).size, 3);
    for (const ref of ['', undefined, '-p', 'a..b', 'bad ref', 'x;y', 'x'.repeat(300)]) {
      assert.throws(() => changed.changedLines(directory, ref), /plain base revision/);
    }
    assert.throws(() => changed.changedLines(directory, 'no-such-ref'), /could not diff against no-such-ref/);
    assert.throws(() => changed.changedLines(directory, 'base', () => {throw new Error('boom');}), /boom/);
  }));

test('baseline totals are validated and compared exactly', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-baseline-'));
  try {
    const file = path.join(temp, 'base.json');
    const read = value => {fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return changed.readBaseline(file);};
    assert.deepEqual(read({lines: [10, 6], branches: [0, 0]}), {lines: [10, 6], branches: [0, 0]});
    assert.throws(() => changed.readBaseline(path.join(temp, 'missing.json')), /readable JSON baseline/);
    for (const value of ['{', '[]', {lines: [1, 1]}, {lines: [1, 1], branches: [1, 1], extra: 1}, {lines: 'x', branches: [1, 1]},
      {lines: [1, 1, 1], branches: [1, 1]}, {lines: [1.5, 1], branches: [1, 1]}, {lines: [-1, 0], branches: [1, 1]},
      {lines: [2, 3], branches: [1, 1]}, {lines: [2, -1], branches: [1, 1]}]) {
      assert.throws(() => read(value), /baseline/);
    }
  } finally {fs.rmSync(temp, {recursive: true, force: true});}
});

const detail = (lines, branches = []) => new Map([['/w/a.js', {lines: new Map(lines), branches}]]);
const baseline = {lines: [10, 5], branches: [4, 2]};
const enforce = (options) => changed.enforceChanged({directory: '/w', baseline, totals: {lines: [10, 5], branches: [4, 2]},
  changed: new Map([['/w/a.js', new Set([2, 3])], ['/w/other.js', new Set([1])]]), ...options});

test('every changed line and branch must be covered and totals must not regress', () => {
  const lines = [[1, false], [2, true], [3, true]];
  const branches = [{from: 2, to: 2, covered: true}, {from: 9, to: 9, covered: false}, {from: 1, to: 3, covered: true}];
  assert.deepEqual(enforce({detail: detail(lines, branches)}), {lines: [2, 2], branches: [2, 2]});
  assert.deepEqual(enforce({detail: detail([[1, false]]), changed: new Map([['/w/a.js', new Set([7])]])}), {lines: [0, 0], branches: [0, 0]});
  assert.throws(() => enforce({detail: detail([[2, false], [3, true]], branches)}), /lines: 1 changed uncovered; uncovered: a\.js:2 line$/);
  assert.throws(() => enforce({detail: detail(lines, [{from: 3, to: 5, covered: false}])}), /branches: 1 changed uncovered; uncovered: a\.js:3 branch$/);
  assert.throws(() => enforce({detail: detail(lines), totals: {lines: [10, 4], branches: [4, 2]}}), /lines: repository-wide coverage fell below the base revision \(base 5\/10, now 4\/10\)/);
  assert.throws(() => enforce({detail: detail(lines), totals: {lines: [10, 5], branches: [8, 3]}}), /branches: repository-wide coverage fell below the base revision \(base 2\/4, now 3\/8\)/);
  assert.deepEqual(enforce({detail: detail(lines), totals: {lines: [20, 11], branches: [4, 3]}}), {lines: [2, 2], branches: [0, 0]});
  const many = Array.from({length: 25}, (_, index) => [index + 1, false]);
  assert.throws(() => enforce({detail: detail(many), changed: new Map([['/w/a.js', new Set(many.map(([line]) => line))]])}), /a\.js:20 line, \.\.\.$/);
});

// ---- adapters expose per-line detail and the gate applies it ----

const istanbulReport = (source, hits) => ({[source]: {path: source,
  statementMap: {0: {start: {line: 1, column: 0}, end: {line: 1, column: 9}}, 1: {start: {line: 2, column: 0}, end: {line: 2, column: 9}}},
  s: {0: 1, 1: hits}, branchMap: {0: {loc: {start: {line: 2}}, locations: [{start: {line: 2}}, {start: {line: 2}}]}}, b: {0: [1, hits]}}});

function ts(run) {
  return repository({'src/a.ts': 'const a = 1;\nconst b = a ? 1 : 2;\n', 'README.md': 'x\n'}, {'src/a.ts': 'const a = 1;\nconst b = a ? 3 : 2;\n'}, directory => {
    sh(directory, 'git', 'branch', 'base', 'HEAD~1');
    const baselineFile = path.join(directory, 'base.json');
    fs.writeFileSync(baselineFile, JSON.stringify({lines: [2, 2], branches: [2, 2]}));
    return run({directory, baselineFile, source: path.join(directory, 'src/a.ts'), report: path.join(directory, 'cov.json')});
  });
}

test('Istanbul changed-line gating passes on a covered change and fails on an uncovered changed branch or regression', () => ts(({directory, baselineFile, source, report}) => {
  const check = hits => {
    fs.writeFileSync(report, JSON.stringify(istanbulReport(source, hits)));
    return gate.changedCheck(JSON.parse(fs.readFileSync(report, 'utf8')), path.join(directory, 'src'), 'istanbul', directory, 'base', baselineFile);
  };
  assert.deepEqual(check(1), {lines: [1, 1], branches: [2, 2]});
  assert.throws(() => check(0), /lines: 1 changed uncovered.*branches: 1 changed uncovered/);
  // The same gap on an unchanged line is tolerated only if the repository-wide total did not fall.
  fs.writeFileSync(baselineFile, JSON.stringify({lines: [2, 1], branches: [2, 1]}));
  assert.deepEqual(gate.changedCheck(istanbulReport(source, 1), path.join(directory, 'src'), 'istanbul', directory, 'base', baselineFile), {lines: [1, 1], branches: [2, 2]});
  const llvm = {type: 'llvm.coverage.json.export', data: [{files: [{filename: source, summary: {lines: {count: 1, covered: 1}, branches: {count: 1, covered: 1}}}]}]};
  assert.throws(() => gate.changedCheck(llvm, path.join(directory, 'src'), 'llvm', directory, 'base', baselineFile), /does not provide them/);
}));

test('Istanbul branch lines come from the decision location, the legacy line or the first outcome and must exist', () => ts(({directory, source}) => {
  const run = branchMap => {
    const report = istanbulReport(source, 1);
    report[source].branchMap = {0: branchMap};
    const map = new Map();
    gate.counters(report, path.join(directory, 'src'), 'istanbul', directory, map);
    return map.get(source).branches.map(branch => branch.from);
  };
  const outcomes = [{start: {line: 4}}, {start: {line: 4}}];
  assert.deepEqual(run({loc: {start: {line: 2}}, line: 3, locations: outcomes}), [2, 2]);
  assert.deepEqual(run({line: 3, locations: outcomes}), [3, 3]);
  assert.deepEqual(run({locations: outcomes}), [4, 4]);
  assert.throws(() => run({locations: [{}, {}]}), /Invalid Istanbul branch line/);
  assert.throws(() => run({line: 0, locations: [{}, {}]}), /Invalid Istanbul branch line/);
  // Exact gating never reads the extra fields.
  const report = istanbulReport(source, 1);
  report[source].branchMap = {0: {locations: [{}, {}]}};
  assert.deepEqual(gate.counters(report, path.join(directory, 'src'), 'istanbul', directory), {lines: [2, 2], branches: [2, 2]});
}));

const LCOV = (file, brLine) => `TN:\nSF:${file}\nDA:1,1\nDA:2,1\nLF:2\nLH:2\nBRDA:${brLine},0,0,1\nBRDA:${brLine},0,1,-\nBRF:2\nBRH:1\nend_of_record\n`;

test('LCOV changed-line gating reads DA and BRDA lines and ignores nothing it was not asked to', () => ts(({directory, baselineFile, source}) => {
  fs.writeFileSync(baselineFile, JSON.stringify({lines: [2, 2], branches: [2, 1]}));
  const check = text => gate.changedCheck(text, path.join(directory, 'src'), 'lcov', directory, 'base', baselineFile);
  assert.throws(() => check(LCOV(source, 2)), /branches: 1 changed uncovered; uncovered: src\/a\.ts:2 branch$/);
  assert.deepEqual(check(LCOV(source, 1)), {lines: [1, 1], branches: [0, 0]});
  assert.throws(() => check(LCOV(source, 'x')), /LCOV numbers/);
  // Exact gating still ignores the branch line field.
  assert.deepEqual(gate.counters(LCOV(source, 'x'), path.join(directory, 'src'), 'lcov', directory), {lines: [2, 2], branches: [2, 1]});
}));

test('Go changed-line gating maps each block to the lines it spans', () => repository({'go.mod': 'module example.test/m\n\ngo 1.21\n', 'm.go': 'package m\n\nfunc F() {\n\t_ = 1\n}\n'},
  {'m.go': 'package m\n\nfunc F() {\n\t_ = 2\n}\n'}, directory => {
    sh(directory, 'git', 'branch', 'base', 'HEAD~1');
    const baselineFile = path.join(directory, 'base.json');
    fs.writeFileSync(baselineFile, JSON.stringify({lines: [1, 1], branches: [1, 1]}));
    const profile = hit => `mode: set\nexample.test/m/m.go:3.10,5.2 1 ${hit}\n`;
    assert.deepEqual(gate.changedCheck(profile(1), directory, 'go', directory, 'base', baselineFile), {lines: [1, 1], branches: [1, 1]});
    assert.throws(() => gate.changedCheck(profile(0), directory, 'go', directory, 'base', baselineFile), /lines: 1 changed uncovered/);
    const map = new Map();
    gate.counters(`mode: set\nexample.test/m/m.go:3.10,4.5 1 1\nexample.test/m/m.go:4.5,5.2 1 0\n`, directory, 'go', directory, map);
    assert.deepEqual([...map.get(path.join(directory, 'm.go')).lines], [[3, true], [4, false], [5, false]]);
  }));

test('coverage.py changed-line gating uses executed and missing lines and decision exits', () => repository(
  {'src/__init__.py': '', 'src/service.py': 'def choose(ok):\n    if ok:\n        return 1\n    return 0\n'}, {'src/service.py': 'def choose(ok):\n    if ok:\n        return 2\n    return 0\n'}, directory => {
    sh(directory, 'git', 'branch', 'base', 'HEAD~1');
    const baselineFile = path.join(directory, 'base.json');
    fs.writeFileSync(baselineFile, JSON.stringify({lines: [4, 4], branches: [2, 2]}));
    const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'coveragepy');
    const load = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
    const full = gate.changedCheck(load('full'), path.join(directory, 'src'), 'coveragepy', directory, 'base', baselineFile);
    assert.deepEqual(full, {lines: [1, 1], branches: [0, 0]});
    assert.throws(() => gate.changedCheck(load('partial'), path.join(directory, 'src'), 'coveragepy', directory, 'base', baselineFile), /changed uncovered|repository-wide/);
  }));

test('changed plans measure every part and the command line exposes mode, totals and gates', () => repository(
  {'src/a.js': 'const a = 1;\nconst b = a ? 1 : 2;\n', '.github/clouseau.json': JSON.stringify({...valid, coverage: {mode: 'changed_lines'}}),
    '.github/exact.json': JSON.stringify(valid)},
  {'src/a.js': 'const a = 1;\nconst b = a ? 3 : 2;\n'}, directory => {
    sh(directory, 'git', 'branch', 'base', 'HEAD~1');
    const source = path.join(directory, 'src/a.js');
    const run = (...argv) => {
      let out = ''; let err = '';
      const status = gate.main(argv, {cwd: directory, stdout: text => {out += text;}, stderr: text => {err += text;}});
      return {status, out, err};
    };
    const write = (name, value) => fs.writeFileSync(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
    write('cov.json', istanbulReport(source, 1));
    write('recipe.json', {version: 2, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md', verification: [['true']],
      coverage: [{format: 'istanbul', report: 'cov.json', source_directory: 'src'}]});
    write('base.json', {lines: [2, 2], branches: [2, 2]});
    assert.equal(run('mode', '.github/clouseau.json').out, 'changed_lines\n');
    assert.equal(run('mode', '.github/exact.json').out, 'exact\n');
    assert.equal(run('totals', 'cov.json', 'src', 'istanbul').out, '{"lines":[2,2],"branches":[2,2]}\n');
    assert.equal(run('totals-plan', 'recipe.json').out, '{"lines":[2,2],"branches":[2,2]}\n');
    assert.equal(run('totals-plan', 'recipe.json', '.').status, 0);
    const passed = run('changed-check', 'cov.json', 'src', 'istanbul', 'base', 'base.json');
    assert.equal(passed.status, 0, passed.err);
    assert.equal(passed.out, 'changed lines: 1/1\nchanged branches: 2/2\n');
    assert.equal(run('changed-plan', 'recipe.json', '.', 'base', 'base.json').out, 'changed lines: 1/1\nchanged branches: 2/2\n');
    write('cov.json', istanbulReport(source, 0));
    const rejected = run('changed-check', 'cov.json', 'src', 'istanbul', 'base', 'base.json');
    assert.equal(rejected.status, 1);
    assert.match(rejected.err, /Coverage gate failed: lines: 1 changed uncovered/);
    assert.equal(run('changed-plan', 'recipe.json', '.', 'base', 'base.json').status, 1);
    assert.match(run('changed-check', 'cov.json').err, /Usage/);
    assert.equal(run('mode', 'missing.json').status, 1);
  }));
