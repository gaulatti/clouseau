'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gate = require('./coverage-gate.cjs');

const FIXTURE = require('../test/fixtures/istanbul-statement-free.json');
const ERASURE = require('../test/fixtures/istanbul-erased-typescript.json');

function withRoot(run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'istanbul-empty-'));
  try {
    const root = path.join(base, 'application');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'active.js'), FIXTURE.active_source);
    return run(root, base);
  } finally {fs.rmSync(base, {recursive: true, force: true});}
}

// Report keys are relative, exactly as emitted by the instrumenter; resolve them from the parent directory.
function verify(root, base, item, mutate) {
  fs.writeFileSync(path.join(root, item.filename), item.source);
  const report = {...FIXTURE.active_report, ...structuredClone(item.report)};
  if (mutate) mutate(report['application/' + item.filename]);
  fs.writeFileSync(path.join(root, 'coverage.json'), JSON.stringify(report));
  const direct = gate.check(report, root, 'istanbul', base);
  const planned = gate.checkPlan([{format: 'istanbul', report: 'application/coverage.json', source_directory: 'application'}], base);
  return {direct, planned};
}
const erase = entry => {entry.statementMap = {}; entry.s = {}; entry.branchMap = {}; entry.b = {};};

test('real native statement-free sources pass both entry points', () => withRoot((root, base) => {
  for (const item of FIXTURE.cases) {
    const {direct, planned} = verify(root, base, item);
    assert.deepEqual(direct, {lines: [2, 2], branches: [2, 2]}, item.filename);
    assert.deepEqual(planned.totals, direct, item.filename);
    fs.rmSync(path.join(root, item.filename));
  }
}));

test('a branch-only source needs its native branches', () => withRoot((root, base) => {
  const {direct, planned} = verify(root, base, FIXTURE.branch_only);
  assert.deepEqual(direct, {lines: [2, 2], branches: [3, 3]});
  assert.deepEqual(planned.totals, direct);
  assert.throws(() => verify(root, base, FIXTURE.branch_only, entry => {entry.branchMap = {}; entry.b = {};}),
    /No branches measured.*default-param\.js/);
}));

test('compiler-erased ambient trees keep their real empty measurements', () => withRoot((root, base) => {
  for (const item of ERASURE.ambient) {
    const {direct, planned} = verify(root, base, item);
    assert.deepEqual(direct, {lines: [2, 2], branches: [2, 2]}, item.filename);
    assert.deepEqual(planned.totals, direct, item.filename);
    fs.rmSync(path.join(root, item.filename));
  }
}));

test('live siblings and runtime namespaces, classes or overloads cannot borrow erasure', () => withRoot((root, base) => {
  for (const item of ERASURE.runtime) {
    assert.throws(() => verify(root, base, item), /uncovered/, item.filename);
    assert.throws(() => verify(root, base, item, erase), /No statements measured/, item.filename);
    fs.rmSync(path.join(root, item.filename));
  }
}));

test('an unloaded executable source cannot hide behind empty maps', () => withRoot((root, base) => {
  const unloaded = path.join(root, 'unloaded.ts');
  fs.writeFileSync(unloaded, 'export function unused() { throw new Error("uncovered"); }\n');
  const report = {...FIXTURE.active_report, [unloaded]: {path: unloaded, statementMap: {}, s: {}, branchMap: {}, b: {}}};
  assert.throws(() => gate.check(report, root, 'istanbul', base), /No statements measured.*unloaded\.ts/);
}));

test('a measured linear file needs no artificial branches', () => withRoot((root, base) => {
  const linear = path.join(root, 'linear.ts');
  fs.writeFileSync(linear, 'export const value = 1;\n');
  const report = {...FIXTURE.active_report, [linear]: {path: linear, statementMap: {0: {start: {line: 1}}}, s: {0: 1}, branchMap: {}, b: {}}};
  assert.deepEqual(gate.check(report, root, 'istanbul', base), {lines: [3, 3], branches: [2, 2]});
}));

test('an entirely erased component still needs nonempty native measurements', () => withRoot((root, base) => {
  fs.rmSync(path.join(root, 'active.js'));
  const item = ERASURE.ambient[0];
  fs.writeFileSync(path.join(root, item.filename), item.source);
  fs.writeFileSync(path.join(root, 'coverage.json'), JSON.stringify(item.report));
  assert.throws(() => gate.measure(item.report, root, 'istanbul', base), /No lines measured/);
  assert.throws(() => gate.checkPlan([{format: 'istanbul', report: 'application/coverage.json', source_directory: 'application'}], base),
    /Every coverage part requires nonempty/);
}));

test('a statement-free file must still be present in the report and unparseable source stops validation', () => withRoot((root, base) => {
  fs.writeFileSync(path.join(root, 'comments.js'), '// deliberately empty\n');
  assert.throws(() => gate.check(FIXTURE.active_report, root, 'istanbul', base), /Missing application source.*comments\.js/);
  fs.rmSync(path.join(root, 'comments.js'));
  const invalid = path.join(root, 'invalid.js');
  fs.writeFileSync(invalid, 'const = ;');
  const report = {...FIXTURE.active_report, [invalid]: {path: invalid, statementMap: {}, s: {}, branchMap: {}, b: {}}};
  assert.throws(() => gate.check(report, root, 'istanbul', base), /Cannot inspect statement-free application source/);
}));
