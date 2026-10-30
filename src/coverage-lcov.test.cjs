'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gate = require('./coverage-gate.cjs');
const {evaluate, toLcov} = require('./v8-coverage.cjs');

function tree(run, files = {'a.cjs': 'module.exports = 1;\n', 'b.mjs': 'export default 2;\n'}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-lcov-')));
  try {
    fs.mkdirSync(path.join(directory, 'src'));
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(directory, 'src', name)), {recursive: true});
      fs.writeFileSync(path.join(directory, 'src', name), text);
    }
    return run(directory);
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
}

const record = (file, {da = ['1,1'], br = ['1,0,0,1'], extra = [], lf = da.length, lh = da.filter(row => !row.endsWith(',0')).length,
  brf = br.length, brh = br.filter(row => !/,(?:0|-)$/.test(row)).length} = {}) =>
  ['TN:', `SF:${file}`, ...extra, ...da.map(row => `DA:${row}`), `LF:${lf}`, `LH:${lh}`, ...br.map(row => `BRDA:${row}`),
    `BRF:${brf}`, `BRH:${brh}`, 'end_of_record', ''].join('\n');
const both = options => record('src/a.cjs', options) + record('src/b.mjs');
const measure = (directory, text) => gate.counters(text, 'src', 'lcov', directory);
const rejects = (text, expected, files) => tree(directory => assert.throws(() => measure(directory, text), expected), files);

test('exact and partial LCOV counts are measured per distinct line and branch', () => tree(directory => {
  assert.deepEqual(measure(directory, both()), {lines: [2, 2], branches: [2, 2]});
  assert.deepEqual(measure(directory, both({da: ['1,1', '1,0', '2,0'], br: ['1,0,0,-', '1,0,1,2'], extra: ['FN:1,f', 'FNDA:1,f', 'FNF:1', 'FNH:1'], lf: 2, lh: 1, brf: 2, brh: 1})),
    {lines: [3, 2], branches: [3, 2]});
  assert.deepEqual(measure(directory, both({da: ['1,0'], br: ['1,0,0,0']}).replace(/\n/g, '\r\n')), {lines: [2, 1], branches: [2, 1]});
}));

test('the gate reads a text report from disk and enforces exactness', () => tree(directory => {
  const report = path.join(directory, 'node.lcov');
  fs.writeFileSync(report, both());
  assert.equal(gate.main(['check', report, path.join(directory, 'src'), 'lcov'], {cwd: directory, stdout: () => {}, stderr: () => {}}), 0);
  fs.writeFileSync(report, both({da: ['1,0'], br: ['1,0,0,0']}));
  assert.equal(gate.main(['check', report, path.join(directory, 'src'), 'lcov'], {cwd: directory, stdout: () => {}, stderr: () => {}}), 1);
}));

test('the repository V8 writer output is readable by the reader', () => tree(directory => {
  const files = evaluate({root: directory, source: 'src', coverage: (() => {
    const raw = path.join(directory, 'raw');
    fs.mkdirSync(raw);
    const ranges = name => ({url: `file://${path.join(directory, 'src', name)}`, functions: [{functionName: '', isBlockCoverage: true,
      ranges: [{startOffset: 0, endOffset: 18, count: 1}]}]});
    fs.writeFileSync(path.join(raw, 'one.json'), JSON.stringify({result: [ranges('a.cjs'), ranges('b.mjs')]}));
    return raw;
  })()});
  const counts = measure(directory, toLcov(files));
  assert.equal(counts.lines[0], 2);
  assert.ok(counts.lines[1] <= counts.lines[0]);
}));

test('malformed, partial, foreign and ambiguous LCOV cannot claim coverage', () => {
  rejects(undefined, /Expected an LCOV report as text/);
  rejects('', /Expected a nonempty LCOV report/);
  rejects('TN:\n', /Expected a nonempty LCOV report/);
  rejects('SF:src/a.cjs\n', /missing end_of_record/);
  rejects(record('src/a.cjs') + 'SF:src/b.mjs\nSF:src/a.cjs\n', /missing end_of_record/);
  rejects('end_of_record\n', /no source file/);
  rejects('DA:1,1\n' + both(), /outside a source record/);
  rejects(record('src/a.cjs'), /Missing application source coverage/);
  rejects(both() + record('src/a.cjs'), /Unexpected or duplicate/);
  rejects(both() + record('src/ghost.cjs'), /Unexpected or duplicate/);
  rejects(record('src/a.cjs', {extra: ['XX:1']}) + record('src/b.mjs'), /Unsupported LCOV record: XX/);
  rejects(record('src/a.cjs', {da: ['1,x']}) + record('src/b.mjs'), /nonnegative safe integers/);
  rejects(record('src/a.cjs', {da: ['1']}) + record('src/b.mjs'), /nonnegative safe integers/);
  rejects(record('src/a.cjs', {br: ['1,0,0']}) + record('src/b.mjs'), /nonnegative safe integers/);
  rejects(record('src/a.cjs', {da: ['1,99999999999999999999']}) + record('src/b.mjs'), /nonnegative safe integers/);
  rejects(record('src/a.cjs', {lf: 5}) + record('src/b.mjs'), /totals do not match/);
  rejects(record('src/a.cjs', {lh: 0}) + record('src/b.mjs'), /totals do not match/);
  rejects(record('src/a.cjs', {brf: 0}) + record('src/b.mjs'), /totals do not match/);
  rejects(record('src/a.cjs', {brh: 0}) + record('src/b.mjs'), /totals do not match/);
  rejects(['SF:src/a.cjs', 'DA:1,1', 'end_of_record', ''].join('\n') + record('src/b.mjs'), /totals do not match/);
});

test('reports outside the application inventory are ignored and bad inventories fail closed', () => {
  tree(directory => {
    const text = both() + record('src/ignored.test.cjs') + record('src/test/helper.cjs') + record('../elsewhere.cjs');
    assert.deepEqual(measure(directory, text), {lines: [2, 2], branches: [2, 2]});
  }, {'a.cjs': 'module.exports = 1;\n', 'b.mjs': 'export default 2;\n', 'ignored.test.cjs': '', 'test/helper.cjs': ''});
  rejects(both(), /No application JS\/TS sources found/, {});
  rejects(both(), /ignore directives are not allowed/, {'a.cjs': '/* c8 ignore next */\n', 'b.mjs': ''});
  tree(directory => {
    fs.symlinkSync(path.join(directory, 'src', 'a.cjs'), path.join(directory, 'src', 'link.cjs'));
    assert.throws(() => measure(directory, both()), /Symbolic or escaped/);
  });
});
