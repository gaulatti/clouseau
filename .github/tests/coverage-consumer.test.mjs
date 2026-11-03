import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parse} from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const action = parse(readFileSync(join(root, 'action.yml'), 'utf8'));
const step = action.runs.steps.find(item => item.name === 'Enforce 100% line and branch coverage');

test('the actual composite coverage entry point accepts native Istanbul and rejects branch gaps and missing application sources', t => {
  const directory = mkdtempSync(join(tmpdir(), 'clouseau-consumer-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const source = join(directory, 'source.ts'); const report = join(directory, 'coverage.json');
  writeFileSync(source, 'export const result = true ? 1 : 2;\n');
  const full = {[source]: {path: source, statementMap: {0: {start: {line: 1, column: 0}, end: {line: 1, column: 33}}},
    s: {0: 1}, branchMap: {0: {locations: [{start: {line: 1}}, {start: {line: 1}}]}}, b: {0: [1, 1]}}};
  const invoke = value => {
    writeFileSync(report, JSON.stringify(value));
    return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {cwd: directory,
      env: {...process.env, CLOUSEAU_ROOT: root, COVERAGE_REPORT: report, SOURCE_DIRECTORY: directory, COVERAGE_FORMAT: 'istanbul'}, encoding: 'utf8'});
  };
  assert.equal(action.inputs['coverage-format'].default, 'llvm');
  assert.equal(step.env.COVERAGE_FORMAT, '${{ inputs.coverage-format }}');
  const passed = invoke(full);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /lines: 1\/1/); assert.match(passed.stdout, /branches: 2\/2/);
  const gap = structuredClone(full); gap[source].b[0][1] = 0;
  const rejected = invoke(gap); assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout, /branches: 1\/2/); assert.match(rejected.stderr, /Coverage gate failed/);
  writeFileSync(join(directory, 'unmeasured.ts'), 'export const missing = 1;\n');
  const missing = invoke(full); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /Missing application source coverage/);
  const previousEntry = step.run.replace(' "$COVERAGE_FORMAT"', '');
  assert.notEqual(previousEntry, step.run);
  const omittedFormat = spawnSync('bash', ['-e', '-c', previousEntry], {cwd: directory, encoding: 'utf8',
    env: {...process.env, CLOUSEAU_ROOT: root, COVERAGE_REPORT: report, SOURCE_DIRECTORY: directory, COVERAGE_FORMAT: 'istanbul'}});
  assert.notEqual(omittedFormat.status, 0); assert.match(omittedFormat.stderr, /Expected an LLVM coverage export/);
});

test('the composite coverage entry point switches to changed lines only for a protected opt-in plus a base revision', t => {
  const directory = mkdtempSync(join(tmpdir(), 'clouseau-changed-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const git = (...args) => spawnSync('git', args, {cwd: directory, encoding: 'utf8'});
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'a@example.test'); git('config', 'user.name', 'A');
  const source = join(directory, 'source.ts'); const report = join(directory, 'coverage.json');
  const entry = hits => ({[source]: {path: source, statementMap: {0: {start: {line: 1, column: 0}, end: {line: 1, column: 9}},
    1: {start: {line: 2, column: 0}, end: {line: 2, column: 9}}}, s: {0: 1, 1: hits}, branchMap: {}, b: {}}});
  writeFileSync(source, 'const a = 1;\nconst b = 1;\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  writeFileSync(source, 'const a = 1;\nconst b = 2;\n'); git('add', '-A'); git('commit', '-q', '-m', 'head');
  const baseline = join(directory, 'base.json'); writeFileSync(baseline, JSON.stringify({lines: [2, 2], branches: [0, 0]}));
  const config = mode => { const file = join(directory, `${mode}.json`); writeFileSync(file, JSON.stringify({...JSON.parse(readFileSync(join(root, 'examples/colombo.json'), 'utf8')), coverage: {mode}})); return file; };
  const invoke = (hits, env) => {
    writeFileSync(report, JSON.stringify(entry(hits)));
    return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {cwd: directory, encoding: 'utf8',
      env: {...process.env, CLOUSEAU_ROOT: root, COVERAGE_REPORT: report, SOURCE_DIRECTORY: directory, COVERAGE_FORMAT: 'istanbul', ...env}});
  };
  const changed = {COVERAGE_BASE_REF: git('rev-parse', 'HEAD~1').stdout.trim(), COVERAGE_BASELINE: baseline, CLOUSEAU_CONFIG: config('changed_lines')};
  assert.match(invoke(1, {}).stderr, /No branches measured/);
  assert.equal(invoke(1, changed).stdout, 'changed lines: 1/1\nchanged branches: 0/0\n');
  assert.notEqual(invoke(0, changed).status, 0);
  assert.match(invoke(0, changed).stderr, /Coverage gate failed: lines: 1 changed uncovered/);
  // Exact stays in force without the base revision or when the protected config does not opt in.
  assert.match(invoke(1, {...changed, COVERAGE_BASE_REF: ''}).stderr, /No branches measured/);
  assert.match(invoke(1, {...changed, CLOUSEAU_CONFIG: config('exact')}).stderr, /No branches measured/);
  assert.notEqual(invoke(1, {...changed, COVERAGE_BASELINE: ''}).status, 0);
});

test('the composite coverage entry point reads declared minimums from the base revision only for a protected declared opt-in', t => {
  const directory = mkdtempSync(join(tmpdir(), 'clouseau-declared-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const git = (...args) => spawnSync('git', args, {cwd: directory, encoding: 'utf8'});
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'a@example.test'); git('config', 'user.name', 'A');
  const source = join(directory, 'source.ts'); const report = join(directory, 'coverage.json');
  const entry = hits => ({[source]: {path: source, statementMap: {0: {start: {line: 1, column: 0}, end: {line: 1, column: 9}},
    1: {start: {line: 2, column: 0}, end: {line: 2, column: 9}}}, s: {0: 1, 1: hits}, branchMap: {}, b: {}}});
  const declare = lines => JSON.stringify({jest: {coverageThreshold: {global: {lines}}}});
  writeFileSync(source, 'const a = 1;\nconst b = 1;\n'); writeFileSync(join(directory, 'package.json'), declare(100)); git('add', '-A'); git('commit', '-q', '-m', 'base');
  // The head lowers its own bar; the gate must keep reading the base.
  writeFileSync(join(directory, 'package.json'), declare(1)); git('add', '-A'); git('commit', '-q', '-m', 'head');
  const config = mode => { const file = join(directory, `${mode}.json`); writeFileSync(file, JSON.stringify({...JSON.parse(readFileSync(join(root, 'examples/colombo.json'), 'utf8')), coverage: {mode}})); return file; };
  const invoke = (hits, env) => {
    writeFileSync(report, JSON.stringify(entry(hits)));
    return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {cwd: directory, encoding: 'utf8',
      env: {...process.env, CLOUSEAU_ROOT: root, COVERAGE_REPORT: report, SOURCE_DIRECTORY: directory, COVERAGE_FORMAT: 'istanbul', ...env}});
  };
  const declared = {COVERAGE_BASE_REF: git('rev-parse', 'HEAD~1').stdout.trim(), CLOUSEAU_CONFIG: config('declared')};
  const passed = invoke(1, declared);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, 'declared lines: 100.00% (2/2), minimum 100%\n');
  const below = invoke(0, declared);
  assert.notEqual(below.status, 0);
  assert.match(below.stderr, /Coverage gate failed: Declared coverage \(cause: `declared_below_threshold`\): lines: 50\.00% \(1\/2\) is below the declared minimum 100%/);
  // A base without the file fails closed with a notice, never to 100% or to zero.
  const missing = invoke(1, {...declared, COVERAGE_BASE_REF: '0'.repeat(40)});
  assert.match(missing.stderr, /cause: `declared_missing`/);
  // Without the base revision, or without the protected opt-in, the exact gate stays in force.
  assert.match(invoke(1, {...declared, COVERAGE_BASE_REF: ''}).stderr, /No branches measured/);
  assert.match(invoke(1, {...declared, CLOUSEAU_CONFIG: config('exact')}).stderr, /No branches measured/);
});
