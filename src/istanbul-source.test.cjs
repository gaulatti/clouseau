'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const {counterSites} = require('./istanbul-source.cjs');

test('native zero-counter declarations remain distinct from missing statement counters', () => {
  const fixture = require('../test/fixtures/istanbul-statement-free.json');
  for (const item of fixture.cases) {
    assert.deepEqual(counterSites(item.source, path.extname(item.filename)),
      {statements: false, branches: false}, item.filename);
  }
  for (const source of ['const x = 1;', 'function f() { return 1; }', 'class X { x = 1; }',
    'class X { #x = 1; }', 'export default () => 1;', 'process.exit(99);']) {
    assert.equal(counterSites(source, '.js').statements, true, source);
  }
  assert.equal(counterSites('class X { #x; }', '.js').statements, false);
  assert.equal(counterSites('const View = () => <div/>;', '.tsx').statements, true);
  assert.equal(counterSites('return;', '.cjs').statements, true);
});

test('native branch-only declarations retain their independent branch requirement', () => {
  for (const source of ['function noop(value = 1) {}', 'export default flag ? 1 : 0;',
    'export default flag || 1;']) {
    assert.deepEqual(counterSites(source, '.js'), {statements: false, branches: true}, source);
  }
  assert.deepEqual(counterSites('if (flag) {}', '.js'), {statements: true, branches: true});
  assert.deepEqual(counterSites('switch (flag) {}', '.js'), {statements: true, branches: true});
});

test('CLI parses stdin as data and fails closed without echoing source on syntax errors', () => {
  const script = path.join(__dirname, 'istanbul-source.cjs');
  const inspect = input => cp.spawnSync(process.execPath, [script, '.js'], {input, encoding: 'utf8'});
  const value = inspect('process.exit(99);');
  assert.equal(value.status, 0);
  assert.deepEqual(JSON.parse(value.stdout), {statements: true, branches: false});
  const invalid = inspect('const = "do-not-echo-source";');
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'Cannot inspect native Istanbul counter sites\n');
});

test('the declared parser bundle retains its verified upstream identity', () => {
  const root = path.join(__dirname, '../vendor/babel-parser');
  const provenance = JSON.parse(fs.readFileSync(path.join(root, 'provenance.json')));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'index.cjs')))
    .digest('hex'), provenance.sha256);
  assert.equal(provenance.version, '7.29.0');
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Permission is hereby granted/);
});
