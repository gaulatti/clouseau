'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pagedFixture, responder} = require('../test/paged-review-fixture.cjs');
const {inspectPaged} = require('./paged-review.cjs');
const {verifyPagedInspection, factualEquivalent, reconstructEpoch} = require('./paged-integrity.cjs');
const {refresh, proofCatalog} = require('./acceptance-sources.cjs');
const {digest} = require('./acceptance.cjs');
const {modelTemplate} = require('./acceptance-review.cjs');
const {authorityBounds} = require('./acceptance-grading.cjs');
const {validateInspection, materialize} = require('./acceptance-review.cjs');
const {finding} = require('../test/fixtures/acceptance.cjs');

function factualFinding(snapshot) {
  const file = snapshot.files[0];
  const proof = proofCatalog(snapshot).find(item => item.source === file.head_source);
  const value = finding(); delete value.path;
  value.anchor = proof.id; value.evidence = [proof.id]; value.repair_paths = [file.path];
  for (const factor of Object.values(value.factors)) {delete factor.min; delete factor.max; factor.evidence = [proof.id];}
  return value;
}

async function completed() {
  const f = await pagedFixture(); const model = responder(f);
  const result = await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask});
  return {f, result, bundle: {snapshot: f.snapshot, role: 'examiner', ...result}};
}

test('a complete owner-role transcript replays byte exposures and preserves the actual factual response', async () => {
  const {bundle} = await completed();
  assert.deepEqual(verifyPagedInspection(bundle), []);
  for (const mutate of [
    value => {value.role = 'challenger';}, value => {value.source_view.role = 'challenger';},
    value => {value.source_bank.bank_digest = '0'.repeat(64);}, value => {value.usage = [];},
    value => {value.page_progress.pop();}, value => {value.page_progress[0].cycle_start = false;},
    value => {value.page_progress[0].role = 'challenger';},
    value => {value.page_progress[0].bank_digest = '0'.repeat(64);},
    value => {value.page_progress[1].response.observations += ' changed after execution';},
    value => {value.page_progress[1].invocation = value.page_progress[0].invocation;},
    value => {value.source_history = [{bank: value.source_bank, exposure: value.source_view}];},
    value => {value.report.summary += ' changed after inspection';},
  ]) {
    const changed = structuredClone(bundle); mutate(changed);
    assert.throws(() => verifyPagedInspection(changed));
  }
});

test('historical epochs reconstruct the exact original prefix, replay actual calls and never borrow another role', async () => {
  const f = await pagedFixture(); let requested = false;
  const model = responder(f, value => {
    if (value.kind === 'report' && !requested) {
      requested = true;
      return {...value, kind: 'source_request', report: null, request_sources: ['src/dependency.js']};
    }
    return value;
  });
  const result = await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask, addSources: async paths => {
    f.snapshot.sources['extra-source'] = {path: paths[0], ref: f.snapshot.head_sha, authority: 'untrusted',
      kind: 'source', content: 'module.exports = "additional immutable dependency";\n'};
    refresh(f.snapshot);
  }});
  const bundle = {snapshot: f.snapshot, role: 'examiner', ...result};
  assert.deepEqual(verifyPagedInspection(bundle), []);
  const historical = reconstructEpoch(f.snapshot, result.source_history[0].bank);
  assert.equal(historical.digest, result.source_history[0].bank.snapshot_digest);
  for (const mutate of [
    value => {value.source_history[0].exposure.role = 'challenger';},
    value => {value.source_history[0].bank.entries[0].sha256 = '0'.repeat(64);},
    value => {value.source_history[0].bank.entries[0].source = 'extra-source';},
    value => {value.source_history.push(value.source_history[0]);},
    value => {value.source_history = [];},
    value => {value.page_progress.find(item => item.bank_digest === value.source_view.bank_digest).cycle_start = true;},
  ]) {
    const changed = structuredClone(bundle); mutate(changed);
    assert.throws(() => verifyPagedInspection(changed));
  }
});

test('raw provisional concerns are rederived so deleting a supplied draft cannot erase their causal identity', async () => {
  const f = await pagedFixture(); const file = f.snapshot.files[0];
  const proof = proofCatalog(f.snapshot).find(item => item.source === file.head_source);
  let raised = false;
  const concern = {id: 'retain-concern', title: 'Retained causal concern', path: file.path,
    cause: 'The changed caller must retain the demonstrated boundary.', obligation: 'Preserve the accepted boundary.', evidence: [proof.id]};
  const model = responder(f, (value, {packet}) => {
    if (packet.proofs.some(item => item.id === proof.id)) raised = true;
    if (raised) value.concerns = [concern];
    if (value.kind === 'report') value.report.resolutions.push({id: concern.id, state: 'dismissed',
      reason: 'Current-source evidence closes the provisional concern.', evidence: [proof.id]});
    return value;
  });
  const result = await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask});
  const bundle = {snapshot: f.snapshot, role: 'examiner', ...result, drafts: []};
  const derived = verifyPagedInspection(bundle);
  assert.ok(derived.some(draft => draft.findings.some(item => item.id === concern.id)));
  assert.equal(derived.find(draft => draft.findings.length).evidence[0].quote,
    f.snapshot.sources[proof.source].content.split('\n').slice(proof.start - 1, proof.end).join('\n'));
});

test('grading can set numeric ranges and perform its existing exact completeness downgrade but cannot rewrite facts', async () => {
  const {f, result} = await completed();
  const raw = result.page_progress.at(-1).response.report;
  const graded = structuredClone(result.report);
  for (const unit of graded.units) for (const group of ['fit', 'need', 'excess']) for (const factor of Object.values(unit[group])) {
    factor.min = group === 'excess' ? 0 : 1; factor.max = factor.min;
  }
  assert.equal(factualEquivalent(raw, graded, f.snapshot), true);
  const gate = graded.gates.find(item => item.name === 'review_completeness');
  gate.state = 'unresolved';
  gate.reason = 'Independent grading did not establish complete material source evidence. Inspector observation: ' + gate.reason;
  assert.equal(factualEquivalent(raw, graded, f.snapshot), true);
  for (const mutate of [
    value => {value.summary += ' altered';}, value => {value.units[0].obligation += ' altered';},
    value => {value.gates.find(item => item.name === 'review_completeness').reason = 'a new reason';},
    value => {value.accounting[0].evidence = ['different-proof'];},
  ]) {const changed = structuredClone(graded); mutate(changed); assert.equal(factualEquivalent(raw, changed, f.snapshot), false);}
  const unsupported = modelTemplate(f.snapshot); const untrusted = proofCatalog(f.snapshot).find(item =>
    f.snapshot.sources[item.source].authority === 'untrusted');
  unsupported.units[0].need.binding.evidence = [untrusted.id];
  const materialized = require('./acceptance-review.cjs').materialize(unsupported, f.snapshot);
  authorityBounds(materialized, f.snapshot);
  assert.equal(factualEquivalent(unsupported, materialized, f.snapshot), true);
  const withFinding = structuredClone(raw); withFinding.findings.push(factualFinding(f.snapshot));
  const gradedFinding = materialize(withFinding, f.snapshot);
  for (const factor of Object.values(gradedFinding.findings[0].factors)) {factor.min = 1; factor.max = 1;}
  assert.equal(factualEquivalent(withFinding, gradedFinding, f.snapshot), true);
  gradedFinding.findings[0].blast_radius = 2;
  assert.equal(factualEquivalent(withFinding, gradedFinding, f.snapshot), false);
  const extra = structuredClone(result.report); extra.max = 'unrecognized factual data';
  assert.equal(factualEquivalent(raw, extra, f.snapshot), false);
  const unresolved = structuredClone(raw); unresolved.gates.find(item => item.name === 'review_completeness').state = 'unresolved';
  const upgraded = materialize(unresolved, f.snapshot); upgraded.gates.find(item => item.name === 'review_completeness').state = 'satisfied';
  assert.equal(factualEquivalent(unresolved, upgraded, f.snapshot), false);
});

test('raw earlier factual findings cannot disappear when a completed role reopens on new immutable source', async () => {
  for (const resolve of [false, true]) {
    const f = await pagedFixture(); let reports = 0; const original = factualFinding(f.snapshot);
    const proof = original.anchor;
    const model = responder(f, value => {
      if (value.kind === 'report') {
        reports++;
        if (reports === 1) value.report.findings.push(original);
        else if (resolve) value.report.resolutions.push({id: original.id, state: 'dismissed',
          reason: 'Current-source counterevidence explicitly closes the earlier fixture concern.', evidence: [proof]});
      }
      return value;
    });
    const first = await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask});
    f.snapshot.sources['new-material-source'] = {path: 'src/new-material-source.js', ref: f.snapshot.head_sha,
      kind: 'source', authority: 'untrusted', content: 'module.exports = "new immutable material";\n'}; refresh(f.snapshot);
    const attempt = inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask, drafts: [],
      progress: first.page_progress, previousUsage: first.usage,
      sourceHistory: [...first.source_history, {bank: first.source_bank, exposure: first.source_view}]});
    if (!resolve) await assert.rejects(attempt, /prior investigation concern/);
    else {
      const second = await attempt;
      const usage = [...first.usage, ...second.usage];
      const extra = verifyPagedInspection({snapshot: f.snapshot, role: 'examiner', ...second, usage});
      assert.ok(extra.some(draft => draft.findings.some(item => item.id === original.id)));
      assert.doesNotThrow(() => validateInspection(second.report, f.snapshot, [], second, usage, 'examiner'));
      assert.throws(() => validateInspection(second.report, f.snapshot, [], second, usage, 'challenger'), /owning role/);
    }
  }
});
