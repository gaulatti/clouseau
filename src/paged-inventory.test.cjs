'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pagedFixture} = require('../test/paged-review-fixture.cjs');
const {modelTemplate, materialize} = require('./acceptance-review.cjs');
const {pageSchema} = require('./paged-review.cjs');

test('every paged source has a required native index slot and normalization preserves each submitted disposition', async () => {
  const f = await pagedFixture(); const facts = modelTemplate(f.snapshot);
  const slots = pageSchema(f.snapshot).properties.report.anyOf[0].properties.coverage.properties.sources;
  const expected = Object.keys(f.snapshot.sources).map((_, index) => String(index));
  assert.equal(slots.type, 'object'); assert.equal(slots.additionalProperties, false);
  assert.deepEqual(slots.required, expected); assert.deepEqual(Object.keys(facts.coverage.sources), expected);
  const original = structuredClone(facts);
  const report = materialize(facts, f.snapshot);
  assert.deepEqual(facts, original);
  for (const [index, item] of report.coverage.sources.entries()) {
    assert.deepEqual(item, {source: Object.keys(f.snapshot.sources)[index], ...facts.coverage.sources[String(index)]});
  }
  for (const mutate of [
    value => {delete value.coverage.sources['0'];},
    value => {value.coverage.sources['999'] = value.coverage.sources['0'];},
    value => {value.coverage.sources['01'] = value.coverage.sources['1']; delete value.coverage.sources['1'];},
    value => {value.coverage.sources = Object.values(value.coverage.sources);},
    value => {value.coverage.sources = null;},
    value => {delete value.coverage;},
    value => {value.coverage.sources['0'] = null;},
    value => {value.coverage.sources['0'].source = 3;},
    value => {value.coverage.sources['0'].evidence = {primary: 'proof-0-1', additional: []};},
  ]) {
    const invalid = structuredClone(facts); mutate(invalid);
    assert.throws(() => materialize(invalid, f.snapshot), /paged inventory|paged source slots/);
  }
});
