'use strict';

// Unit views and report merge. The unit specs below are a LOCAL fixture of the design's pinned shape
// {id, owned, context_ids}; the real partition planner is a separate module and is not used here.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {digest, GATES, scoreReport, validateReport, validateApproval, approvalHold} = require('./acceptance.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {template, validateInspection, combine} = require('./acceptance-review.cjs');
const {withDiscovery} = require('./acceptance-controller.cjs');
const {unitView, mergeUnitReports, DEFAULTS} = require('./review-units.cjs');

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const lines = n => Array.from({length: n}, (_, i) => `line ${i + 1}`).join('\n');
const patch = '@@ -1,2 +1,3 @@\n context\n-old\n+new\n+newer\n';
const source = (path, content, extra = {}) => ({path, ref: HEAD, authority: 'untrusted', kind: 'source', content, ...extra});

// Eight changed files: a lockfile with a derived summary, a rename, a removal, an addition, tests and docs.
function combined({prior = [], manifest = true} = {}) {
  const sources = {
    contract: {path: '.github/clouseau.md', ref: BASE, authority: 'trusted', kind: 'contract', content: '# Contract\nKeep behaviour.\n'},
    verification: {path: 'verification', ref: HEAD, authority: 'trusted', kind: 'verification', content: '{"ok":true}'},
    'local-request': {path: 'local-request', ref: 'r', authority: 'untrusted', kind: 'requirement', content: 'Change the modules.'},
    'a.head': source('src/a.cjs', "const b = require('./b.cjs');\nmodule.exports = () => b();\n"),
    'a.base': source('src/a.cjs', 'module.exports = () => 1;\n', {ref: BASE}),
    'at.head': source('src/a.test.cjs', "const a = require('./a.cjs');\nawait a();\n"),
    'b.head': source('src/b.cjs', 'module.exports = () => 2;\n'),
    'bt.head': source('src/b.test.cjs', "const b = require('./b.cjs');\nb();\n"),
    'gone.base': source('src/gone.cjs', 'exports.x = 1;\n', {ref: BASE}),
    'old.base': source('src/old-name.cjs', 'exports.y = 1;\n', {ref: BASE}),
    'new.head': source('src/new-name.cjs', 'exports.y = 1;\n// moved\n'),
    'docs.head': source('docs/readme.md', '# Docs\nText.\n'),
    'docs.base': source('docs/readme.md', '# Docs\n', {ref: BASE}),
    'lock.base': source('pnpm-lock.yaml', 'Dependency summary (base)\n', {ref: BASE, authority: 'derived', kind: 'lockfile-summary'}),
    'lock.head': source('pnpm-lock.yaml', 'Dependency summary (head)\n', {authority: 'derived', kind: 'lockfile-summary'}),
    'ctx.engine': source('.clouseau-ci/engine.cjs', 'engine context\n'),
  };
  const files = [
    {path: 'src/a.cjs', status: 'modified', patch, base_source: 'a.base', head_source: 'a.head'},
    {path: 'src/a.test.cjs', status: 'added', patch, head_source: 'at.head'},
    {path: 'src/b.cjs', status: 'added', patch: '--- a\n+++ b\n+only\n', head_source: 'b.head'},
    {path: 'src/b.test.cjs', status: 'added', patch, head_source: 'bt.head'},
    {path: 'src/gone.cjs', status: 'removed', patch: '-x\n', base_source: 'gone.base'},
    {path: 'src/new-name.cjs', status: 'renamed', patch, base_source: 'old.base', head_source: 'new.head'},
    {path: 'docs/readme.md', status: 'modified', patch, base_source: 'docs.base', head_source: 'docs.head'},
    {path: 'pnpm-lock.yaml', status: 'modified', patch: '# replaced\n', base_source: 'lock.base', head_source: 'lock.head'},
  ];
  const snapshot = {version: 2, ...(manifest ? {review_manifest_version: 1} : {}), repository: 'o/r', number: 0, base_sha: BASE, head_sha: HEAD,
    head_repository: {owner: 'o', repo: 'r'}, paths: files.map(file => file.path).sort(), config_digest: 'c', policy_digest: 'p',
    sources, files, history: [{path: 'src/a.cjs', commits: 'x'}, {path: 'src/old-name.cjs', commits: 'y'}, {path: 'docs/readme.md', commits: 'z'}],
    tickets: [], intent_confirmation: null, prior_findings: prior, claims: {title: 'change', description: 'Describe the change.'},
    covering_tests: {'src/a.cjs': ['src/a.test.cjs'], 'src/b.cjs': ['src/b.test.cjs']}};
  return refresh(snapshot, 3000000);
}
const U0 = {id: 'u0', owned: ['src/a.cjs', 'src/a.test.cjs', 'docs/readme.md', 'pnpm-lock.yaml'], context_ids: []};
const U1 = {id: 'u1', owned: ['src/b.cjs', 'src/b.test.cjs', 'src/gone.cjs', 'src/new-name.cjs'], context_ids: ['ctx.engine']};
const UNITS = [U0, U1];

const views = snapshot => UNITS.map(unit => unitView(snapshot, unit, {units: UNITS}));

// A valid, fully satisfied report for a view, optionally with edits; built from the controller's own template.
function report(view, edit = () => {}) {
  const value = template(view);
  for (const item of value.evidence) item.quote = view.sources[item.source].content.split('\n')[item.start - 1];
  for (const unit of value.units) unit.paths = value.accounting.filter(item => item.units.includes(unit.id)).map(item => item.path);
  for (const gate of value.gates) gate.state = 'satisfied';
  edit(value, view);
  return value;
}
function evidenceFor(value, view, filename) {
  return value.evidence.find(item => view.sources[item.source].path === filename).id;
}
const factors = (value, level, evidence) => Object.fromEntries(['necessity', 'confidence', 'severity', 'activation', 'irreversibility', 'reach', 'detection', 'propagation', 'recurrence']
  .map(name => [name, {value: name === 'confidence' ? level : 1, evidence: [evidence], reason: 'Observed.'}]));
function addFinding(value, view, filename, id, level) {
  const evidence = evidenceFor(value, view, filename);
  value.findings.push({id, title: 'Defect', path: filename, cause: `cause ${id}`, trigger: 't', consequence: 'c', obligation: 'o', evidence: [evidence],
    factors: factors(value, level, evidence), blast_radius: 1, opportunity: {mechanical: false, beneficial: false, within_scope: false, verified: false},
    repair_paths: [filename]});
}
const merge = (snapshot, edits = [], drafts = []) => mergeUnitReports(views(snapshot).map((view, index) =>
  ({view, report: report(view, edits[index]), drafts: drafts[index]})), snapshot);

test('a view is an ordinary snapshot over the owned files with the shared context', () => {
  const snapshot = combined();
  const [v0, v1] = views(snapshot);
  assert.deepEqual(v0.paths, [...U0.owned].sort());
  assert.deepEqual(v0.files.map(file => file.path), ['src/a.cjs', 'src/a.test.cjs', 'docs/readme.md', 'pnpm-lock.yaml']);
  assert.equal(v0.base_sha, BASE); assert.equal(v0.config_digest, 'c'); assert.equal(v0.claims.description, 'Describe the change.');
  assert.equal(v0.partition_of, snapshot.digest);
  assert.notEqual(v0.digest, v1.digest);
  assert.equal(v0.digest, refresh(structuredClone(v0)).digest, 'the digest is the existing refresh digest');
  // shared: contract, verification, request and BOTH derived lockfile summaries; the engine context only in the unit that names it
  for (const id of ['contract', 'verification', 'local-request', 'lock.base', 'lock.head']) assert.ok(v0.sources[id] && v1.sources[id], id);
  assert.ok(!v0.sources['ctx.engine'] && v1.sources['ctx.engine']);
  assert.ok(!v0.sources['b.head'] && v1.sources['b.head'], 'a changed source belongs to its owner only');
  assert.deepEqual(v1.history, [{path: 'src/old-name.cjs', commits: 'y'}], 'history of a rename is kept under its old path');
  assert.deepEqual(v0.covering_tests, {'src/a.cjs': ['src/a.test.cjs']});
  assert.deepEqual(v1.covering_tests, {'src/b.cjs': ['src/b.test.cjs']});
  // the unit input is not mutated and the combined snapshot is untouched
  assert.equal(snapshot.digest, refresh(structuredClone(snapshot), 3000000).digest);
  // and an unchanged validator accepts a report over it
  validateInspection(report(v0), v0);
  validateInspection(report(v1), v1);
});

test('the manifest lists the whole change with owners, counts, sizes and rename origins', () => {
  const [v0, v1] = views(combined());
  assert.deepEqual(v0.change_manifest, v1.change_manifest);
  const entry = name => v0.change_manifest.find(item => item.path === name);
  assert.deepEqual(entry('src/a.cjs'), {path: 'src/a.cjs', status: 'modified', additions: 2, deletions: 1,
    size: 'module.exports = () => 1;\n'.length + "const b = require('./b.cjs');\nmodule.exports = () => b();\n".length, unit: 'u0'});
  assert.deepEqual(entry('src/b.cjs'), {path: 'src/b.cjs', status: 'added', additions: 1, deletions: 0, size: 'module.exports = () => 2;\n'.length, unit: 'u1'});
  assert.equal(entry('src/new-name.cjs').previous_path, 'src/old-name.cjs');
  assert.equal(entry('src/gone.cjs').status, 'removed');
  assert.equal(v0.change_manifest.length, 8);
});

test('imports of a changed file in another unit bring that callee hunk, read-only and bounded', () => {
  const snapshot = combined();
  const [v0, v1] = views(snapshot);
  assert.deepEqual(v0.foreign_hunks, [{path: 'src/b.cjs', unit: 'u1', status: 'added', patch: '--- a\n+++ b\n+only\n'}]);
  assert.deepEqual(v0.foreign_omitted, []);
  assert.deepEqual(v1.foreign_hunks, [], 'b.test imports b (owned); nothing foreign');
  assert.ok(!v0.sources['b.head'], 'a foreign hunk is not citable evidence');
});

test('a view over the cap, or with oversized shared context or manifest, is refused with a typed code', () => {
  const snapshot = combined();
  assert.throws(() => unitView(snapshot, U0, {units: UNITS, cap: 1000}), error => error.code === 'unit_exceeds_budget' && error.unit === 'u0' && /source budget/.test(error.message));
  assert.throws(() => unitView(snapshot, U0, {units: UNITS, sharedCap: 10}), error => error.code === 'shared_context_too_large');
  assert.throws(() => unitView(snapshot, U0, {units: UNITS, manifestCap: 100}), error => error.code === 'manifest_too_large');
  const tight = unitView(snapshot, U0, {units: UNITS, cap: 60000, foreignShare: 0.0001});
  assert.deepEqual(tight.foreign_hunks, []);
  assert.deepEqual(tight.foreign_omitted, ['src/b.cjs'], 'what does not fit is listed, never silently dropped');
});

test('the specs must be a disjoint cover of the changed paths and contain the unit', () => {
  const snapshot = combined();
  const bad = (unit, units) => assert.throws(() => unitView(snapshot, unit, {units}), error => error.code === 'partition_invalid');
  bad(U0, [U0]);
  bad(U0, [U0, {...U1, owned: [...U1.owned, 'src/a.cjs']}]);
  bad(U0, [U0, {...U1, owned: U1.owned.slice(1)}]);
  bad(U0, [U0, {...U1, id: 'u0'}]);
  bad(U0, [U1]);
  bad({...U0, id: ''}, [{...U0, id: ''}, U1]);
  bad(U0, [U0, {...U1, context_ids: ['missing']}]);
  bad(U0, [U0, {...U1, owned: 'x'}]);
  bad(U0, [U0, {id: 'u1', owned: U1.owned}]);
  bad({...U0, owned: [...U0.owned]}, [{...U0, context_ids: ['contract']}, U1]);
});

test('a change reviewed as one unit needs no unit list', () => {
  const snapshot = combined();
  const whole = {id: 'u0', owned: [...snapshot.paths], context_ids: []};
  const view = unitView(snapshot, whole);
  assert.deepEqual(view.paths, snapshot.paths);
  assert.deepEqual(view.foreign_hunks, []);
  assert.equal(view.prior_findings.length, 0);
  const {report: merged} = mergeUnitReports([{view, report: report(view)}], snapshot);
  validateInspection(merged, snapshot);
});

test('a snapshot without a manifest version and without prior findings or covering tests views and merges', () => {
  const snapshot = combined({manifest: false}); delete snapshot.prior_findings; delete snapshot.covering_tests; refresh(snapshot, 3000000);
  const [v0] = views(snapshot);
  assert.equal(v0.prior_findings, undefined); assert.equal(v0.covering_tests, undefined);
  const {report: merged} = merge(snapshot);
  assert.equal(merged.coverage, undefined);
  validateReport(merged, snapshot);
});

test('the merged report passes the unchanged validators, scoring and approval hold', () => {
  const snapshot = combined();
  const {report: merged, drafts} = merge(snapshot);
  assert.deepEqual(drafts, []);
  validateInspection(merged, snapshot, drafts);
  assert.equal(scoreReport(merged).decision, 'auto_approve');
  assert.equal(merged.accounting.length, snapshot.paths.length);
  assert.equal(merged.coverage.sources.length, Object.keys(snapshot.sources).length);
  assert.ok(merged.summary.startsWith('u0: ') && merged.summary.includes(' | u1: '));
  assert.ok(merged.evidence.every(item => /^u[01]:/.test(item.id)) && merged.units.every(item => /^u[01]:/.test(item.id)));
});

test('findings are namespaced by path and evidence by unit; units cannot erase one another', () => {
  const snapshot = combined();
  const {report: merged} = merge(snapshot, [(value, view) => addFinding(value, view, 'src/a.cjs', 'f1', 0.4), (value, view) => addFinding(value, view, 'src/b.cjs', 'f1', 0.4)]);
  const ids = merged.findings.map(item => item.id);
  assert.equal(new Set(ids).size, 2, 'the same local id in two units does not collide');
  assert.deepEqual(ids, [`p${digest('src/a.cjs').slice(0, 8)}:f1`, `p${digest('src/b.cjs').slice(0, 8)}:f1`]);
  assert.ok(merged.findings.every(item => item.evidence.every(id => /^u[01]:/.test(id))));
  validateInspection(merged, snapshot);
  assert.equal(scoreReport(merged).decision, 'auto_approve', 'two sub-threshold findings stay sub-threshold: no summing');
});

test('one finding scored 70 or more in any unit blocks, and the score is never averaged', () => {
  const snapshot = combined();
  const alone = report(views(snapshot)[1], (value, view) => addFinding(value, view, 'src/b.cjs', 'hard', 0.9));
  for (const blocker of [0, 1]) {
    const edits = [undefined, undefined]; const file = blocker ? 'src/b.cjs' : 'src/a.cjs';
    edits[blocker] = (value, view) => addFinding(value, view, file, 'hard', 0.9);
    const {report: merged} = merge(snapshot, edits);
    validateInspection(merged, snapshot);
    const scored = scoreReport(merged);
    assert.equal(scored.decision, 'repair_required');
    assert.equal(scored.findings[0].disposition, 'blocking');
    assert.equal(scored.findings[0].score, scoreReport(alone).findings[0].score, 'the merged score equals the unit score; a clean unit does not dilute it');
  }
});

test('strictest gate wins for every pair of states; inapplicable only when all units say so', () => {
  const snapshot = combined();
  const states = ['violated', 'unresolved', 'satisfied', 'inapplicable'];
  for (const first of states) for (const second of states) {
    const {report: merged} = merge(snapshot, [first, second].map(state => value => {
      value.gates.find(gate => gate.name === 'security_isolation').state = state;
    }));
    const expected = states.find(state => state === first || state === second);
    assert.equal(merged.gates.find(gate => gate.name === 'security_isolation').state, expected, `${first} + ${second}`);
    validateInspection(merged, snapshot);
    assert.equal(merged.gates.length, GATES.length);
  }
  const {report: merged} = merge(snapshot, [value => {value.gates.find(gate => gate.name === 'test_integrity').state = 'violated';}]);
  assert.equal(scoreReport(merged).decision, 'blocked_integrity');
  assert.match(merged.gates.find(gate => gate.name === 'test_integrity').reason, /^u0: /);
});

test('missing evidence in any unit stays missing, forces unresolved completeness and holds approval', () => {
  const snapshot = combined();
  const missing = source => (value, view) => {
    const item = value.coverage.sources.find(entry => entry.source === source);
    Object.assign(item, {state: 'missing', evidence: []});
    value.gates.find(gate => gate.name === 'review_completeness').state = 'unresolved';
  };
  // a shared source inspected by u0 but missing for u1; and a dependency missing in u1 only
  const {report: merged} = merge(snapshot, [undefined, (value, view) => {
    missing('contract')(value, view);
    value.coverage.dependencies.push({path: 'src/dep.cjs', state: 'missing', reason: 'Not supplied.', evidence: []});
  }]);
  validateInspection(merged, snapshot);
  assert.equal(merged.coverage.sources.find(item => item.source === 'contract').state, 'missing');
  assert.equal(merged.coverage.dependencies[0].state, 'missing');
  assert.equal(merged.gates.find(gate => gate.name === 'review_completeness').state, 'unresolved');
  assert.equal(approvalHold(merged, snapshot), 'review completeness is unresolved');
  // a unit that violated completeness while another has missing evidence: the validator's rule (missing => unresolved) wins
  const {report: both} = merge(snapshot, [value => {value.gates.find(gate => gate.name === 'review_completeness').state = 'violated';}, missing('contract')]);
  validateInspection(both, snapshot);
  assert.equal(both.gates.find(gate => gate.name === 'review_completeness').state, 'unresolved');
  assert.match(both.gates.find(gate => gate.name === 'review_completeness').reason, /recorded as missing/);
});

test('coverage dispositions: the owner unit judges a changed source; a shared source takes the best non-missing judgement; dependencies merge by path', () => {
  const snapshot = combined();
  const cite = (value, view) => value.evidence.find(item => view.sources[item.source].path === 'verification').id;
  const {report: merged} = merge(snapshot, [(value, view) => {
    // u0 only excludes the shared contract and dependency; u1 inspects them
    Object.assign(value.coverage.sources.find(entry => entry.source === 'contract'), {state: 'excluded', reason: 'Not relevant here.'});
    value.coverage.dependencies.push({path: 'verification', state: 'excluded', reason: 'Skip.', evidence: [cite(value, view)]});
  }, (value, view) => {
    value.coverage.dependencies.push({path: 'verification', state: 'inspected', reason: 'Read.', evidence: [cite(value, view)]});
  }]);
  validateInspection(merged, snapshot);
  assert.equal(merged.coverage.dependencies.length, 1);
  assert.equal(merged.coverage.dependencies[0].state, 'inspected');
  assert.ok(merged.coverage.dependencies[0].evidence[0].startsWith('u1:'));
  assert.equal(merged.coverage.sources.find(item => item.source === 'contract').state, 'inspected');
  // the owner's judgement of an owned changed source stands even when a non-owner reports the same source differently
  const own = merge(snapshot, [undefined, (value) => {
    Object.assign(value.coverage.sources.find(entry => entry.source === 'lock.head'), {state: 'excluded', reason: 'Derived, not mine.'});
  }]);
  const lock = own.report.coverage.sources.find(item => item.source === 'lock.head');
  assert.equal(lock.state, 'inspected', 'u0 owns the lockfile and inspected it');
  assert.match(lock.reason, /^u0: /);
});

test('a source that no supplied view contains is recorded as missing and holds completeness', () => {
  const snapshot = combined();
  const [v0, v1] = views(snapshot);
  delete v1.sources['ctx.engine']; delete v1.digest; refresh(v1);
  const {report: merged} = mergeUnitReports([{view: v0, report: report(v0)}, {view: v1, report: report(v1)}], snapshot);
  validateInspection(merged, snapshot);
  const item = merged.coverage.sources.find(entry => entry.source === 'ctx.engine');
  assert.deepEqual([item.state, item.evidence], ['missing', []]);
  assert.equal(merged.gates.find(gate => gate.name === 'review_completeness').state, 'unresolved');
  assert.equal(approvalHold(merged, snapshot), 'review completeness is unresolved');
});

test('prior findings are carried by the unit that owns their path; ledger identities and dispositions survive the merge', () => {
  const ledgerId = 'f'.repeat(64);
  const prior = [
    {id: ledgerId, kind: 'technical', title: 'Old', path: 'src/b.cjs', cause: 'old cause', obligation: 'old', blocking: false, state: 'dismissed', resolution: 'ok'},
    {id: 'e'.repeat(64), kind: 'technical', title: 'Orphan', path: 'src/vanished.cjs', cause: 'orphan', obligation: 'o', blocking: false, state: 'dismissed', resolution: 'ok'},
    {id: 'c'.repeat(64), kind: 'technical', title: 'Open', path: 'src/a.cjs', cause: 'open', obligation: 'o', blocking: true, state: 'outstanding'},
  ];
  const snapshot = combined({prior});
  const [v0, v1] = views(snapshot);
  assert.deepEqual(v0.prior_findings.map(item => item.id), ['e'.repeat(64), 'c'.repeat(64)], 'a prior finding whose path left the change goes to the first unit');
  assert.deepEqual(v1.prior_findings.map(item => item.id), [ledgerId]);
  const {report: merged} = merge(snapshot, [
    (value, view) => {
      const evidence = value.evidence.find(item => view.sources[item.source].ref === HEAD && view.sources[item.source].kind === 'source').id;
      value.reopenings.push({id: 'e'.repeat(64), reason: 'It changed again.', evidence: [evidence]});
      value.resolutions.push({id: 'c'.repeat(64), state: 'corrected', reason: 'Fixed.', evidence: [evidence]});
    },
    (value, view) => {
      addFinding(value, view, 'src/b.cjs', ledgerId, 0.3);
    },
  ]);
  validateInspection(merged, snapshot);
  assert.equal(merged.findings[0].id, ledgerId, 'a ledger identity is not renamed, so reconcile still matches it');
  assert.deepEqual(merged.reopenings.map(item => item.id), ['e'.repeat(64)]);
  assert.deepEqual(merged.resolutions.map(item => item.id), ['c'.repeat(64)], 'a ledger resolution keeps its identity');
  assert.ok(merged.reopenings[0].evidence[0].startsWith('u0:'));
});

test('resolutions of a prior draft finding follow the draft finding to its merged identity; drafts merge by round', () => {
  const snapshot = combined();
  const [v0, v1] = views(snapshot);
  // Round one of u1 raised a concern; round two retains it, and u0's round two resolves its own concern.
  const first1 = report(v1, (value, view) => addFinding(value, view, 'src/b.cjs', 'kept', 0.3));
  const first0 = report(v0, (value, view) => addFinding(value, view, 'src/a.cjs', 'closed', 0.3));
  const second1 = report(v1, (value, view) => addFinding(value, view, 'src/b.cjs', 'kept', 0.3));
  const second0 = report(v0, (value, view) => {
    value.resolutions.push({id: 'closed', state: 'corrected', reason: 'Fixed.', evidence: [evidenceFor(value, view, 'src/a.cjs')]});
  });
  const {report: merged, drafts} = mergeUnitReports([{view: v0, report: second0, drafts: [first0]}, {view: v1, report: second1, drafts: [first1]}], snapshot);
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0].findings.map(item => item.id).sort(), [`p${digest('src/a.cjs').slice(0, 8)}:closed`, `p${digest('src/b.cjs').slice(0, 8)}:kept`].sort());
  assert.ok(drafts[0].evidence.every(item => /^u[01]:d0:/.test(item.id)));
  assert.deepEqual(merged.resolutions.map(item => item.id), [`p${digest('src/a.cjs').slice(0, 8)}:closed`]);
  validateInspection(merged, snapshot, drafts);
  // the derived decision needs both; dropping a draft's concern without resolving it is still rejected by the unchanged validator
  const dropped = structuredClone(merged); dropped.resolutions = [];
  assert.throws(() => validateInspection(dropped, snapshot, drafts), /prior investigation concern/);
});

test('single derivation: approvalHold and the receipt discovery decide the merged report exactly as a one-snapshot report', () => {
  const snapshot = combined();
  const {report: merged} = merge(snapshot);
  // The same review done in one piece over the combined snapshot: every gate satisfied.
  const whole = template(snapshot);
  for (const gate of whole.gates) gate.state = 'satisfied';
  // A stored discovery is JSON: the importers of the renamed production file.
  const found = JSON.parse(JSON.stringify({test_imports: [{path: 'src/b.test.cjs', specifiers: ['./b.cjs', './new-name.cjs']}], sources: {}}));
  const lost = {test_imports: [], sources: {}};
  for (const [name, discovery, expected] of [['discovered', found, null], ['lost', lost, 'no supplied test imports changed production code: src/new-name.cjs']]) {
    assert.equal(approvalHold(merged, withDiscovery(snapshot, discovery)), expected, name);
    assert.equal(approvalHold(merged, withDiscovery(snapshot, discovery)), approvalHold(whole, withDiscovery(snapshot, discovery)), `${name}: same as one snapshot`);
  }
  const validated = validateInspection(merged, snapshot);
  const approve = validateApproval(merged, validated, withDiscovery(validated, found));
  assert.equal(approve.decision, 'auto_approve');
  assert.equal(combine([{scores: approve}, {scores: approve}]), 'auto_approve');
  assert.equal(validateApproval(merged, validated, withDiscovery(validated, lost)).decision, 'review_incomplete');
  // A missing source in one unit produces the same hold a one-snapshot review would.
  const {report: holding} = merge(snapshot, [undefined, value => {
    Object.assign(value.coverage.sources.find(entry => entry.source === 'verification'), {state: 'missing', evidence: []});
    value.gates.find(gate => gate.name === 'review_completeness').state = 'unresolved';
  }]);
  const single = template(snapshot);
  for (const gate of single.gates) gate.state = gate.name === 'review_completeness' ? 'unresolved' : 'satisfied';
  Object.assign(single.coverage.sources.find(entry => entry.source === 'verification'), {state: 'missing', evidence: []});
  assert.equal(approvalHold(holding, withDiscovery(snapshot, found)), 'review completeness is unresolved');
  assert.equal(approvalHold(holding, withDiscovery(snapshot, found)), approvalHold(single, withDiscovery(snapshot, found)));
});

test('merging refuses an incomplete cover, a foreign or altered view and a duplicated finding identity', () => {
  const snapshot = combined();
  const [v0, v1] = views(snapshot);
  const ok = view => ({view, report: report(view), drafts: []});
  const refused = (reports, snap = snapshot) => assert.throws(() => mergeUnitReports(reports, snap), error => error.code === 'merge_invalid');
  refused([ok(v0)]);
  refused([ok(v0), ok(v0)]);
  const other = structuredClone(snapshot); other.claims = {title: 'other', description: 'other'}; refresh(other, 3000000);
  refused([ok(v0), ok(v1)], other);
  const altered = structuredClone(v1); altered.claims = {title: 'altered', description: 'altered'};
  refused([ok(v0), ok(altered)]);
  // two units cannot both report the same ledger identity
  const ledgerId = 'd'.repeat(64);
  const prior = combined({prior: [{id: ledgerId, kind: 'technical', title: 'T', path: 'src/a.cjs', cause: 'c', obligation: 'o', blocking: false, state: 'dismissed', resolution: 'r'}]});
  const [p0, p1] = views(prior);
  const withId = (view, name) => ({view, report: report(view, (value, v) => addFinding(value, v, name, ledgerId, 0.3))});
  assert.throws(() => mergeUnitReports([withId(p0, 'src/a.cjs'), withId(p1, 'src/b.cjs')], prior), error => error.code === 'merge_invalid' && /same finding identity/.test(error.message));
  // an invalid unit report is rejected by the unchanged validator, not repaired
  const bad = report(v1); bad.summary = '';
  assert.throws(() => mergeUnitReports([ok(v0), {view: v1, report: bad}], snapshot), /Invalid acceptance evidence/);
});

test('refresh takes the cap as a parameter and the default stays 900000', () => {
  assert.equal(DEFAULTS.cap, 900000);
  const value = {sources: {large: {content: 'x'.repeat(900001)}}};
  assert.throws(() => refresh(value), /source budget/);
  assert.throws(() => refresh({sources: {s: {content: 'x'.repeat(100)}}}, 50), /source budget/);
  assert.equal(refresh({sources: {s: {content: 'x'}}}, 5000).digest, refresh({sources: {s: {content: 'x'}}}).digest, 'the cap never enters the digest');
  assert.equal(refresh({sources: {s: {content: 'x'}}}, undefined).digest, refresh({sources: {s: {content: 'x'}}}).digest, 'undefined means the default');
  for (const bad of [NaN, '10', 0, -1, Infinity, 1.5, null, {}]) {
    assert.throws(() => refresh({sources: {s: {content: 'x'.repeat(2000000)}}}, bad), /Invalid evidence limit/, String(bad));
  }
  const a = {sources: {s: {content: 'x'.repeat(500000)}}};
  assert.equal(refresh(a).digest, digest({sources: a.sources}), 'unchanged behaviour under the default cap');
  assert.throws(() => refresh({sources: {large: {content: 'x'.repeat(900001)}}}, 899999), /source budget/);
  assert.ok(refresh({sources: {large: {content: 'x'.repeat(900001)}}}, 1000000).digest, 'a larger cap admits what the default refuses');
});

test('every unit evidence limit must be a positive safe integer (a fraction for foreignShare); invalid limits fail closed', () => {
  const snapshot = combined();
  for (const name of ['cap', 'sharedCap', 'manifestCap']) {
    for (const bad of [NaN, '10', 0, -1, Infinity, 1.5, null]) {
      assert.throws(() => unitView(snapshot, U0, {units: UNITS, [name]: bad}), error => error.code === 'limit_invalid' && error.message.includes(name), `${name}=${String(bad)}`);
    }
    assert.ok(unitView(snapshot, U0, {units: UNITS, [name]: undefined}).digest, `${name} undefined means the default`);
  }
  for (const bad of [NaN, '0.2', 0, -0.1, 1.01, Infinity, null]) {
    assert.throws(() => unitView(snapshot, U0, {units: UNITS, foreignShare: bad}), error => error.code === 'limit_invalid' && /foreignShare/.test(error.message), `foreignShare=${String(bad)}`);
  }
  assert.ok(unitView(snapshot, U0, {units: UNITS, foreignShare: 1}).digest);
});
