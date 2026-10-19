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
