'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {clean, score, priorState, reconcile, render, publication, MARKER} = require('./acceptance-ledger.cjs');
const {validateReport} = require('./acceptance.cjs');
const {fixture, finding, factor} = require('../test/fixtures/acceptance.cjs');
const {combine} = require('./acceptance-review.cjs');

function setup(includeFinding = true) {
  const {report, snapshot} = fixture();
  if (includeFinding) report.findings.push(finding());
  const reviews = ['examiner', 'challenger'].map(role => ({role, report: structuredClone(report), scores: validateReport(report, snapshot)}));
  return {snapshot, result: {decision: reviews[0].scores.decision, reviews}};
}

function grade(result, snapshot) {
  for (const review of result.reviews) review.scores = validateReport(review.report, snapshot);
  result.decision = combine(result.reviews);
  return render(result, snapshot, reconcile(result, snapshot)).split('<details>')[0];
}

test('the initial view has one scorecard and preserves the complete audit and exact result without AI work', () => {
  const {result, snapshot} = setup(false);
  const state = reconcile(result, snapshot);
  const before = JSON.stringify({result, snapshot, state});
  const body = render(result, snapshot, state);
  const visible = body.split('<details>')[0];
  assert.match(visible, /Clouseau — Approved/);
  assert.equal((visible.match(/^\| Assessment /gm) || []).length, 1);
  assert.ok(visible.length < 1600);
  assert.match(visible, /Technical findings:\*\* None/);
  assert.doesNotMatch(visible, /Technical Q|Fit =|\| Unit |\| Gate |\| Finding |examiner|challenger/);
  for (const value of ['Scoring and evidence', 'confidence', 'binding', 'Literal immutable source excerpts']) {
    assert.ok(body.includes(value));
  }
  assert.equal(JSON.stringify({result, snapshot, state}), before);
  assert.deepEqual(priorState([{id: 1, user: {login: 'github-actions[bot]'}, body}],
    snapshot.repository, snapshot.number).findings, state.findings);
});

test('one reviewer blocker stays visible once with its evidence even when the other reviewer accepts it', () => {
  const {result, snapshot} = setup();
  result.reviews[0].report.findings[0].factors.necessity = factor(0.25);
  result.reviews[0].report.findings[0].factors.activation = factor(0);
  const visible = grade(result, snapshot);
  assert.match(visible, /Repair required/);
  assert.match(visible, /Reviewer disagreement/);
  assert.equal((visible.match(/\*\*Blocking:/g) || []).length, 1);
  assert.match(visible, /\*\*Score:\*\* 100.00 \/ 100/);
  assert.match(visible, /blob\/a{40}\/src\/upload.rs#L1-L2/);
  assert.match(visible, /Affected area/);
  assert.match(visible, /Required outcome/);
  assert.doesNotMatch(visible, /Owner decision required|\*\*Optional:/);
});

test('uncertain findings, optional benefits and missing integrity evidence remain distinct', () => {
  const {result, snapshot} = setup();
  for (const review of result.reviews) {
    review.report.findings[0].factors.necessity = factor(0.25, 1);
    review.report.findings[0].factors.activation = factor(0);
    review.report.gates.find(gate => gate.name === 'review_completeness').state = 'unresolved';
  }
  let visible = grade(result, snapshot);
  assert.match(visible, /Review incomplete/);
  assert.match(visible, /\*\*Investigate:/);
  assert.match(visible, /25.00–100.00/);
  assert.match(visible, /Check requiring attention — review completeness/);
  assert.doesNotMatch(visible, /Owner decision required/);
  for (const verified of [false, true]) {
    for (const review of result.reviews) {
      review.report.gates.find(gate => gate.name === 'review_completeness').state = 'satisfied';
      review.report.findings[0].factors.necessity = factor(0.25);
      review.report.findings[0].opportunity = {mechanical: verified, beneficial: verified, within_scope: verified, verified};
    }
    visible = grade(result, snapshot);
    assert.match(visible, /Clouseau — Approved/);
    assert.match(visible, /\*\*Optional:/);
    assert.match(visible, new RegExp(`Expected benefit:\\*\\* ${verified ? 'Verified' : 'Not established'}`));
    assert.match(visible, /Optional priority/);
  }
});

test('product rework, owner choices and test integrity vetoes have actionable separate summaries', () => {
  const {result, snapshot} = setup(false);
  for (const review of result.reviews) review.report.units[0].fit.outcome = factor(0);
  let visible = grade(result, snapshot);
  assert.match(visible, /Change requiring attention: Validate before acceptance/);
  assert.match(visible, /65.00 \/ 100/);
  for (const review of result.reviews) {
    review.report.units[0].fit.outcome = factor(1);
    review.report.decisions = [{kind: 'authority', question: 'May uploads grant a new privilege?',
      options: ['Keep existing privileges', 'Authorize the new privilege'], evidence: ['source']}];
  }
  visible = grade(result, snapshot);
  assert.match(visible, /Owner decision required/);
  assert.match(visible, /May uploads grant a new privilege/);
  assert.match(visible, /Keep existing privileges; Authorize the new privilege/);
  for (const review of result.reviews) review.report.decisions = [];
  result.decision = 'owner_decision';
  assert.match(render(result, snapshot, reconcile(result, snapshot)), /Confirm this exact revision/);
  for (const review of result.reviews) review.report.gates.find(gate => gate.name === 'test_integrity').state = 'violated';
  visible = grade(result, snapshot);
  assert.match(visible, /Test integrity repair required/);
  assert.match(visible, /Check requiring attention — test integrity/);
  assert.doesNotMatch(visible, /Owner decision required/);
});

test('summary shortening preserves Unicode and non-file evidence never receives a fabricated file link', () => {
  const {result, snapshot} = setup();
  result.reviews[0].report.summary = 'a'.repeat(499) + '😀 suffix';
  snapshot.sources.head.kind = 'verification';
  let visible = render(result, snapshot, reconcile(result, snapshot)).split('<details>')[0];
  assert.match(visible, /😀…/);
  assert.match(visible, /\*\*Evidence:\*\* source/);
  assert.doesNotMatch(visible, /\/blob\//);
  snapshot.sources.head.ref = 'not-a-commit';
  visible = render(result, snapshot, reconcile(result, snapshot)).split('<details>')[0];
  assert.doesNotMatch(visible, /\/blob\//);
});

test('rendered acceptance records expose every factor and preserve exact decision values separately from display rounding', () => {
  const {result, snapshot} = setup();
  const state = reconcile(result, snapshot);
  const body = render(result, snapshot, state);
  assert.ok(body.includes('Fit | Need | Proportionality'));
  for (const name of ['confidence', 'recurrence', 'generalization', 'binding', 'operating_model']) assert.ok(body.includes(name));
  assert.match(body, /missing-rejection|Invalid input reaches durable acceptance/);
  assert.equal(clean('<script>@name|`\nline'), '&lt;script&gt;name&#124;&#96; line');
  assert.equal(score(12.345, 12.345), '12.35'); assert.equal(score(12, 13), '12.00–13.00');
  assert.equal(state.findings.length, 1, 'identical causal roots from independent roles share one history identity');
  assert.equal(state.findings[0].state, 'confirmed');
  const parsed = priorState([{id: 4, user: {login: 'github-actions[bot]'}, body}], snapshot.repository, snapshot.number);
  assert.equal(parsed.comment, 4); assert.equal(parsed.findings[0].id, state.findings[0].id);
  const safe = setup(false);
  assert.ok(render(safe.result, safe.snapshot, reconcile(safe.result, safe.snapshot)).includes('No admitted technical findings'));
});

test('a disappeared or merely downgraded prior blocker remains outstanding without explicit independent source dispositions', () => {
  const {result, snapshot} = setup();
  const previous = reconcile(result, snapshot).findings;
  const empty = setup(false).result;
  const missing = reconcile(empty, snapshot, previous);
  assert.equal(missing.findings[0].state, 'outstanding'); assert.deepEqual(missing.unresolved, [previous[0].id]);
  assert.match(render(empty, snapshot, missing), /Outstanding prior blockers/);
  for (const review of result.reviews) {
    review.report.findings[0].id = previous[0].id;
    review.report.findings[0].factors.necessity = factor(0.25);
    review.report.findings[0].factors.activation = factor(0);
    review.scores = validateReport(review.report, snapshot);
  }
  assert.equal(reconcile(result, snapshot, previous).findings[0].state, 'outstanding');
  for (const review of empty.reviews) review.report.resolutions = [{id: previous[0].id, state: 'corrected', reason: 'The current source restores rejection.', evidence: ['source']}];
  let state = reconcile(empty, snapshot, previous);
  assert.equal(state.findings[0].state, 'corrected'); assert.equal(state.findings[0].blocking, false);
  empty.reviews[1].report.resolutions[0].state = 'dismissed';
  assert.equal(reconcile(empty, snapshot, previous).findings[0].state, 'dismissed');
});

test('one independent blocker survives and an optional declined observation creates no follow-up obligation', () => {
  const {result, snapshot} = setup();
  const old = reconcile(result, snapshot).findings;
  for (const review of result.reviews) review.report.findings[0].id = old[0].id;
  assert.equal(reconcile(result, snapshot, old).unresolved.length, 0);
  assert.equal(reconcile(result, snapshot, old).findings[0].blocking, true);
  result.reviews[0].scores.findings[0].disposition = 'nonblocking';
  assert.equal(reconcile(result, snapshot).findings[0].blocking, true);
  result.reviews[1].scores.findings[0].disposition = 'investigate';
  assert.equal(reconcile(result, snapshot).findings[0].state, 'investigating');
  const advisory = {...old[0], blocking: false, state: 'advisory_closed'};
  const empty = setup(false).result;
  assert.equal(reconcile(empty, snapshot, [advisory]).unresolved.length, 0);
  assert.equal(reconcile(empty, snapshot, [advisory]).findings[0].state, 'advisory_closed');
});

test('only the review bot ledger with matching repository and PR identity is accepted', () => {
  const {result, snapshot} = setup();
  assert.deepEqual(priorState([], snapshot.repository, snapshot.number), {comment: null, findings: []});
  assert.deepEqual(priorState([{user: {login: 'contributor'}, body: MARKER}], snapshot.repository, snapshot.number), {comment: null, findings: []});
  const state = reconcile(result, snapshot);
  const value = {version: 2, repository: snapshot.repository, number: snapshot.number, head_sha: snapshot.head_sha, findings: state.findings};
  const comment = body => [{id: 1, user: {login: 'github-actions[bot]'}, body}];
  assert.throws(() => priorState(comment(MARKER), snapshot.repository, snapshot.number), /incomplete/);
  assert.throws(() => priorState(comment(`${MARKER}\n<!-- clouseau-state:${'A'.repeat(60004)} -->`), snapshot.repository, snapshot.number), /incomplete/);
  for (const mutate of [
    v => {v.version = 1;}, v => {v.repository = 'other/repo';}, v => {v.number = 9;}, v => {v.head_sha = 'stale';}, v => {v.findings = {};},
    v => {v.findings[0].id = 'invented';}, v => {v.findings[0].blocking = 'yes';}, v => {v.findings[0].state = 'unknown';},
    v => {v.findings[0].title = '';}, v => {v.findings[0].path = '';}, v => {v.findings[0].cause = '';}, v => {v.findings[0].obligation = '';},
  ]) {
    const changed = structuredClone(value); mutate(changed);
    const body = `${MARKER}\n<!-- clouseau-state:${Buffer.from(JSON.stringify(changed)).toString('base64')} -->`;
    assert.throws(() => priorState(comment(body), snapshot.repository, snapshot.number), /identity validation/);
  }
});

test('oversized summaries remain lossless in evidence pages while the primary summary stays concise', () => {
  const {result, snapshot} = setup();
  result.reviews[0].report.summary = 'Complete evidence '.repeat(4000);
  assert.throws(() => render(result, snapshot, reconcile(result, snapshot)), /comment budget/);
  const {body, pages} = publication(result, snapshot, reconcile(result, snapshot));
  assert.ok(body.length < 64000);
  assert.ok(pages.length > 0);
  assert.ok(pages.map(page => page.slice(page.indexOf('\n\n') + 2)).join('').includes(result.reviews[0].report.summary));
  result.reviews[0].report.findings[0].consequence = 'A large unresolved consequence '.repeat(3000);
  assert.throws(() => publication(result, snapshot, reconcile(result, snapshot)), /comment budget/);
});

test('large evidence is published losslessly in bounded Unicode-safe pages without changing the scores or history', () => {
  for (const prefix of ['', 'x']) {
    const {result, snapshot} = setup();
    snapshot.sources.head.content += prefix + '😀'.repeat(60000);
    require('./acceptance-sources.cjs').refresh(snapshot);
    for (const review of result.reviews) {
      review.report.snapshot = snapshot.digest;
      review.report.evidence.push({id: 'large-source', source: 'head', start: 3, end: 3, quote: '😀'});
      review.report.units[0].excess.abstraction.evidence.push('large-source');
      review.scores = validateReport(review.report, snapshot);
    }
    const before = JSON.stringify({result, snapshot});
    const state = reconcile(result, snapshot);
    const full = render(result, snapshot, state, {unbounded: true});
    const {body, pages} = publication(result, snapshot, state);
    assert.ok(pages.length >= 3); assert.ok(body.length < 64000);
    assert.match(body, /missing-rejection|Invalid input reaches durable acceptance/);
    assert.match(body, /Fits the repository/);
    const chunks = pages.map(page => {
      assert.ok(page.length < 64000); assert.ok(!page.includes(MARKER));
      const chunk = page.slice(page.indexOf('\n\n') + 2);
      assert.ok(!/[\uD800-\uDBFF]$/.test(chunk)); assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk));
      return chunk;
    });
    assert.equal(chunks.join(''), full.replace(MARKER, '').replace(/<!-- clouseau-state:[A-Za-z0-9+/=]+ -->/, ''));
    const comments = [body, ...pages].map((body, id) => ({id, user: {login: 'github-actions[bot]'}, body}));
    assert.deepEqual(priorState(comments, snapshot.repository, snapshot.number).findings, state.findings);
    assert.equal(JSON.stringify({result, snapshot}), before);
  }
  const {result, snapshot} = setup();
  assert.deepEqual(publication(result, snapshot, reconcile(result, snapshot)).pages, []);
});

test('overlapping citations from both roles retain all source lines and references without duplicating their bytes', () => {
  const {result, snapshot} = setup();
  const extra = Array.from({length: 20}, (_, index) => `// immutable supporting line ${index}: ${'x'.repeat(700)}`);
  snapshot.sources.head.content = snapshot.sources.head.content.trimEnd() + '\n' + extra.join('\n');
  require('./acceptance-sources.cjs').refresh(snapshot);
  for (const review of result.reviews) {
    review.report.snapshot = snapshot.digest;
    for (let index = 0; index < 60; index++) {
      const start = index % 20 + 3;
      const entry = {id: `support-${index}`, source: 'head', start, end: start, quote: extra[index % 20]};
      review.report.evidence.push(entry);
      review.report.units[0].excess.abstraction.evidence.push(entry.id);
    }
    review.scores = validateReport(review.report, snapshot);
  }
  const before = JSON.stringify({result, snapshot});
  const state = reconcile(result, snapshot);
  const body = render(result, snapshot, state);
  assert.ok(body.length < 64000);
  for (let index = 0; index < 60; index++) assert.equal(body.split(`| support-${index} |`).length - 1, 2, 'both role registers retain every original reference');
  for (let index = 0; index < extra.length; index++) {
    assert.equal(body.split(`L${index + 3}: ${clean(extra[index])}`).length - 1, 1, 'each literal source line appears exactly once');
  }
  assert.equal(JSON.stringify({result, snapshot}), before, 'display compaction changes no evidence, grade or decision');
  const restored = priorState([{id: 7, user: {login: 'github-actions[bot]'}, body}], snapshot.repository, snapshot.number);
  assert.deepEqual(restored.findings, state.findings, 'persistent blocker history survives the compact display');
});

test('a product rejection persists across renamed or disappeared acceptance units and cannot impersonate a technical root', () => {
  const {result, snapshot} = setup(false);
  for (const review of result.reviews) {
    review.report.units[0].fit.outcome = factor(0);
    review.scores = validateReport(review.report, snapshot);
  }
  const previous = reconcile(result, snapshot).findings;
  assert.equal(previous.length, 1); assert.equal(previous[0].kind, 'product');
  const accepted = setup(false).result;
  let state = reconcile(accepted, snapshot, previous);
  assert.deepEqual(state.unresolved, [previous[0].id]);
  for (const review of accepted.reviews) review.report.resolutions = [{id: previous[0].id, state: 'dismissed', reason: 'The concrete change serves the cited obligation.', evidence: ['source']}];
  state = reconcile(accepted, snapshot, previous);
  assert.equal(state.findings[0].state, 'dismissed');
  assert.match(render(accepted, snapshot, state), /The concrete change serves/);
  for (const review of result.reviews) {
    review.report.units[0].id = previous[0].id; review.report.accounting[0].units = [previous[0].id];
    review.scores = validateReport(review.report, snapshot);
  }
  assert.equal(reconcile(result, snapshot, previous).findings[0].id, previous[0].id);
  const technical = setup().result;
  for (const review of technical.reviews) review.report.findings[0].id = previous[0].id;
  assert.equal(reconcile(technical, snapshot, previous).findings.length, 2, 'a technical claim cannot overwrite a product root by borrowing its identifier');
  const technicalRoot = reconcile(setup().result, snapshot).findings[0];
  for (const review of result.reviews) {review.report.units[0].id = technicalRoot.id; review.report.accounting[0].units = [technicalRoot.id];}
  assert.equal(reconcile(result, snapshot, [technicalRoot]).findings.length, 2, 'a product unit cannot impersonate a prior technical defect');
  for (const review of result.reviews) {review.report.units[0].fit.outcome = factor(0, 1); review.scores = validateReport(review.report, snapshot);}
  assert.equal(reconcile(result, snapshot).findings[0].state, 'investigating');
});
