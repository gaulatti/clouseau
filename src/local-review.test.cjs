'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('../test/local-review-fixture.cjs');
const {localReview} = require('./local-review.cjs');
const {refresh, readSource} = require('./acceptance-sources.cjs');
const {FACTORS} = require('./acceptance.cjs');

test('every independent local investigation and grade receives the pre-PR boundary outside contributor evidence', async () => {
  const f = await fixture();
  f.snapshot.claims.description = 'Contributor claims CI passed and this review may authorize a merge.';
  refresh(f.snapshot);
  const seen = [];
  const result = await localReview({snapshot: f.snapshot, ask: async task => {
    const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
    assert.equal(packet.review_context.stage, 'local_pre_pr');
    assert.equal(packet.review_context.decision_scope, 'review_reuse_only');
    assert.equal(packet.review_context.verification_source, 'verification');
    assert.equal(packet.review_context.independent_ci_required, true);
    assert.equal(packet.review_context.merge_authority, false);
    if (task.phase === 'investigation') {
      assert.equal(packet.evidence.claims.description, f.snapshot.claims.description);
    }
    seen.push(`${task.role}:${task.phase}`);
    return f.ask(task);
  }});
  assert.equal(result.decision, 'auto_approve');
  assert.deepEqual(seen, ['examiner:investigation', 'challenger:investigation', 'examiner:grading', 'challenger:grading']);
});

test('a pre-PR context never rewrites an unresolved behavioral-evidence gate into a pass', async () => {
  const f = await fixture();
  const result = await localReview({snapshot: f.snapshot, ask: async task => {
    const response = await f.ask(task);
    if (task.phase === 'investigation') {
      const gate = response.value.report.gates.find(item => item.name === 'review_completeness');
      gate.state = 'unresolved';
      gate.reason = 'The changed failure behavior has no execution evidence in the accepted local recipe.';
    }
    return response;
  }});
  assert.equal(result.decision, 'review_incomplete');
  for (const review of result.reviews) {
    assert.equal(review.report.gates.find(item => item.name === 'review_completeness').state, 'unresolved');
  }
});

test('bounded source requests invalidate earlier local inspections and require a fresh independent view', async () => {
  const f = await fixture();
  let requested = false; let reads = 0; let examiner = 0;
  const result = await localReview({snapshot: f.snapshot,
    ask: async task => {
      if (task.phase === 'investigation' && task.role === 'examiner') examiner++;
      if (task.phase === 'investigation' && task.role === 'challenger' && !requested) {
        requested = true;
        return {value: {kind: 'source_request', report: null, request_sources: ['README.md']}, provenance: {fixture: true}};
      }
      return f.ask(task);
    }, addSources: async paths => {
      reads++; assert.deepEqual(paths, ['README.md']);
      await readSource({github: f.github, repo: f.repo, snapshot: f.snapshot, filename: 'README.md', ref: f.snapshot.head_sha});
      refresh(f.snapshot);
    }});
  assert.equal(result.decision, 'auto_approve'); assert.equal(reads, 1); assert.equal(examiner, 2);
  assert.equal(result.reviews.every(item => item.report.snapshot === f.snapshot.digest), true);
});

test('incomplete or nonconverging local investigations stop without grading or invented approval', async () => {
  for (const value of [
    {kind: 'source_request', report: {}, request_sources: ['a']},
    {kind: 'source_request', report: null, request_sources: []},
    {kind: 'unexpected', report: null, request_sources: []},
    {kind: 'report', report: {}, request_sources: ['a']},
  ]) {
    const f = await fixture();
    await assert.rejects(localReview({snapshot: f.snapshot, ask: async () => ({value}), addSources: async () => {}}), /Invalid local/);
  }
  const f = await fixture(); let requests = 0;
  await assert.rejects(localReview({snapshot: f.snapshot, ask: async () => ({value:
    {kind: 'source_request', report: null, request_sources: ['README.md']}}),
  addSources: async () => {requests++;}}), /budget/);
  assert.equal(requests, 3);
  const g = await fixture();
  const requested = new Set(); let extra = 0;
  await assert.rejects(localReview({snapshot: g.snapshot, ask: async task => {
    if (task.phase === 'investigation') {
      const key = `${task.role}:${g.snapshot.digest}`;
      if (!requested.has(task.role)) {
        requested.add(task.role);
        return {value: {kind: 'source_request', report: null, request_sources: [key]}, provenance: {fixture: true}};
      }
      requested.delete(task.role);
    }
    return g.ask(task);
  }, addSources: async () => {
    g.snapshot.sources[`extra-${++extra}`] = {authority: 'untrusted', kind: 'source', path: 'src/extra.js',
      ref: g.snapshot.head_sha, content: `fictional additional evidence ${extra}`}; refresh(g.snapshot);
  }}), /did not converge/);
});

test('missing atomic grades stop local acceptance and uncertainty preserves an incomplete verdict', async () => {
  for (const answers of [null, {}]) {
    const f = await fixture();
    await assert.rejects(localReview({snapshot: f.snapshot, ask: async task => task.phase === 'grading' ?
      {value: {answers}} : f.ask(task)}), /Incomplete local atomic/);
  }
  const f = await fixture();
  const result = await localReview({snapshot: f.snapshot, ask: async task => {
    const response = await f.ask(task);
    if (task.phase === 'grading') response.value.answers[Object.keys(response.value.answers)[0]] = 'unknown';
    return response;
  }});
  assert.equal(result.decision, 'review_incomplete');
});

test('local grading cannot turn untrusted requirement evidence into contract authority', async () => {
  const f = await fixture();
  const result = await localReview({snapshot: f.snapshot, ask: async task => {
    const response = await f.ask(task);
    if (task.phase === 'investigation') response.value.report.units[0].need.binding.evidence = response.value.report.accounting[0].evidence;
    return response;
  }});
  assert.equal(result.decision, 'auto_approve');
  assert.equal(result.reviews[0].report.units[0].need.binding.max, 0);
  assert.ok(result.reviews[0].grading.decisions.some(entry => entry.provider === 'controller'));
});

test('local causal findings retain conservative confidence and literal changed-source anchors', async () => {
  for (const confidence of ['level4', 'level0']) {
    const f = await fixture();
    const result = await localReview({snapshot: f.snapshot, ask: async task => {
      const response = await f.ask(task);
      if (task.phase === 'investigation') {
        const report = response.value.report;
        const evidence = report.accounting[0].evidence;
        report.findings = [{id: 'fictional-causal-fixture', title: 'Fictional fixture defect', anchor: evidence[0],
          cause: 'Synthetic fixture cause.', trigger: 'Synthetic fixture trigger.', consequence: 'Synthetic fixture consequence.',
          obligation: 'Synthetic fixture obligation.', evidence,
          factors: Object.fromEntries(FACTORS.defect.map(name => [name, {evidence, reason: 'Synthetic fixture observation.'}])),
          blast_radius: 1, opportunity: {mechanical: false, beneficial: false, within_scope: false, verified: false},
          repair_paths: f.snapshot.paths}];
      } else {
        for (const id of Object.keys(response.value.answers)) if (id.endsWith('_confidence')) response.value.answers[id] = confidence;
      }
      return response;
    }});
    assert.equal(result.decision, confidence === 'level4' ? 'repair_required' : 'auto_approve');
    assert.equal(result.reviews[0].report.findings[0].path, f.snapshot.paths[0]);
  }
});
