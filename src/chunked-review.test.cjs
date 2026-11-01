'use strict';

// Unit runner for chunked local review, against a fake harness that answers every session from the controller's
// own templates. The partition is the real planner's; nothing here calls the network or a model.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {digest, FACTORS} = require('./acceptance.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {modelTemplate} = require('./acceptance-review.cjs');
const {unitView} = require('./review-units.cjs');
const {partition} = require('./review-partition.cjs');
const {chunkedVerifier, RECORD_LIMIT} = require('./chunked-record.cjs');
const {changeTable, segmentLimit} = require('./change-table.cjs');
const {runnerLimits, memoryJournal, chunkedReview, mergeWithIntegration, ChunkedReviewRefusal} = require('./chunked-review.cjs');

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

const PARAMS = {C: 1, S: 100000};
const sizeOf = (snapshot, id) => (id ? snapshot.sources[id].content.length : 0);
function planOf(snapshot, ceiling = 1) {
  return partition(snapshot.files.map(file => ({path: file.path, base_size: sizeOf(snapshot, file.base_source),
    head_size: sizeOf(snapshot, file.head_source), patch_chars: file.patch.length})), {unit_ceiling: ceiling});
}

// A fake harness. `options.finding` adds a defect to unit u0 of the examiner; `options.dispose` chooses seam states.
function harness(snapshot, plan, options = {}) {
  const spec = unit => ({id: unit.id, owned: unit.owned, context_ids: [], ...(unit.parts ? {parts: unit.parts} : {})});
  const views = Object.fromEntries(plan.units.map(unit => [unit.id, unitView(snapshot, spec(unit),
    {units: plan.units.map(spec), segmentLimit: segmentLimit({unit_ceiling: options.ceiling ?? PARAMS.C, shared: PARAMS.S})})]));
  const state = {calls: [], active: 0, peak: 0, tasks: []};
  const ask = async task => {
    state.tasks.push(task);
    const n = state.calls.length + 1;
    state.calls.push(`${task.role}:${task.phase}${task.unit ? `:${task.unit}` : ''}`);
    state.active++; state.peak = Math.max(state.peak, state.active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      if (options.hook) await options.hook(task, n);
      let value;
      if (task.phase === 'investigation') {
        const view = views[task.unit];
        const report = modelTemplate(view);
        report.gates.forEach(gate => {gate.state = 'satisfied';});
        if (options.finding && task.role === 'examiner' && task.unit === 'u0') {
          const evidence = report.accounting[0].evidence;
          report.findings = [{id: 'fictional-defect', title: 'Fictional fixture defect', anchor: evidence[0],
            cause: 'Synthetic cause.', trigger: 'Synthetic trigger.', consequence: 'Synthetic consequence.', obligation: 'Synthetic obligation.', evidence,
            factors: Object.fromEntries(FACTORS.defect.map(name => [name, {evidence, reason: 'Synthetic observation.'}])),
            blast_radius: 1, opportunity: {mechanical: false, beneficial: false, within_scope: false, verified: false}, repair_paths: view.paths}];
        }
        value = options.sourceRequest ? {kind: 'source_request', report: null, request_sources: ['x.js']} : {kind: 'report', report, request_sources: []};
      } else if (task.phase === 'integration') {
        const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
        value = options.integration ? options.integration(packet) : {dispositions: packet.seams.map(seam => ({seam: seam.id,
          state: (options.dispose || (() => 'checked'))(seam), reason: 'Examined both ends.'}))};
      } else {
        value = {answers: Object.fromEntries(Object.keys(task.schema.properties.answers.properties).map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))};
      }
      return {value, provenance: {harness: 'codex', role: task.role, phase: task.phase, session: `fictional-session-${n}`,
        request_digest: digest(task.prompt), response_digest: digest(value), transport_digest: digest({n, value})}};
    } finally {state.active--;}
  };
  return {ask, state, views};
}

const seam = (id, size = 20) => ({id, kind: 'import', a: {path: 'src/a.cjs', unit: 'u0'}, b: {path: 'src/b.cjs', unit: 'u1'}, excerpts: 'x'.repeat(size)});
const run = (snapshot, plan, h, extra = {}) => chunkedReview({snapshot, plan, ask: h.ask, chunked: {params: PARAMS}, ...extra});
const refused = async (promise, code) => {
  await assert.rejects(promise, error => error instanceof ChunkedReviewRefusal && error.code === code, code);
};

test('every unit is reviewed by both roles with at most two sessions, then integrated, merged and graded once per role', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  assert.ok(plan.units.length > 2);
  const h = harness(snapshot, plan, {finding: true});
  const out = await run(snapshot, plan, h, {seams: [seam('s1'), seam('s2')]});
  assert.equal(h.state.peak, 2, 'two sessions run together and never more');
  const count = phase => h.state.calls.filter(call => call.includes(`:${phase}`)).length;
  assert.equal(count('investigation'), plan.units.length * 2);
  assert.equal(count('integration'), 2);
  assert.equal(count('grading'), 1, 'only the role that has findings is graded');
  assert.deepEqual(h.state.calls.slice(0, 4), ['examiner:investigation:u0', 'challenger:investigation:u0', 'examiner:investigation:u1', 'challenger:investigation:u1']);
  assert.ok(h.state.tasks.filter(task => task.phase === 'investigation').every(task => task.prompt.length < 1048576 && task.prompt.includes('one unit (')));
  assert.equal(out.result.decision, 'repair_required');
  assert.equal(out.reviews.length, 2);
  assert.equal(out.partition.units.length, plan.units.length);
  assert.ok(out.result.usage.filter(item => item.phase === 'investigation').every(item => typeof item.unit === 'string'));
  assert.equal(out.result.execution_digest, digest(out.result.usage));
  assert.ok(out.result.reviews.every(review => !('report' in review) && !('scores' in review)));
  // The record the runner describes is exactly what the unchanged chunked verifier accepts and re-derives.
  const specs = out.partition.units;
  const hooks = {partition: () => out.partition, seams: () => out.seams,
    unitView: (combinedSnapshot, unit) => unitView(combinedSnapshot, unit, {units: specs, sharedCap: PARAMS.S}),
    merge: ({unitReports, integration, snapshot: combinedSnapshot}) => mergeWithIntegration({integration, snapshot: combinedSnapshot, seams: out.seams,
      reports: unitReports.map(({unit, report}) => ({view: h.views[unit], report, drafts: []}))}).report};
  const record = {version: 3, snapshot, partition: out.partition, seams: out.seams, result: out.result};
  const verified = chunkedVerifier(record, {params: PARAMS, hooks}).reviews();
  assert.deepEqual(verified.map(item => item.report), out.reviews.map(item => item.report));
});

test('a plan of more units than the old ceiling still runs, one session at a time when so configured', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  const h = harness(snapshot, plan);
  const out = await chunkedReview({snapshot, plan, ask: h.ask, chunked: {params: {...PARAMS, cap: 10, max_units: 2}, concurrency: 1}});
  assert.equal(h.state.peak, 1);
  assert.equal(out.result.decision, 'auto_approve');
  assert.equal(h.state.calls.filter(call => call.includes('integration')).length, 2, 'the integration pass runs even with no seams');
});

test('seams are sharded under the integration cap and any seam not checked leaves completeness unresolved', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  const h = harness(snapshot, plan, {dispose: item => (item.id === 's2' ? 'missing' : item.id === 's3' ? 'finding' : 'checked')});
  const seams = [seam('s1', 60000), seam('s2', 60000), seam('s3', 60000), seam('s4', 60000)];
  const out = await chunkedReview({snapshot, plan, seams, ask: h.ask, chunked: {params: PARAMS, integration_cap: 140000}});
  const integrations = out.result.reviews[0].integration;
  assert.ok(integrations.length >= 2);
  assert.deepEqual(integrations.flatMap(entry => entry.seams).sort(), ['s1', 's2', 's3', 's4']);
  const gate = out.reviews[0].report.gates.find(item => item.name === 'review_completeness');
  assert.equal(gate.state, 'unresolved');
  assert.ok(gate.reason.includes('s2 missing') && gate.reason.includes('s3 finding'));
});

test('a resumed review never samples a finished call again', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  const journal = memoryJournal();
  const first = harness(snapshot, plan, {hook: (task, n) => {if (n === 7) throw new Error('crash');}});
  await assert.rejects(run(snapshot, plan, first, {journal, scope: 'engine-1'}), /crash/);
  const finished = first.state.calls.length - 1;
  assert.ok(finished >= 6);
  const second = harness(snapshot, plan);
  const out = await run(snapshot, plan, second, {journal, scope: 'engine-1'});
  assert.equal(out.result.decision, 'auto_approve');
  const total = plan.units.length * 2 + 2;
  assert.ok(second.state.calls.length <= total - 6, 'finished sessions were replayed from the journal');
  const other = harness(snapshot, plan);
  await run(snapshot, plan, other, {journal, scope: 'engine-2'});
  assert.equal(other.state.calls.length, total, 'another scope shares nothing');
});

test('a response that fails its own check is not remembered', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  const journal = memoryJournal();
  const bad = harness(snapshot, plan, {integration: () => ({dispositions: [{seam: 'nope', state: 'checked', reason: 'x'}]})});
  await assert.rejects(run(snapshot, plan, bad, {journal, seams: [seam('s1')]}), /exactly once/);
  const good = harness(snapshot, plan);
  const out = await run(snapshot, plan, good, {journal, seams: [seam('s1')]});
  assert.equal(good.state.calls.filter(call => call.includes('integration')).length, 2, 'the invalid answer was sampled again');
  assert.equal(out.result.decision, 'auto_approve');
});

test('protected limits are validated and nothing else can change them', () => {
  assert.deepEqual(runnerLimits({params: PARAMS}), {concurrency: 2, unit_deadline_ms: 300000, integration_cap: 250000, params: PARAMS});
  for (const chunked of [null, [], 'x', {}, {params: PARAMS, extra: 1}, {params: PARAMS, concurrency: 0}, {params: PARAMS, concurrency: 9},
    {params: PARAMS, unit_deadline_ms: 1.5}, {params: {C: 1}}]) {
    assert.throws(() => runnerLimits(chunked), error => error.code === 'chunk_config_invalid');
  }
});

test('malformed input is refused before any session starts', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  const h = harness(snapshot, plan);
  await refused(chunkedReview({snapshot, plan, ask: h.ask, chunked: null}), 'chunk_config_invalid');
  await refused(run(snapshot, {...plan, scheme: 'other'}, h), 'plan_invalid');
  await refused(run(snapshot, {...plan, units: []}, h), 'plan_invalid');
  await refused(run(snapshot, undefined, h), 'plan_invalid');
  await refused(run(snapshot, plan, h, {seams: [seam('a'), seam('a')]}), 'seams_invalid');
  await refused(run(snapshot, plan, h, {seams: 'x'}), 'seams_invalid');
  await refused(run(snapshot, plan, h, {seams: [{id: ''}]}), 'seams_invalid');
  await assert.rejects(run(snapshot, {...plan, units: plan.units.slice(1)}, h), error => error.code === 'partition_invalid');
  assert.deepEqual(h.state.calls, []);
});

test('a plan that was not sized for its evidence is an integrity error, not a size verdict', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  const big = structuredClone(snapshot);
  big.sources['a.head'].content = 'x'.repeat(950000);
  refresh(big, 3000000);
  const h = harness(snapshot, plan);
  await assert.rejects(run(big, plan, h), error => error.code === 'unit_exceeds_budget' && typeof error.unit === 'string');
});

// A file of 40,000 lines edited every third line: far more than one unit can hold, so the planner splits it.
function huge() {
  const old = Array.from({length: 40000}, (_, index) => `line ${index + 1}`);
  const edited = old.map((line, index) => (index % 3 === 0 ? `${line} edited` : line));
  let diff = 'diff --git a/src/a.cjs b/src/a.cjs\n--- a/src/a.cjs\n+++ b/src/a.cjs\n';
  old.forEach((line, index) => {if (index % 3 === 0) diff += `@@ -${index + 1},1 +${index + 1},1 @@\n-${line}\n+${edited[index]}\n`;});
  const snapshot = combined();
  snapshot.sources['a.base'].content = `${old.join('\n')}\n`; snapshot.sources['a.head'].content = `${edited.join('\n')}\n`;
  snapshot.files.find(file => file.path === 'src/a.cjs').patch = diff;
  return refresh(snapshot, Number.MAX_SAFE_INTEGER);
}

test('a file larger than any unit is split into segments, each unit reviewed on its own segment, and the record verifies', async () => {
  const snapshot = huge();
  const params = {C: 450000, S: 100000};
  const plan = partition(changeTable(snapshot, {unit_ceiling: params.C, shared: params.S}), {unit_ceiling: params.C, shared: params.S});
  const holders = plan.units.filter(unit => unit.owned.includes('src/a.cjs'));
  assert.ok(holders.length >= 3 && holders.every(unit => unit.parts['src/a.cjs'].count === holders.length));
  const h = harness(snapshot, plan, {ceiling: params.C});
  const out = await chunkedReview({snapshot, plan, ask: h.ask, chunked: {params}});
  assert.equal(out.result.decision, 'auto_approve');
  assert.deepEqual(out.partition.units.filter(unit => unit.owned.includes('src/a.cjs')).map(unit => unit.parts['src/a.cjs'].index), holders.map((_, index) => index));
  assert.equal(out.result.usage.filter(item => item.phase === 'investigation').length, plan.units.length * 2);
  const hooks = {
    partition: () => out.partition,
    unitView: (combinedSnapshot, unit) => h.views[unit.id],
    seams: () => out.seams,
    merge: ({unitReports, integration, snapshot: combinedSnapshot}) => mergeWithIntegration({integration, snapshot: combinedSnapshot, seams: out.seams,
      reports: unitReports.map(({unit, report}) => ({view: h.views[unit], report, drafts: []}))}).report};
  const record = {version: 3, snapshot, partition: out.partition, seams: out.seams, result: out.result};
  assert.deepEqual(chunkedVerifier(record, {params, hooks}).reviews().map(item => item.report), out.reviews.map(item => item.report));
});

test('a unit asking for more source refuses the whole review', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  await assert.rejects(run(snapshot, plan, harness(snapshot, plan, {sourceRequest: true})),
    error => error.code === 'unit_source_request' && typeof error.unit === 'string');
});

test('a missed deadline names the unit and proposes smaller units; an integration deadline is typed too', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  const never = new Promise(() => {});
  const slowUnit = harness(snapshot, plan, {hook: task => (task.phase === 'investigation' ? never : undefined)});
  await assert.rejects(chunkedReview({snapshot, plan, ask: slowUnit.ask, chunked: {params: {...PARAMS, C: 9}, unit_deadline_ms: 20}}),
    error => error.code === 'unit_deadline' && /^u\d$/.test(error.unit) &&error.retry_ceiling === 4);
  const slowIntegration = harness(snapshot, plan, {hook: task => (task.phase === 'integration' ? never : undefined)});
  await assert.rejects(chunkedReview({snapshot, plan, ask: slowIntegration.ask, chunked: {params: PARAMS, unit_deadline_ms: 20}}),
    error => error.code === 'integration_deadline' && typeof error.role === 'string');
});

test('a prompt above the transport limit refuses before the session is asked', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  const h = harness(snapshot, plan);
  await assert.rejects(chunkedReview({snapshot, plan, ask: h.ask, seams: [seam('big', 1100000)], chunked: {params: PARAMS, integration_cap: 2000000}}),
    error => error.code === 'prompt_too_large' && error.unit === null);
  assert.ok(!h.state.calls.some(call => call.includes('integration')));
});

test('integration input that cannot fit the cap is typed, and so is a single seam that cannot fit', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  const h = harness(snapshot, plan);
  await refused(chunkedReview({snapshot, plan, ask: h.ask, chunked: {params: PARAMS, integration_cap: 10}}), 'integration_input_too_large');
  const probe = harness(snapshot, plan);
  let fixed = 0;
  await chunkedReview({snapshot, plan, ask: probe.ask, chunked: {params: PARAMS}});
  const packet = JSON.parse(probe.state.tasks.find(task => task.phase === 'integration').prompt.split('\n').at(-1));
  fixed = JSON.stringify({...packet, seams: []}).length;
  await assert.rejects(chunkedReview({snapshot, plan, ask: h.ask, seams: [seam('wide', 500)], chunked: {params: PARAMS, integration_cap: fixed + 100}}),
    error => error.code === 'seam_too_large' && error.seam === 'wide');
});

test('invalid integration answers are rejected, and a failing run waits for the sessions already in flight', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  for (const integration of [() => ({dispositions: 'x'}), () => ({dispositions: []}), () => ({dispositions: [null]}),
    () => ({dispositions: [{seam: 's1', state: 'maybe', reason: 'x'}]}), () => ({dispositions: [{seam: 's1', state: 'checked', reason: ''}]}),
    () => ({dispositions: [{seam: 's1', state: 'checked', reason: 'y'.repeat(2001)}]}), () => ({dispositions: [{seam: 's1', state: 'checked'}]})]) {
    await assert.rejects(run(snapshot, plan, harness(snapshot, plan, {integration}), {seams: [seam('s1')]}), /exactly once/);
  }
  const both = harness(snapshot, plan, {hook: () => {throw new Error('both crash');}});
  await assert.rejects(run(snapshot, plan, both), /both crash/);
  assert.equal(both.state.calls.length, 2, 'no new session starts after a failure');
});

test('a plan unit may carry its own context ids', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  const h = harness(snapshot, plan);
  const out = await run(snapshot, {...plan, units: plan.units.map(unit => ({...unit, context_ids: []}))}, h);
  assert.equal(out.result.decision, 'auto_approve');
});

test('a record above the single-receipt limit is not refused: it is signed in parts', async () => {
  const snapshot = combined();
  const plan = planOf(snapshot);
  const seams = Array.from({length: 15}, (_, index) => seam(`s${index}`, 200000));
  const out = await chunkedReview({snapshot, plan, seams, ask: harness(snapshot, plan).ask, chunked: {params: PARAMS}});
  assert.equal(out.result.decision, 'auto_approve');
  assert.ok(Buffer.byteLength(JSON.stringify({snapshot, partition: out.partition, seams: out.seams, result: out.result})) > RECORD_LIMIT);
});

test('merging requires every seam dispositioned exactly once by well-formed integration entries', () => {
  const entry = {seams: ['s1'], dispositions: [{seam: 's1', state: 'checked', reason: 'ok'}]};
  const snapshot = combined();
  for (const integration of [undefined, [], [null], [{seams: 'x', dispositions: []}], [{seams: ['s1'], dispositions: []}],
    [{seams: ['zz'], dispositions: [{seam: 'zz', state: 'checked', reason: 'ok'}]}], [entry, entry]]) {
    assert.throws(() => mergeWithIntegration({reports: [], integration, snapshot, seams: [seam('s1')]}),
      error => error.code === 'integration_invalid');
  }
});
