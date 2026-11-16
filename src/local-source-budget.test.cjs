'use strict';
// A reviewer's source request in `clouseau review` that would take the evidence past its budget: the source that does not fit
// is omitted with the hosted review's reason (acceptance-sources.cjs admitWithinBudget), and the review continues. Before,
// the whole local review failed with "Complete review evidence exceeds the source budget".
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {repository} = require('../test/local-git-fixture.cjs');
const {collectLocal} = require('./local-git.cjs');
const {runReview} = require('./local-cli.cjs');
const {digest} = require('./acceptance.cjs');
const {BUDGET, OVER_BUDGET, evidenceSize} = require('./acceptance-sources.cjs');

const LARGE = ['docs/a.txt', 'docs/b.txt', 'docs/c.txt', 'docs/d.txt'];
const large = directory => {
  fs.mkdirSync(path.join(directory, 'docs'));
  for (const [index, name] of LARGE.entries()) fs.writeFileSync(path.join(directory, name), `${index}`.repeat(280000) + '\n');
};

test('a requested source that would exceed the budget is omitted with the hosted reason; the rest of the request is kept', () =>
  repository(async f => {
    const {snapshot, addSources} = collectLocal({...f, request: 'Reject missing input.', technical: {}});
    const before = Object.keys(snapshot.sources).length;
    await addSources(LARGE);
    const kept = LARGE.filter(name => Object.values(snapshot.sources).some(source => source.path === name));
    const omitted = (snapshot.omitted_sources || []).filter(item => LARGE.includes(item.path));
    assert.ok(kept.length >= 1 && kept.length < LARGE.length, `kept ${kept.join(', ')}`);
    assert.deepEqual(omitted.map(item => item.path), LARGE.filter(name => !kept.includes(name)));
    assert.ok(omitted.every(item => item.reason === OVER_BUDGET), JSON.stringify(omitted));
    assert.equal(Object.keys(snapshot.sources).length, before + kept.length);
    assert.ok(evidenceSize(snapshot) <= BUDGET);
    // A request that fits is unchanged: nothing is omitted and the source is read.
    const small = collectLocal({...f, request: 'Reject missing input.', technical: {}});
    await small.addSources(['AGENTS.md']);
    assert.equal(small.snapshot.omitted_sources, undefined);
  }, large));

test('through clouseau review: a reviewer asking for more than fits still gets a review, which states what was omitted', () =>
  repository(async f => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-source-budget-'));
    try {
      const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
      let calls = 0; let asked = false; let seen = null;
      const ask = async task => {
        const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
        let value;
        if (task.phase === 'investigation' && task.role === 'examiner' && !asked) {
          asked = true;
          value = {kind: 'source_request', report: null, request_sources: LARGE};
        } else if (task.phase === 'investigation') {
          if (task.role === 'examiner') seen = packet.evidence;
          const report = packet.template;
          report.gates.forEach(gate => {gate.state = 'satisfied';});
          value = {kind: 'report', report, request_sources: []};
        } else value = {answers: Object.fromEntries(Object.keys(task.schema.properties.answers.properties)
          .map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))};
        return {value, provenance: {harness: 'codex', role: task.role, phase: task.phase, session: `fictional-budget-session-${++calls}`,
          request_digest: digest(task), response_digest: digest(value), transport_digest: digest({fixture_only: value})}};
      };
      const installed = () => ({sha: 'e'.repeat(40), digest: require('./local-version.cjs').engineDigest(), clean: true});
      const result = await runReview({directory: f.directory, base: f.base, 'request-file': request},
        {state, ask, attest: technical => technical, verify: () => ({fixture_execution_only: true}), installed});
      assert.equal(result.decision, 'auto_approve');
      const record = JSON.parse(fs.readFileSync(result.record));
      const omitted = record.snapshot.omitted_sources.filter(item => LARGE.includes(item.path));
      assert.ok(omitted.length >= 1 && omitted.every(item => item.reason === OVER_BUDGET), JSON.stringify(omitted));
      // The reviewer sees which requested sources were omitted and why.
      assert.deepEqual(seen.omitted_sources.filter(item => LARGE.includes(item.path)), omitted);
    } finally {fs.rmSync(state, {recursive: true, force: true});}
  }, large));

// The rest of a request is still read after an omission: a regression that stopped at the first omitted path would leave
// the small source after it unread.
test('a path requested after an omitted one is still read', () =>
  repository(async f => {
    const {snapshot, addSources} = collectLocal({...f, request: 'Reject missing input.', technical: {}});
    await addSources([...LARGE, 'docs/small.txt']);
    const omitted = (snapshot.omitted_sources || []).map(item => item.path);
    assert.ok(omitted.some(name => LARGE.includes(name)), JSON.stringify(omitted));
    assert.ok(!omitted.includes('docs/small.txt'));
    assert.ok(Object.values(snapshot.sources).some(source => source.path === 'docs/small.txt'));
  }, directory => {large(directory); fs.writeFileSync(path.join(directory, 'docs/small.txt'), 'small\n');}));

// A review kept within one omission entry of the cap fails closed when a requested source is then omitted: the entry itself
// takes the evidence past the budget (documented in docs/local-review.md). A source already in the evidence is never removed
// to make room, so the failure is the budget error and the present source is still there.
test('within one omission entry of the cap, an omission fails closed and a present source is never removed', async () => {
  const setup = pad => directory => {
    large(directory);
    fs.writeFileSync(path.join(directory, 'docs/pad.txt'), 'p'.repeat(pad));
    fs.writeFileSync(path.join(directory, 'docs/big.txt'), 'b'.repeat(1000));
  };
  const FILL = ['docs/a.txt', 'docs/b.txt', 'docs/c.txt', 'docs/pad.txt'];
  let measured;
  await repository(async f => {
    const {snapshot, addSources} = collectLocal({...f, request: 'Reject missing input.', technical: {}});
    await addSources(FILL);
    assert.equal(snapshot.omitted_sources, undefined);
    measured = evidenceSize(snapshot);
  }, setup(1));
  const pad = 1 + BUDGET - 10 - measured;
  await repository(async f => {
    const {snapshot, addSources} = collectLocal({...f, request: 'Reject missing input.', technical: {}});
    await addSources(FILL);
    assert.equal(evidenceSize(snapshot), BUDGET - 10);
    const present = Object.keys(snapshot.sources).find(id => snapshot.sources[id].path === 'docs/a.txt');
    await assert.rejects(addSources(['docs/big.txt', 'docs/a.txt']), /exceeds the source budget/);
    assert.ok(snapshot.sources[present], 'the present source was removed');
    assert.deepEqual(snapshot.omitted_sources, [{path: 'docs/big.txt', reason: OVER_BUDGET}]);
  }, setup(pad));
});
