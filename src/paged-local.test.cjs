'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pagedFixture, responder} = require('../test/paged-review-fixture.cjs');
const {localReview} = require('./local-review.cjs');
const {issueReceipt, verifyReceipt} = require('./local-receipt.cjs');
const {refresh, selectSourceBank, proofCatalog} = require('./acceptance-sources.cjs');
const {MAX_PROMPT_BYTES} = require('./paged-review.cjs');
const {digest} = require('./acceptance.cjs');
const {gradeReport} = require('./acceptance-grading.cjs');

test('both local roles inspect independently, grade literal bounded evidence and sign a replayable receipt', async () => {
  const f = await pagedFixture(); const model = responder(f); const audits = [];
  const result = await localReview({snapshot: f.snapshot, ask: async task => {
    if (task.phase === 'investigation') return model.ask(task);
    const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
    const audit = packet.questions.review_completeness.evidence.context.source_exposure;
    assert.equal(audit.role, task.role);
    assert.equal(audit.snapshot_digest, f.snapshot.digest);
    assert.ok(audit.sources.rows.length > 0);
    assert.ok(audit.sources.rows.every(row => row[2] === row[3].length));
    assert.ok(audit.additional_entries.rows.every(row => row[3] === row[4].length));
    assert.match(audit.meaning, /independently judge/);
    audits.push(task.role); return f.ask(task);
  }});
  assert.equal(result.decision, 'auto_approve');
  assert.deepEqual(audits, ['examiner', 'challenger']);
  for (const packet of model.packets) assert.ok(packet.own_page_progress.every(frame => frame.role === packet.review_context.role));
  f.record.result = result;
  const signed = issueReceipt(f.issue);
  assert.equal(verifyReceipt(signed, f.expected).decision, 'auto_approve');
  for (const mutate of [
    record => {record.result.reviews[0].source_view = record.result.reviews[1].source_view;},
    record => {record.result.reviews[0].source_view.rounds.pop();},
    record => {record.result.reviews[0].page_progress.pop();},
    record => {record.result.reviews[0].source_bank.entries[0].sha256 = '0'.repeat(64);},
    record => {record.result.reviews[0].report.summary += ' modified';},
  ]) {
    const record = structuredClone(f.record); mutate(record);
    assert.throws(() => issueReceipt({...f.issue, record}), /source inspection|paged inspection/);
  }
});

test('source growth invalidates both local roles while preserving each own completed transcript and actual calls', async () => {
  const f = await pagedFixture(); let requested = false;
  const model = responder(f, (value, {task}) => {
    if (task.role === 'challenger' && value.kind === 'report' && !requested) {
      requested = true; return {...value, kind: 'source_request', report: null, request_sources: ['src/added-context.js']};
    }
    return value;
  });
  const result = await localReview({snapshot: f.snapshot,
    ask: task => task.phase === 'investigation' ? model.ask(task) : f.ask(task),
    addSources: async paths => {
      f.snapshot.sources['added-context'] = {path: paths[0], ref: f.snapshot.head_sha, kind: 'source',
        authority: 'untrusted', content: 'module.exports = "immutable additional material";\n'};
      refresh(f.snapshot);
    }});
  assert.equal(result.decision, 'auto_approve');
  const examiner = result.reviews[0];
  assert.equal(examiner.source_history.length, 1);
  assert.equal(examiner.page_progress.filter(frame => frame.cycle_start).length, 2);
  assert.equal(examiner.report.snapshot, f.snapshot.digest);
  assert.equal(result.reviews[1].source_history.length, 1);
  f.record.result = result;
  assert.equal(verifyReceipt(issueReceipt(f.issue), f.expected).decision, 'auto_approve');
});

test('crossing from legacy local source requests preserves the existing eight-batch allowance', async () => {
  const f = await pagedFixture(); delete f.snapshot.source_bank_version; refresh(f.snapshot);
  const model = responder(f); let legacy = 0;
  const result = await localReview({snapshot: f.snapshot, ask: async task => {
    if (task.phase === 'grading') return f.ask(task);
    if (f.snapshot.source_bank_version === 1) return model.ask(task);
    legacy++;
    const response = await f.ask(task);
    response.value = {kind: 'source_request', report: null, request_sources: ['src/large-context.js']};
    response.provenance.response_digest = digest(response.value); return response;
  }, addSources: async paths => {
    f.snapshot.sources['large-context'] = {path: paths[0], ref: f.snapshot.head_sha, kind: 'source', authority: 'untrusted',
      content: 'module.exports = true;\n'.repeat(17000)};
    refresh(selectSourceBank(f.snapshot));
  }});
  assert.equal(result.decision, 'auto_approve'); assert.equal(legacy, 1);
  assert.equal(result.reviews[0].page_progress[0].source_batch_limit, 7);
  f.record.result = result;
  assert.equal(verifyReceipt(issueReceipt(f.issue), f.expected).decision, 'auto_approve');
});

test('large local grading batches retain all literal questions and grade each exactly once', async () => {
  const f = await pagedFixture(); const source = f.snapshot.files[0].head_source;
  f.snapshot.sources[source].content = 'x'.repeat(20000) + '\n'; refresh(f.snapshot);
  const proof = proofCatalog(f.snapshot).find(item => item.source === source).id;
  const model = responder(f, value => {
    if (value.kind === 'report') {
      value.report.units = Array.from({length: 12}, (_, index) => ({...structuredClone(value.report.units[0]), id: `unit-${index}`}));
      for (const unit of value.report.units) for (const group of ['fit', 'excess']) for (const factor of Object.values(unit[group])) factor.evidence = [proof];
      for (const item of value.report.accounting) item.units = value.report.units.map(unit => unit.id);
    }
    return value;
  });
  const seen = {examiner: new Set(), challenger: new Set()}; let batches = 0;
  const result = await localReview({snapshot: f.snapshot, ask: task => {
    if (task.phase === 'investigation') return model.ask(task);
    batches++; assert.ok(Buffer.byteLength(task.prompt) <= MAX_PROMPT_BYTES);
    for (const id of Object.keys(task.schema.properties.answers.properties)) {
      assert.ok(!seen[task.role].has(id)); seen[task.role].add(id);
    }
    return f.ask(task);
  }});
  assert.equal(result.decision, 'auto_approve'); assert.ok(batches > 2);
  for (const review of result.reviews) assert.equal(seen[review.role].size, review.grading.decisions.length);
});

test('one genuinely oversized atomic question fails intact in local and central grading', async () => {
  const f = await pagedFixture(); const source = f.snapshot.files[0].head_source;
  f.snapshot.sources[source].content = 'x'.repeat(MAX_PROMPT_BYTES + 10000); refresh(f.snapshot);
  const model = responder(f);
  await assert.rejects(localReview({snapshot: f.snapshot,
    ask: task => task.phase === 'investigation' ? model.ask(task) : f.ask(task)}), /atomic question exceeds/);
  const {inspectPaged} = require('./paged-review.cjs');
  const inspection = await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: responder(f).ask});
  const old = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional-only';
  try {
    await assert.rejects(gradeReport({report: inspection.report, snapshot: f.snapshot, inspection,
      provider: 'deepseek', model: 'deepseek-flash', fetchImpl: async (_, options) => {
        const packet = JSON.parse(JSON.parse(options.body).messages[1].content);
        assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= MAX_PROMPT_BYTES);
        return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({answers:
          Object.fromEntries(Object.keys(packet.questions).map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))})}}]})};
      }}), /atomic grading question exceeds/);
  } finally {if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;}
});
