'use strict';

// End to end: a synthetic pull request above 1 MB through assess and gate, with a fake hosted provider. Nothing here calls
// the network. The attacker cases rewrite the stored record the way an altered artifact would and expect the gate to refuse.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {digest} = require('./acceptance.cjs');
const {verifyRecord} = require('./acceptance-controller.cjs');
const {largeFixture, finding, sources, signedTrust, signLargeReceipt, CONFIG} = require('../test/hosted-large-pr.cjs');

const on = (chunked_hosted = {enabled: true}) => ({...CONFIG, acceptance: {...CONFIG.acceptance, chunked_hosted}});
const ENABLED = on();
const names = f => f.state.writes.map(item => item.name);

test('off by default: an oversized change is still held as before, with no provider call and no record', () => largeFixture(async f => {
  const assessment = await f.assess();
  assert.equal(assessment.decision, 'review_incomplete');
  assert.equal(assessment.cause, 'evidence_budget');
  assert.equal(assessment.reason, 'The changed files together exceed the 900 KB review evidence budget.');
  assert.equal(f.state.calls.length, 0);
  assert.equal(fs.existsSync(f.recordPath), false);
}));

test('a disabled object is the same as absent', () => largeFixture(async f => {
  assert.equal((await f.assess()).cause, 'evidence_budget');
  assert.equal(f.state.calls.length, 0);
}, {config: on({enabled: false})}));

test('a change above 1 MB is reviewed in bounded units, integrated, merged and approved by the gate', () => largeFixture(async f => {
  const lines = [];
  const assessment = await f.assess({report: line => lines.push(line)});
  assert.equal(assessment.decision, 'auto_approve', assessment.reason);
  const record = f.read();
  assert.equal(record.version, 3);
  assert.equal(assessment.record_digest, digest(record));
  assert.ok(JSON.stringify(record.snapshot).length > 1000000, 'the combined snapshot is above the single-snapshot budget');
  assert.ok(record.partition.units.length > 2 && record.seams.length > 0);
  assert.deepEqual(record.result.reviews.map(review => review.role), ['examiner', 'challenger']);
  for (const review of record.result.reviews) {
    assert.equal(review.unit_reports.length, record.partition.units.length);
    assert.ok(review.integration.length > 0);
    assert.equal(Object.hasOwn(review, 'report'), false, 'the merged report is derived, never stored');
  }
  // Every provider prompt is a bounded unit or integration packet, never the whole change; both roles reviewed every unit.
  const units = record.partition.units.length;
  assert.ok(f.state.calls.every(call => call.chars < 1000000));
  assert.equal(f.state.calls.filter(call => call.phase === 'investigation').length, units * 2);
  assert.equal(f.state.calls.filter(call => call.phase === 'integration').length, 2);
  assert.equal(f.state.calls.filter(call => call.phase === 'grading').length, 0);
  assert.deepEqual([...new Set(f.state.calls.filter(call => call.phase === 'investigation').map(call => call.model))].sort(), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(fs.existsSync(`${f.recordPath}.repair.json`), false);
  await f.gate(assessment);
  assert.deepEqual(names(f), ['create-ledger', 'approve']);
}, {config: ENABLED}));

test('a finding in one unit blocks the whole change and is graded once over the merged findings', () => largeFixture(async f => {
  const assessment = await f.assess();
  assert.equal(assessment.decision, 'repair_required');
  assert.equal(f.state.calls.filter(call => call.phase === 'grading').length, 1, 'only the role that reported a finding is graded');
  assert.equal(assessment.repair_digest, undefined, 'a chunked record produces no automatic repair proposal');
  await assert.rejects(f.gate(assessment), /Clouseau repair_required/);
  assert.equal(names(f).includes('approve'), false);
}, {config: ENABLED, provider: {report(report, task, view) {
  if (view.evidence.paths[0] === 'src/mod-000.cjs' && task.model === 'deepseek-flash') finding(report, 'one');
}}}));

test('a seam the integration pass cannot check holds approval', () => largeFixture(async f => {
  const assessment = await f.assess();
  assert.equal(assessment.decision, 'review_incomplete');
  assert.equal(assessment.cause, undefined);
  await assert.rejects(f.gate(assessment), /Clouseau review_incomplete/);
  assert.equal(names(f).includes('approve'), false);
}, {config: ENABLED, provider: {dispositions: ids => ids.map(seam => ({seam, state: 'missing', reason: 'The packet does not show the other end.'}))}}));

test('seams beyond the protected integration limit are recorded as missing, never skipped', () => largeFixture(async f => {
  const assessment = await f.assess();
  const record = f.read();
  assert.ok(record.seams.length > 1);
  assert.equal(assessment.decision, 'review_incomplete');
  assert.ok(record.result.reviews[0].integration.some(entry => entry.dispositions.some(row => row.state === 'missing')));
  const covered = record.result.reviews[0].integration.flatMap(entry => entry.seams);
  assert.deepEqual([...covered].sort(), record.seams.map(seam => seam.id).sort());
}, {config: on({enabled: true, integration_max_seams: 1})}));

test('the unit cap holds the pull request before any provider call and names the cap and how to raise it', () => largeFixture(async f => {
  const assessment = await f.assess();
  assert.equal(assessment.decision, 'review_incomplete');
  assert.equal(assessment.cause, 'chunked_unit_cap');
  assert.match(assessment.reason, /Held, not failed/);
  assert.match(assessment.reason, /acceptance\.chunked_hosted\.max_units = 2/);
  assert.match(assessment.reason, /raise max_units/);
  assert.equal(f.state.calls.length, 0);
  assert.equal(fs.existsSync(f.recordPath), false);
  const posted = [];
  await require('./incomplete.cjs').post({github: {paginate: async () => [], rest: {issues: {listComments: async () => ({data: []}),
    createComment: async args => {posted.push(args.body);}}}}, context: f.context, assessment});
  assert.match(posted[0], /max_units = 2/);
  assert.doesNotMatch(posted[0], /too big|too large/i);
}, {config: on({enabled: true, max_units: 2})}));

test('the token cap holds the pull request before any provider call', () => largeFixture(async f => {
  const assessment = await f.assess();
  assert.equal(assessment.cause, 'chunked_token_cap');
  assert.match(assessment.reason, /max_input_tokens = 1000/);
  assert.equal(f.state.calls.length, 0);
}, {config: on({enabled: true, max_input_tokens: 1000})}));

test('a token cap reached during the run holds it and names the cap', async () => {
  // The preflight estimate counts the unit costs only; the real prompts are larger, so this cap passes the preflight and is
  // crossed during the run.
  let estimate;
  await largeFixture(async f => {
    assert.equal((await f.assess()).decision, 'auto_approve');
    estimate = Math.ceil(2 * f.read().partition.units.reduce((sum, unit) => sum + unit.cost, 0) / 4);
    assert.ok(f.state.calls.reduce((sum, call) => sum + call.chars, 0) / 4 > estimate, 'real prompts exceed the preflight estimate');
  }, {config: ENABLED});
  await largeFixture(async f => {
    const held = await f.assess();
    assert.equal(held.decision, 'review_incomplete');
    assert.equal(held.cause, 'chunked_token_cap');
    assert.match(held.reason, /reached the protected cap acceptance\.chunked_hosted\.max_input_tokens = \d+/);
    assert.match(held.reason, /raise max_input_tokens/);
    assert.ok(f.state.calls.length > 0, 'some calls finished before the cap');
    assert.equal(fs.existsSync(f.recordPath), false, 'no partial record is produced');
  }, {config: on({enabled: true, max_input_tokens: estimate})});
});

test('a provider outage mid-run holds the review and a later run continues from the finished calls', async () => {
  let calls;
  await largeFixture(async f => {
    assert.equal((await f.assess()).decision, 'auto_approve');
    calls = f.state.calls.length;
  }, {config: ENABLED});
  await largeFixture(async f => {
    f.state.outage = true;
    const held = await f.assess();
    assert.equal(held.decision, 'review_incomplete');
    assert.equal(held.cause, 'provider_unavailable');
    const finished = f.state.calls.filter(call => !call.failed).length;
    assert.ok(finished > 0 && finished < calls);
    f.state.outage = false;
    const assessment = await f.assess();
    assert.equal(assessment.decision, 'auto_approve', assessment.reason);
    assert.equal(f.state.calls.filter(call => !call.failed).length, calls, 'every call completed exactly once across both runs');
  }, {config: ENABLED, provider: {fail(task) {return task.state.outage && task.state.calls.length > 5;}}});
});

// Attacker cases: the stored record is rewritten the way an altered artifact would be, and re-bound to the assessment so that
// the record digest is not what stops it. The gate re-derives everything from the signed-in-place evidence.
const attack = (title, mutate, pattern, options = {}, decision = 'auto_approve') => test(`gate refuses ${title}`, () => largeFixture(async f => {
  const assessment = await f.assess(); assert.equal(assessment.decision, decision);
  const record = f.read(); mutate(record); f.write(record);
  await assert.rejects(f.gate(f.rebind(assessment, f.read())), pattern);
  assert.equal(names(f).includes('approve'), false);
}, {config: ENABLED, ...options}));

attack('a forged partition', record => {record.partition.units[0].cost += 1;}, /forged partition/);
attack('a partition that leaves a changed path unowned', record => {record.partition.units[0].owned.pop();}, /owned by no unit|has no owned paths/);
attack('a partition that gives a path to two units', record => {record.partition.units[1].owned.push(record.partition.units[0].owned[0]);}, /duplicate ownership/);
attack('a missing unit report', record => {record.result.reviews[0].unit_reports.shift();}, /has no report for unit/);
attack('a unit report replayed for another unit', record => {
  const [first, second] = record.result.reviews[1].unit_reports; second.report = first.report;
}, /not bound to that unit's view/);
attack('a report for an unknown unit', record => {record.result.reviews[0].unit_reports[0].unit = 'u999';}, /unknown unit/);
attack('a stored merged report', record => {record.result.reviews[0].report = {};}, /stores a merged report/);
attack('a dropped integration pass', record => {record.result.reviews[0].integration = [];}, /integration_invalid/);
attack('seams that differ from the recomputed seams', record => {record.seams.pop();}, /seams differ/);
attack('a dropped overflow entry', record => {record.result.reviews[0].integration.pop();}, /integration_invalid/,
  {config: on({enabled: true, integration_max_seams: 1})}, 'review_incomplete');
attack('an execution record without a unit investigation', record => {
  record.result.usage = record.result.usage.filter(item => !(item.role === 'examiner' && item.unit === 'u0'));
}, /no recorded investigation of unit u0/);
attack('altered evidence', record => {
  const id = Object.keys(record.snapshot.sources).find(name => name.includes('mod-000.cjs')); record.snapshot.sources[id].content += '//';
}, /rejected/);
attack('parameters that differ from the protected ones', record => {record.partition.params.C -= 1;}, /partition parameters differ/);

test('gate refuses a changed record without a matching digest', () => largeFixture(async f => {
  const assessment = await f.assess();
  const record = f.read(); record.controls = true; f.write(record);
  await assert.rejects(f.gate(assessment), /Stale or altered acceptance record/);
}, {config: ENABLED}));

test('turning the feature off after assessment makes the record stale; a verifier without it refuses a partitioned record', () => largeFixture(async f => {
  const assessment = await f.assess();
  const off = require('./policy.cjs').createPolicy(CONFIG);
  await assert.rejects(off.gate({github: f.github, context: f.context, core: {info() {}, summary: {addRaw() {return this;}, async write() {}}},
    recordPath: f.recordPath, assessment, nativeGate: true}), /Stale or altered acceptance record/);
  const record = f.read(); record.snapshot.config_digest = digest(CONFIG); f.write(record);
  assert.throws(() => verifyRecord(f.read(), f.rebind(assessment, f.read()), CONFIG), /not enabled for chunked records/);
}, {config: ENABLED}));

test('a partitioned record inside a local receipt keeps its own path and is not read as a hosted one', () => largeFixture(async f => {
  const assessment = await f.assess();
  const record = f.read(); record.local_receipt = {payload: {}}; f.write(record);
  assert.throws(() => verifyRecord(f.read(), f.rebind(assessment, f.read()), ENABLED), error => !/Chunked review record rejected/.test(error.message));
}, {config: ENABLED}));

test('a change that fits one snapshot is reviewed as before when the feature is on, and chunked only when forced', async () => {
  await largeFixture(async f => {
    const assessment = await f.assess();
    assert.equal(assessment.decision, 'auto_approve');
    assert.equal(f.read().version, 2);
    assert.equal(f.state.calls.length, 2);
  }, {config: ENABLED, count: 2, size: 2000});
  await largeFixture(async f => {
    const assessment = await f.assess();
    assert.equal(assessment.decision, 'auto_approve', assessment.reason);
    assert.equal(f.read().version, 3);
    await f.gate(assessment);
    assert.deepEqual(names(f), ['create-ledger', 'approve']);
  }, {config: on({enabled: true, force: true, params: {C: 3000, S: 2000}}), count: 3, size: 2000});
});

test('a changed file above the single-snapshot file limit is reviewed in segments when the feature is on, and held as before when off', async () => {
  await largeFixture(async f => {
    const assessment = await f.assess();
    assert.equal(assessment.cause, 'changed_file_unreadable');
    assert.equal(f.state.calls.length, 0);
  }, {count: 1, size: 350000});
  await largeFixture(async f => {
    const assessment = await f.assess();
    assert.equal(assessment.decision, 'auto_approve', assessment.reason);
    const record = f.read();
    assert.equal(record.version, 3);
    assert.ok(Object.values(record.partition.units).some(unit => unit.parts));
  }, {config: on({enabled: true, params: {C: 200000, S: 50000}}), count: 1, size: 350000});
});

test('a failure that is not a size limit is not retried as a chunked review', () => largeFixture(async f => {
  delete f.state.contents['src/mod-001.cjs'];
  const assessment = await f.assess();
  assert.equal(assessment.cause, 'github_api_error');
  assert.equal(f.state.calls.length, 0);
}, {config: ENABLED, count: 3, size: 2000}));

test('a unit that asks for more source is held with a named cause, not failed', () => largeFixture(async f => {
  const assessment = await f.assess();
  assert.equal(assessment.decision, 'review_incomplete');
  assert.equal(assessment.cause, 'chunked_unit_source_request');
  assert.match(assessment.reason, /Held, not failed: the chunked review stopped/);
}, {config: on({enabled: true, force: true, params: {C: 3000, S: 2000}}), count: 3, size: 2000,
  provider: {respond: () => ({kind: 'source_request', report: null, request_sources: ['src/other.cjs']})}}));

test('a record the job-output transport cannot carry is held with the fix named, and the artifact transport carries it', async () => {
  const old = process.env.CLOUSEAU_RECORD_TRANSPORT;
  try {
    await largeFixture(async f => {
      process.env.CLOUSEAU_RECORD_TRANSPORT = 'job-output';
      const held = await f.assess();
      assert.equal(held.decision, 'review_incomplete');
      assert.equal(held.cause, 'chunked_record_transport');
      assert.match(held.reason, /Held, not failed.*record-transport to artifact/);
      assert.equal(fs.existsSync(f.recordPath), false);
      process.env.CLOUSEAU_RECORD_TRANSPORT = 'artifact';
      assert.equal((await f.assess()).decision, 'auto_approve');
    }, {config: ENABLED});
    const { checkTransport } = require('./hosted-chunked.cjs');
    assert.doesNotThrow(() => checkTransport('job-output', 'small'));
    assert.throws(() => checkTransport('job-output', 'x'.repeat(2 * 1024 * 1024 + 1)), /job-output/);
    const noisy = Array.from({length: 40000}, (_, i) => require('node:crypto').createHash('sha256').update(String(i)).digest('hex')).join('');
    assert.throws(() => checkTransport('job-output', noisy), /job-output/);
    assert.doesNotThrow(() => checkTransport(undefined, noisy));
  } finally {
    if (old === undefined) delete process.env.CLOUSEAU_RECORD_TRANSPORT; else process.env.CLOUSEAU_RECORD_TRANSPORT = old;
  }
});

// The cost model of docs/chunked-hosted.md: the recorded usage of a fake run priced with the published tariffs of review-cost.cjs,
// assuming no cache hits (the upper end of the estimate also doubles the lower end).
test('the default caps hold a 4 MB change under $8 and a 1.2 MB change under $2 without holding either', async () => {
  const {estimate} = require('./review-cost.cjs');
  for (const [count, ceiling] of [[40, 2], [134, 8]]) {
    await largeFixture(async f => {
      const assessment = await f.assess();
      assert.equal(assessment.decision, 'auto_approve', assessment.reason);
      const cost = estimate(f.read().result.usage);
      assert.equal(cost.complete, true);
      assert.ok(cost.known_cost_max < ceiling, `${count} modules: ${cost.known_cost_max}`);
      if (process.env.CLOUSEAU_PRINT_COST) console.log(count, f.read().partition.units.length, cost);
    }, {config: ENABLED, count, size: 30000});
  }
});

// Issue #66: a large signed review is stored once, as the immutable multi-part receipt. CI reuses it through a compact reference,
// so the job-output transport (2 MiB expanded, 300 KB compressed) never has to carry the record, and the gate rehydrates every byte.
for (const [count, parted] of [[40, false], [70, true]]) test(`a signed ${parted ? 'multi-part' : 'single-receipt'} chunked review is stored once: CI reuses it by reference with zero AI calls and the gate rehydrates the whole record`, async () => {
  const {isRoot} = require('./receipt-parts.cjs');
  const transport = require('./record-transport.cjs');
  const trust = signedTrust(ENABLED);
  await largeFixture(async f => {
    f.state.pr.number = 0;
    assert.equal((await f.assess()).decision, 'auto_approve');
    f.state.pr.number = 3;
    const receipt = signLargeReceipt(f, trust);
    assert.equal(isRoot(receipt.bundle.payload.record), parted, 'a record above one receipt is signed as parts');
    const full = fs.statSync(f.recordPath).size;
    assert.ok(full > transport.MAX_EXPANDED_BYTES, 'the complete record cannot travel as a job output');
    assert.throws(() => transport.encode({assessment: {version: 2, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), record_digest: digest(f.read())},
      context: f.context, runAttempt: '1', record: f.read(), repair: null}), /expanded limit|compressed limit/);

    const served = new Map(receipt.files); const reads = [];
    const original = f.github.rest.repos.getContent;
    f.github.rest.repos.getContent = async args => {
      if (!args.path.startsWith('clouseau-review.')) return original(args);
      reads.push(args.path); assert.equal(args.ref, receipt.ref);
      const bytes = served.get(args.path);
      if (!bytes) throw Object.assign(new Error('Not Found'), {status: 404});
      return {data: {encoding: 'base64', content: bytes.toString('base64'), size: bytes.length}};
    };
    f.state.pr.body = `Adds the fictional modules.\n<!-- clouseau-local-review:v1 ${receipt.ref} -->`;
    fs.rmSync(f.recordPath);
    const calls = f.state.calls.length;
    const policy = require('./policy.cjs').createPolicy(trust.config);
    const refuse = async () => {throw new Error('CI AI must not be called');};
    const assess = () => policy.assess({github: f.github, context: f.context, recordPath: f.recordPath, fetchImpl: refuse, retryWait: async () => {}});
    const assessment = await assess();
    assert.equal(assessment.decision, 'auto_approve', assessment.reason);
    assert.equal(assessment.review_source, 'authenticated_local');
    assert.equal(assessment.provider_api_calls, 0);
    assert.equal(f.state.calls.length, calls, 'no provider request was made');
    assert.deepEqual(reads, ['clouseau-review.json', ...(receipt.bundle.parts ?? []).map((_, index) => require('./receipt-parts.cjs').partName(index))]);

    // The CI record names the receipt and carries only the run facts; the signed review exists once, in the receipt.
    const compact = f.read();
    assert.equal(compact.local_receipt_reference, true);
    assert.equal(compact.local_artifact, receipt.ref);
    for (const key of ['snapshot', 'partition', 'seams', 'result', 'local_receipt']) assert.equal(Object.hasOwn(compact, key), false, key);
    assert.ok(fs.statSync(f.recordPath).size < 20000, 'the compact record is small');
    assert.equal(assessment.record_reference_digest, digest(compact));
    assert.equal(assessment.record_digest, digest(await policy.rehydrate(compact, assessment, {github: f.github, repo: f.repo})),
      'record_digest still names the complete rebuilt record');

    // The compact record fits the job-output transport and arrives byte for byte at the write boundary.
    const outputs = {};
    const published = {setOutput: (name, value) => {outputs[name] = value;}};
    transport.publish({mode: 'job-output', assessment, context: f.context, runAttempt: '1', core: published, recordPath: f.recordPath});
    const chunks = JSON.parse(outputs['review-record']);
    assert.ok(chunks.join('').length < transport.MAX_ENCODED_BYTES / 10);
    const sent = fs.readFileSync(f.recordPath, 'utf8'); fs.rmSync(f.recordPath);
    transport.receive({mode: 'job-output', payload: transport.joinParts(chunks, true), assessment, context: f.context, runAttempt: '1', recordPath: f.recordPath});
    assert.deepEqual(JSON.parse(fs.readFileSync(f.recordPath, 'utf8')), JSON.parse(sent));
    assert.equal(f.state.writes.length, 0, 'assessment writes nothing');

    // A part that differs by one byte, a part that is gone, or a stale receipt fails closed at the write boundary before any write.
    if (parted) for (const tamper of [
      () => {const bytes = Buffer.from(receipt.files.get('clouseau-review.part-0001')); bytes[10] ^= 1; served.set('clouseau-review.part-0001', bytes);},
      () => {served.set('clouseau-review.part-0002', receipt.files.get('clouseau-review.part-0001'));},
      () => {served.delete('clouseau-review.part-0002');},
    ]) {
      for (const [name, bytes] of receipt.files) served.set(name, bytes);
      tamper();
      await assert.rejects(policy.gate({github: f.github, context: f.context, core: {info() {}, summary: {addRaw() {return this;}, async write() {}}},
        recordPath: f.recordPath, assessment, nativeGate: true, wait: async () => {}}), /differs from the signed root|Not Found/);
      assert.equal(f.state.writes.length, 0);
    }
    for (const [name, bytes] of receipt.files) served.set(name, bytes);
    await policy.gate({github: f.github, context: f.context, core: {info() {}, summary: {addRaw() {return this;}, async write() {}}},
      recordPath: f.recordPath, assessment, nativeGate: true, wait: async () => {}});
    assert.deepEqual(names(f), ['create-ledger', 'approve']);
    assert.equal(f.state.calls.length, calls, 'the gate made no provider request either');
  }, {config: trust.config, count, size: 30000});
});
