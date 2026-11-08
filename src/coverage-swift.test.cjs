'use strict';
// Swift coverage through the documented recipe: `swift test --enable-code-coverage`, then `xcrun llvm-cov export
// -format=lcov`, read as an lcov part that declares `.swift` sources (docs/swift-coverage.md). The committed reports are
// real output of that recipe for test/fixtures/swift/pkg (Apple Swift 6.4, LLVM 21); `@ROOT@` stands for the checkout path.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gate = require('./coverage-gate.cjs');

const fixtures = path.join(__dirname, '..', 'test', 'fixtures', 'swift');
const SWIFT = ['.swift'];

// A temporary copy of the Swift package; `run(directory)` gets its real path.
function withPackage(run) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-swift-')));
  try {
    fs.cpSync(path.join(fixtures, 'pkg'), directory, {recursive: true});
    return run(directory);
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
}

const committed = (name, directory) => fs.readFileSync(path.join(fixtures, name), 'utf8').replaceAll('@ROOT@', directory);
const measure = (text, directory, source, notes) => gate.counters(text, source, 'lcov', directory, undefined, {suffixes: SWIFT, notes});
const failure = run => {try {run();} catch (error) {return error.message;} return assert.fail('expected a failure');};

test('real llvm-cov lcov of a fully tested Swift package measures every executable line and no branch', () => withPackage(directory => {
  const notes = [];
  assert.deepEqual(measure(committed('full.lcov', directory), directory, 'Sources', notes), {lines: [9, 9], branches: [0, 0]});
  assert.match(notes.join('\n'), /no BRDA records, so branches are not measured and only lines are gated/);
  // The package root is not a source directory: Package.swift is a .swift file the report cannot contain.
  assert.match(failure(() => measure(committed('full.lcov', directory), directory, '.')), /Missing application source coverage: .*Package\.swift/);
}));

test('the exact gate refuses a pure Swift report: branches are not measured, never 100%', () => withPackage(directory => {
  const report = path.join(directory, 'full.lcov');
  fs.writeFileSync(report, committed('full.lcov', directory));
  assert.equal(failure(() => gate.check(fs.readFileSync(report, 'utf8'), 'Sources', 'lcov', directory, {suffixes: SWIFT})), 'No branches measured');
  assert.match(failure(() => gate.checkPlan([{format: 'lcov', report: 'full.lcov', source_directory: 'Sources', source_suffixes: SWIFT}], directory)),
    /No branches measured/);
  const stderr = [];
  assert.equal(gate.main(['check', 'full.lcov', 'Sources', 'lcov', '--source-suffixes=.swift'], {cwd: directory, stdout: () => {}, stderr: text => stderr.push(text)}), 1);
  assert.match(stderr.join(''), /Coverage gate failed: No branches measured/);
}));

test('an unexecuted Swift function is counted line by line and fails with its lines', () => withPackage(directory => {
  const counts = measure(committed('partial.lcov', directory), directory, 'Sources');
  assert.deepEqual(counts, {lines: [9, 6], branches: [0, 0]});
  assert.equal(failure(() => gate.enforce(counts)), 'lines: 3 uncovered; require exactly 100%; No branches measured');
}));

test('a Swift source the report omits is not silently dropped from the denominator', () => withPackage(directory => {
  fs.writeFileSync(path.join(directory, 'Sources', 'Tiny', 'Unloaded.swift'), 'func unloaded() {}\n');
  assert.match(failure(() => measure(committed('full.lcov', directory), directory, 'Sources')),
    /Missing application source coverage: .*Unloaded\.swift/);
}));

const toolchain = cp.spawnSync('xcrun', ['--find', 'llvm-cov'], {encoding: 'utf8'}).status === 0 && cp.spawnSync('swift', ['--version']).status === 0;

test('the documented recipe, run with the installed Swift toolchain, yields the committed measurements', {skip: !toolchain}, () => withPackage(directory => {
  const run = (...argv) => cp.execFileSync(argv[0], argv.slice(1), {cwd: directory, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe']});
  const export_ = () => {
    run('swift', 'test', '--enable-code-coverage');
    const products = path.dirname(path.dirname(run('swift', 'test', '--show-codecov-path').trim().split('\n').pop()));
    const bundle = fs.readdirSync(products).find(name => name.endsWith('.xctest'));
    const executable = path.join(products, bundle, 'Contents', 'MacOS', path.basename(bundle, '.xctest'));
    return run('xcrun', 'llvm-cov', 'export', '-format=lcov', `-instr-profile=${path.join(products, 'codecov', 'default.profdata')}`, executable);
  };
  assert.deepEqual(measure(export_(), directory, 'Sources'), {lines: [9, 9], branches: [0, 0]});
}));
