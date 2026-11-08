'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const gate = require('./coverage-gate.cjs');
const plan = require('./coverage-plan.cjs');
const declared = require('./coverage-declared.cjs');

// The reports are real tools/goinstr output (Go 1.27.3) for test/fixtures/go-outcomes/app: `full` is the whole
// suite on the host and a windows build, `partial` runs three tests, `host-only` omits the windows build.
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'go-outcomes');
const load = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
const withTree = run => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-gooutcomes-')));
  try {
    fs.cpSync(path.join(FIXTURES, 'app'), directory, {recursive: true});
    return run(directory);
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
};
const measure = (report, directory, detail) => gate.counters(report, directory, 'gooutcomes', directory, detail);
const rejects = (report, expected, directory) => assert.throws(() => measure(report, directory), expected);
const edit = (change, name = 'full') => {const report = load(name); change(report); return report;};
const entry = (report, file) => report.files.find(item => item.path === file);

test('outcome counts are measured: unloaded and unreached units stay unhit and a recovered panic is not inferred', () => withTree(directory => {
  assert.deepEqual(measure(load('full'), directory), {lines: [54, 48], branches: [46, 44]});
  assert.deepEqual(measure(load('partial'), directory), {lines: [54, 7], branches: [46, 2]});
  const detail = new Map();
  measure(load('full'), directory, detail);
  const decide = detail.get(path.join(directory, 'decide.go'));
  assert.equal(decide.lines.get(112), true);
  assert.equal(decide.lines.get(114), false);
  assert.equal(decide.lines.get(115), false);
  assert.ok(decide.branches.every(branch => branch.from === branch.to));
  assert.equal(detail.get(path.join(directory, 'unloaded', 'unloaded.go')).lines.get(6), false);
}));

test('a line is covered only when every statement starting on it ran', () => withTree(directory => {
  const report = load('full');
  const decide = entry(report, 'decide.go');
  decide.statements.push({line: 112, hits: 0});
  assert.deepEqual(measure(report, directory), {lines: [54, 47], branches: [46, 44]});
}));

test('a file excluded from every declared build or never loaded is an explicit error, never branchless', () => withTree(directory => {
  rejects(load('host-only'), /excluded from every declared build.*platform_windows\.go \(excluded by build constraints/, directory);
  rejects(edit(report => {delete entry(report, 'platform_windows.go').reason;}, 'host-only'), /platform_windows\.go \(no reason given\)/, directory);
}));

test('missing, unknown, duplicate, stale and escaping files are rejected', () => withTree(directory => {
  rejects(edit(report => {report.files = report.files.filter(item => item.path !== 'unloaded/unloaded.go');}), /missing from the outcome report: .*unloaded\.go/, directory);
  rejects(edit(report => {report.files.push({...entry(report, 'decide.go'), path: 'extra.go'});}), /Unexpected Go application outcomes: extra\.go/, directory);
  rejects(edit(report => {report.files.push(entry(report, 'decide.go'));}), /Duplicate Go outcome entry: decide\.go/, directory);
  rejects(edit(report => {entry(report, 'decide.go').sha256 = crypto.createHash('sha256').update('other').digest('hex');}), /stale or from another source: decide\.go/, directory);
  rejects(edit(report => {entry(report, 'decide.go').lines += 1;}), /stale or from another source/, directory);
  fs.appendFileSync(path.join(directory, 'decide.go'), '// changed\n');
  rejects(load('full'), /stale or from another source/, directory);
}));

test('paths must be safe module-relative paths inside the source directory', () => withTree(directory => {
  for (const unsafe of ['/decide.go', 'a\\b.go', '../decide.go', 'unloaded//unloaded.go', './decide.go', '']) {
    rejects(edit(report => {entry(report, 'decide.go').path = unsafe;}), /Unsafe Go outcome path|nonempty strings/, directory);
  }
  rejects(edit(report => {entry(report, 'decide.go').path = 7;}), /nonempty strings/, directory);
  assert.throws(() => measure(load('full'), path.join(directory, 'unloaded')), /escapes the source directory: decide\.go/);
}));

test('the report header must be the exact supported schema for this module', () => withTree(directory => {
  rejects([], /Malformed Go outcome report/, directory);
  rejects(edit(report => {report.extra = 1;}), /Malformed Go outcome report/, directory);
  rejects(edit(report => {delete report.files;}), /Malformed Go outcome report/, directory);
  rejects(edit(report => {report.schema = 'other';}), /Unsupported Go outcome report schema/, directory);
  rejects(edit(report => {report.version = 2;}), /Unsupported Go outcome report schema/, directory);
  rejects(edit(report => {report.go_version = 'devel';}), /no Go version/, directory);
  rejects(edit(report => {report.go_version = 127;}), /no Go version/, directory);
  rejects(edit(report => {report.module = 'example.com/other';}), /another module/, directory);
  rejects(edit(report => {report.files = {};}), /Malformed Go outcome report/, directory);
  rejects(edit(report => {report.builds = [];}), /one to 16 declared builds/, directory);
  rejects(edit(report => {report.builds = 'host';}), /one to 16 declared builds/, directory);
  rejects(edit(report => {report.builds = Array(17).fill(report.builds[0]);}), /one to 16 declared builds/, directory);
  for (const broken of [null, {goos: 'linux', goarch: 'amd64'}, {goos: 'Linux', goarch: 'amd64', tags: []}, {goos: 'linux', goarch: 'x'.repeat(41), tags: []},
    {goos: 'linux', goarch: 'amd64', tags: 'a'}, {goos: 'linux', goarch: 'amd64', tags: [1]}, {goos: 'linux', goarch: 'amd64', tags: ['bad tag']}]) {
    rejects(edit(report => {report.builds = [broken];}), /requires goos, goarch and tags/, directory);
  }
  assert.deepEqual(measure(edit(report => {report.builds = [{goos: 'linux', goarch: 'amd64', tags: ['integration', 'go1.21']}];}), directory), {lines: [54, 48], branches: [46, 44]});
}));

test('file entries, statuses, statements and outcomes are strictly shaped', () => withTree(directory => {
  rejects(edit(report => {report.files[0] = null;}), /Malformed Go outcome file entry/, directory);
  rejects(edit(report => {report.files[0].extra = 1;}), /Malformed Go outcome file entry/, directory);
  rejects(edit(report => {entry(report, 'decide.go').status = 'covered';}), /Unknown Go outcome file status: decide\.go/, directory);
  rejects(edit(report => {entry(report, 'decide.go').reason = 'why';}), /Unknown Go outcome file status/, directory);
  rejects(edit(report => {entry(report, 'decide.go').statements = {};}), /Malformed Go outcome file entry/, directory);
  rejects(edit(report => {entry(report, 'decide.go').outcomes = null;}), /Malformed Go outcome file entry/, directory);
  rejects(edit(report => {entry(report, 'decide.go').statements[0] = {line: 5};}), /Malformed Go statement entry/, directory);
  rejects(edit(report => {entry(report, 'decide.go').outcomes[0] = {line: 5};}), /Malformed Go outcome entry/, directory);
  for (const line of [0, 127, 1.5, '5', -1]) {
    rejects(edit(report => {entry(report, 'decide.go').statements[0].line = line;}), /beyond the source file|nonnegative safe integers/, directory);
  }
  for (const hits of [-1, 1.5, '1', 2 ** 60]) {
    rejects(edit(report => {entry(report, 'decide.go').statements[0].hits = hits;}), /nonnegative safe integers/, directory);
    rejects(edit(report => {entry(report, 'decide.go').outcomes[0].hits = hits;}), /nonnegative safe integers/, directory);
  }
  for (const field of ['construct', 'group', 'outcome']) {
    for (const value of ['', 7, 'x'.repeat(300)]) {
      rejects(edit(report => {entry(report, 'decide.go').outcomes[0][field] = value;}), /nonempty strings/, directory);
    }
  }
  rejects(edit(report => {const outcomes = entry(report, 'decide.go').outcomes; outcomes[1] = {...outcomes[0], line: outcomes[0].line};}), /Duplicate Go outcome/, directory);
}));

test('the gate reads the JSON report, rejects duplicate keys and runs through plans and per-file declarations', () => withTree(directory => {
  const report = path.join(directory, '..', `report-${path.basename(directory)}.json`);
  try {
    fs.writeFileSync(report, JSON.stringify(load('full')));
    const out = [];
    assert.equal(gate.main(['totals', report, directory, 'gooutcomes'], {cwd: directory, stdout: text => out.push(text), stderr: text => out.push(text)}), 0);
    assert.match(out.join(''), /lines/);
    fs.writeFileSync(report, '{"schema":"a","schema":"b"}');
    const errors = [];
    assert.notEqual(gate.main(['totals', report, directory, 'gooutcomes'], {cwd: directory, stdout: () => {}, stderr: text => errors.push(text)}), 0);
    assert.match(errors.join(''), /Duplicate coverage JSON key/);
    const parts = [{format: 'gooutcomes', report: path.basename(report), source_directory: '.'}];
    fs.writeFileSync(path.join(directory, path.basename(report)), JSON.stringify(load('full')));
    assert.deepEqual(gate.measurePlan(parts, directory).totals, {lines: [54, 48], branches: [46, 44]});
    assert.deepEqual(plan.coverageParts({version: 2, coverage: parts}), parts);
    assert.throws(() => plan.coverageParts({version: 1, coverage: parts[0]}), /Invalid local-only/);
    assert.doesNotThrow(() => declared.requirePerFile({per_file: true}, 'gooutcomes'));
  } finally {fs.rmSync(report, {force: true});}
}));
