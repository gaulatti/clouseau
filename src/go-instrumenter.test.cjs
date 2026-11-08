'use strict';
// Runs the real tools/goinstr program (Go is required; the test is skipped without it) and checks that what it
// writes is what the committed reports contain, which src/coverage-gooutcomes.test.cjs reads without Go.
// The per-outcome-class proofs live in tools/goinstr/main_test.go, which this test also runs.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const gate = require('./coverage-gate.cjs');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'goinstr');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'go-outcomes');
const hasGo = spawnSync('go', ['version']).status === 0;
const go = (cwd, args) => {
  const result = spawnSync('go', args, {cwd, encoding: 'utf8'});
  assert.equal(result.status, 0, `go ${args.join(' ')}\n${result.stdout}${result.stderr}`);
  return result.stdout;
};

test('goinstr produces the committed report for the fixture module and the gate measures it', {skip: !hasGo}, () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-goinstr-')));
  try {
    const app = path.join(directory, 'app');
    fs.cpSync(path.join(FIXTURES, 'app'), app, {recursive: true});
    const tool = path.join(directory, 'goinstr');
    go(TOOL, ['build', '-o', tool, '.']);
    const run = args => {
      const result = spawnSync(tool, args, {cwd: app, encoding: 'utf8'});
      assert.equal(result.status, 0, result.stderr);
    };
    const host = path.join(directory, 'host');
    const windows = path.join(directory, 'windows');
    run(['instrument', '-module', '.', '-work', host]);
    run(['instrument', '-module', '.', '-work', windows, '-goos', 'windows', '-goarch', 'amd64']);
    go(app, ['test', '-count=1', `-overlay=${path.join(host, 'overlay.json')}`, './...']);
    const report = path.join(directory, 'report.json');
    run(['report', '-out', report, '-run', host, '-run', windows]);
    const produced = JSON.parse(fs.readFileSync(report, 'utf8'));
    const committed = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'full.json'), 'utf8'));
    assert.deepEqual({...produced, go_version: null, builds: null}, {...committed, go_version: null, builds: null});
    assert.deepEqual(gate.counters(produced, app, 'gooutcomes', app), {lines: [54, 48], branches: [46, 44]});
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});

test('the goinstr program passes its own tests, vet and formatting', {skip: !hasGo}, () => {
  go(TOOL, ['vet', './...']);
  go(TOOL, ['test', '-count=1', './...']);
  const formatted = spawnSync('gofmt', ['-l', TOOL], {encoding: 'utf8'});
  assert.equal(formatted.stdout, '');
});
