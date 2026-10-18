'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {digest} = require('../src/acceptance.cjs');

// Only the fixed, checked-in qualification cases call this helper. Production
// PR assessment never executes repository source or model-produced code.
function runFixture(source, tests) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-fixed-case-'));
  try {
    fs.mkdirSync(path.join(directory, 'src'));
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}\n');
    fs.writeFileSync(path.join(directory, 'src/upload.js'), source);
    fs.writeFileSync(path.join(directory, 'src/upload.test.js'), tests);
    fs.writeFileSync(path.join(directory, 'load.mjs'), "import './src/upload.js';\n");
    const result = spawnSync(process.execPath, ['--experimental-test-coverage', '--test-coverage-include=**/src/upload.js',
      '--test-reporter=lcov', '--test-reporter-destination=coverage.lcov', '--import=./load.mjs', '--test', 'src/upload.test.js'],
    {cwd: directory, env: {}, encoding: 'utf8', timeout: 10000});
    if (result.error || result.status !== 0) throw new Error('A fixed qualification fixture failed actual execution');
    const lcov = fs.readFileSync(path.join(directory, 'coverage.lcov'), 'utf8');
    const count = key => Number(lcov.match(new RegExp(`^${key}:([0-9]+)$`, 'm'))?.[1]);
    const lines = {count: count('LF'), covered: count('LH')};
    const branches = {count: count('BRF'), covered: count('BRH')};
    if (![lines.count, lines.covered, branches.count, branches.covered].every(Number.isSafeInteger) ||
        !lines.count || !branches.count) throw new Error('The fixed fixture lacks real nonempty coverage evidence');
    return {runtime: 'Node.js', version: process.version, exit_code: result.status,
      source_digest: digest(source), tests_digest: digest(tests), lines, branches,
      exact_coverage: lines.count === lines.covered && branches.count === branches.covered};
  } finally {fs.rmSync(directory, {recursive: true});}
}

module.exports = {runFixture};
