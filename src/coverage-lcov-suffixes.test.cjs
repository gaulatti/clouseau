'use strict';
// lcov parts that declare their own source suffixes (Swift and Rust style reports).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gate = require('./coverage-gate.cjs');
const {coverageParts} = require('./coverage-plan.cjs');
const {validPartShape, validateSourceSuffixes} = require('./coverage-util.cjs');
const {scopeFor} = require('./coverage-scope.cjs');

const sh = (cwd, ...argv) => cp.execFileSync(argv[0], argv.slice(1), {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

// A committed repository: `base` on main, `head` on top of it.
function repository(base, head, run) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-suffix-')));
  try {
    sh(directory, 'git', 'init', '-q', '-b', 'main');
    sh(directory, 'git', 'config', 'user.email', 'a@example.test');
    sh(directory, 'git', 'config', 'user.name', 'A');
    for (const files of [base, head]) {
      for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(directory, name)), {recursive: true});
        fs.writeFileSync(path.join(directory, name), text);
      }
      sh(directory, 'git', 'add', '-A');
      sh(directory, 'git', 'commit', '-q', '-m', 'x');
    }
    sh(directory, 'git', 'branch', 'base', 'HEAD~1');
    return run(directory);
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
}

// llvm-cov export -format=lcov: absolute SF paths, DA lines, and BRF:0/BRH:0 with no BRDA records.
const swift = (file, hits = [1, 1, 1]) => ['TN:', `SF:${file}`, ...hits.map((count, index) => `DA:${index + 1},${count}`),
  'BRF:0', 'BRH:0', `LF:${hits.length}`, `LH:${hits.filter(Boolean).length}`, 'end_of_record', ''].join('\n');
const rust = (file, hits = [1, 1], branches = []) => ['SF:' + file, 'FN:1,main', 'FNDA:1,main', 'FNF:1', 'FNH:1',
  ...branches.map(([line, taken]) => `BRDA:${line},0,0,${taken}`), `BRF:${branches.length}`, `BRH:${branches.filter(([, taken]) => taken !== '-' && taken > 0).length}`,
  ...hits.map((count, index) => `DA:${index + 1},${count}`), `LF:${hits.length}`, `LH:${hits.filter(Boolean).length}`, 'end_of_record', ''].join('\n');

const tree = (files, run) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-suffix-')));
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(directory, name)), {recursive: true});
      fs.writeFileSync(path.join(directory, name), text);
    }
    return run(directory);
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
};

const SWIFT = ['.swift'];
const measure = (directory, text, suffixes, source = 'Sources', notes) => gate.counters(text, source, 'lcov', directory, undefined, {suffixes, notes});

test('suffix declarations are validated: one to eight distinct lowercase suffixes, lcov parts only', () => {
  for (const good of [['.swift'], ['.rs', '.c', '.h'], ['.a1b2c3d4'], Array.from({length: 8}, (_, index) => `.s${index}`)]) {
    assert.deepEqual(validateSourceSuffixes(good), good);
  }
  for (const bad of [undefined, null, 'swift', '.swift', [], [''], ['swift'], ['.'], ['.Swift'], ['.sw ift'], ['.swift/'], ['.a.b'], ['.abcdefghi'], [1], [null],
    ['.rs', '.rs'], Array.from({length: 9}, (_, index) => `.s${index}`), {length: 1, 0: '.rs'}]) {
    assert.throws(() => validateSourceSuffixes(bad), /source_suffixes must be/);
  }
  const part = extra => ({format: 'lcov', report: 'r.lcov', source_directory: 'Sources', ...extra});
  assert.equal(validPartShape(part({source_suffixes: SWIFT})), true);
  assert.equal(validPartShape(part({source_suffixes: SWIFT, package_directory: 'Sources'})), true);
  assert.equal(validPartShape(part({source_suffixes: []})), false);
  assert.equal(validPartShape(part({source_suffixes: ['.rs', '.rs']})), false);
  assert.equal(validPartShape(part({source_suffixes: SWIFT, extra: 1})), false);
  assert.equal(validPartShape({...part({source_suffixes: SWIFT}), format: 'istanbul'}), false);
  assert.equal(validPartShape({format: 'lcov', report: 'r', source_suffixes: SWIFT}), false);
  const recipe = coverage => ({version: 2, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md', verification: [['true']], coverage});
  assert.deepEqual(coverageParts(recipe([part({source_suffixes: SWIFT})])), [part({source_suffixes: SWIFT})]);
  assert.deepEqual(coverageParts(recipe([part()])), [part()]);
  assert.throws(() => coverageParts(recipe([part({source_suffixes: []})])), /Invalid local-only/);
  assert.throws(() => coverageParts(recipe([{...part({source_suffixes: SWIFT}), format: 'go'}])), /Invalid local-only/);
});

test('the default scope is the unchanged JS/TS inventory and a custom scope adds only the documented rules', () => {
  const normal = scopeFor(undefined);
  assert.equal(normal.custom, false);
  assert.deepEqual([...normal.suffixes], ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs']);
  for (const parts of [['Tests'], ['target'], ['.build'], ['a', 'Tests']]) assert.equal(normal.excludesDirectories(parts), false);
  for (const parts of [['tests'], ['a', 'node_modules'], ['vendor'], ['.git'], ['__tests__'], ['test', 'x']]) assert.equal(normal.excludesDirectories(parts), true);
  tree({'Cargo.toml': '', 'Package.swift': ''}, manifests => {
    const custom = scopeFor(SWIFT, manifests);
    assert.equal(custom.custom, true);
    for (const parts of [['tests'], ['a', 'node_modules'], ['vendor'], ['.git'], ['__tests__'], ['Tests'], ['a', 'Tests'], ['target'], ['.build'], ['target', 'debug']]) {
      assert.equal(custom.excludesDirectories(parts), true, parts.join('/'));
    }
    // target and .build are build outputs only beside their manifest, never a module deeper in the source tree.
    for (const parts of [['a', 'target'], ['a', '.build'], ['Sources'], ['targets']]) assert.equal(custom.excludesDirectories(parts), false, parts.join('/'));
  });
  tree({}, bare => {
    // Without the manifest beside it, a directory named target or .build is application source.
    for (const parts of [['target'], ['.build']]) assert.equal(scopeFor(SWIFT, bare).excludesDirectories(parts), false, parts.join('/'));
    assert.equal(scopeFor(SWIFT).excludesDirectories(['target']), false);
  });
  const custom = scopeFor(SWIFT);
  assert.equal(custom.ignorePattern.test('// LCOV_EXCL_LINE'), true);
  assert.equal(normal.ignorePattern.test('// LCOV_EXCL_LINE'), false);
});

test('a Swift-style report with absolute paths is measured against .swift sources; lines only, branches not measured', () => tree({
  'Sources/App/A.swift': 'let a = 1\n', 'Sources/App/B.swift': 'let b = 2\n', 'Sources/App/readme.md': 'x',
  'Sources/Tests/CTests.swift': 'x', 'Tests/AppTests/ATests.swift': 'x',
}, directory => {
  const abs = name => path.join(directory, 'Sources', 'App', name);
  const notes = [];
  const text = swift(abs('A.swift')) + swift(abs('B.swift'), [1, 0, 1]);
  assert.deepEqual(measure(directory, text, SWIFT, 'Sources', notes), {lines: [6, 5], branches: [0, 0]});
  assert.equal(notes.length, 1);
  assert.match(notes[0], /no BRDA records, so branches are not measured and only lines are gated/);
  // Reports that list excluded test directories contribute nothing; relative workspace paths resolve the same way.
  const withTests = text + swift(path.join(directory, 'Sources', 'Tests', 'CTests.swift')) + swift('Sources/Tests/CTests.swift');
  assert.deepEqual(measure(directory, withTests, SWIFT), {lines: [6, 5], branches: [0, 0]});
  const relative = swift('Sources/App/A.swift') + swift('Sources/App/B.swift', [1, 0, 1]);
  assert.deepEqual(measure(directory, relative, SWIFT), {lines: [6, 5], branches: [0, 0]});
  // Without a declaration the same tree has no JS/TS source and the default behaviour is unchanged.
  assert.throws(() => measure(directory, text, undefined), /No application JS\/TS sources found/);
  // A repository root source directory reaches the Tests siblings that SwiftPM keeps beside Sources.
  assert.deepEqual(measure(directory, text + swift(path.join(directory, 'Tests', 'AppTests', 'ATests.swift')), SWIFT, '.'), {lines: [6, 5], branches: [0, 0]});
}));

test('the strict gate still fails a declared source that the report does not name, or a foreign one', () => tree({
  'Sources/A.swift': 'let a = 1\n', 'Sources/B.swift': 'let b = 2\n', 'Sources/legacy.m': 'x',
}, directory => {
  assert.throws(() => measure(directory, swift(path.join(directory, 'Sources/A.swift')), SWIFT), /Missing application source coverage: .*B\.swift/);
  assert.throws(() => measure(directory, swift(path.join(directory, 'Sources/A.swift')) + swift(path.join(directory, 'Sources/B.swift')) +
    swift(path.join(directory, 'Sources/Ghost.swift')), SWIFT), /Unexpected or duplicate application coverage/);
  // Declaring a second suffix puts those files in the inventory too.
  assert.throws(() => measure(directory, swift(path.join(directory, 'Sources/A.swift')) + swift(path.join(directory, 'Sources/B.swift')), ['.swift', '.m']),
    /Missing application source coverage: .*legacy\.m/);
  assert.throws(() => measure(directory, '', ['.kt']), /No application \.kt sources found/);
  assert.throws(() => measure(directory, swift('x'), ['.kt', '.java']), /No application \.kt \.java sources found/);
  // Uncovered lines are still counted, so the exact gate refuses them.
  assert.throws(() => gate.check(swift(path.join(directory, 'Sources/A.swift'), [1, 0]) + swift(path.join(directory, 'Sources/B.swift')), 'Sources', 'lcov', directory, {suffixes: SWIFT}),
    /No branches measured|lines: 1 uncovered/);
}));

test('Rust-style reports: target and tests are skipped, a nested module named target is application source', () => tree({
  'src/main.rs': 'fn main() {}\n', 'src/target/mod.rs': 'pub fn f() {}\n', 'src/tests/it.rs': 'x', 'target/debug/build/x/out.rs': 'x',
  'tests/api.rs': 'x', 'vendor/dep/lib.rs': 'x', 'Cargo.toml': '[package]\n',
}, directory => {
  const abs = name => path.join(directory, name);
  const body = rust(abs('src/main.rs'), [1, 1], [[1, 1], [1, '-']]) + rust(abs('src/target/mod.rs'), [1]);
  const noise = rust(abs('target/debug/build/x/out.rs')) + rust(abs('tests/api.rs')) + rust(abs('src/tests/it.rs')) + rust(abs('vendor/dep/lib.rs'));
  const notes = [];
  // Source directory is the crate root: target/, tests/ and vendor/ beside the manifest are excluded.
  assert.deepEqual(measure(directory, body + noise, ['.rs'], '.', notes), {lines: [3, 3], branches: [2, 1]});
  assert.deepEqual(notes, []);
  assert.throws(() => measure(directory, rust(abs('src/main.rs')), ['.rs'], '.'), /Missing application source coverage: .*mod\.rs/);
  // With src as the source directory there is no manifest beside it, so src/target/ is application source.
  assert.deepEqual(measure(directory, body, ['.rs'], 'src'), {lines: [3, 3], branches: [2, 1]});
  assert.throws(() => measure(directory, rust(abs('src/main.rs')), ['.rs'], 'src'), /Missing application source coverage: .*mod\.rs/);
}));

test('ignore directives of lcov producers fail a custom-suffix part only', () => {
  for (const directive of ['// LCOV_EXCL_LINE', '// LCOV_EXCL_START', '// GRCOV_EXCL_STOP', '#[coverage(off)]', '#[cfg_attr(coverage_nightly, coverage(off))]',
    '#[tarpaulin::skip]', '#[cfg(not(tarpaulin_include))]', '// istanbul ignore next']) {
    tree({'a.rs': `${directive}\nfn f() {}\n`}, directory =>
      assert.throws(() => measure(directory, rust(path.join(directory, 'a.rs')), ['.rs'], '.'), /ignore directives are not allowed/, directive));
  }
  // The JS/TS default keeps its original directive set.
  tree({'a.cjs': '// LCOV_EXCL_LINE\n'}, directory => assert.deepEqual(gate.counters(rust(path.join(directory, 'a.cjs')), '.', 'lcov', directory), {lines: [2, 2], branches: [0, 0]}));
  tree({'a.swift': 'let a = 1\n', 'b.cjs': '// c8 ignore next\n'}, directory =>
    assert.deepEqual(measure(directory, swift(path.join(directory, 'a.swift')), SWIFT, '.'), {lines: [3, 3], branches: [0, 0]}));
});

test('suffix declarations are refused for formats other than lcov', () => {
  assert.throws(() => gate.counters({}, '.', 'istanbul', '.', undefined, {suffixes: SWIFT}), /only for the lcov format/);
});

const LIB = 'let a = 1\nlet b = 2\nlet c = 3\n';
const files = {'Sources/A.swift': LIB, '.github/x': '1'};

test('changed plans gate Swift lines, report branches as not measured, and the CLI mirrors the recipe', () => repository(
  files, {'Sources/A.swift': 'let a = 1\nlet b = 20\nlet c = 3\n'}, directory => {
    const write = (name, value) => fs.writeFileSync(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
    const run = (...argv) => {
      let out = ''; let err = '';
      const status = gate.main(argv, {cwd: directory, stdout: text => {out += text;}, stderr: text => {err += text;}});
      return {status, out, err};
    };
    const source = path.join(directory, 'Sources/A.swift');
    const recipe = suffixes => ({version: 2, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md', verification: [['true']],
      coverage: [{format: 'lcov', report: 'llvm.lcov', source_directory: 'Sources', ...(suffixes ? {source_suffixes: suffixes} : {})}]});
    write('recipe.json', recipe(SWIFT));
    write('base.json', {lines: [3, 3], branches: [0, 0]});
    write('llvm.lcov', swift(source));
    const passed = run('changed-plan', 'recipe.json', '.', 'base', 'base.json');
    assert.equal(passed.status, 0, passed.err);
    assert.match(passed.out, /^changed lines: 1\/1\nchanged branches: 0\/0\nnote: coverage part 1 \(lcov, source Sources\): the lcov report has no BRDA records, so branches are not measured and only lines are gated\n$/);
    assert.match(run('totals-plan', 'recipe.json').err, /^note: coverage part 1 .*only lines are gated/);
    assert.equal(run('totals-plan', 'recipe.json').out, '{"lines":[3,3],"branches":[0,0]}\n');
    // The same gate through the single-report command line.
    assert.equal(run('changed-check', 'llvm.lcov', 'Sources', 'lcov', 'base', 'base.json', '--source-suffixes=.swift').out, passed.out.replace('coverage part 1 (lcov, source Sources): ', ''));
    assert.equal(run('totals', 'llvm.lcov', 'Sources', 'lcov', '--source-suffixes=.swift').out, '{"lines":[3,3],"branches":[0,0]}\n');
    assert.equal(run('declared-check', 'llvm.lcov', 'Sources', 'lcov', 'base', '--source-suffixes=.swift').status, 1);
    const exact = run('check', 'llvm.lcov', 'Sources', 'lcov', '--source-suffixes=.swift');
    assert.equal(exact.status, 1);
    assert.equal(exact.out, 'lines: 3/3\nbranches: 0/0\nnote: the lcov report has no BRDA records, so branches are not measured and only lines are gated\n');
    assert.match(exact.err, /No branches measured/);
    // An uncovered changed line fails with its file:line.
    write('llvm.lcov', swift(source, [1, 0, 1]));
    const failed = run('changed-plan', 'recipe.json', '.', 'base', 'base.json');
    assert.equal(failed.status, 1);
    assert.match(failed.err, /lines: 1 changed uncovered.*uncovered: Sources\/A\.swift:2 line/);
    // A declared source missing from the report fails; so does a recipe without the declaration.
    write('llvm.lcov', swift(path.join(directory, 'Sources/Other.swift')));
    assert.match(run('changed-plan', 'recipe.json', '.', 'base', 'base.json').err, /Unexpected or duplicate|Missing application source coverage/);
    write('recipe.json', recipe(undefined));
    write('llvm.lcov', swift(source));
    assert.match(run('changed-plan', 'recipe.json', '.', 'base', 'base.json').err, /No application JS\/TS sources found/);
    // The flag is rejected where it cannot apply, and a bad flag value is refused.
    assert.match(run('totals-plan', 'recipe.json', '.', '--source-suffixes=.swift').err, /single-report commands/);
    assert.match(run('totals', 'llvm.lcov', 'Sources', 'lcov', '--source-suffixes=swift').err, /source_suffixes must be/);
    assert.match(run('totals', 'llvm.lcov', 'Sources', 'lcov', '--source-suffixes=.rs', '--source-suffixes=.swift').err, /once/);
    // The recipe itself rejects invalid declarations before any report is read.
    write('recipe.json', recipe(['.swift', '.swift']));
    assert.match(run('changed-plan', 'recipe.json', '.', 'base', 'base.json').err, /Each coverage part requires/);
  }));

test('a part with BRDA is measured on branches and mixed plans label only the branchless part', () => repository(
  {'swift/A.swift': LIB, 'rust/src/lib.rs': 'fn a() {}\nfn b() {}\n'}, {'rust/src/lib.rs': 'fn a() {}\nfn c() {}\n'}, directory => {
    const write = (name, value) => fs.writeFileSync(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
    write('swift.lcov', swift(path.join(directory, 'swift/A.swift')));
    write('rust.lcov', rust(path.join(directory, 'rust/src/lib.rs'), [1, 1], [[2, 1], [2, 0]]));
    const parts = [{format: 'lcov', report: 'swift.lcov', source_directory: 'swift', source_suffixes: SWIFT},
      {format: 'lcov', report: 'rust.lcov', source_directory: 'rust/src', source_suffixes: ['.rs']}];
    const notes = [];
    const result = gate.measurePlan(parts, directory, undefined, notes);
    assert.deepEqual(result.totals, {lines: [5, 5], branches: [2, 1]});
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^coverage part 1 \(lcov, source swift\): /);
    assert.deepEqual(result.parts[0].notes, notes);
    assert.equal('notes' in result.parts[1], false);
    write('base.json', {lines: [5, 5], branches: [2, 2]});
    assert.throws(() => gate.changedPlan(parts, directory, 'base', path.join(directory, 'base.json')), /branches: 1 changed uncovered; branches: repository-wide coverage fell below/);
    // The exact plan gate rejects the uncovered Rust branch and accepts a fully taken one beside a branchless Swift part.
    assert.throws(() => gate.checkPlan(parts, directory), /uncovered branches/);
    write('rust.lcov', rust(path.join(directory, 'rust/src/lib.rs'), [1, 1], [[2, 1], [2, 3]]));
    assert.deepEqual(gate.checkPlan(parts, directory).totals, {lines: [5, 5], branches: [2, 2]});
    // A plan whose every part lacks BRDA is never exact: nothing measures a branch.
    assert.throws(() => gate.checkPlan(parts.slice(0, 1), directory), /No branches measured/);
    // The plan is exposed through the command line and the notes reach the declared plan output channel too.
    let out = '';
    write('recipe.json', {version: 2, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md', verification: [['true']], coverage: parts});
    assert.equal(gate.main(['plan', 'recipe.json', '.'], {cwd: directory, stdout: text => {out += text;}, stderr: () => {}}), 0);
    assert.match(JSON.parse(out).parts[0].notes[0], /only lines are gated/);
  }));

test('llvm-cov summary LF/LH are not compared for a declared-suffix part; BRF/BRH and the default part still are', () => tree({'a.swift': 'x', 'b.cjs': 'x'}, directory => {
  const llvm = ['SF:' + path.join(directory, 'a.swift'), 'DA:1,1', 'DA:2,0', 'BRF:0', 'BRH:0', 'LF:9', 'LH:7', 'end_of_record', ''].join('\n');
  assert.deepEqual(measure(directory, llvm, SWIFT, '.'), {lines: [2, 1], branches: [0, 0]});
  assert.throws(() => measure(directory, llvm.replace('BRF:0', 'BRF:1'), SWIFT, '.'), /totals do not match/);
  assert.throws(() => measure(directory, llvm.replace('BRH:0', 'BRH:1'), SWIFT, '.'), /totals do not match/);
  assert.throws(() => measure(directory, llvm.replace('BRF:0\nBRH:0\n', ''), SWIFT, '.'), /totals do not match/);
  const javascript = llvm.replace('a.swift', 'b.cjs');
  assert.throws(() => gate.counters(javascript, '.', 'lcov', directory), /totals do not match/);
}));
