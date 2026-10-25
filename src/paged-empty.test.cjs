'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pagedFixture, responder} = require('../test/paged-review-fixture.cjs');
const {inspectPaged} = require('./paged-review.cjs');
const {refresh, proofCatalog} = require('./acceptance-sources.cjs');
const {modelTemplate, materialize} = require('./acceptance-review.cjs');
const {validateFacts} = require('./acceptance.cjs');

test('empty added, removed and renamed source retains literal proofs and complete page inspection', async () => {
  for (const [status, content] of [['added', ''], ['removed', ' \t\n'], ['renamed', '\n'.repeat(85)]]) {
    const f = await pagedFixture(); const file = f.snapshot.files[0];
    const source = file.head_source; f.snapshot.sources[source].content = content; file.status = status;
    if (status === 'removed') {file.base_source = source; delete file.head_source; f.snapshot.sources[source].ref = f.snapshot.base_sha;}
    if (status === 'renamed') f.snapshot.sources[source].path = 'src/previous-empty-name.js';
    refresh(f.snapshot);
    const facts = modelTemplate(f.snapshot);
    assert.ok(proofCatalog(f.snapshot).some(proof => proof.source === source));
    const report = materialize(facts, f.snapshot);
    assert.doesNotThrow(() => validateFacts(report, f.snapshot));
    const literal = report.evidence.find(proof => proof.source === source);
    assert.equal(literal.quote, content.split('\n').slice(literal.start - 1, literal.end).join('\n'));
    const model = responder(f); const result = await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask});
    assert.equal(result.report.coverage.sources.find(item => item.source === source).state, 'inspected');
    assert.ok(model.packets.some(packet => packet.pages.some(page => page.text === content)));
    const invented = structuredClone(report); invented.evidence.find(proof => proof.source === source).quote = 'invented nonempty source';
    assert.throws(() => validateFacts(invented, f.snapshot), /citation does not match/);
    const partial = structuredClone(report);
    const nonempty = partial.evidence.find(proof => f.snapshot.sources[proof.source].content.trim());
    nonempty.quote = '';
    assert.throws(() => validateFacts(partial, f.snapshot), /citation does not match/);
    const unread = responder(f, value => ({...value, concerns: [{id: 'unread-empty', title: 'Unread source identity', path: file.path,
      cause: 'The empty source has not been delivered.', obligation: 'Inspect the immutable source.',
      evidence: [proofCatalog(f.snapshot).find(proof => proof.source === source).id]}]}));
    await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: unread.ask}), /unseen citation bytes/);
  }
});
