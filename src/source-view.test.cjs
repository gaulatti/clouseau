'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {digest} = require('./acceptance.cjs');
const {LIMITS} = require('./source-bank.cjs');
const {createSourceView, prepareSourcePages, recordSourcePages, sourceExposure, verifySourceExposure,
  MAX_VIEW_ROUNDS} = require('./source-view.cjs');

function fixture() {
  const snapshot = {version: 2, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), repository: 'fixture/producer',
    sources: {contract: {path: 'README.md', ref: 'b'.repeat(40), authority: 'trusted', kind: 'contract', content: 'Verify all required source.\n'},
      head: {path: 'src/handler.js', ref: 'a'.repeat(40), authority: 'untrusted', kind: 'source',
        content: 'const value = true;\n' + 'x'.repeat(LIMITS.page_bytes * 2)}},
    files: [{path: 'src/handler.js', status: 'added', head_source: 'head', patch: '@@ added source @@'}],
    history: [], tickets: [], claims: {title: 'A frozen source-view fixture'}};
  snapshot.digest = digest(snapshot);
  const report = {evidence: [{id: 'contract', source: 'contract', start: 1, end: 1, quote: 'Verify all required source.'},
    {id: 'head', source: 'head', start: 1, end: 1, quote: 'const value = true;'}],
  coverage: {sources: [{source: 'contract', state: 'inspected', evidence: ['contract']},
    {source: 'head', state: 'inspected', evidence: ['head']}], dependencies: []},
  gates: [{name: 'review_completeness', state: 'satisfied'}]};
  return {snapshot, report};
}

const provenance = (role, index) => ({role, phase: 'investigation', request_digest: digest(['request', index]),
  response_digest: digest(['response', index]), transport_digest: digest(['transport', index])});

function deliver(view, entry, page, index = 0) {
  const request = {bank_digest: view.bank.bank_digest, pages: [{entry, page}]};
  const payload = prepareSourcePages(view, request);
  const invocation = provenance(view.role, index);
  recordSourcePages(view, invocation);
  return {payload, invocation};
}

function deliverAll(view) {
  const usage = []; let index = 0;
  for (const entry of view.bank.entries) for (let page = 0; page < entry.page_count; page++) {
    usage.push(deliver(view, entry.entry, page, index++).invocation);
  }
  return usage;
}

test('each role records only acknowledged immutable page deliveries and cannot borrow another role inspection', () => {
  const f = fixture();
  const examiner = createSourceView(f.snapshot, 'examiner');
  const challenger = createSourceView(f.snapshot, 'challenger');
  const usage = deliverAll(examiner);
  const exposure = sourceExposure(examiner);
  assert.doesNotThrow(() => verifySourceExposure(f.snapshot, f.report, exposure, usage));
  assert.equal(sourceExposure(challenger).rounds.length, 0);
  assert.throws(() => verifySourceExposure(f.snapshot, f.report, sourceExposure(challenger), usage), /unseen/);
  assert.equal(JSON.stringify(exposure).includes(f.snapshot.sources.head.content.slice(0, 100)), false,
    'delivery receipts bind hashes and execution provenance without copying source text');
  const changed = structuredClone(f.snapshot); changed.sources.head.content += 'changed'; delete changed.digest; changed.digest = digest(changed);
  assert.throws(() => verifySourceExposure(changed, f.report, exposure, usage), /identity/);
});

test('citing an inspected line cannot stand in for unread required source, patch or context pages', () => {
  const f = fixture(); const view = createSourceView(f.snapshot, 'examiner');
  const contract = view.bank.entries.find(item => item.source === 'contract');
  const head = view.bank.entries.find(item => item.source === 'head');
  deliver(view, contract.entry, 0, 0); deliver(view, head.entry, 0, 1);
  assert.throws(() => verifySourceExposure(f.snapshot, f.report, sourceExposure(view)), /unseen/);
  const missing = structuredClone(f.report); missing.coverage.sources[1].state = 'missing';
  missing.coverage.sources[1].evidence = [];
  missing.gates[0].state = 'unresolved';
  assert.doesNotThrow(() => verifySourceExposure(f.snapshot, missing, sourceExposure(view)),
    'an honest unresolved report may retain its actually inspected citations');
  for (let page = 1; page < head.page_count; page++) deliver(view, head.entry, page, page + 1);
  assert.throws(() => verifySourceExposure(f.snapshot, f.report, sourceExposure(view)), /required page/);
  for (const entry of view.bank.entries.filter(item => ['patch', 'context'].includes(item.kind))) {
    for (let page = 0; page < entry.page_count; page++) deliver(view, entry.entry, page, 20 + entry.entry + page);
  }
  assert.doesNotThrow(() => verifySourceExposure(f.snapshot, f.report, sourceExposure(view)));
});

test('unexposed citation bytes and dependency bodies cannot claim inspected material', () => {
  const f = fixture(); const view = createSourceView(f.snapshot, 'examiner');
  const contract = view.bank.entries.find(item => item.source === 'contract');
  deliver(view, contract.entry, 0);
  assert.throws(() => verifySourceExposure(f.snapshot, f.report, sourceExposure(view)), /citation/);
  const partial = structuredClone(f.report); partial.evidence.pop(); partial.coverage.sources[1].state = 'missing';
  partial.coverage.sources[1].evidence = [];
  partial.gates[0].state = 'unresolved';
  partial.coverage.dependencies.push({path: 'src/handler.js', state: 'inspected', evidence: ['contract']});
  assert.throws(() => verifySourceExposure(f.snapshot, partial, sourceExposure(view)), /dependency/);
});

test('a citation spanning native page boundaries requires every intervening byte, including a non-first-line prefix', () => {
  const f = fixture(); const view = createSourceView(f.snapshot, 'examiner');
  const contract = view.bank.entries.find(item => item.source === 'contract');
  const head = view.bank.entries.find(item => item.source === 'head');
  f.report.evidence[1] = {...f.report.evidence[1], start: 2, end: 2, quote: f.snapshot.sources.head.content.split('\n')[1]};
  f.report.gates[0].state = 'unresolved';
  deliver(view, contract.entry, 0, 0); deliver(view, head.entry, 0, 1); deliver(view, head.entry, 2, 2);
  assert.throws(() => verifySourceExposure(f.snapshot, f.report, sourceExposure(view)), /unseen citation/);
  deliver(view, head.entry, 1, 3);
  assert.doesNotThrow(() => verifySourceExposure(f.snapshot, f.report, sourceExposure(view)));
});

test('current-head dependencies require their whole body while excluded dependencies cannot claim an inspection', () => {
  const f = fixture(); const view = createSourceView(f.snapshot, 'examiner'); deliverAll(view);
  f.report.coverage.dependencies = [{path: 'src/handler.js', state: 'inspected', evidence: ['head']},
    {path: 'unrelated/optional.js', state: 'excluded', evidence: ['contract']}];
  assert.doesNotThrow(() => verifySourceExposure(f.snapshot, f.report, sourceExposure(view)));
  const stale = structuredClone(f.report); stale.coverage.dependencies[0] = {path: 'README.md', state: 'inspected', evidence: ['contract']};
  assert.throws(() => verifySourceExposure(f.snapshot, stale, sourceExposure(view)), /dependency/);
  const partial = createSourceView(f.snapshot, 'examiner');
  deliver(partial, 0, 0, 0); deliver(partial, 1, 0, 1);
  const unresolved = structuredClone(f.report); unresolved.coverage.sources[1] = {source: 'head', state: 'missing', evidence: []};
  unresolved.gates[0].state = 'unresolved';
  assert.throws(() => verifySourceExposure(f.snapshot, unresolved, sourceExposure(partial)), /dependency/);
});

test('pending calls, invalid provenance and page-budget exhaustion fail without inventing delivery', () => {
  const f = fixture();
  assert.throws(() => createSourceView(f.snapshot, 'another-role'));
  const view = createSourceView(f.snapshot, 'examiner');
  assert.throws(() => recordSourcePages(view, provenance('examiner', 0)), /pending/);
  prepareSourcePages(view, {bank_digest: view.bank.bank_digest, pages: [{entry: 0, page: 0}]});
  assert.throws(() => sourceExposure(view), /pending/);
  assert.throws(() => prepareSourcePages(view, {bank_digest: view.bank.bank_digest, pages: [{entry: 0, page: 0}]}), /pending/);
  for (const invalid of [null, provenance('challenger', 0), {...provenance('examiner', 0), phase: 'grading'},
    {...provenance('examiner', 0), request_digest: 'invalid'}]) assert.throws(() => recordSourcePages(view, invalid));
  recordSourcePages(view, provenance('examiner', 0));
  for (let index = 1; index < MAX_VIEW_ROUNDS; index++) deliver(view, 0, 0, index);
  assert.equal(sourceExposure(view).rounds.length, MAX_VIEW_ROUNDS);
  assert.throws(() => prepareSourcePages(view, {bank_digest: view.bank.bank_digest, pages: [{entry: 0, page: 0}]}), /budget/);
});

test('substituted page digests, missing execution, duplicate invocation and forged receipts are rejected', () => {
  const f = fixture(); const view = createSourceView(f.snapshot, 'examiner'); const usage = deliverAll(view);
  const original = sourceExposure(view);
  for (const mutate of [
    value => {value.version = 2;}, value => {value.role = 'unknown';}, value => {value.extra = true;},
    value => {value.bank_digest = '0'.repeat(64);}, value => {value.rounds[0].pages_digest = '0'.repeat(64);},
    value => {value.rounds[0].request.bank_digest = '0'.repeat(64);},
    value => {value.rounds[1].invocation = value.rounds[0].invocation;},
    value => {value.rounds[0].invocation.transport_digest = 'invalid';},
    value => {value.rounds[0].extra = true;},
  ]) {
    const changed = structuredClone(original); mutate(changed);
    assert.throws(() => verifySourceExposure(f.snapshot, f.report, changed, usage));
  }
  assert.throws(() => verifySourceExposure(f.snapshot, f.report, original, usage.slice(1)), /execution/);
});
