'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gate = require('./coverage-gate.cjs');
const declared = require('./coverage-declared.cjs');
const {validateConfig} = require('./config.cjs');
const valid = require('../examples/colombo.json');

const pkg = value => JSON.stringify(value);
const cause = (text, name, fragment) => {
  assert.throws(() => declared.parse(text), error => {
    assert.ok(error instanceof declared.DeclaredError, `${name}: ${error.message}`);
    assert.ok(error.message.startsWith(`Declared coverage (cause: \`${error.declared_cause}\`): `), error.message);
    assert.ok(error.message.includes(fragment), `${name}: ${error.message}`);
    assert.match(error.message, /\n\n1\. /);
    assert.ok(!/[{}]/.test(error.message.replace(/\{[^}]*\}/g, '')), 'no unfilled placeholder');
    return true;
  }, name);
  try {declared.parse(text);} catch (error) {return error.declared_cause;}
};

test('declarations are read from jest, c8 and nyc, and equal values across tools merge', () => {
  const jest = declared.parse(pkg({jest: {coverageThreshold: {global: {lines: 80, branches: 70.5, functions: 60, statements: 50}}}}));
  assert.deepEqual(jest, {tools: ['jest'], per_file: false, thresholds: {lines: 80, branches: 70.5, functions: 60, statements: 50}});
  assert.deepEqual(declared.parse(pkg({c8: {'check-coverage': true, lines: 90, 'per-file': true}})),
    {tools: ['c8'], per_file: true, thresholds: {lines: 90}});
  assert.deepEqual(declared.parse(pkg({nyc: {checkCoverage: true, perFile: false, branches: 0}})),
    {tools: ['nyc'], per_file: false, thresholds: {branches: 0}});
  assert.deepEqual(declared.parse(pkg({jest: {coverageThreshold: {global: {lines: 80}}}, nyc: {'check-coverage': true, lines: 80, branches: 10}})),
    {tools: ['jest', 'nyc'], per_file: false, thresholds: {lines: 80, branches: 10}});
  // Unrelated keys of the tools and of package.json are ignored.
  assert.deepEqual(declared.parse(pkg({name: 'x', jest: {preset: 'ts-jest', coverageThreshold: {global: {lines: 1}}}, c8: {reporter: ['text']}})).tools, ['jest']);
});

test('every unreadable shape fails closed with a stable cause class that names the problem', () => {
  const jest = global => pkg({jest: {coverageThreshold: {global}}});
  const rows = [
    ['not JSON', '{"jest": ', 'declared_unsupported', 'not valid JSON'],
    ['an array', '[]', 'declared_unsupported', 'not a JSON object'],
    ['a null', 'null', 'declared_unsupported', 'not a JSON object'],
    ['duplicate key', '{"jest":{"coverageThreshold":{"global":{"lines":50,"lines":99}}}}', 'declared_conflict', 'repeats a JSON key'],
    ['duplicate top key', '{"c8":{"lines":1},"c8":{"lines":2}}', 'declared_conflict', 'repeats a JSON key'],
    ['string threshold', jest({lines: '80'}), 'declared_unsupported', 'jest.coverageThreshold.global.lines must be a plain decimal number'],
    ['negative threshold', jest({lines: -10}), 'declared_unsupported', 'negative'],
    ['over 100', jest({lines: 101}), 'declared_unsupported', 'out-of-range'],
    ['infinite', '{"jest":{"coverageThreshold":{"global":{"lines":1e999}}}}', 'declared_unsupported', 'must be a plain decimal'],
    ['exponent', '{"jest":{"coverageThreshold":{"global":{"lines":1e-7}}}}', 'declared_unsupported', 'must be a plain decimal'],
    ['null threshold', jest({lines: null}), 'declared_unsupported', 'must be a plain decimal'],
    ['unknown metric', jest({line: 80}), 'declared_unsupported', 'is not a coverage metric'],
    ['empty global', jest({}), 'declared_unsupported', 'at least one threshold'],
    ['global not an object', jest(80), 'declared_unsupported', 'at least one threshold'],
    ['path entry', pkg({jest: {coverageThreshold: {global: {lines: 80}, './src/a.js': {lines: 100}}}}), 'declared_unsupported', 'path and glob entries are not read'],
    ['glob only', pkg({jest: {coverageThreshold: {'./src/**/*.js': {lines: 100}}}}), 'declared_unsupported', 'path and glob entries are not read'],
    ['threshold not an object', pkg({jest: {coverageThreshold: 80}}), 'declared_unsupported', 'path and glob entries are not read'],
    ['jest not an object', pkg({jest: 'x'}), 'declared_unsupported', '"jest" in package.json must be an object'],
    ['c8 not an object', pkg({c8: 'x'}), 'declared_unsupported', '"c8" in package.json must be an object'],
    ['c8 without check-coverage', pkg({c8: {lines: 80}}), 'declared_unsupported', 'without "check-coverage": true'],
    ['nyc check false', pkg({nyc: {'check-coverage': false, lines: 80}}), 'declared_unsupported', 'without "check-coverage": true'],
    ['check without thresholds', pkg({nyc: {'check-coverage': true}}), 'declared_unsupported', 'implicit defaults are not read'],
    ['flag not boolean', pkg({c8: {'check-coverage': 'yes', lines: 80}}), 'declared_unsupported', 'c8.check-coverage must be true or false'],
    ['both spellings', pkg({c8: {'check-coverage': true, checkCoverage: true, lines: 80}}), 'declared_conflict', 'sets both check-coverage and checkCoverage'],
    ['tools disagree on a value', pkg({jest: {coverageThreshold: {global: {lines: 90}}}, c8: {'check-coverage': true, lines: 10}}), 'declared_conflict', 'lines is declared with different values (jest 90, c8 10)'],
    ['tools disagree on per-file', pkg({jest: {coverageThreshold: {global: {lines: 90}}}, c8: {'check-coverage': true, lines: 90, 'per-file': true}}), 'declared_conflict', 'jest per-file false, c8 per-file true disagree'],
    ['second weaker declaration', pkg({c8: {'check-coverage': true, lines: 99}, nyc: {'check-coverage': true, lines: 1}}), 'declared_conflict', 'lines is declared with different values'],
    ['nothing declared', pkg({name: 'x'}), 'declared_missing', 'declares no coverage threshold'],
    ['empty tool blocks', pkg({jest: {}, c8: {reporter: []}}), 'declared_missing', 'declares no coverage threshold'],
    ['only functions and statements', pkg({c8: {'check-coverage': true, functions: 90, statements: 90}}), 'declared_missing', 'only functions or statements'],
    ['vitest', pkg({devDependencies: {vitest: '^1.0.0'}}), 'declared_unsupported', 'Vitest'],
    ['vitest as a string field', pkg({devDependencies: 'vitest'}), 'declared_missing', 'declares no coverage threshold'],
  ];
  const seen = new Set();
  for (const [name, text, expected, fragment] of rows) {
    assert.equal(cause(text, name, fragment), expected, name);
    seen.add(expected);
  }
  assert.deepEqual([...seen].sort(), ['declared_conflict', 'declared_missing', 'declared_unsupported']);
  assert.deepEqual(Object.keys(declared.STEPS).sort(), ['declared_below_threshold', 'declared_conflict', 'declared_missing', 'declared_unsupported']);
  assert.throws(() => declared.threshold('x', NaN), /plain decimal/);
});

test('thresholds are compared with exact integer arithmetic and shown floored', () => {
  const rows = [
    [[100, 80], 80, true], [[100, 79], 80, false], [[3, 2], 66.66, true], [[3, 2], 66.67, false], [[3, 2], 66.666666666666666, false],
    [[1000, 875], 87.5, true], [[1000, 874], 87.5, false], [[0, 0], 100, true], [[7, 7], 100, true], [[7, 6], 100, false],
    [[10 ** 15, 10 ** 15 - 1], 99.99999999999, true], [[10 ** 15, 10 ** 15 - 1], 100, false], [[5, 0], 0, true], [[3, 1], 0.1, true],
  ];
  for (const [pair, threshold, expected] of rows) assert.equal(declared.meets(pair, threshold), expected, `${pair} ${threshold}`);
  assert.equal(declared.percent([3, 2]), '66.66%');
  assert.equal(declared.percent([100000, 79999]), '79.99%');
  assert.equal(declared.percent([4, 4]), '100.00%');
  assert.equal(declared.percent([0, 0]), 'n/a');
});

const detail = entries => new Map(entries.map(([file, lines, branches]) => [file, {lines: new Map(lines), branches: branches.map(covered => ({from: 1, to: 1, covered}))}]));

test('enforcement reports each declared metric, skips the undeclared and names every shortfall', () => {
  const ok = {tools: ['jest'], per_file: false, thresholds: {lines: 50, functions: 90}};
  assert.deepEqual(declared.enforce({totals: {lines: [4, 2], branches: [0, 0]}, declared: ok, directory: '/w'}),
    ['declared lines: 50.00% (2/4), minimum 50%', 'declared but not enforced (Clouseau measures lines and branches): functions 90%']);
  const both = {tools: ['c8'], per_file: false, thresholds: {lines: 80, branches: 60, statements: 1}};
  assert.deepEqual(declared.enforce({totals: {lines: [10, 8], branches: [0, 0]}, declared: both, directory: '/w'}).slice(0, 2),
    ['declared lines: 80.00% (8/10), minimum 80%', 'declared branches: n/a (0/0), minimum 60%']);
  assert.throws(() => declared.enforce({totals: {lines: [10, 7], branches: [10, 5]}, declared: both, directory: '/w'}), error => {
    assert.equal(error.declared_cause, 'declared_below_threshold');
    assert.ok(error.message.includes('lines: 70.00% (7/10) is below the declared minimum 80%; branches: 50.00% (5/10) is below the declared minimum 60%'), error.message);
    assert.match(error.message, /1\. Add tests until each metric named above/);
    return true;
  });
  // Undeclared branches are never enforced.
  assert.doesNotThrow(() => declared.enforce({totals: {lines: [10, 10], branches: [10, 0]}, declared: {...ok, thresholds: {lines: 100}}, directory: '/w'}));
});

test('per-file minimums check every file and cap the listed shortfalls', () => {
  const one = {tools: ['nyc'], per_file: true, thresholds: {lines: 50, branches: 50}};
  const files = detail([['/w/src/b.js', [[1, true], [2, false], [3, false]], [true, false]], ['/w/src/a.js', [[1, true], [2, true]], [true, true]]]);
  assert.throws(() => declared.enforce({totals: {}, detail: files, declared: one, directory: '/w'}), error => {
    assert.match(error.message, /^Declared coverage \(cause: `declared_below_threshold`\): src\/b\.js: lines 33\.33% \(1\/3\) is below the declared minimum 50%\n\n1\. /);
    assert.ok(!error.message.includes('src/a.js'));
    return true;
  });
  const passing = detail([['/w/src/a.js', [[1, true]], [true]]]);
  assert.deepEqual(declared.enforce({totals: {}, detail: passing, declared: one, directory: '/w'}),
    ['declared per file: 1 files checked against lines 50%, branches 50%']);
  const many = detail(Array.from({length: 23}, (_, index) => [`/w/f${String(index).padStart(2, '0')}.js`, [[1, false]], []]));
  assert.throws(() => declared.enforce({totals: {}, detail: many, declared: {...one, thresholds: {lines: 100}}, directory: '/w'}),
    error => error.message.includes('f19.js') && !error.message.includes('f20.js') && error.message.includes('; and 3 more'));
  for (const format of ['istanbul', 'lcov', 'coveragepy']) assert.doesNotThrow(() => declared.requirePerFile(one, format));
  for (const format of ['llvm', 'go']) {
    assert.throws(() => declared.requirePerFile(one, format), new RegExp(`per-file minimums need per-file line and branch counts, which the ${format} coverage format`));
    assert.doesNotThrow(() => declared.requirePerFile({...one, per_file: false}, format));
  }
});

const sh = (cwd, ...argv) => cp.execFileSync(argv[0], argv.slice(1), {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

// A git repository with branch `base` holding `base` files and HEAD holding `head` files (name -> text, null removes).
function repository(base, head, run) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-declared-')));
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
    sh(directory, 'git', 'branch', 'base');
    apply(head);
    return run(directory);
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
}

test('the declaration is read from the base revision, never from the head', () => repository(
  {'package.json': pkg({jest: {coverageThreshold: {global: {lines: 90}}}})},
  {'package.json': pkg({jest: {coverageThreshold: {global: {lines: 1}}}, c8: {'check-coverage': true, lines: 1}})}, directory => {
    assert.deepEqual(declared.declaration(directory, 'base').thresholds, {lines: 90});
    assert.deepEqual(declared.declaration(directory, 'HEAD').tools, ['jest', 'c8']);
    // A base without the file, or a revision the checkout lacks, is a missing declaration, never a default.
    for (const ref of ['0'.repeat(40), 'no-such-branch']) assert.throws(() => declared.readBase(directory, ref), /declared_missing.*cannot be read at the base revision/s);
    for (const ref of ['', null, 'a..b', '--help', 'a b']) assert.throws(() => declared.readBase(directory, ref), /requires a plain base revision/);
    assert.equal(declared.readBase(directory, 'base', (command, argv) => `${command} ${argv.join(' ')}`), 'git cat-file blob base:package.json');
  }));

test('a base without package.json is a missing declaration', () => repository({'README.md': 'x\n'}, {'package.json': pkg({jest: {coverageThreshold: {global: {lines: 1}}}})}, directory => {
  assert.throws(() => declared.declaration(directory, 'base'), error => error.declared_cause === 'declared_missing');
}));

// ---- the gate over real adapters ----

const istanbulFile = (source, hits) => ({path: source,
  statementMap: {0: {start: {line: 1, column: 0}, end: {line: 1, column: 9}}, 1: {start: {line: 2, column: 0}, end: {line: 2, column: 9}}},
  s: {0: 1, 1: hits}, branchMap: {0: {loc: {start: {line: 2}}, locations: [{start: {line: 2}}, {start: {line: 2}}]}}, b: {0: [1, hits]}});
const SOURCE = 'const a = 1;\nconst b = a ? 1 : 2;\n';
const THRESHOLDS = lines => pkg({jest: {coverageThreshold: {global: {lines, branches: lines}}}});

test('the single-artifact gate enforces the base declaration against measured totals', () => repository(
  {'src/a.ts': SOURCE, 'src/b.ts': SOURCE, 'package.json': THRESHOLDS(75)}, {'package.json': THRESHOLDS(1)}, directory => {
    const a = path.join(directory, 'src/a.ts'); const b = path.join(directory, 'src/b.ts');
    const report = (aHits, bHits) => ({[a]: istanbulFile(a, aHits), [b]: istanbulFile(b, bHits)});
    const check = (value, format = 'istanbul') => gate.declaredCheck(value, path.join(directory, 'src'), format, directory, 'base');
    // 3/4 lines and 3/4 branches is exactly 75%.
    assert.deepEqual(check(report(1, 0)), ['declared lines: 75.00% (3/4), minimum 75%', 'declared branches: 75.00% (3/4), minimum 75%']);
    assert.throws(() => check({[a]: istanbulFile(a, 0), [b]: istanbulFile(b, 0)}), /lines: 50\.00% \(2\/4\) is below the declared minimum 75%; branches: 50\.00% \(2\/4\) is below/);
    // The head lowered its own threshold to 1 and is still held to the base's 75.
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).jest.coverageThreshold.global.lines, 1);
  }));

test('per-file declarations use per-file counts and reject formats without them', () => repository(
  {'src/a.ts': SOURCE, 'src/b.ts': SOURCE, 'package.json': pkg({c8: {'check-coverage': true, 'per-file': true, lines: 100}})}, {'README.md': 'x\n'}, directory => {
    const a = path.join(directory, 'src/a.ts'); const b = path.join(directory, 'src/b.ts');
    const check = (value, format = 'istanbul') => gate.declaredCheck(value, path.join(directory, 'src'), format, directory, 'base');
    assert.deepEqual(check({[a]: istanbulFile(a, 1), [b]: istanbulFile(b, 1)}), ['declared per file: 2 files checked against lines 100%']);
    assert.throws(() => check({[a]: istanbulFile(a, 1), [b]: istanbulFile(b, 0)}), /src\/b\.ts: lines 50\.00% \(1\/2\) is below the declared minimum 100%/);
    // A per-file minimum is not met by a good average.
    assert.throws(() => gate.declaredCheck({type: 'llvm.coverage.json.export'}, directory, 'llvm', directory, 'base'), /llvm coverage format/);
    assert.throws(() => gate.declaredCheck('mode: set\n', directory, 'go', directory, 'base'), /go coverage format/);
  }));

test('declared plans measure every part and reject per-file minimums on Go parts', () => repository(
  {'src/a.js': SOURCE, 'package.json': THRESHOLDS(100)}, {'README.md': 'x\n'}, directory => {
    const source = path.join(directory, 'src/a.js');
    fs.writeFileSync(path.join(directory, 'cov.json'), JSON.stringify({[source]: istanbulFile(source, 1)}));
    const parts = [{format: 'istanbul', report: 'cov.json', source_directory: 'src'}];
    assert.deepEqual(gate.declaredPlan(parts, directory, 'base'), ['declared lines: 100.00% (2/2), minimum 100%', 'declared branches: 100.00% (2/2), minimum 100%']);
    fs.writeFileSync(path.join(directory, 'cov.json'), JSON.stringify({[source]: istanbulFile(source, 0)}));
    assert.throws(() => gate.declaredPlan(parts, directory, 'base'), /declared_below_threshold/);
    fs.writeFileSync(path.join(directory, 'package.json'), pkg({c8: {'check-coverage': true, 'per-file': true, lines: 1}}));
    sh(directory, 'git', 'commit', '-q', '-am', 'per file');
    sh(directory, 'git', 'branch', '-f', 'base', 'HEAD');
    assert.deepEqual(gate.declaredPlan(parts, directory, 'base').length, 1);
    fs.mkdirSync(path.join(directory, 'g'));
    fs.writeFileSync(path.join(directory, 'g/go.mod'), 'module example.test/m\n\ngo 1.21\n');
    fs.writeFileSync(path.join(directory, 'g/m.go'), 'package m\n\nfunc F() {\n\t_ = 1\n}\n');
    fs.writeFileSync(path.join(directory, 'g/cover.out'), 'mode: set\nexample.test/m/m.go:3.10,5.2 1 1\n');
    assert.throws(() => gate.declaredPlan([{format: 'go', report: 'g/cover.out', source_directory: 'g'}], directory, 'base'), /go coverage format/);
  }));

test('the command line exposes declared-check and declared-plan with fail-closed notices', () => repository(
  {'src/a.js': SOURCE, 'package.json': THRESHOLDS(100), '.github/clouseau.json': JSON.stringify({...valid, coverage: {mode: 'declared'}})},
  {'README.md': 'x\n'}, directory => {
    const source = path.join(directory, 'src/a.js');
    const run = (...argv) => {
      let out = ''; let err = '';
      const status = gate.main(argv, {cwd: directory, stdout: text => {out += text;}, stderr: text => {err += text;}});
      return {status, out, err};
    };
    const write = (name, value) => fs.writeFileSync(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
    write('cov.json', {[source]: istanbulFile(source, 1)});
    write('recipe.json', {version: 2, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md', verification: [['true']],
      coverage: [{format: 'istanbul', report: 'cov.json', source_directory: 'src'}]});
    assert.equal(run('mode', '.github/clouseau.json').out, 'declared\n');
    const passed = run('declared-check', 'cov.json', 'src', 'istanbul', 'base');
    assert.equal(passed.status, 0, passed.err);
    assert.equal(passed.out, 'declared lines: 100.00% (2/2), minimum 100%\ndeclared branches: 100.00% (2/2), minimum 100%\n');
    assert.equal(run('declared-plan', 'recipe.json', '.', 'base').out, passed.out);
    write('cov.json', {[source]: istanbulFile(source, 0)});
    const failed = run('declared-check', 'cov.json', 'src', 'istanbul', 'base');
    assert.equal(failed.status, 1);
    assert.match(failed.err, /^Coverage gate failed: Declared coverage \(cause: `declared_below_threshold`\): lines: 50\.00% \(1\/2\)/);
    assert.equal(run('declared-plan', 'recipe.json', '.', 'base').status, 1);
    const missing = run('declared-check', 'cov.json', 'src', 'istanbul', '0'.repeat(40));
    assert.match(missing.err, /cause: `declared_missing`/);
    assert.match(run('declared-check', 'cov.json').err, /Usage/);
  }));

// ---- the approval hold ----

test('the declared outcome ignores unrelated package.json edits and differs for any change to the declaration', () => {
  const base = pkg({name: 'x', version: '1.0.0', dependencies: {a: '1'}, jest: {coverageThreshold: {global: {lines: 80, branches: 70}}}});
  const same = pkg({name: 'y', version: '2.0.0', scripts: {test: 'jest'}, jest: {coverageThreshold: {global: {branches: 70, lines: 80}}}});
  assert.equal(declared.differs(base, same), false);
  for (const head of [
    pkg({jest: {coverageThreshold: {global: {lines: 79, branches: 70}}}}), pkg({jest: {coverageThreshold: {global: {lines: 80}}}}),
    pkg({name: 'x'}), pkg({jest: {coverageThreshold: {global: {lines: 80, branches: 70}}}, c8: {'check-coverage': true, lines: 1}}),
    pkg({jest: {coverageThreshold: {global: {lines: 80, branches: 70, functions: 1}}}}), '{"jest": ', null]) {
    assert.equal(declared.differs(base, head), true, String(head));
  }
  // Raising is a change too; so is a file that stops being readable.
  assert.equal(declared.differs(base, pkg({jest: {coverageThreshold: {global: {lines: 90, branches: 70}}}})), true);
  // An absent file reads like one with no declaration, so unrelated additions are not held and an unreadable base is stable.
  assert.equal(declared.differs(null, pkg({name: 'new'})), false);
  assert.equal(declared.differs('{"a":', '{"b":'), false);
  assert.equal(declared.differs(null, base), true);
  assert.equal(declared.differs(base, null), true);
});

const SHA = 'a'.repeat(40); const BASE = 'b'.repeat(40);
function world(texts, fail) {
  return {rest: {repos: {getContent: async ({ref, path: file}) => {
    assert.equal(file, 'package.json');
    if (fail) throw fail;
    const text = texts[ref];
    if (text === undefined) throw Object.assign(new Error('Not Found'), {status: 404});
    return {data: {encoding: 'base64', size: text.length, content: Buffer.from(text).toString('base64')}};
  }}}};
}
const pr = (repo = {owner: {login: 'o'}, name: 'r'}) => ({head: {sha: SHA, repo}, base: {sha: BASE}});
const protectedFor = (texts, files, {config = {coverage: {mode: 'declared'}}, fail, request = pr()} = {}) =>
  declared.protect({github: world(texts, fail), repo: {owner: 'o', repo: 'r'}, pr: request, files, config});

test('a changed declaration is held at the protected-control boundary, only in declared mode', async () => {
  const file = {filename: 'package.json', status: 'modified'};
  const lowered = {[BASE]: THRESHOLDS(90), [SHA]: THRESHOLDS(10)};
  const held = await protectedFor(lowered, [file]);
  assert.deepEqual([...held.protect], ['package.json']);
  assert.deepEqual(held.notices, ['package.json is a protected-control hold: the declared coverage thresholds changed.']);
  // Unrelated edits and untouched files never hold.
  const unrelated = await protectedFor({[BASE]: THRESHOLDS(90), [SHA]: pkg({name: 'z', jest: {coverageThreshold: {global: {lines: 90, branches: 90}}}})}, [file]);
  assert.deepEqual([[...unrelated.protect], unrelated.notices], [[], []]);
  assert.deepEqual([...(await protectedFor(lowered, [{filename: 'src/a.js', status: 'modified'}])).protect], []);
  // Other modes read nothing: the fetch below would throw.
  for (const config of [{}, {coverage: {mode: 'exact'}}, {coverage: {mode: 'changed_lines'}}]) {
    assert.deepEqual([...(await protectedFor(lowered, [file], {config, fail: new Error('must not be read')})).protect], []);
  }
  // Added, deleted and renamed files compare against an absent side.
  assert.deepEqual([...(await protectedFor({[SHA]: THRESHOLDS(10)}, [{filename: 'package.json', status: 'added'}])).protect], ['package.json']);
  assert.deepEqual([...(await protectedFor({[BASE]: THRESHOLDS(10)}, [{filename: 'package.json', status: 'removed'}])).protect], ['package.json']);
  assert.deepEqual([...(await protectedFor({[BASE]: THRESHOLDS(10)}, [{filename: 'other.json', previous_filename: 'package.json', status: 'renamed'}])).protect], ['package.json']);
  // Unreadable evidence holds; a failure that is not about availability propagates.
  const unreadable = await protectedFor(lowered, [file], {fail: Object.assign(new Error('x'), {unavailable: true})});
  assert.match(unreadable.notices[0], /the base or head file is unavailable as complete text/);
  const forkless = await protectedFor(lowered, [file], {request: pr(null)});
  assert.match(forkless.notices[0], /the head repository is unavailable/);
  assert.match((await protectedFor(lowered, [file], {request: pr({owner: {login: 'o'}})})).notices[0], /the head repository is unavailable/);
  await assert.rejects(protectedFor(lowered, [file], {fail: Object.assign(new Error('boom'), {status: 500})}), /boom/);
});

test('the policy treats a held declaration as a protected control and leaves other package.json edits alone', async () => {
  const {createPolicy} = require('./policy.cjs');
  const config = {...require('../test/fixtures/config.json'), coverage: {mode: 'declared'}};
  const policy = createPolicy(config);
  const file = {filename: 'package.json', status: 'modified', patch: '@@', sha: 'f'.repeat(40), changes: 1};
  const small = {changed_files: 1, additions: 1, deletions: 0};
  assert.equal(policy.scopeReason([file], small), null);
  assert.ok(policy.scopeReason([file], small, new Set(), new Set(['package.json'])));
  assert.ok(policy.scopeReason([{...file, filename: 'x.json', previous_filename: 'package.json', status: 'renamed'}], small, new Set(), new Set(['package.json'])));
  assert.equal(policy.scopeReason([{...file, filename: 'src/x.js'}], small, new Set(), new Set(['package.json'])), null);
  const request = {head: {sha: SHA, repo: {owner: {login: 'o'}, name: 'r'}}, base: {sha: BASE}};
  const github = world({[BASE]: THRESHOLDS(90), [SHA]: THRESHOLDS(10)});
  const result = await policy.managedExemptions(github, {owner: 'o', repo: 'r'}, request, [file]);
  assert.deepEqual([[...result.exempt], [...result.protect], result.notices.length], [[], ['package.json'], 1]);
  const exact = await createPolicy(require('../test/fixtures/config.json')).managedExemptions(github, {owner: 'o', repo: 'r'}, request, [file]);
  assert.deepEqual([[...exact.protect], exact.notices], [[], []]);
});

test('the configuration accepts declared and rejects anything else, and the wording names the requirement', () => {
  const changed = require('./coverage-changed.cjs');
  assert.deepEqual(validateConfig({...valid, coverage: {mode: 'declared'}}).coverage, {mode: 'declared'});
  assert.throws(() => validateConfig({...valid, coverage: {mode: 'Declared'}}), /"exact", "changed_lines" or "declared"/);
  assert.equal(changed.modeOf({coverage: {mode: 'declared'}}), 'declared');
  const wording = changed.requirement({coverage: {mode: 'declared'}});
  assert.equal(wording.waiting, 'coverage at or above the minimums declared in package.json');
  assert.equal(wording.full, 'coverage at or above the minimums declared in package.json at the base revision');
  assert.equal(wording.brief, 'declared coverage');
  assert.equal(changed.requirement({}).full, 'exact 100% line and branch coverage');
});
