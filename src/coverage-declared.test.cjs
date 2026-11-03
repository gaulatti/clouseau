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
const PART1 = 'coverage part 1 (istanbul, source src, declaration package.json)';
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
    const parts = [{format: 'istanbul', report: 'cov.json', source_directory: 'src', package_directory: '.'}];
    assert.deepEqual(gate.declaredPlan(parts, directory, 'base'), [`${PART1}: declared lines: 100.00% (2/2), minimum 100%`, `${PART1}: declared branches: 100.00% (2/2), minimum 100%`]);
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
    assert.throws(() => gate.declaredPlan([{format: 'go', report: 'g/cover.out', source_directory: 'g', package_directory: '.'}], directory, 'base'), /go coverage format/);
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
      coverage: [{format: 'istanbul', report: 'cov.json', source_directory: 'src', package_directory: '.'}]});
    assert.equal(run('mode', '.github/clouseau.json').out, 'declared\n');
    const passed = run('declared-check', 'cov.json', 'src', 'istanbul', 'base');
    assert.equal(passed.status, 0, passed.err);
    assert.equal(passed.out, 'declared lines: 100.00% (2/2), minimum 100%\ndeclared branches: 100.00% (2/2), minimum 100%\n');
    assert.equal(run('declared-plan', 'recipe.json', '.', 'base').out, passed.out.split('\n').filter(Boolean).map(line => `${PART1}: ${line}\n`).join(''));
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

// ---- monorepo: each part is held to the package.json of its own directory ----

const util = require('./coverage-util.cjs');
const {coverageParts} = require('./coverage-plan.cjs');
const C8 = (lines, extra = {}) => pkg({name: 'p', c8: {'check-coverage': true, lines, branches: lines, ...extra}});
const MONO = {'backend/src/a.ts': SOURCE, 'frontend/src/b.ts': SOURCE, 'package.json': C8(1), 'backend/package.json': C8(100), 'frontend/package.json': pkg({jest: {coverageThreshold: {global: {lines: 50, branches: 50}}}})};
const BACKEND = 'coverage part 1 (istanbul, source backend/src, declaration backend/package.json)';
const FRONTEND = 'coverage part 2 (istanbul, source frontend/src, declaration frontend/package.json)';
const PARTS = [
  {format: 'istanbul', report: 'backend/cov.json', source_directory: 'backend/src', package_directory: 'backend'},
  {format: 'istanbul', report: 'frontend/cov.json', source_directory: 'frontend/src', package_directory: 'frontend'}];
const without = (files, ...names) => Object.fromEntries(Object.entries(files).filter(([name]) => !names.includes(name)));
const monorepo = (base, run, head = {'README.md': 'x\n'}) => repository(base, head, directory => {
  const measure = (backendHits, frontendHits) => {
    for (const [name, hits] of [['backend', backendHits], ['frontend', frontendHits]]) {
      const source = path.join(directory, name, 'src', name === 'backend' ? 'a.ts' : 'b.ts');
      fs.writeFileSync(path.join(directory, name, 'cov.json'), JSON.stringify({[source]: istanbulFile(source, hits)}));
    }
  };
  return run(directory, measure);
});
const plan = (directory, parts = PARTS, ref = 'base') => gate.declaredPlan(parts, directory, ref);
const failure = (directory, parts, ref) => {
  try {plan(directory, parts, ref);} catch (error) {return error;}
  assert.fail('expected the plan to fail');
};

test('every part is enforced against ITS OWN package.json, never the root or another part', () => monorepo(MONO, (directory, measure) => {
  measure(1, 0);
  // Backend 100% meets its 100; frontend 50% meets its 50; the root's 1 and the others' minimums are not mixed.
  assert.deepEqual(plan(directory), [`${BACKEND}: declared lines: 100.00% (2/2), minimum 100%`, `${BACKEND}: declared branches: 100.00% (2/2), minimum 100%`,
    `${FRONTEND}: declared lines: 50.00% (1/2), minimum 50%`, `${FRONTEND}: declared branches: 50.00% (1/2), minimum 50%`]);
  // Backend below ITS 100 fails although it would pass the frontend's 50 and the root's 1; the frontend part is not blamed.
  measure(0, 1);
  const one = failure(directory);
  assert.equal(one.declared_cause, 'declared_below_threshold');
  assert.ok(one.message.startsWith(`Declared coverage (cause: \`declared_below_threshold\`) for ${BACKEND}: lines: 50.00% (1/2) is below the declared minimum 100%`), one.message);
  assert.ok(!one.message.includes('coverage part 2'), one.message);
  // Both parts failing are reported separately, each under its own class and name.
  fs.writeFileSync(path.join(directory, 'frontend/package.json'), pkg({name: 'f'}));
  sh(directory, 'git', 'commit', '-qam', 'frontend declares nothing');
  sh(directory, 'git', 'branch', '-f', 'base', 'HEAD');
  const both = failure(directory);
  assert.deepEqual(both.declared_parts, [{part: BACKEND, cause: 'declared_below_threshold'}, {part: FRONTEND, cause: 'declared_missing'}]);
  assert.ok(both.message.includes(`for ${BACKEND}: lines`) && both.message.includes(`for ${FRONTEND}: package.json declares no coverage threshold`), both.message);
}));

test('a part without a readable declaration in its own directory fails closed naming the part, never falling back', () => monorepo(MONO, (directory, measure) => {
  measure(1, 1);
  const cases = [
    // The root declares 1 and would pass anything; the part directory has none at the base revision.
    ['no package.json in the part directory', without(MONO, 'backend/package.json'), PARTS, 'declared_missing', `for ${BACKEND}: backend/package.json cannot be read at the base revision`],
    ['no declaration in the part package.json', {...MONO, 'backend/package.json': pkg({name: 'b'})}, PARTS, 'declared_missing', `for ${BACKEND}: package.json declares no coverage threshold`],
    ['an unparseable declaration', {...MONO, 'frontend/package.json': '{"c8":'}, PARTS, 'declared_unsupported', `for ${FRONTEND}: package.json is not valid JSON`],
    ['a repeated key', {...MONO, 'frontend/package.json': '{"c8":{"lines":1},"c8":{"lines":2}}'}, PARTS, 'declared_conflict', `for ${FRONTEND}: package.json repeats a JSON key`],
    // Without package_directory the source directory itself is the package directory: nothing is inferred from a parent.
    ['the source directory is not a package directory', MONO, [{...PARTS[0], package_directory: undefined}, PARTS[1]].map(part => JSON.parse(JSON.stringify(part))), 'declared_missing',
      'for coverage part 1 (istanbul, source backend/src, declaration backend/src/package.json): backend/src/package.json cannot be read'],
  ];
  for (const [name, files, parts, expected, fragment] of cases) {
    // The base revision is rebuilt from `files`; the head only adds a harmless README.
    const result = repository(files, {'README.md': 'x\n'}, other => {
      for (const part of ['backend', 'frontend']) {
        const source = path.join(other, part, 'src', part === 'backend' ? 'a.ts' : 'b.ts');
        fs.writeFileSync(path.join(other, part, 'cov.json'), JSON.stringify({[source]: istanbulFile(source, 1)}));
      }
      return failure(other, parts);
    });
    assert.equal(result.declared_cause, expected, name);
    assert.ok(result.message.includes(fragment), `${name}: ${result.message}`);
    assert.match(result.message, /\n\n1\. /);
  }
}));

test('a pull request cannot add, replace or move a declaration to weaken its part', () => {
  const weak = pkg({jest: {coverageThreshold: {global: {lines: 1, branches: 1}}}});
  // Added in the pull request: the base has none, so the part fails closed.
  const added = repository(without(MONO, 'backend/package.json'), {'backend/package.json': weak}, directory => {
    const source = path.join(directory, 'backend/src/a.ts');
    fs.writeFileSync(path.join(directory, 'backend/cov.json'), JSON.stringify({[source]: istanbulFile(source, 0)}));
    const one = [PARTS[0]];
    assert.equal(declared.declaration(directory, 'HEAD', undefined, 'backend').thresholds.lines, 1);
    return failure(directory, one);
  });
  assert.equal(added.declared_cause, 'declared_missing');
  // Replaced in the pull request: the base declaration still decides.
  repository(MONO, {'backend/package.json': weak}, directory => {
    const source = path.join(directory, 'backend/src/a.ts');
    fs.writeFileSync(path.join(directory, 'backend/cov.json'), JSON.stringify({[source]: istanbulFile(source, 0)}));
    assert.match(failure(directory, [PARTS[0]]).message, /below the declared minimum 100%/);
  });
  // Moved: the recipe still names the base directory, which no longer exists, so the plan stops with a plain error.
  repository(MONO, {'server/src/a.ts': SOURCE, 'backend/src/a.ts': null, 'backend/package.json': null}, directory => {
    fs.rmSync(path.join(directory, 'backend'), {recursive: true, force: true});
    assert.throws(() => plan(directory, [PARTS[0]]), error => !(error instanceof declared.DeclaredError) && /existing application source directory/.test(error.message));
  });
});

test('package directories that are symbolic links or escape the checkout never supply a declaration', () => {
  // A symbolic-link package.json is its link text, not JSON.
  repository({'a/src/a.ts': SOURCE, 'a/real.json': C8(1), 'x/package.json': C8(1)}, {'README.md': 'x\n'}, directory => {
    fs.symlinkSync('../x/package.json', path.join(directory, 'a/package.json'));
    sh(directory, 'git', 'add', '-A');
    sh(directory, 'git', 'commit', '-qm', 'link');
    sh(directory, 'git', 'branch', '-f', 'base', 'HEAD');
    assert.throws(() => declared.declaration(directory, 'base', undefined, 'a'), error => error.declared_cause === 'declared_unsupported');
  });
  // A directory that is a symbolic link is not traversed by the tree lookup.
  repository({'real/package.json': C8(1), 'real/src/a.ts': SOURCE}, {'README.md': 'x\n'}, directory => {
    fs.symlinkSync('real', path.join(directory, 'linked'));
    sh(directory, 'git', 'add', '-A');
    sh(directory, 'git', 'commit', '-qm', 'link');
    sh(directory, 'git', 'branch', '-f', 'base', 'HEAD');
    assert.throws(() => declared.declaration(directory, 'base', undefined, 'linked'), error => error.declared_cause === 'declared_missing');
    // The part's source may not leave the checkout through a link either.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-outside-'));
    try {
      fs.symlinkSync(outside, path.join(directory, 'escape'));
      fs.writeFileSync(path.join(directory, 'cov.json'), '{}');
      assert.throws(() => plan(directory, [{format: 'istanbul', report: 'cov.json', source_directory: 'escape', package_directory: 'escape'}]), /cannot escape/);
    } finally {fs.rmSync(outside, {recursive: true, force: true});}
  });
  // Dot-dot, absolute, backslash and .git directories are rejected before any lookup; so is a directory that does not hold the source.
  for (const bad of ['../x', 'a/../x', '/x', 'a\\b', '.git', 'a/.git', '', 'a//b', './a', 'a\0', 7, null]) {
    assert.throws(() => declared.readBase('/nowhere', 'base', () => '{}', bad), /explicit repository-relative directory/, String(bad));
  }
});

test('per-file minimums apply to the files of their own part, and unsupported formats name the part', () => monorepo(
  {...MONO, 'frontend/package.json': C8(100, {'per-file': true})}, (directory, measure) => {
    measure(0, 1);
    // The backend is not per-file (its totals must reach 100, so it fails first); give it a lower bar to isolate the frontend.
    fs.writeFileSync(path.join(directory, 'backend/package.json'), C8(50));
    sh(directory, 'git', 'commit', '-qam', 'lower backend');
    sh(directory, 'git', 'branch', '-f', 'base', 'HEAD');
    assert.deepEqual(plan(directory).slice(0, 2), [`${BACKEND}: declared lines: 50.00% (1/2), minimum 50%`, `${BACKEND}: declared branches: 50.00% (1/2), minimum 50%`]);
    assert.ok(plan(directory).includes(`${FRONTEND}: declared per file: 1 files checked against lines 100%, branches 100%`));
    measure(1, 0);
    const error = failure(directory);
    assert.ok(error.message.includes(`for ${FRONTEND}: frontend/src/b.ts: lines 50.00% (1/2) is below the declared minimum 100%`), error.message);
    assert.ok(!error.message.includes('backend/src/a.ts'), error.message);
    fs.mkdirSync(path.join(directory, 'g'));
    fs.writeFileSync(path.join(directory, 'g/go.mod'), 'module example.test/m\n\ngo 1.21\n');
    fs.writeFileSync(path.join(directory, 'g/m.go'), 'package m\n\nfunc F() {\n\t_ = 1\n}\n');
    fs.writeFileSync(path.join(directory, 'g/cover.out'), 'mode: set\nexample.test/m/m.go:3.10,5.2 1 1\n');
    fs.writeFileSync(path.join(directory, 'g/package.json'), C8(100, {'per-file': true}));
    sh(directory, 'git', 'add', '-A');
    sh(directory, 'git', 'commit', '-qm', 'go');
    sh(directory, 'git', 'branch', '-f', 'base', 'HEAD');
    const go = failure(directory, [{format: 'go', report: 'g/cover.out', source_directory: 'g', package_directory: 'g'}]);
    assert.equal(go.declared_cause, 'declared_unsupported');
    assert.ok(go.message.includes('for coverage part 1 (go, source g, declaration g/package.json): per-file minimums need per-file line and branch counts'), go.message);
  }));

test('parts may share a package directory, but duplicate reports, overlapping sources and bad shapes are rejected', () => monorepo(
  {...MONO, 'backend/src2/c.ts': SOURCE}, (directory, measure) => {
    measure(1, 1);
    const source = path.join(directory, 'backend/src2/c.ts');
    fs.writeFileSync(path.join(directory, 'backend/cov2.json'), JSON.stringify({[source]: istanbulFile(source, 1)}));
    const shared = [PARTS[0], {format: 'istanbul', report: 'backend/cov2.json', source_directory: 'backend/src2', package_directory: 'backend'}];
    const lines = plan(directory, shared);
    assert.equal(lines.length, 4);
    assert.ok(lines[2].startsWith('coverage part 2 (istanbul, source backend/src2, declaration backend/package.json): declared lines: 100.00%'), lines[2]);
    assert.throws(() => plan(directory, [PARTS[0], {...shared[1], report: 'backend/cov.json'}]), /Duplicate reports or overlapping/);
    assert.throws(() => plan(directory, [PARTS[0], {...shared[1], source_directory: 'backend/src/inner'}]), /Duplicate reports or overlapping|existing application source/);
    assert.throws(() => plan(directory, [PARTS[0], PARTS[0]]), /Duplicate reports or overlapping/);
    for (const part of [{...PARTS[0], package_directory: '../backend'}, {...PARTS[0], package_directory: 'frontend'}, {...PARTS[0], package_directory: 'backend/src/x'},
      {...PARTS[0], package_directory: 'back'}, {...PARTS[0], package_directory: null}, {...PARTS[0], extra: 1}]) {
      assert.throws(() => plan(directory, [part]), /package_directory must be an explicit|requires a supported native format/);
    }
    // A plain failure (not a declaration problem) is not dressed as a declared cause.
    assert.throws(() => plan(directory, shared, '--help'), error => !(error instanceof declared.DeclaredError) && /plain base revision/.test(error.message));
  }));

test('the package directory of a part is explicit, contains its source and is validated like every other path', () => {
  const part = (source, extra = {}) => ({format: 'istanbul', report: 'r.json', source_directory: source, ...extra});
  assert.equal(util.packageDirectory(part('backend/src', {package_directory: 'backend'})), 'backend');
  assert.equal(util.packageDirectory(part('backend/src', {package_directory: 'backend/src'})), 'backend/src');
  assert.equal(util.packageDirectory(part('backend/src')), 'backend/src');
  assert.equal(util.packageDirectory(part('.')), '.');
  assert.equal(util.packageDirectory(part('src', {package_directory: '.'})), '.');
  for (const bad of [part('backend/src', {package_directory: 'backend2'}), part('backend', {package_directory: 'backend/src'}), part('src', {package_directory: './'}),
    part('src', {package_directory: '..'}), part('.', {package_directory: 'x'}), part('../src'), part('src', {package_directory: 3}), part('src', {package_directory: 'a'.repeat(500)})]) {
    assert.throws(() => util.packageDirectory(bad), /explicit repository-relative directory that contains its source_directory/, JSON.stringify(bad));
  }
  const recipe = coverage => ({version: 2, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md', verification: [['true']], coverage});
  assert.deepEqual(coverageParts(recipe([part('backend/src', {package_directory: 'backend'})])), [part('backend/src', {package_directory: 'backend'})]);
  assert.deepEqual(coverageParts(recipe([part('backend/src')])).length, 1);
  assert.throws(() => coverageParts(recipe([part('backend/src', {package_directory: 'other'})])), /Invalid local-only/);
  assert.throws(() => coverageParts(recipe([part('backend/src', {package_directory: '../backend'})])), /Invalid local-only/);
  // A v1 single-artifact configuration keeps its fields and never reads a package directory.
  assert.equal(util.validPartShape({format: 'istanbul', report: 'r', source_directory: 's', package_directory: 'p'}), true);
  assert.equal(util.validPartShape({format: 'istanbul', report: 'r'}), false);
  assert.equal(util.validPartShape(null), false);
});

test('a changed declaration in ANY package.json is held; unrelated package.json edits and other files are not', async () => {
  const nested = {filename: 'backend/package.json', status: 'modified'};
  const root = {filename: 'package.json', status: 'modified'};
  const worldNested = (texts) => ({rest: {repos: {getContent: async ({ref, path: file}) => {
    const text = texts[`${file}@${ref}`];
    if (text === undefined) throw Object.assign(new Error('Not Found'), {status: 404});
    return {data: {encoding: 'base64', size: text.length, content: Buffer.from(text).toString('base64')}};
  }}}});
  const run = (texts, files, request = pr()) => declared.protect({github: worldNested(texts), repo: {owner: 'o', repo: 'r'}, pr: request, files, config: {coverage: {mode: 'declared'}}});
  const texts = {[`backend/package.json@${BASE}`]: C8(100), [`backend/package.json@${SHA}`]: C8(10), [`frontend/package.json@${BASE}`]: C8(50),
    [`frontend/package.json@${SHA}`]: pkg({name: 'renamed', c8: {'check-coverage': true, lines: 50, branches: 50}}), [`package.json@${BASE}`]: C8(1), [`package.json@${SHA}`]: C8(1)};
  const result = await run(texts, [nested, {filename: 'frontend/package.json', status: 'modified'}, root, {filename: 'frontend/package-lock.json', status: 'modified'}]);
  assert.deepEqual([...result.protect], ['backend/package.json']);
  assert.deepEqual(result.notices, ['backend/package.json is a protected-control hold: the declared coverage thresholds changed.']);
  // A package.json added to a part directory, or one moved away, is judged against the absent side.
  const added = await run({[`backend/package.json@${SHA}`]: C8(1)}, [{filename: 'backend/package.json', status: 'added'}]);
  assert.deepEqual([...added.protect], ['backend/package.json']);
  const moved = await run({[`backend/package.json@${BASE}`]: C8(1)}, [{filename: 'server/package.json', previous_filename: 'backend/package.json', status: 'renamed'}]);
  assert.deepEqual([...moved.protect], ['backend/package.json']);
  // An unreadable file is held by itself; the others are still compared.
  const mixed = await declared.protect({github: {rest: {repos: {getContent: async ({path: file}) => {
    if (file === 'a/package.json') throw Object.assign(new Error('big'), {unavailable: true});
    return {data: {encoding: 'base64', size: 2, content: Buffer.from('{}').toString('base64')}};
  }}}}, repo: {owner: 'o', repo: 'r'}, pr: pr(), files: [{filename: 'a/package.json'}, {filename: 'b/package.json'}], config: {coverage: {mode: 'declared'}}});
  assert.deepEqual([...mixed.protect], ['a/package.json']);
  assert.match(mixed.notices[0], /^a\/package\.json is a protected-control hold: the base or head file is unavailable/);
  // Without a head repository every candidate is held.
  const forkless = await run({}, [nested, root], pr(null));
  assert.deepEqual([...forkless.protect].sort(), ['backend/package.json', 'package.json']);
  // More candidates than can be compared are all held with one notice.
  const many = Array.from({length: declared.CANDIDATE_LIMIT + 1}, (_, index) => ({filename: `p${index}/package.json`, status: 'modified'}));
  const crowded = await run({}, many);
  assert.equal(crowded.protect.size, many.length);
  assert.equal(crowded.notices.length, 1);
  assert.match(crowded.notices[0], /^21 package\.json files changed, more than the 20 /);
  assert.deepEqual([declared.isPackageFile('a/package.json'), declared.isPackageFile('package.json'), declared.isPackageFile('a/package.json5'), declared.isPackageFile(undefined)], [true, true, false, false]);
  assert.equal(declared.fileIn('a/b'), 'a/b/package.json');
  assert.equal(declared.fileIn('.'), 'package.json');
});
