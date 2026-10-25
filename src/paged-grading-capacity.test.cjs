'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {capacityFixture} = require('../test/paged-capacity-fixture.cjs');
const {responder} = require('../test/paged-review-fixture.cjs');
const {inspectPaged} = require('./paged-review.cjs');
const {gradeReport, packetFor, locations} = require('./acceptance-grading.cjs');
const {JEV_MODEL, JEV_PACKET_LIMIT} = require('./review-provider.cjs');

test('a full large inventory retains distinct literal reasons and source identities inside the unchanged routed grading limit', async () => {
  const f = await capacityFixture(); const model = responder(f, value => {
    if (value.kind === 'report') for (const [index, item] of Object.entries(value.report.coverage.sources)) {
      item.reason = `Source ${index} was examined as supplied immutable material; its exact path and revision remain in the catalog. ` +
        'All required pages were available.';
    }
    return value;
  });
  const inspection = await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask});
  const preserved = structuredClone(inspection);
  const audit = packetFor(locations(inspection.report).find(item => item.id === 'review_completeness'), inspection.report, f.snapshot, inspection);
  assert.deepEqual(audit.context.coverage.sources.rows.map(([, state, reason, evidence]) => [audit.context.coverage.dispositions[state], reason, evidence]),
    inspection.report.coverage.sources.map(({state, reason, evidence}) => [state, reason, evidence]));
  assert.deepEqual(audit.context.available_sources.rows.map(([index, path, revision, kind]) =>
    [index, path, audit.context.revisions[revision], audit.context.source_kinds[kind]]),
  Object.values(f.snapshot.sources).map((source, index) => [index, source.path, source.ref, source.kind]));
  const old = ['TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY'].map(name => process.env[name]);
  process.env.TYPESAFE_API_KEY = 'fictional-only'; process.env.DEEPSEEK_API_KEY = 'fictional-only';
  const packets = [];
  try {
    const graded = await gradeReport({report: inspection.report, snapshot: f.snapshot, inspection, provider: 'routed',
      model: 'deepseek-flash', fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body); const packet = body.questions ? body : JSON.parse(body.messages[1].content);
        packets.push({provider: url.includes('typesafe') ? 'typesafe' : 'deepseek', ids: Object.keys(packet.questions)});
        const answer = id => id === 'review_completeness' ? 'unknown' : id.includes('_excess_') ? 'level0' : 'level4';
        if (body.questions) {
          assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= JEV_PACKET_LIMIT);
          return {ok: true, json: async () => ({model: JEV_MODEL, answers: Object.fromEntries(Object.keys(packet.questions).map(id =>
            [id, {type: 'choice', choice: answer(id), confidence: 1, probabilities: Object.fromEntries(
              ['level0', 'level1', 'level2', 'level3', 'level4', 'unknown'].map(level => [level, level === answer(id) ? 1 : 0]))}]))})};
        }
        return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers:
          Object.fromEntries(Object.keys(packet.questions).map(id => [id, answer(id)]))})}}]})};
      }});
    assert.equal(graded.report.gates.find(item => item.name === 'review_completeness').state, 'unresolved');
    assert.ok(packets.some(packet => packet.provider === 'typesafe' && packet.ids.includes('review_completeness')));
    assert.ok(packets.some(packet => packet.provider === 'deepseek' && packet.ids.includes('review_completeness')));
    assert.deepEqual(inspection, preserved);
  } finally {
    for (const [index, name] of ['TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY'].entries()) {
      if (old[index] === undefined) delete process.env[name]; else process.env[name] = old[index];
    }
  }
});
