'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {evaluate, gate, paint, toLcov, toReport} = require('./v8-coverage.cjs');

const MODULE = `'use strict';
function pick(n) {
  if (n > 1) {
    return n === 2 ? 'two' : 'many';
  }
  return 'one';
}
module.exports = {pick};
`;

function project(files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-v8-')));
  fs.mkdirSync(path.join(root, 'src'));
  for (const [name, text] of Object.entries({'m.cjs': MODULE, ...files})) {
    fs.mkdirSync(path.dirname(path.join(root, 'src', name)), {recursive: true});
    fs.writeFileSync(path.join(root, 'src', name), text);
  }
  return root;
}

// One real Node process per call list, each writing its own raw V8 report.
let launched = 0;
function processes(root, callLists) {
  return callLists.map(calls => {
    const directory = path.join(root, `raw-${launched++}`);
    const run = spawnSync(process.execPath, ['-e', `const {pick} = require(${JSON.stringify(path.join(root, 'src/m.cjs'))}); for (const n of ${JSON.stringify(calls)}) pick(n);`],
      {env: {...process.env, NODE_V8_COVERAGE: directory}});
    assert.equal(run.status, 0, String(run.stderr));
    return path.join(directory, fs.readdirSync(directory).find(name => name.startsWith('coverage-')));
  });
}

function combine(root, reports, label) {
  const directory = path.join(root, `merged-${label}`);
  fs.mkdirSync(directory);
  reports.forEach((report, index) => fs.copyFileSync(report, path.join(directory, `coverage-${1000 + index}-${1700000000000 + index}-0.json`)));
  return directory;
}

function permutations(items) {
  return items.length < 2 ? [items] : items.flatMap((item, index) => permutations(items.filter((_, other) => other !== index)).map(rest => [item, ...rest]));
}

const summary = measured => measured.map(file => ({path: file.path, lines: file.lines, branches: file.branches}));

test('every arrival order of the same process reports gives identical complete coverage', () => {
  // Node's own merge reports a false branch gap for some orders of exactly these four processes.
  const root = project();
  const reports = processes(root, [[], [3], [3, 3, 3, 2], [2], [1]]);
  const orders = permutations(reports);
  assert.equal(orders.length, 120);
  const results = orders.map((order, index) => summary(evaluate({root, source: 'src', coverage: combine(root, order, index)})));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.ok(results[0][0].lines.length > 0 && results[0][0].lines.every(line => line.count > 0));
  assert.ok(results[0][0].branches.length > 0 && results[0][0].branches.every(branch => branch.count > 0));
});

test('a path no process executed is reported as uncovered however the other paths were reached', () => {
  const root = project();
  const reports = processes(root, [[1], [1, 1]]);
  permutations(reports).forEach((order, index) => {
    const [file] = evaluate({root, source: 'src', coverage: combine(root, order, `gap-${index}`)});
    assert.deepEqual(file.lines.filter(line => line.count === 0).map(line => line.number), [4, 5]);
    assert.ok(file.branches.some(branch => branch.count === 0 && branch.line === 3));
  });
});

test('production files without any coverage data are fully uncovered and tests, other files and foreign reports are ignored', () => {
  const root = project({'untested.js': 'module.exports = 1;\n', 'nested/deep.mjs': 'export const value = 1;\n',
    'deep.test.cjs': 'throw new Error("test file");\n', 'deep.spec.js': 'throw new Error("spec file");\n', 'notes.txt': 'not source\n'});
  const directory = combine(root, processes(root, [[1, 2, 3]]), 'one');
  fs.writeFileSync(path.join(directory, 'notes.json'), 'not a process report');
  const raw = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory).find(name => name.startsWith('coverage-'))), 'utf8'));
  assert.ok(raw.result.some(script => script.url.startsWith('node:')), 'real reports include Node internals');
  const measured = evaluate({root, source: 'src', coverage: directory});
  assert.deepEqual(measured.map(file => file.path), ['src/m.cjs', 'src/nested/deep.mjs', 'src/untested.js']);
  assert.deepEqual(measured.slice(1).map(file => file.lines.map(line => line.count)), [[0], [0]]);
  assert.equal(gate({root, source: 'src', coverage: directory, lcov: path.join(root, 'out.lcov'), stdout: {write() {}}}), 1);
});

test('reports for files outside the production tree are skipped', () => {
  const root = project();
  const directory = path.join(root, 'raw');
  fs.mkdirSync(directory);
  const foreign = {scriptId: '1', url: 'file:///elsewhere/other.cjs', functions: [{functionName: '', isBlockCoverage: false, ranges: [{startOffset: 0, endOffset: 5, count: 1}]}]};
  fs.writeFileSync(path.join(directory, 'coverage-1-2-0.json'), JSON.stringify({result: [foreign]}));
  const [file] = evaluate({root, source: 'src', coverage: directory});
  assert.ok(file.lines.every(line => line.count === 0));
});

test('an empty production tree is refused instead of passing vacuously', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-v8-empty-'));
  fs.mkdirSync(path.join(root, 'src'));
  assert.throws(() => evaluate({root, source: 'src', coverage: root}), /No production source files under src/);
});

test('enclosing functions are painted before nested ones whatever order V8 lists them in', () => {
  const nested = {ranges: [{startOffset: 2, endOffset: 4, count: 7}]};
  const outer = {ranges: [{startOffset: 0, endOffset: 8, count: 1}, {startOffset: 6, endOffset: 99, count: 0}]};
  const sibling = {ranges: [{startOffset: 2, endOffset: 3, count: 9}]};
  for (const order of permutations([nested, outer, sibling])) {
    assert.deepEqual([...paint(order, 8)], [1, 1, 9, 7, 1, 1, 0, 0]);
  }
});

test('LCOV and the text report describe lines and branches and files without branches read as complete', () => {
  const measured = [{path: 'src/a.cjs', lines: [{number: 1, count: 2}, {number: 3, count: 0}], branches: [{line: 3, count: 0}, {line: 4, count: 5}]},
    {path: 'src/b.cjs', lines: [{number: 1, count: 1}], branches: []}];
  assert.equal(toLcov(measured), [
    'TN:', 'SF:src/a.cjs', 'DA:1,2', 'DA:3,0', 'LF:2', 'LH:1', 'BRDA:3,0,0,0', 'BRDA:4,1,0,5', 'BRF:2', 'BRH:1', 'end_of_record',
    'TN:', 'SF:src/b.cjs', 'DA:1,1', 'LF:1', 'LH:1', 'BRF:0', 'BRH:0', 'end_of_record', ''].join('\n'));
  assert.equal(toReport(measured), [
    'src/a.cjs | line 50.00% | branch 50.00% | uncovered lines: 3 | uncovered branches at lines: 3',
    'src/b.cjs | line 100.00% | branch 100.00% | uncovered lines:  | uncovered branches at lines: ',
    'Coverage is below 100% for lines or branches.', ''].join('\n'));
  assert.match(toReport(measured.slice(1)), /Coverage is 100% for lines and branches\.\n$/);
});

test('the gate command writes LCOV and exits nonzero only when coverage is incomplete', () => {
  const root = project();
  const script = path.join(__dirname, '../scripts/v8-coverage-gate.cjs');
  const run = (calls, label) => {
    const lcov = path.join(root, `${label}.lcov`);
    const coverage = combine(root, processes(root, calls), label);
    const result = spawnSync(process.execPath, [script, coverage, lcov, root], {encoding: 'utf8'});
    return {...result, lcov: fs.readFileSync(lcov, 'utf8')};
  };
  const complete = run([[1, 2, 3]], 'complete');
  assert.equal(complete.status, 0, complete.stderr);
  assert.match(complete.stdout, /src\/m\.cjs \| line 100\.00% \| branch 100\.00%/);
  assert.match(complete.lcov, /^TN:\nSF:src\/m\.cjs\n/);
  const gap = run([[1]], 'gap');
  assert.equal(gap.status, 1);
  assert.match(gap.stdout, /Coverage is below 100%/);
  assert.match(gap.lcov, /BRDA:3,\d+,0,0/);
});
