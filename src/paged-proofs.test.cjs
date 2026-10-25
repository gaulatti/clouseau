'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {digest} = require('./acceptance.cjs');
const {refresh, proofCatalog} = require('./acceptance-sources.cjs');
const {createSourceView, sourceExposure, prepareSourcePages, recordSourcePages, pageAvailability} = require('./source-view.cjs');
const {pageProofs, pageSchema} = require('./paged-review.cjs');
const {citableProofs, MAX_PROOF_CATALOG_BYTES} = require('./paged-proofs.cjs');
const {readSourcePages} = require('./source-bank.cjs');

function fixture(content = Array.from({length: 240}, (_, i) => `// Actual source line ${i + 1}`).join('\n')) {
  const snapshot = {version: 2, source_bank_version: 1, repository: 'fixture/producer', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
    sources: {head: {path: 'src/producer.js', ref: 'b'.repeat(40), authority: 'untrusted', kind: 'source', content}},
    files: [{path: 'src/producer.js', status: 'added', head_source: 'head', patch: '@@ actual fixture patch @@\n'}],
    history: [], tickets: [], claims: {title: 'Bounded native proof selection fixture'}};
  refresh(snapshot); return snapshot;
}
function acknowledge(view, number) {
  recordSourcePages(view, {role: view.role, phase: 'investigation', request_digest: digest(['request', number]),
    response_digest: digest(['response', number]), transport_digest: digest(['transport', number])});
}
function prepare(view, pages) {
  const exposure = sourceExposure(view);
  const literal = prepareSourcePages(view, {bank_digest: view.bank.bank_digest, pages});
  return {exposure, literal};
}

test('the report schema offers actual source proofs instead of inventible patch-entry aliases', () => {
  const snapshot = fixture(); const view = createSourceView(snapshot, 'examiner');
  const {exposure, literal} = prepare(view, [{entry: 0, page: 0}]);
  const available = citableProofs(snapshot, view, exposure, literal, pageProofs(snapshot, view, literal));
  assert.ok(available.length > 1);
  assert.ok(available.every(proof => proof.source_index === 0 && proof.id.startsWith('proof-0-')));
  const schema = pageSchema(snapshot, pageAvailability(snapshot, view.bank, exposure, literal), [], available.map(proof => proof.id));
  const allowed = schema.properties.report.anyOf[0].properties.units.items.properties.fit.properties.outcome.properties.evidence.items.enum;
  assert.deepEqual(allowed, available.map(proof => proof.id));
  assert.equal(allowed.includes('proof-1-1'), false, 'entry1 is a patch, not a source');
  assert.throws(() => sourceExposure(view), /pending/);
  acknowledge(view, 0);
  const metadata = prepare(view, [{entry: 1, page: 0}, {entry: 2, page: 0}]);
  assert.deepEqual(citableProofs(snapshot, view, metadata.exposure, metadata.literal,
    pageProofs(snapshot, view, metadata.literal)).map(proof => proof.id), ['proof-0-1']);
  acknowledge(view, 1);
});

test('a cross-page UTF-8 proof is citable only when every byte is available to this role, including current pending pages', () => {
  const snapshot = fixture('first line\n' + '🧭'.repeat(16000) + '\nlast line');
  const view = createSourceView(snapshot, 'examiner');
  assert.deepEqual(citableProofs(snapshot, view, sourceExposure(view), [], []), []);
  let delivery = prepare(view, [{entry: 0, page: 0}]);
  assert.deepEqual(citableProofs(snapshot, view, delivery.exposure, delivery.literal, proofCatalog(snapshot)), []);
  acknowledge(view, 0);
  delivery = prepare(view, [{entry: 0, page: 2}]);
  assert.deepEqual(citableProofs(snapshot, view, delivery.exposure, delivery.literal, proofCatalog(snapshot)), []);
  acknowledge(view, 1);
  delivery = prepare(view, [{entry: 0, page: 1}]);
  assert.deepEqual(citableProofs(snapshot, view, delivery.exposure, delivery.literal, proofCatalog(snapshot)).map(proof => proof.id), ['proof-0-1']);
  assert.equal(delivery.exposure.rounds.length, 2, 'prospective availability never invents an acknowledged invocation');
  acknowledge(view, 2);
  const other = createSourceView(snapshot, 'challenger');
  assert.throws(() => citableProofs(snapshot, other, sourceExposure(view), [], []), /owning view/);
  for (const change of [{bank_digest: 'f'.repeat(64)}, {snapshot_digest: 'f'.repeat(64)}]) {
    assert.throws(() => citableProofs(snapshot, view, {...sourceExposure(view), ...change}, [], []), /owning view/);
  }
  assert.throws(() => citableProofs(snapshot, view, sourceExposure(view), [{...delivery.literal[0], bank_digest: 'f'.repeat(64)}], []), /owning view/);
});

test('first proofs and all earlier structured citations persist; another range can be exposed by requesting its source again', () => {
  const snapshot = fixture(); const view = createSourceView(snapshot, 'examiner');
  const delivery = prepare(view, [{entry: 0, page: 0}]); acknowledge(view, 0);
  const progress = [{response: {concerns: [{evidence: ['proof-0-53', 'proof-999-1']}],
    report: {coverage: {dependencies: [{evidence: {primary: 'proof-0-121', additional: ['proof-0-161']}}]}}}}];
  const drafts = [{findings: [{anchor: 'proof-0-81'}], evidence: [{id: 'native register object'}]}];
  const selected = citableProofs(snapshot, view, sourceExposure(view), [], [], progress, drafts);
  assert.deepEqual(selected.map(proof => proof.id), ['proof-0-1', 'proof-0-41', 'proof-0-121', 'proof-0-161', 'proof-0-81']);
  assert.equal(selected.some(proof => proof.id === 'proof-0-201'), false);
  const bookmarked = citableProofs(snapshot, view, sourceExposure(view), [], [], [
    {response: {observations: 'Positive evidence: proof-0-201. Unknown proof-999-1 and noncanonical proof-0-53 cannot register new proof IDs.'}},
    {response: {observations: 42}},
  ]);
  assert.deepEqual(bookmarked.map(proof => proof.id), ['proof-0-1', 'proof-0-201']);
  const repeated = prepare(view, [{entry: 0, page: 0}]);
  const exposed = citableProofs(snapshot, view, repeated.exposure, repeated.literal, pageProofs(snapshot, view, repeated.literal), progress, drafts);
  assert.ok(exposed.some(proof => proof.id === 'proof-0-201'));
  acknowledge(view, 1);
  assert.equal(delivery.literal[0].sha256, repeated.literal[0].sha256);
});

test('empty files require an actual empty page, and an exhausted proof catalog fails without truncating source', () => {
  const empty = fixture(''); const view = createSourceView(empty, 'examiner');
  assert.deepEqual(citableProofs(empty, view, sourceExposure(view), [], []), []);
  const delivery = prepare(view, [{entry: 0, page: 0}]);
  assert.deepEqual(citableProofs(empty, view, delivery.exposure, delivery.literal, pageProofs(empty, view, delivery.literal)).map(proof => proof.id), ['proof-0-1']);
  acknowledge(view, 0);
  const dense = fixture('\n'.repeat(127999)); const large = createSourceView(dense, 'examiner');
  const selectors = Array.from({length: large.bank.entries[0].page_count}, (_, page) => ({entry: 0, page}));
  const current = prepare(large, selectors);
  assert.ok(proofCatalog(dense).length * 50 > MAX_PROOF_CATALOG_BYTES);
  assert.throws(() => citableProofs(dense, large, current.exposure, current.literal, pageProofs(dense, large, current.literal)), /exceeds.*nothing was truncated/);
  assert.equal(readSourcePages(large.bank, {bank_digest: large.bank.bank_digest, pages: selectors}).map(page => page.text).join(''), dense.sources.head.content);
  const initial = pageSchema(empty, null, [], []).properties.report.anyOf[0].properties.units.items.properties.fit.properties.outcome.properties.evidence.items;
  assert.equal(initial.pattern, '^$');
});
