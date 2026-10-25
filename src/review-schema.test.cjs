'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {compactSchema} = require('./review-schema.cjs');
const {pageSchema} = require('./paged-review.cjs');
const {pageFunctions} = require('./paged-provider.cjs');
const {pagedFixture} = require('../test/paged-review-fixture.cjs');

function expand(value, root = value) {
  if (Array.isArray(value)) return value.map(item => expand(item, root));
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    const [, key, id] = value.$ref.split('/');
    assert.ok(['$defs', '$def'].includes(key) && root[key][id]);
    const {$ref, ...siblings} = value;
    return {...expand(root[key][id], root), ...expand(siblings, root)};
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['$defs', '$def'].includes(key))
    .map(([key, item]) => [key, expand(item, root)]));
}

test('shared controller schema objects and enums expand to the exact original constraints in both transports', async () => {
  const f = await pagedFixture();
  const schema = pageSchema(f.snapshot);
  const untouched = structuredClone(schema);
  const local = compactSchema(schema);
  assert.deepEqual(expand(local), schema);
  assert.deepEqual(schema, untouched);
  assert.ok(Object.keys(local.$defs).some(key => key.startsWith('object_')));
  assert.deepEqual(compactSchema(local), local);
  const functions = pageFunctions(schema);
  for (const parameters of Object.values(functions)) {
    assert.ok(!Object.hasOwn(parameters, '$defs'));
    const plain = expand(parameters);
    assert.equal(plain.type, 'object'); assert.equal(plain.additionalProperties, false);
    assert.deepEqual(plain.required, Object.keys(plain.properties));
  }
  assert.deepEqual(expand(functions.acceptance_report).properties.report, schema.properties.report.anyOf[0]);
  assert.deepEqual(compactSchema(functions.acceptance_report, {definitionKey: '$def'}), functions.acceptance_report);
  assert.deepEqual(compactSchema({type: 'object', properties: {literal: null}}), {type: 'object', properties: {literal: null}});
  assert.throws(() => compactSchema(schema, {definitionKey: 'definitions'}), /Unsupported/);
});
