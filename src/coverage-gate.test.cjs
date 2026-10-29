'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gate = require('./coverage-gate.cjs');
const {loadReport, realPath, isInside} = require('./coverage-util.cjs');
const {inventory} = require('./coverage-coveragepy.cjs');

// The coverage.py reports are real coverage.py 7.13.0 `coverage json` output for the
// small Python trees below, so these tests qualify the native format without Python.
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'coveragepy');
const native = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
const SOURCE = 'def choose(ok):\n    if ok:\n        return 1\n    return 0\n';
const LOOP = 'def walk(items):\n    for item in items:\n        if item:\n            return item\n';
const cwd = process.cwd();

function temp(run) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-coverage-gate-')));
  try {return run(directory);}
  finally {fs.rmSync(directory, {recursive: true, force: true});}
}

function write(root, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true});
    fs.writeFileSync(path.join(root, name), text);
  }
}

// Run `run(root, directory)` over a Python tree whose native report is `name`.
function python(run, files = {}) {
  return temp(directory => {
    const root = path.join(directory, 'src');
    write(root, {'service.py': SOURCE, '__init__.py': '', ...files});
    return run(root, directory);
  });
}

const checkPy = (report, root, at = root) => gate.check(report, root, 'coveragepy', at);
const messages = (run, expected) => assert.throws(run, expected);

// ---- LLVM and dispatch ----

const llvm = ({lines = 10, coveredLines = 10, branches = 4, coveredBranches = 4, filename = path.resolve('src/main.rs')} = {}) => ({
  type: 'llvm.coverage.json.export',
  data: [{files: [{filename, summary: {lines: {count: lines, covered: coveredLines}, branches: {count: branches, covered: coveredBranches}}}]}]});
const checkLlvm = (report, source = 'src') => gate.check(report, source, 'llvm', cwd);

test('exact LLVM coverage passes and partial native counts stay measurable without passing the gate', () => {
  assert.deepEqual(checkLlvm(llvm()), {lines: [10, 10], branches: [4, 4]});
  const partial = llvm({coveredLines: 7, coveredBranches: 1});
  assert.deepEqual(gate.measure(partial, 'src', 'llvm', cwd), {lines: [10, 7], branches: [4, 1]});
  messages(() => checkLlvm(partial), /3 uncovered/);
  const branchless = llvm({branches: 0, coveredBranches: 0});
  assert.deepEqual(gate.measure(branchless, 'src', 'llvm', cwd), {lines: [10, 10], branches: [0, 0]});
  messages(() => checkLlvm(branchless), /No branches measured/);
  messages(() => checkLlvm(llvm({lines: 1000000, coveredLines: 999999})), /1 uncovered/);
  messages(() => checkLlvm(llvm({coveredBranches: 3})), /branches: 1 uncovered/);
  messages(() => checkLlvm(llvm({lines: 0, coveredLines: 0})), /No lines measured/);
  messages(() => gate.measure(llvm({lines: 0, coveredLines: 0}), 'src', 'llvm', cwd), /No lines measured/);
});

test('missing, empty and malformed LLVM exports and counts fail closed', () => {
  for (const value of [{}, [], null, {type: 'llvm.coverage.json.export'}, {type: 'llvm.coverage.json.export', data: []}]) {
    messages(() => checkLlvm(value), /Expected an LLVM|Coverage data is missing/);
  }
  for (const files of [[], null, 'files']) {
    const value = llvm(); value.data[0].files = files;
    messages(() => checkLlvm(value), /Per-file coverage is missing/);
  }
  messages(() => checkLlvm({type: 'llvm.coverage.json.export', data: [null]}), /Per-file coverage is missing/);
  const missing = llvm(); delete missing.data[0].files[0].summary.branches;
  messages(() => checkLlvm(missing), /Missing integer branches/);
  const noSummary = llvm(); delete noSummary.data[0].files[0].summary;
  messages(() => checkLlvm(noSummary), /Missing integer lines/);
  for (const [count, covered] of [[-1, 0], [1, 2], [1, -1], [true, 1], ['1', 1]]) {
    const value = llvm(); value.data[0].files[0].summary.lines = {count, covered};
    assert.throws(() => checkLlvm(value), /Missing integer lines|Invalid lines/);
  }
});

test('LLVM dependency and external sources cannot mask application gaps or replace it', () => {
  const value = llvm({coveredLines: 9});
  for (const dependency of ['vendor/library/src/lib.rs', '.cargo/registry/src/lib.rs']) {
    value.data[0].files.push({...value.data[0].files[0], filename: path.resolve('src', dependency),
      summary: {lines: {count: 1000000, covered: 1000000}, branches: {count: 1, covered: 1}}});
  }
  messages(() => checkLlvm(value), /lines: 1 uncovered/);
  messages(() => checkLlvm(llvm({filename: '/another/repo/src/main.rs'})), /No application source/);
  messages(() => checkLlvm(llvm({filename: 5})), /No application source/);
  const anonymous = llvm(); delete anonymous.data[0].files[0].filename;
  messages(() => checkLlvm(anonymous), /No application source/);
  messages(() => checkLlvm(llvm({filename: path.resolve('application/service.py')})), /No application source/);
  assert.deepEqual(checkLlvm(llvm({filename: path.resolve('application/service.py')}), 'application'), {lines: [10, 10], branches: [4, 4]});
});

test('an unknown coverage format fails closed', () => {
  messages(() => gate.counters({}, 'src', 'percentages', cwd), /Unknown coverage format/);
});

// ---- strict JSON and path helpers ----

test('the strict loader rejects duplicate keys anywhere and ordinary JSON loads unchanged', () => temp(directory => {
  const filename = path.join(directory, 'report.json');
  for (const text of ['{"a": 1, "a": 2}', '{"a": {"b": 1, "b": 2}}', '[{"a": 1, "a": 1}]', '{"k": [1, 2], "k": 3}']) {
    fs.writeFileSync(filename, text);
    messages(() => loadReport(filename), /Duplicate coverage JSON key/);
  }
  fs.writeFileSync(filename, '{"a": ["x, \\"y\\"", {"b": 1}], "c": {"b": 1}, "d": [1, 2]}');
  assert.deepEqual(loadReport(filename), {a: ['x, "y"', {b: 1}], c: {b: 1}, d: [1, 2]});
  fs.writeFileSync(filename, '[1, 2]');
  assert.deepEqual(loadReport(filename), [1, 2]);
  fs.writeFileSync(filename, 'invalid');
  assert.throws(() => loadReport(filename), SyntaxError);
}));

test('path helpers resolve existing links, missing tails and containment exactly', () => temp(directory => {
  fs.mkdirSync(path.join(directory, 'real'));
  fs.symlinkSync(path.join(directory, 'real'), path.join(directory, 'link'));
  assert.equal(realPath('link/missing/file', directory), path.join(directory, 'real', 'missing', 'file'));
  assert.equal(realPath(path.join(directory, 'real'), '/'), path.join(directory, 'real'));
  assert.ok(isInside(directory, directory));
  assert.ok(isInside(path.join(directory, 'a', 'b'), directory));
  assert.ok(!isInside(path.dirname(directory), directory));
  assert.ok(!isInside(path.join(directory + '-sibling', 'a'), directory));
}));

// ---- Istanbul ----

function istanbul(run, files = {}) {
  return temp(directory => {
    const root = path.join(directory, 'src');
    write(root, {'service.ts': 'export function f(ok: boolean) {\n  return ok ? 1 : 0;\n}\n', ...files});
    const name = path.join(root, 'service.ts');
    const report = {[name]: {path: name, statementMap: {0: {start: {line: 1}}, 1: {start: {line: 2}}}, s: {0: 1, 1: 2},
      branchMap: {0: {locations: [{}, {}]}}, b: {0: [1, 1]}}};
    return run({root, directory, name, report, check: value => gate.check(value ?? report, root, 'istanbul', root)});
  });
}

test('Istanbul counters are exact hits and duplicate line locations count once', () => istanbul(({report, name, check}) => {
  assert.deepEqual(check(), {lines: [2, 2], branches: [2, 2]});
  report[name].statementMap[2] = {start: {line: 2}}; report[name].s[2] = 0;
  assert.deepEqual(check(), {lines: [2, 2], branches: [2, 2]});
  for (const metric of ['s', 'b']) {
    const value = structuredClone(report);
    value[name][metric][0] = metric === 's' ? 0 : [1000000, 0];
    messages(() => check(value), /1 uncovered/);
  }
}));

test('Istanbul requires a complete production inventory and ignores only concrete test and dependency conventions', () => istanbul(({root, report, name, check}) => {
  write(root, {'unloaded.ts': 'export const unloaded = 1;\n'});
  messages(() => check(), /Missing application source.*unloaded\.ts/);
  fs.rmSync(path.join(root, 'unloaded.ts'));
  write(root, {'types.d.ts': 'declare const x: number;\n', 'README.md': 'Documentation\n'});
  assert.equal(check().lines[0], 2);
  for (const relative of ['service.test.ts', 'service.spec.tsx', 'test/fixture.js', 'tests/fixture.cjs', '__tests__/fixture.mjs',
    'node_modules/dependency.js', 'vendor/library.js', '.git/hook.js']) {
    write(root, {[relative]: '/* c8 ignore next */\nfixture();\n'});
    report[path.join(root, relative)] = {non_application_fixture: true};
  }
  assert.deepEqual(check(), {lines: [2, 2], branches: [2, 2]});
  for (const relative of ['test-support.ts', 'contest.js', 'generated/client.ts', 'config/settings.ts']) {
    write(root, {[relative]: 'export const application = 1;\n'});
    messages(() => check(), /Missing application source/);
    fs.rmSync(path.join(root, relative));
  }
  const external = path.join(path.dirname(root), 'dependency.js');
  report[external] = {path: external};
  assert.equal(check().lines[0], 2);
  delete report[name];
  messages(() => check(), /Missing application source/);
}));

test('Istanbul fails closed on missing sources, empty measurements, directives and skips', () => istanbul(({root, report, name, check}) => {
  for (const tool of ['c8', 'istanbul', 'v8']) {
    fs.writeFileSync(name, `/* ${tool} ignore next */\nexport const hidden = 1;\n`);
    messages(() => check(), /ignore directives/);
  }
  fs.writeFileSync(name, 'export const visible = 1;\n');
  for (const location of ['statementMap', 'branchMap']) {
    const value = structuredClone(report); value[name][location][0].skip = true;
    messages(() => check(value), /skipped/);
  }
  for (const keys of [['statementMap', 's'], ['branchMap', 'b']]) {
    const value = structuredClone(report);
    for (const key of keys) value[name][key] = {};
    messages(() => check(value), /No .* measured/);
  }
  fs.rmSync(name);
  messages(() => check(), /No application JS\/TS sources/);
  fs.mkdirSync(path.join(root, 'dir.ts'));
  fs.symlinkSync(path.join(root, 'dir.ts'), path.join(root, 'alias-dir.ts'));
  fs.symlinkSync(path.join(root, 'missing.ts'), path.join(root, 'dangling.ts'));
  messages(() => check(), /No application JS\/TS sources/);
}));

test('Istanbul rejects unexpected, duplicate, symbolic and mismatched paths', () => istanbul(({root, report, name, check}) => {
  messages(() => check({...report, [path.join(root, 'other.js')]: {}}), /Unexpected or duplicate/);
  const alias = path.join(root, 'alias.ts');
  fs.symlinkSync(name, alias);
  messages(() => check({...report, [alias]: {...report[name], path: alias}}), /Symbolic or escaped/);
  fs.unlinkSync(alias);
  for (const entry of [null, {path: 'wrong.ts'}]) messages(() => check({[name]: entry}), /Mismatched/);
  for (const value of [{}, []]) messages(() => check(value), /nonempty Istanbul/);
  messages(() => gate.check(null, root, 'istanbul', root), /nonempty Istanbul/);
}));

test('Istanbul rejects malformed maps, hits and locations', () => istanbul(({report, name, check}) => {
  const mutations = [['statementMap', null], ['s', null], ['s', {}], ['branchMap', null], ['b', null], ['b', {}], ['s', {0: 1, 5: 1}]];
  for (const loc of [null, {}, {start: {line: 0}}, {start: {line: true}}, {start: null}, 'text']) {
    mutations.push(['statementMap', {0: loc, 1: {start: {line: 2}}}]);
  }
  for (const loc of [null, {}, {locations: null}]) mutations.push(['branchMap', {0: loc}]);
  for (const values of [null, [], [1], [true, 1], [-1, 1], ['1', 1]]) mutations.push(['b', {0: values}]);
  for (const value of [true, -1, '1']) mutations.push(['s', {0: value, 1: 1}]);
  for (const [key, replacement] of mutations) {
    const value = structuredClone(report); value[name][key] = replacement;
    assert.throws(() => check(value), Error, `${key} ${JSON.stringify(replacement)}`);
  }
}));

// ---- coverage.py ----

test('real coverage.py decision exits are exact; percentages are irrelevant', () => python(root => {
  const report = native('full');
  assert.deepEqual(checkPy(report, root), {lines: [4, 4], branches: [2, 2]});
  report.files['service.py'].summary.percent_covered = 0;
  report.totals = {percent_covered: 0};
  assert.deepEqual(checkPy(report, root).lines, [4, 4]);
}));

test('real partial coverage, unloaded modules and missing branch data cannot pass', () => python((root, directory) => {
  const partial = native('partial');
  messages(() => checkPy(partial, root), /1 uncovered/);
  assert.deepEqual(gate.counters(partial, root, 'coveragepy', root), {lines: [4, 3], branches: [2, 1]});
  write(root, {'unloaded.py': 'def unused():\n    return 1\n'});
  const unloaded = native('unloaded');
  assert.deepEqual(unloaded.files['unloaded.py'].missing_lines, [1, 2]);
  messages(() => checkPy(unloaded, root), /2 uncovered/);
  delete unloaded.files['unloaded.py'];
  messages(() => checkPy(unloaded, root), /Missing application Python.*unloaded\.py/);
  messages(() => checkPy(native('nobranch'), root), /branch-aware native/);
  fs.rmSync(path.join(root, 'unloaded.py'));
  assert.equal(directory, path.dirname(root));
}));

test('real configured exclusions cannot hide failures', () => python(root => {
  messages(() => checkPy(native('exclude-line'), root), /Excluded Python/);
  messages(() => checkPy(native('exclude-partial'), root), /Inconsistent|summary disagrees/);
}));

test('real loop exits, negative destinations and docstring-only statements are measured exactly', () => python(root => {
  write(root, {'loop.py': LOOP});
  const loop = native('loop');
  assert.ok(loop.files['loop.py'].executed_branches.some(([, target]) => target < 0));
  assert.deepEqual(checkPy(loop, root).branches, [6, 6]);
  fs.rmSync(path.join(root, 'loop.py'));
  write(root, {'documented.py': '"""Module documentation."""\nvalue = 1\n'});
  const documented = native('documented');
  assert.equal(documented.files['documented.py'].summary.num_statements, 1);
  assert.deepEqual(checkPy(documented, root).lines, [5, 5]);
}));

test('the source inventory keeps entrypoints, configuration, migrations and generated code', () => python(root => {
  const report = native('full');
  for (const name of ['manage.py', 'config/settings.py', 'apps/migrations/0001_initial.py', 'proto/generated_pb2.py']) {
    write(root, {[name]: 'application_value = 1\n'});
    messages(() => checkPy(report, root), /Missing application Python/);
    fs.rmSync(path.join(root, name));
  }
  for (const name of ['tests/test_app.py', 'test/test_app.py', 'test_service.py', 'service_test.py', 'tests.py', 'conftest.py',
    '.venv/lib/dependency.py', 'venv/dependency.py', '.tox/py/lib/dependency.py', 'node_modules/tool.py', '__pycache__/cache.py']) {
    write(root, {[name]: 'non_application_fixture = 1\n'});
  }
  write(root, {'README.md': 'Documentation\n', 'data/notes.txt': 'text\n'});
  assert.deepEqual(checkPy(report, root).lines, [4, 4]);
}));

test('real extensionless entrypoints are inventoried statically and measured exactly', () => python(root => {
  write(root, {launch: '#!/usr/bin/env python3\n' + SOURCE});
  const complete = native('launch-full');
  assert.ok(complete.files.launch);
  assert.deepEqual(checkPy(complete, root), {lines: [8, 8], branches: [4, 4]});
  const partial = native('launch-partial');
  assert.deepEqual(gate.counters(partial, root, 'coveragepy', root), {lines: [8, 7], branches: [4, 3]});
  messages(() => checkPy(partial, root), /1 uncovered/);
  messages(() => checkPy(native('full'), root), /Missing application Python.*launch/);
}));

test('Python shebangs are classified without executing the file', () => python((root, directory) => {
  const launch = path.join(root, 'launch');
  for (const header of ['#!/usr/bin/python', '#!/opt/local/bin/python3', '#!/usr/bin/python3.13 -u', '#! /usr/bin/env python3',
    '#!/usr/bin/env -S python3 -u', '#!/usr/bin/env -S python3.13 -u\r', '#!/usr/bin/env /usr/bin/python3',
    "#!/usr/bin/env -S /opt/local/bin/python3.13 -u", '#!"/usr/bin/python3"', '#!/usr/bin/pyth\\on3', '#!/usr/bin/python3 \\-u']) {
    fs.writeFileSync(launch, header + '\n' + SOURCE);
    assert.ok(inventory(root, root).has(launch), header);
  }
  fs.writeFileSync(launch, '#!/usr/bin/python3');
  assert.ok(inventory(root, root).has(launch));
  const marker = path.join(directory, 'executed');
  fs.writeFileSync(launch, `#!/usr/bin/env python3\nrequire_marker = ${JSON.stringify(marker)}\n`);
  assert.ok(inventory(root, root).has(launch));
  assert.ok(!fs.existsSync(marker));
  fs.rmSync(launch);
}));

test('malformed, unsupported and relative Python shebangs fail closed', () => python(root => {
  const launch = path.join(root, 'launch');
  const cases = [['#!\n', /Malformed/], ['#!/usr/bin/env\n', /Malformed/], ['#!/usr/bin/env -S\n', /Malformed/],
    ['#!/usr/bin/python3 "unterminated\n', /Malformed/], ['#!/usr/bin/python3 \\', /Malformed/],
    [Buffer.concat([Buffer.from('#!'), Buffer.from([0xff, 0x0a])]), /Malformed/],
    ['#!python3\n', /Nonabsolute/], ['#!/usr/bin/env bin/python3\n', /Nonabsolute/],
    ['#!/usr/bin/env sh python3\n', /Unsupported/], [`#!${'x'.repeat(4100)}\n`, /Overlong/]];
  for (const [content, expected] of cases) {
    fs.writeFileSync(launch, content);
    messages(() => inventory(root, root), expected);
  }
}));

test('non-Python and excluded extensionless files stay outside the inventory', () => python(root => {
  const report = native('full');
  const files = {shell: '#!/bin/sh\necho ready\n', 'env-shell': '#!/usr/bin/env bash\necho ready\n', text: 'application documentation\n',
    binary: '\x00\xff\n', 'large-binary': 'x'.repeat(10000), 'not-an-interpreter': '#!/usr/bin/python-helper\n',
    'tests/launch': '#!/usr/bin/env python3\ninvalid excluded source\n', test_launch: '#!/usr/bin/python3\ninvalid excluded source\n',
    '.venv/launch': '#!/usr/bin/python3\ninvalid dependency\n', one: 'x'};
  for (const [name, content] of Object.entries(files)) write(root, {[name]: Buffer.from(content, 'latin1')});
  fs.writeFileSync(path.join(root, 'empty'), '');
  assert.deepEqual(checkPy(report, root).lines, [4, 4]);
}));

test('dependency and test symlink directories are not inspected but other links fail closed', () => python((root, directory) => {
  const report = native('full');
  const external = path.join(directory, 'external');
  write(external, {launch: '#!/usr/bin/env python3\ninvalid outside source\n'});
  for (const name of ['node_modules', 'venv', '.venv', 'test', 'tests']) {
    fs.symlinkSync(external, path.join(root, name), 'dir');
    assert.deepEqual(checkPy(report, root).lines, [4, 4], name);
    fs.unlinkSync(path.join(root, name));
  }
  for (const [name, target] of [['link', external], ['link.py', path.join(root, 'service.py')], ['dangling', path.join(root, 'missing')]]) {
    fs.symlinkSync(target, path.join(root, name));
    messages(() => checkPy(report, root), /Symbolic Python application source/);
    fs.unlinkSync(path.join(root, name));
  }
}));

test('invalid, undecodable and ignore-directive sources are rejected while strings are not directives', () => python(root => {
  const report = native('full');
  for (const directive of ['# pragma: no cover', '# PRAGMA: no branch', '# pragma : no   branch', '# pragma no branch', '#pragmanocover']) {
    fs.writeFileSync(path.join(root, 'service.py'), SOURCE + directive + '\n');
    messages(() => checkPy(report, root), /ignore directives/);
  }
  fs.writeFileSync(path.join(root, 'service.py'), SOURCE + 'message = "# pragma: no cover"\nother = \'\\\' # pragma: no cover\'\n' +
    'long = """\n# pragma: no cover\n"""\nraw = r"\\\\"\nbytes_ = b"x"\nformatted = f"{1}"\n# an ordinary comment\n');
  assert.deepEqual(checkPy(report, root).lines, [4, 4]);
  fs.writeFileSync(path.join(root, 'service.py'), SOURCE + 'folded = "a\\\r\nb"\r\n');
  assert.deepEqual(checkPy(report, root).lines, [4, 4]);
  fs.writeFileSync(path.join(root, 'service.py'), 'x = "unterminated\n');
  messages(() => checkPy(report, root), /Invalid Python application source/);
  fs.writeFileSync(path.join(root, 'service.py'), 'x = """never closed\n');
  messages(() => checkPy(report, root), /Invalid Python application source/);
  fs.writeFileSync(path.join(root, 'service.py'), 'x = "\\');
  messages(() => checkPy(report, root), /Invalid Python application source/);
  fs.writeFileSync(path.join(root, 'service.py'), Buffer.from([0xff, 0xfe, 0x41]));
  messages(() => checkPy(report, root), /Invalid Python application source/);
  fs.writeFileSync(path.join(root, 'service.py'), SOURCE);
  const empty = structuredClone(report); empty.files['service.py'].executed_lines = [];
  messages(() => checkPy(empty, root), /empty executable/);
  const excluded = structuredClone(report); excluded.files['service.py'].excluded_lines = [3];
  messages(() => checkPy(excluded, root), /Excluded Python/);
  const missing = structuredClone(report); missing.files['service.py'].missing_lines = [3];
  messages(() => checkPy(missing, root), /Inconsistent or empty/);
}));

test('line counting follows Python line terminators and only strings, comments and blanks are non-executable', () => python(root => {
  const report = native('full');
  for (const text of ['', '"""Module documentation."""\n', '# Empty package\n', "'a' \"b\"\n\f\n# c\r\n", 'r"x" u"y" R\'z\'\n']) {
    fs.writeFileSync(path.join(root, '__init__.py'), text);
    assert.deepEqual(checkPy(report, root).lines, [4, 4], JSON.stringify(text));
  }
  fs.writeFileSync(path.join(root, '__init__.py'), 'value = 1\n');
  messages(() => checkPy(report, root), /Inconsistent or empty/);
  fs.writeFileSync(path.join(root, '__init__.py'), '"doc" % 1\n');
  messages(() => checkPy(report, root), /Inconsistent or empty/);
  fs.writeFileSync(path.join(root, '__init__.py'), 'b"bytes"\n');
  messages(() => checkPy(report, root), /Inconsistent or empty/);
  fs.writeFileSync(path.join(root, '__init__.py'), '');
  const limited = structuredClone(report); limited.files['service.py'].executed_lines = [1, 2, 3, 4, 5];
  messages(() => checkPy(limited, root), /line numbers/);
  fs.writeFileSync(path.join(root, 'service.py'), SOURCE.replace(/\n/g, '\r\n'));
  assert.deepEqual(checkPy(report, root).lines, [4, 4]);
  fs.writeFileSync(path.join(root, 'service.py'), SOURCE);
  fs.rmSync(path.join(root, 'service.py'));
  delete report.files['service.py'];
  messages(() => checkPy(report, root), /No lines measured.*No branches measured/);
  fs.rmSync(path.join(root, '__init__.py'));
  messages(() => checkPy(report, root), /No application Python/);
}));

test('absolute and cwd-relative native paths resolve without substitution', () => python((root, directory) => {
  const report = native('full');
  const absolute = Object.fromEntries(Object.entries(report.files).map(([name, entry]) => [path.join(root, name), entry]));
  assert.deepEqual(checkPy({...report, files: absolute}, root).branches, [2, 2]);
  const relative = Object.fromEntries(Object.entries(report.files).map(([name, entry]) => ['src/' + name, entry]));
  assert.deepEqual(checkPy({...report, files: relative}, root, directory).branches, [2, 2]);
}));

test('foreign, unsafe, duplicate, symbolic and non-production report entries cannot satisfy coverage', () => python((root, directory) => {
  const report = native('full');
  const foreign = structuredClone(report);
  foreign.files[path.join(directory, 'dependency.py')] = {untrusted: 'ignored'};
  assert.deepEqual(checkPy(foreign, root).lines, [4, 4]);
  for (const name of ['', '../outside.py', 'nested/../../outside.py']) {
    const value = structuredClone(report); value.files[name] = report.files['service.py'];
    messages(() => checkPy(value, root), /Unsafe/);
  }
  const duplicate = structuredClone(report);
  duplicate.files[path.join(root, 'service.py')] = report.files['service.py'];
  messages(() => checkPy(duplicate, root), /Unexpected or duplicate/);
  fs.symlinkSync(path.join(root, 'service.py'), path.join(root, 'test_alias.py'));
  const alias = structuredClone(report); alias.files['test_alias.py'] = report.files['service.py'];
  messages(() => checkPy(alias, root), /Symbolic coverage.py source path/);
  fs.unlinkSync(path.join(root, 'test_alias.py'));
  write(root, {'test_extra.py': 'not_application = 1\n'});
  const extra = structuredClone(report); extra.files[path.join(root, 'test_extra.py')] = report.files['service.py'];
  messages(() => checkPy(extra, root), /Unexpected or duplicate/);
}));

test('missing, empty or incompatible coverage.py metadata cannot claim coverage', () => python(root => {
  const report = native('full');
  for (const value of [null, [], {}, {meta: null}, {...report, meta: {}}]) messages(() => checkPy(value, root), /branch-aware native/);
  for (const [key, value] of [['format', 2], ['format', true], ['branch_coverage', 1], ['branch_coverage', false], ['version', null], ['version', '']]) {
    const changed = structuredClone(report); changed.meta[key] = value;
    messages(() => checkPy(changed, root), /branch-aware native/);
  }
  for (const files of [null, [], {}]) messages(() => checkPy({...report, files}, root), /file measurements/);
  const entry = structuredClone(report); entry.files['service.py'] = null;
  messages(() => checkPy(entry, root), /file measurements/);
}));

test('invalid, duplicate or conflicting line and decision-exit data fails', () => python(root => {
  const changed = update => {const value = structuredClone(native('full')); update(value.files['service.py']); return value;};
  for (const value of [null, {}, [true], [0], [-1], [1000], ['1'], [1, 1]]) {
    messages(() => checkPy(changed(entry => {entry.executed_lines = value;}), root), /line numbers/);
  }
  for (const value of [null, {}, [null], [[1]], [[true, 2]], [[0, 1]], [[1000, 1]], [[2, 0]], [[2, 1000]], [[2, -1000]], [[2, 2]], [[2, 3], [2, 3]]]) {
    messages(() => checkPy(changed(entry => {entry.executed_branches = value;}), root), /branch decision exit/);
  }
  for (const [taken, missing] of [[[[2, 3]], [[2, 3]]], [[[3, 2], [3, 4]], []], [[], [[3, 2], [3, 4]]], [[[2, 3]], []]]) {
    messages(() => checkPy(changed(entry => {
      entry.executed_branches = taken; entry.missing_branches = missing;
      if (taken.length && taken[0][0] === 3 || missing.length && missing[0][0] === 3) {entry.executed_lines = [1, 2, 4]; entry.missing_lines = taken.length ? [3] : [];}
    }), root), /Inconsistent/);
  }
}));

test('missing, invalid or inconsistent integer summaries fail', () => python(root => {
  const summary = native('full').files['service.py'].summary;
  for (const value of [null, {}, {...summary, covered_lines: true}, {...summary, covered_lines: -1}, {...summary, covered_lines: 5},
    {...summary, num_statements: 5}, {...summary, num_statements: 0, covered_lines: 0}, {...summary, num_branches: 0},
    {...summary, num_partial_branches: 1}, {...summary, missing_branches: '0'}]) {
    const report = native('full'); report.files['service.py'].summary = value;
    messages(() => checkPy(report, root), /summary disagrees/);
  }
}));

// ---- plans and command line ----

function plan(run) {
  return temp(directory => {
    write(directory, {'frontend/app/service.js': 'module.exports = value => (value ? 1 : 0);\n'});
    const frontend = path.join(directory, 'frontend', 'app', 'service.js');
    write(directory, {'frontend.json': JSON.stringify({[frontend]: {path: frontend,
      statementMap: {0: {start: {line: 1}}}, s: {0: 1}, branchMap: {0: {locations: [{}, {}]}}, b: {0: [1, 1]}}})});
    write(directory, {'backend/service.py': SOURCE, 'backend/__init__.py': '', 'backend.json': JSON.stringify(native('full'))});
    const parts = [{format: 'istanbul', report: 'frontend.json', source_directory: 'frontend/app'},
      {format: 'coveragepy', report: 'backend.json', source_directory: 'backend'}];
    return run({directory, parts, frontend});
  });
}

test('every native part is measured separately, never merged, and each must be exact', () => plan(({directory, parts}) => {
  const result = gate.checkPlan(parts, directory);
  assert.deepEqual(result.totals, {lines: [5, 5], branches: [4, 4]});
  assert.deepEqual(result.parts.map(part => part.counts.lines), [[1, 1], [4, 4]]);
  assert.deepEqual(Object.keys(result.parts[0]), ['format', 'report', 'source_directory', 'counts']);
  fs.writeFileSync(path.join(directory, 'backend.json'), JSON.stringify(native('partial')));
  assert.deepEqual(gate.measurePlan(parts, directory).totals, {lines: [5, 4], branches: [4, 3]});
  messages(() => gate.checkPlan(parts, directory), /backend\.json has uncovered/);
}));

test('a plan may use the repository root as its only source directory', () => temp(directory => {
  write(directory, {'app.js': 'module.exports = 1;\n'});
  const file = path.join(directory, 'app.js');
  write(directory, {'coverage/report.json': JSON.stringify({[file]: {path: file, statementMap: {0: {start: {line: 1}}}, s: {0: 1},
    branchMap: {0: {locations: [{}, {}]}}, b: {0: [1, 1]}}})});
  const parts = [{format: 'istanbul', report: 'coverage/report.json', source_directory: '.'}];
  assert.deepEqual(gate.checkPlan(parts, directory).totals, {lines: [1, 1], branches: [2, 2]});
}));

test('branchless components and empty parts cannot pass a plan', () => plan(({directory, parts, frontend}) => {
  const bare = {[frontend]: {path: frontend, statementMap: {0: {start: {line: 1}}}, s: {0: 1}, branchMap: {}, b: {}}};
  fs.writeFileSync(path.join(directory, 'frontend.json'), JSON.stringify(bare));
  const solo = [parts[0]];
  assert.deepEqual(gate.measurePlan(solo, directory).totals, {lines: [1, 1], branches: [0, 0]});
  messages(() => gate.checkPlan(solo, directory), /No branches measured/);
  fs.writeFileSync(path.join(directory, 'frontend.json'), JSON.stringify({[frontend]: {path: frontend, statementMap: {}, s: {}, branchMap: {}, b: {}}}));
  messages(() => gate.measurePlan(solo, directory), /nonempty application line counters/);
}));

test('invalid plan shapes, formats and extra policy fields fail', () => plan(({directory, parts}) => {
  const values = [null, {}, [], 'not a plan', Array(17).fill(parts).flat(), [null], [{}], [{...parts[0], format: 'gcov'}],
    [{...parts[0], format: 'llvm'}], [{...parts[0], exclude: ['hidden.js']}]];
  for (const value of values) messages(() => gate.checkPlan(value, directory), /coverage plan|coverage part/);
}));

test('duplicate reports and overlapping source roots are rejected before counting', () => plan(({directory, parts}) => {
  for (const value of [[parts[0], parts[0]], [parts[0], {...parts[1], report: 'frontend.json'}],
    [parts[0], {...parts[1], source_directory: 'frontend'}]]) {
    messages(() => gate.checkPlan(value, directory), /Duplicate reports or overlapping/);
  }
  fs.mkdirSync(path.join(directory, 'backend', 'nested'));
  const nested = {...parts[1], source_directory: 'backend/nested'};
  for (const value of [[parts[1], nested], [nested, parts[1]]]) messages(() => gate.checkPlan(value, directory), /overlapping/);
  fs.symlinkSync(path.join(directory, 'frontend.json'), path.join(directory, 'alias.json'));
  messages(() => gate.checkPlan([parts[0], {...parts[1], report: 'alias.json'}], directory), /Duplicate reports/);
}));

test('plan paths are explicit repository-relative paths that cannot escape the checkout', () => plan(({directory, parts}) => {
  for (const field of ['report', 'source_directory']) {
    for (const value of [null, '', '/outside', '../outside', 'folder//file', './file', 'folder\\file', 'file\0', 'x'.repeat(500), 'a/.git/b']) {
      messages(() => gate.checkPlan([{...parts[0], [field]: value}], directory), /repository-relative/);
    }
  }
  messages(() => gate.checkPlan([{...parts[0], source_directory: 'missing'}], directory), /existing application/);
  messages(() => gate.checkPlan([{...parts[0], source_directory: 'frontend.json'}], directory), /existing application/);
  temp(outside => {
    fs.symlinkSync(outside, path.join(directory, 'escaped'), 'dir');
    messages(() => gate.checkPlan([{...parts[0], source_directory: 'escaped'}], directory), /escape the application/);
    messages(() => gate.checkPlan([{...parts[0], report: 'escaped/report.json'}], directory), /escape the application/);
  });
}));

test('the plan loader rejects duplicate JSON keys in native reports', () => plan(({directory, parts, frontend}) => {
  fs.writeFileSync(path.join(directory, 'frontend.json'), JSON.stringify({[frontend]: {}}).slice(0, -1) + ',' + JSON.stringify(frontend) + ':{}}');
  messages(() => gate.checkPlan(parts, directory), /Duplicate/);
}));

test('an accepted recipe is read as data and its verification commands are never run', () => plan(({directory, parts}) => {
  const recipe = path.join(directory, 'accepted.json');
  fs.writeFileSync(recipe, JSON.stringify({version: 2, coverage: parts, verification: [['must-never-execute-from-coverage']]}));
  const measured = gate.planMain([recipe, directory], '/');
  assert.deepEqual(gate.planMain(['accepted.json'], directory).totals, measured.totals);
  for (const value of [{version: 1, coverage: parts[0]}, [], {version: 2, coverage: []},
    {version: 2, coverage: parts, exclude: ['uncovered.js']}, {version: 2, coverage: parts, verfication: [['must-not-execute']]}]) {
    fs.writeFileSync(recipe, JSON.stringify(value));
    assert.throws(() => gate.planMain(['accepted.json'], directory), Error);
  }
  for (const argv of [[], ['a', 'b', 'c']]) messages(() => gate.planMain(argv, directory), /Usage/);
}));

test('the command line checks reports and plans and exits nonzero with a reason on any failure', () => plan(({directory, parts, frontend}) => {
  const run = (...argv) => {
    const out = []; const err = [];
    const status = gate.main(argv, {cwd: directory, stdout: text => out.push(text), stderr: text => err.push(text)});
    return {status, out: out.join(''), err: err.join('')};
  };
  const ok = run('check', 'frontend.json', 'frontend/app', 'istanbul');
  assert.deepEqual([ok.status, ok.out, ok.err], [0, 'lines: 1/1\nbranches: 2/2\n', '']);
  assert.equal(run('check', 'backend.json', 'backend', 'coveragepy').status, 0);
  const defaults = run('check', 'missing.json', 'src');
  assert.equal(defaults.status, 1); assert.match(defaults.err, /Coverage gate failed/);
  fs.writeFileSync(path.join(directory, 'llvm.json'), JSON.stringify(llvm({coveredLines: 9, filename: path.join(directory, 'src', 'main.rs')})));
  const gap = run('check', 'llvm.json', 'src');
  assert.equal(gap.status, 1); assert.match(gap.out, /lines: 9\/10/); assert.match(gap.err, /lines: 1 uncovered; require exactly 100%/);
  for (const argv of [[], ['check'], ['check', 'a', 'b', 'c', 'd'], ['other']]) {
    const usage = run(...argv); assert.equal(usage.status, 1); assert.match(usage.err, /Usage/);
  }
  fs.writeFileSync(path.join(directory, 'accepted.json'), JSON.stringify({version: 2, coverage: parts}));
  const accepted = run('plan', 'accepted.json');
  assert.equal(accepted.status, 0);
  assert.deepEqual(JSON.parse(accepted.out).totals, {lines: [5, 5], branches: [4, 4]});
  assert.equal(run('plan').status, 1);
  assert.match(run('plan', 'missing.json').err, /Coverage gate failed/);
  assert.ok(frontend);
}));

// ---- Go ----

// The profiles are real `go test -coverpkg=./... -coverprofile` output (Go 1.27.3) for the tree
// in test/fixtures/go/app. They keep Go's repeated per-package-binary rows.
const GO_FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'go');
const goProfile = name => fs.readFileSync(path.join(GO_FIXTURES, `${name}.out`), 'utf8');
const withGoTree = run => temp(directory => {
  fs.cpSync(path.join(GO_FIXTURES, 'app'), directory, {recursive: true});
  return run(directory);
});
const checkGo = (report, directory) => gate.check(report, directory, 'go', directory);

test('native Go profiles count statements and basic blocks, aggregating repeated rows as a union', () => withGoTree(directory => {
  assert.deepEqual(checkGo(goProfile('full-set'), directory), {lines: [8, 8], branches: [8, 8]});
  assert.deepEqual(checkGo(goProfile('full-atomic'), directory), {lines: [8, 8], branches: [8, 8]});
  const partial = gate.measure(goProfile('partial-count'), directory, 'go', directory);
  assert.deepEqual(partial, {lines: [8, 4], branches: [8, 4]});
  messages(() => checkGo(goProfile('partial-count'), directory), /lines: 4 uncovered/);
}));

test('a Go source subdirectory binds to its enclosing module and ignores profile rows outside it', () => withGoTree(directory => {
  const util = path.join(directory, 'util');
  assert.deepEqual(gate.check(goProfile('full-set'), util, 'go', directory), {lines: [3, 3], branches: [3, 3]});
  fs.appendFileSync(path.join(directory, 'service.go'), '// no trailing newline');
  fs.writeFileSync(path.join(directory, 'tail.go'), 'package app // trailing comment');
  assert.deepEqual(checkGo(goProfile('full-set'), directory), {lines: [8, 8], branches: [8, 8]});
}));

test('Go sources absent from the profile, or conflicting with it, fail closed', () => withGoTree(directory => {
  const full = goProfile('full-set');
  messages(() => checkGo(full.split('\n').filter(row => !row.includes('util/util.go')).join('\n'), directory), /missing from the profile.*util\.go/);
  // A declaration-only file needs no entry; a file with functions always does.
  fs.writeFileSync(path.join(directory, 'extra.go'), 'package app\n\n// func in a comment, "func" in a string\nconst c = `func`\nvar r = \'f\'\n/* func */\n');
  assert.deepEqual(checkGo(full, directory), {lines: [8, 8], branches: [8, 8]});
  fs.writeFileSync(path.join(directory, 'extra_linux.go'), '//go:build linux\n\npackage app\n\nfunc Extra() {}\n');
  messages(() => checkGo(full, directory), /extra_linux\.go/);
}));

test('malformed, stale and wrong-source Go profiles are rejected', () => withGoTree(directory => {
  const full = goProfile('full-set');
  const row = 'example.com/fixture/service.go:5.2,5.8 1 1';
  const bad = (text, pattern) => messages(() => checkGo(text, directory), pattern);
  bad('', /mode line/);
  bad('mode: bogus\n', /mode line/);
  bad(`mode: set\n${row} extra\n`, /Malformed/);
  bad(`mode: set\nexample.com/fixture/service.go:5.2,4.8 1 1\n`, /ends before it starts/);
  bad(`mode: set\nexample.com/fixture/service.go:5.9,5.8 1 1\n`, /ends before it starts/);
  bad(`mode: set\nexample.com/fixture/service.go:5.2,5.8 1 99999999999999999999\n`, /safe integers/);
  bad(`mode: set\nexample.com/fixture/service.go:5.2,500.8 1 1\n`, /beyond the source file/);
  bad(`mode: set\nexample.com/fixture/nothere.go:5.2,5.8 1 1\n`, /Unexpected Go application coverage/);
  bad(`${full}${row.replace(' 1 1', ' 2 1')}\n`, /Conflicting/);
  bad(`${full}example.com/fixture/service.go:5.4,6.1 1 1\n`, /Overlapping/);
  // Other modules and files outside the declared directory are not application coverage.
  const other = 'example.org/dep/x.go:1.1,2.1 1 1\n';
  assert.deepEqual(checkGo(full.replace(/^mode: set\n/, `mode: set\n${other}`), directory).lines, [8, 8]);
  bad(`mode: set\n${other}`, /missing from the profile/);
  assert.throws(() => gate.counters(Buffer.from(full), directory, 'go', directory), /as text/);
}));

test('Go source inventory skips tests, dependencies and nested modules and rejects invalid sources', () => withGoTree(directory => {
  for (const name of ['vendor', 'testdata', '.hidden', '_ignored', 'nested']) {
    fs.mkdirSync(path.join(directory, name));
    fs.writeFileSync(path.join(directory, name, 'x.go'), 'package x\n\nfunc X() {}\n');
  }
  fs.writeFileSync(path.join(directory, 'nested', 'go.mod'), 'module example.com/nested\n');
  fs.writeFileSync(path.join(directory, 'service_test.go'), 'package app\n\nfunc helper() {}\n');
  assert.deepEqual(checkGo(goProfile('full-set'), directory), {lines: [8, 8], branches: [8, 8]});
  const invalid = (text, pattern) => {
    fs.writeFileSync(path.join(directory, 'bad.go'), text);
    messages(() => checkGo(goProfile('full-set'), directory), pattern);
    fs.rmSync(path.join(directory, 'bad.go'));
  };
  invalid(Buffer.from([0xff, 0xfe]), /Invalid Go application source/);
  for (const text of ['package a\n/* open', 'package a\nvar s = `open', 'package a\nvar s = "open\n', "package a\nvar r = 'x", 'package a\nvar s = "\\']) {
    invalid(text, /Invalid Go application source/);
  }
  fs.symlinkSync(path.join(directory, 'service.go'), path.join(directory, 'link.go'));
  messages(() => checkGo(goProfile('full-set'), directory), /Symbolic Go application source/);
  fs.rmSync(path.join(directory, 'link.go'));
  fs.symlinkSync(path.join(directory, 'util'), path.join(directory, 'alias'));
  messages(() => checkGo(goProfile('full-set'), directory), /Symbolic Go application source/);
  fs.rmSync(path.join(directory, 'alias'));
  fs.symlinkSync(path.join(directory, 'missing-target'), path.join(directory, 'broken'));
  assert.deepEqual(checkGo(goProfile('full-set'), directory), {lines: [8, 8], branches: [8, 8]});
}));

test('Go module and source discovery fail without a usable go.mod or Go sources', () => temp(directory => {
  const src = path.join(directory, 'src');
  fs.mkdirSync(src);
  messages(() => gate.counters('mode: set\n', src, 'go', directory) , /No go\.mod/);
  fs.writeFileSync(path.join(directory, 'go.mod'), 'go 1.22\n');
  messages(() => gate.counters('mode: set\n', src, 'go', directory), /no module path/);
  fs.writeFileSync(path.join(directory, 'go.mod'), 'module "example.com/q" // quoted\n');
  messages(() => gate.counters('mode: set\n', src, 'go', directory), /No application Go sources/);
  // A directory with only declarations has no statements, so the gate reports nothing measured.
  fs.writeFileSync(path.join(src, 'types.go'), 'package q\n\ntype T int\n');
  assert.deepEqual(gate.counters('mode: set\n', src, 'go', directory), {lines: [0, 0], branches: [0, 0]});
  messages(() => gate.measure('mode: set\n', src, 'go', directory), /No lines measured/);
  messages(() => gate.check('mode: set\n', src, 'go', directory), /No lines measured/);
}));

test('the command line reads Go text profiles, labels the measurement and plans accept the go format', () => withGoTree(directory => {
  const report = path.join(directory, 'cover.out');
  fs.writeFileSync(report, goProfile('full-set'));
  let out = '';
  assert.equal(gate.main(['check', report, directory, 'go'], {cwd: directory, stdout: text => {out += text;}, stderr: () => {}}), 0);
  assert.match(out, /lines: 8\/8\nbranches: 8\/8\nnote: go lines are statements and go branches are basic blocks/);
  fs.writeFileSync(report, goProfile('partial-count'));
  let err = '';
  assert.equal(gate.main(['check', report, directory, 'go'], {cwd: directory, stdout: () => {}, stderr: text => {err += text;}}), 1);
  assert.match(err, /uncovered/);
  const parts = [{format: 'go', report: 'cover.out', source_directory: '.'}];
  assert.deepEqual(gate.measurePlan(parts, directory).totals, {lines: [8, 4], branches: [8, 4]});
  fs.writeFileSync(report, goProfile('full-set'));
  assert.deepEqual(gate.checkPlan(parts, directory).totals, {lines: [8, 8], branches: [8, 8]});
}));

test('real go test output measures a changed tree and the gate follows real execution', {skip: require('node:child_process').spawnSync('go', ['version']).status !== 0}, () => withGoTree(directory => {
  const {spawnSync} = require('node:child_process');
  fs.writeFileSync(path.join(directory, 'service_test.go'), 'package app\n\nimport "testing"\n\nfunc TestChoose(t *testing.T) {\n\tif Choose(true) != 1 {\n\t\tt.Fatal("x")\n\t}\n}\n');
  for (const name of ['util', 'idle']) {
    fs.writeFileSync(path.join(directory, name, `${name}_test.go`), `package ${name}\n\nimport "testing"\n\nfunc TestNothing(t *testing.T) {}\n`);
  }
  const run = spawnSync('go', ['test', '-covermode=set', '-coverpkg=./...', '-coverprofile=cover.out', './...'], {cwd: directory, encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  const counts = gate.measure(fs.readFileSync(path.join(directory, 'cover.out'), 'utf8'), directory, 'go', directory);
  assert.ok(counts.lines[0] > counts.lines[1] && counts.lines[1] > 0);
  messages(() => gate.check(fs.readFileSync(path.join(directory, 'cover.out'), 'utf8'), directory, 'go', directory), /uncovered/);
}));
