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

test('runtime projection omits entire compiler-erased scopes without hiding live siblings or property names', () => {
  const fixture = require('../test/fixtures/istanbul-erased-typescript.json');
  for (const item of fixture.ambient) {
    assert.deepEqual(counterSites(item.source, '.ts'), {statements: false, branches: false}, item.filename);
  }
  for (const item of fixture.runtime) {
    assert.equal(counterSites(item.source, '.ts').statements, true, item.filename);
  }
  assert.equal(counterSites('export const value: number = 1;', '.ts').statements, true);
  assert.equal(counterSites('function declaration() { return 1; }', '.js').statements, true);
  assert.equal(counterSites('export default {declare: true, typeAnnotation: () => 1};', '.js').statements, true);
});

const DECORATED = require('../test/fixtures/istanbul-decorated-typescript.json');
const NEST_MODULE = "import {Module} from '@nestjs/common'; @Module({}) export class AppModule {}";

test('decorator syntax stays unparsed unless the opt-in path is asked for (#261, dormant)', () => {
  assert.throws(() => counterSites(NEST_MODULE, '.ts'), error =>
    error.code === 'BABEL_PARSER_SYNTAX_ERROR' &&
    JSON.stringify(error.missingPlugin) === JSON.stringify(['decorators', 'decorators-legacy']));
  assert.throws(() => counterSites(NEST_MODULE, '.ts', {}), /decorators/);
  // JavaScript keeps its parser exactly: the option is TypeScript's syntax only.
  assert.throws(() => counterSites('@decorate class X {}', '.js', {decorators: true}), /decorators/);
});

test('the opt-in path classifies every decorated source as its native producers measure it', () => {
  assert.ok(DECORATED.cases.length >= 7);
  for (const item of DECORATED.cases) {
    assert.deepEqual(counterSites(item.source, path.extname(item.filename), {decorators: true}),
      item.classification, item.filename);
    // Every producer measured statements for every decorated file, so a decorator
    // is a statement site: an empty statement map for it is a missing measurement.
    for (const [producer, measured] of Object.entries(item.native)) {
      assert.ok(measured.statements > 0, `${item.filename} ${producer}`);
    }
    if (item.classification.branches) assert.ok(item.native.istanbul_ts.branches > 0, item.filename);
  }
  assert.deepEqual(counterSites(NEST_MODULE, '.ts', {decorators: true}), {statements: true, branches: false});
});

test('runtime code nested in decorator expressions is never hidden by the syntax support', () => {
  const inspect = source => counterSites(source, '.ts', {decorators: true});
  assert.deepEqual(inspect('@Module(flag ? {} : {imports: []}) export class M {}'), {statements: true, branches: true});
  assert.deepEqual(inspect('export class S { use(@Inject(token ?? "fallback") value: string): void {} }'),
    {statements: true, branches: true});
  assert.deepEqual(inspect('export class S { constructor(@Inject(TOKEN) private readonly x: string) {} }'),
    {statements: true, branches: false});
  assert.deepEqual(inspect('export class E { @Column() name: string; }'), {statements: true, branches: false});
  assert.deepEqual(inspect('@Module({providers: [{provide: "X", useFactory: () => 1}]}) export class F {}'),
    {statements: true, branches: false});
  assert.deepEqual(inspect('@Module({imports: [a || b]}) export class G {}'), {statements: true, branches: true});
  assert.deepEqual(inspect('@Module(build({lazy = true} = {})) export class H {}'), {statements: true, branches: true});
});

test('the opt-in path keeps compiler erasure and parses decorators as data, never executing them', () => {
  const inspect = source => counterSites(source, '.ts', {decorators: true});
  for (const item of require('../test/fixtures/istanbul-erased-typescript.json').ambient)
    assert.deepEqual(inspect(item.source), {statements: false, branches: false}, item.filename);
  assert.deepEqual(inspect('export interface Options { flag?: boolean }'), {statements: false, branches: false});
  // TypeScript refuses decorators on ambient or abstract members, but the parser
  // accepts them: they still mark the file, so an empty map can never pass.
  for (const source of ['@d export declare class X {}', 'export declare class Y { @p x: string; }',
    'declare namespace N { @d class Z {} }', 'export abstract class A { @p abstract m(): void; }'])
    assert.deepEqual(inspect(source), {statements: true, branches: false}, source);
  assert.deepEqual(inspect('export declare class Ambient { method(): void; }'), {statements: false, branches: false});
  assert.deepEqual(inspect('@(process.exit(99)) export class Exits {}'), {statements: true, branches: false});
  assert.equal(process.exitCode ?? 0, 0);
  assert.deepEqual(counterSites('const View = () => <div/>;', '.tsx', {decorators: true}), {statements: true, branches: false});
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
