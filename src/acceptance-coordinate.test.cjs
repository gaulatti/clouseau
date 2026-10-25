'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('../test/fixtures/acceptance.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {modelTemplate, materialize, validateInspection} = require('./acceptance-review.cjs');
const {validateReport} = require('./acceptance.cjs');

const captured = [
  {index: 12, path: 'src/installation-bootstrap.cjs', alias: 'proof-12-181', chunk: 'proof-12-161', start: 161, end: 200},
  {index: 14, path: 'src/installation-cli.cjs', alias: 'proof-14-61', chunk: 'proof-14-41', start: 41, end: 80},
  {index: 15, path: 'src/installation-cli.test.cjs', alias: 'proof-15-61', chunk: 'proof-15-41', start: 41, end: 80},
  {index: 24, path: 'src/local-receipt.cjs', alias: 'proof-24-141', chunk: 'proof-24-121', start: 121, end: 160},
  {index: 26, path: 'src/local-receipt.test.cjs', alias: 'proof-26-21', chunk: 'proof-26-1', start: 1, end: 40},
];

function manifest() {
  const {snapshot} = fixture(); snapshot.review_manifest_version = 1;
  for (let index = 2; index <= 26; index++) {
    snapshot.sources[`support-${index}`] = {kind: 'source', ref: snapshot.head_sha,
      path: captured.find(item => item.index === index)?.path || `src/support-${index}.cjs`,
      content: Array.from({length: 200}, (_, line) => `source ${index} statement ${line + 1}`).join('\n')};
  }
  refresh(snapshot);
  return {snapshot, facts: modelTemplate(snapshot)};
}

function legacyArrays(facts) {
  const legacy = structuredClone(facts);
  for (const item of [...legacy.coverage.sources, ...legacy.coverage.dependencies]) {
    if (item.evidence && !Array.isArray(item.evidence)) item.evidence = [item.evidence.primary, ...item.evidence.additional];
  }
  return legacy;
}

test('all five captured coordinate aliases produce exactly the legacy-array record and scores', () => {
  const {snapshot, facts} = manifest();
  for (const item of captured) {
    facts.coverage.sources[item.index].evidence = item.index === 26 ?
      {primary: item.alias, additional: [item.chunk]} : {primary: item.chunk, additional: [item.alias]};
  }
  facts.coverage.dependencies.push({path: captured[0].path, state: 'inspected',
    reason: 'Inspected the supplied current-head implementation.',
    evidence: {primary: captured[0].alias, additional: [captured[0].chunk, 'proof-12-200']}});
  const original = structuredClone(facts);
  const legacy = materialize(legacyArrays(facts), snapshot);
  const report = materialize(facts, snapshot);
  assert.deepEqual(facts, original, 'captured model-selected references are never rewritten');
  assert.deepEqual(report, legacy, 'object and legacy transports resolve the same supplied proof chunks');
  assert.doesNotThrow(() => validateInspection(report, snapshot));
  assert.deepEqual(validateReport(report, snapshot), validateReport(legacy, snapshot));
  assert.equal(validateReport(report, snapshot).decision, 'review_incomplete', 'transport equivalence supplies no missing grades');
  for (const item of captured) {
    assert.deepEqual(report.coverage.sources[item.index].evidence, [item.chunk]);
    const proof = report.evidence.find(entry => entry.id === item.chunk);
    assert.equal(proof.start, item.start); assert.equal(proof.end, item.end);
    assert.equal(proof.quote, snapshot.sources[`support-${item.index}`].content.split('\n').slice(item.start - 1, item.end).join('\n'));
  }
  assert.deepEqual(report.coverage.dependencies[0].evidence, ['proof-12-161'], 'distinct coordinates share existing chunk set semantics');
});

test('coverage proof objects retain the existing resolver boundaries and immutable-source checks', () => {
  const {snapshot, facts} = manifest();
  for (const id of ['proof-99-1', 'proof-12-201', 'proof-12-0', 'proof-012-181', 'proof-12-1.5', 'invented-alias']) {
    const invalid = structuredClone(facts);
    invalid.coverage.sources[12].evidence = {primary: id, additional: []};
    assert.throws(() => materialize(invalid, snapshot), /Factual coverage requires distinct controller-supplied proof IDs/);
    assert.throws(() => materialize(legacyArrays(invalid), snapshot), /Unknown controller-supplied source proof/);
  }
  snapshot.sources['support-2'].content = 'one supplied statement\n' + '\n'.repeat(199); refresh(snapshot);
  const blank = modelTemplate(snapshot);
  blank.coverage.sources[2].evidence = {primary: 'proof-2-61', additional: []};
  assert.throws(() => materialize(blank, snapshot), /Factual coverage requires distinct controller-supplied proof IDs/,
    'an offset in an unsupplied blank block cannot invent a chunk');
  const crossSource = modelTemplate(snapshot);
  crossSource.coverage.sources[14].evidence = {primary: 'proof-12-181', additional: []};
  assert.throws(() => validateInspection(materialize(crossSource, snapshot), snapshot), /inspection lacks direct immutable evidence/);
  for (const evidence of [{primary: 'proof-12-181'}, {primary: 'proof-12-181', additional: null},
    {primary: 'proof-12-181', additional: ['proof-12-181']}, {primary: 'proof-12-181', additional: [], extra: true}]) {
    const malformed = modelTemplate(snapshot); malformed.coverage.sources[12].evidence = evidence;
    assert.throws(() => materialize(malformed, snapshot), /Factual coverage requires/);
  }
});
