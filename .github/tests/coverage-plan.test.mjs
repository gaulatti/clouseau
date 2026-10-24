import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parse} from 'yaml';

test('the actual packaged coverage step verifies each native artifact without credentials or setup execution', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const action = parse(fs.readFileSync(path.join(root, 'action.yml'), 'utf8'));
  const step = action.runs.steps.find(item => item.name === 'Enforce 100% line and branch coverage');
  assert.equal(action.inputs['coverage-config'].default, '');
  assert.equal(step.env.COVERAGE_CONFIG, '${{ inputs.coverage-config }}');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-action-native-parts-'));
  try {
    const parts = ['backend', 'frontend'].map((name, index) => {
      const source = path.join(directory, name, 'main.js'); fs.mkdirSync(path.dirname(source));
      fs.writeFileSync(source, index ? 'module.exports = 1;\n' : 'module.exports = value => value ? 1 : 0;\n');
      const report = {[source]: {path: source, statementMap: {0: {start: {line: 1}}}, s: {0: 1},
        branchMap: index ? {} : {0: {locations: [{}, {}]}}, b: index ? {} : {0: [1, 1]}}};
      fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(report));
      return {format: 'istanbul', report: `${name}.json`, source_directory: name};
    });
    fs.writeFileSync(path.join(directory, 'accepted.json'), JSON.stringify({version: 2, coverage: parts,
      verification: [['must-never-execute-from-coverage']]}));
    const run = override => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
      cwd: directory, encoding: 'utf8', env: {PATH: process.env.PATH, CLOUSEAU_ROOT: root,
        GITHUB_WORKSPACE: directory, COVERAGE_CONFIG: 'accepted.json', COVERAGE_REPORT: '',
        SOURCE_DIRECTORY: '', COVERAGE_FORMAT: 'llvm', ...override},
    });
    const passing = run();
    assert.equal(passing.status, 0, passing.stderr);
    assert.deepEqual(JSON.parse(passing.stdout).totals, {lines: [2, 2], branches: [2, 2]});
    assert.notEqual(run({COVERAGE_REPORT: 'backend.json'}).status, 0, 'ambiguous legacy report must fail');
    assert.notEqual(run({SOURCE_DIRECTORY: 'backend'}).status, 0, 'ambiguous legacy root must fail');
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'backend.json')));
    Object.values(report)[0].b[0][1] = 0;
    fs.writeFileSync(path.join(directory, 'backend.json'), JSON.stringify(report));
    const failing = run();
    assert.notEqual(failing.status, 0);
    assert.match(failing.stderr, /backend.json has uncovered branches/);
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});
