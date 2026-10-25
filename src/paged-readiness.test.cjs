'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pagedFixture, responder} = require('../test/paged-review-fixture.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {digest} = require('./acceptance.cjs');
const {pageSchema, inspectPaged} = require('./paged-review.cjs');
const {createSourceView, sourceExposure, prepareSourcePages, recordSourcePages, pageAvailability} = require('./source-view.cjs');

const provenance = index => ({role: 'examiner', phase: 'investigation', request_digest: digest(['request', index]),
  response_digest: digest(['response', index]), transport_digest: digest(['transport', index])});

test('actual available bytes constrain inspected source and completeness choices without acknowledging a pending invocation', async () => {
  const f = await pagedFixture();
  f.snapshot.sources.optional = {path: 'src/optional.js', ref: f.snapshot.head_sha, kind: 'source', authority: 'untrusted',
    content: 'Optional unchanged material.\n'.repeat(3000)};
  refresh(f.snapshot);
  const view = createSourceView(f.snapshot, 'examiner'); const before = sourceExposure(view);
  const initial = pageAvailability(f.snapshot, view.bank, before);
  assert.equal(initial.completeness_ready, false); assert.deepEqual(initial.inspected_sources, []);
  const restricted = pageSchema(f.snapshot, initial).properties.report.anyOf[0].properties;
  const gate = restricted.gates.items.anyOf.find(item => item.properties.name.enum.includes('review_completeness'));
  assert.deepEqual(gate.properties.state.enum, ['unresolved', 'violated']);
  assert.ok(Object.values(restricted.coverage.properties.sources.properties).every(item => !item.properties.state.enum.includes('inspected')));
  const first = view.bank.entries.find(entry => entry.source_kind === 'contract');
  const current = prepareSourcePages(view, {bank_digest: view.bank.bank_digest, pages: [{entry: first.entry, page: 0}]});
  const prospective = pageAvailability(f.snapshot, view.bank, before, current);
  assert.ok(prospective.inspected_sources.includes(first.source));
  assert.equal(before.rounds.length, 0);
  assert.throws(() => sourceExposure(view), /pending page/);
  recordSourcePages(view, provenance(0));
  let index = 1;
  for (const entry of view.bank.entries.filter(entry => entry.source !== 'optional')) for (let page = 0; page < entry.page_count; page++) {
    prepareSourcePages(view, {bank_digest: view.bank.bank_digest, pages: [{entry: entry.entry, page}]});
    recordSourcePages(view, provenance(index++));
  }
  const ready = pageAvailability(f.snapshot, view.bank, sourceExposure(view));
  assert.equal(ready.completeness_ready, true); assert.deepEqual(ready.required_unread_page_selectors, []);
  assert.ok(!ready.inspected_sources.includes('optional'));
  const available = pageSchema(f.snapshot, ready).properties.report.anyOf[0].properties;
  assert.ok(available.gates.items.properties.state.enum.includes('satisfied'));
  const optional = available.coverage.properties.sources.properties[String(Object.keys(f.snapshot.sources).indexOf('optional'))];
  assert.ok(!optional.properties.state.enum.includes('inspected'));
  const dependencies = available.coverage.properties.dependencies.items.anyOf.find(item => item.properties.state.enum.includes('inspected'));
  assert.ok(!dependencies.properties.path.enum.includes('src/optional.js'));
});

test('unread required pages are explicit in each real driver frame and its syntax template makes no inspection claim', async () => {
  const f = await pagedFixture(); const seen = [];
  const model = responder(f, (value, {task, packet}) => {
    seen.push(packet.review_context.completeness_claim_available);
    if (packet.required_unread_page_selectors.length) {
      assert.equal(packet.review_context.completeness_claim_available, false);
      for (const item of Object.values(packet.template.coverage.sources).filter(item => item.state === 'missing')) assert.deepEqual(item.evidence, []);
      const gates = task.schema.properties.report.anyOf[0].properties.gates.items.anyOf;
      assert.ok(!gates.find(item => item.properties.name.enum.includes('review_completeness')).properties.state.enum.includes('satisfied'));
    } else assert.equal(packet.review_context.completeness_claim_available, true);
    return value;
  });
  await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask});
  assert.equal(seen[0], false); assert.equal(seen.at(-1), true);
});

test('availability rejects stale banks and invalid pending selectors, and a wholly changed source cannot be excluded', async () => {
  const f = await pagedFixture(); const view = createSourceView(f.snapshot, 'examiner'); const exposure = sourceExposure(view);
  for (const change of [{snapshot_digest: '0'.repeat(64)}, {bank_digest: '0'.repeat(64)}]) {
    assert.throws(() => pageAvailability(f.snapshot, view.bank, {...exposure, ...change}), /availability identity/);
  }
  for (const selector of [{entry: '0', page: 0}, {entry: 0, page: -1}, {entry: 0, page: 999}, {entry: 999, page: 0}]) {
    assert.throws(() => pageAvailability(f.snapshot, view.bank, exposure, [{...selector, bank_digest: view.bank.bank_digest}]), /availability selector/);
  }
  assert.throws(() => pageAvailability(f.snapshot, view.bank, exposure, [{entry: 0, page: 0, bank_digest: '0'.repeat(64)}]), /page identity/);
  const only = structuredClone(f.snapshot); const file = only.files[0];
  only.sources = {head: only.sources[file.head_source]}; only.files = [{...file, status: 'added', head_source: 'head'}];
  delete only.files[0].base_source; refresh(only);
  const coverage = pageSchema(only, {inspected_sources: [], completeness_ready: false})
    .properties.report.anyOf[0].properties.coverage.properties.sources.properties;
  assert.deepEqual(coverage['0'].properties.state.enum, ['missing']);
});
