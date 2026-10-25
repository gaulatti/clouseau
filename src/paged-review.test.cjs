'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pagedFixture, responder} = require('../test/paged-review-fixture.cjs');
const {digest} = require('./acceptance.cjs');
const {refresh, proofCatalog} = require('./acceptance-sources.cjs');
const {modelTemplate} = require('./acceptance-review.cjs');
const {inspectPaged, pageSchema, concernDraft, MAX_SOURCE_BATCHES, MAX_PROMPT_BYTES} = require('./paged-review.cjs');
const {MAX_VIEW_ROUNDS} = require('./source-view.cjs');

test('bounded role views inspect complete source, patches and context before accepting a factual report', async () => {
  const f = await pagedFixture(); const model = responder(f);
  const result = await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask});
  assert.equal(result.report.snapshot, f.snapshot.digest);
  assert.equal(result.source_view.role, 'examiner');
  assert.equal(result.usage.length, model.packets.length);
  assert.equal(result.page_progress.length, model.packets.length);
  assert.ok(result.source_view.rounds.length > 0);
  assert.ok(model.packets[0].pages.length === 0, 'initial inventory cannot count as reading source bytes');
  assert.ok(model.packets.slice(1).every(packet => packet.pages.length > 0));
  const challenger = await inspectPaged({snapshot: f.snapshot, role: 'challenger', ask: model.ask});
  assert.equal(challenger.source_view.role, 'challenger');
  const first = model.packets.find(packet => packet.review_context.role === 'challenger');
  assert.deepEqual(first.own_page_progress, []);
  assert.deepEqual(first.earlier_reports_by_this_role, []);
});

test('fresh literal pages follow all retained hypotheses so old progress cannot hide the current frame', async () => {
  const f = await pagedFixture(); const model = responder(f);
  await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: async task => {
    const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
    const keys = Object.keys(packet);
    assert.ok(keys.indexOf('pages') > keys.indexOf('own_page_progress'));
    assert.ok(keys.indexOf('pages') > keys.indexOf('earlier_reports_by_this_role'));
    assert.ok(keys.indexOf('required_unread_page_selectors') > keys.indexOf('own_page_progress'));
    assert.equal(keys.at(-1), 'pages');
    assert.match(task.prompt, /Earlier observations are hypotheses/);
    return model.ask(task);
  }});
  assert.ok(model.packets.some(packet => packet.pages.length && packet.own_page_progress.length));
});

test('the bounded schema uses proof patterns while controller citations remain authoritative', async () => {
  const f = await pagedFixture(); const schema = pageSchema(f.snapshot);
  const report = schema.properties.report.anyOf[0];
  assert.equal(report.properties.units.items.properties.fit.properties.outcome.properties.evidence.items.enum, undefined);
  assert.match(report.properties.findings.items.properties.anchor.pattern, /proof/);
  assert.equal(/"(?:maxItems|minItems|maxLength|minLength)"/.test(JSON.stringify(schema)), false,
    'the shared strict schema stays within the documented selected CI provider subset');
  const model = responder(f, value => {
    if (value.kind === 'report') value.report.gates[0].evidence = ['proof-99999-1'];
    return value;
  });
  await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask}), /Unknown controller-supplied/);
});

test('adding a missing immutable dependency invalidates prior exposure and preserves own earlier observations', async () => {
  const f = await pagedFixture(); let requested = false;
  const model = responder(f, value => {
    if (value.kind === 'report' && !requested) {
      requested = true;
      return {...value, kind: 'source_request', report: null, request_sources: ['src/dependency.js']};
    }
    return value;
  });
  const result = await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask, addSources: async paths => {
    assert.deepEqual(paths, ['src/dependency.js']);
    f.snapshot.sources['additional-dependency'] = {path: paths[0], ref: f.snapshot.head_sha,
      authority: 'untrusted', kind: 'source', content: 'module.exports = "complete additional dependency";\n'};
    refresh(f.snapshot);
  }});
  assert.equal(result.source_history.length, 1);
  assert.notEqual(result.source_history[0].bank.bank_digest, result.source_view.bank_digest);
  const changed = model.packets.find(packet => packet.source_bank.bank_digest === result.source_view.bank_digest);
  assert.equal(changed.pages.length, 0, 'old delivery is not borrowed into the new frozen bank');
  assert.ok(changed.own_page_progress.length > 0);
  assert.equal(result.report.coverage.sources.length, Object.keys(f.snapshot.sources).length);
});

test('provisional causal concerns survive paging and require explicit current-source closure', async () => {
  for (const resolve of [false, true]) {
    const f = await pagedFixture(); let raised = false;
    const changed = f.snapshot.files[0];
    const proof = proofCatalog(f.snapshot).find(item => item.source === changed.head_source);
    const concern = {id: 'page-concern', title: 'Provisional causal concern', path: changed.path,
      cause: 'The caller boundary requires current-source investigation.', obligation: 'Preserve the accepted fixture boundary.', evidence: [proof.id]};
    const model = responder(f, (value, {packet}) => {
      if (!raised && packet.proofs.some(item => item.id === proof.id)) {
        value.concerns = [concern]; raised = true;
      }
      if (value.kind === 'report' && resolve) value.report.resolutions.push({id: concern.id, state: 'dismissed',
        reason: 'The inspected current-source fixture supplies the required boundary counterevidence.', evidence: [proof.id]});
      return value;
    });
    const attempt = inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask});
    if (!resolve) await assert.rejects(attempt, /prior investigation concern|prior-finding/);
    else {
      const result = await attempt;
      assert.ok(result.drafts.some(draft => draft.findings.some(item => item.id === concern.id)));
      assert.ok(result.page_progress.some(item => item.response.concerns.some(item => item.id === concern.id)));
    }
  }
});

test('a measured-scale complete inventory is reviewed with bounded schemas and views rather than replayed literal source', async () => {
  const f = await pagedFixture();
  const baseBytes = Object.values(f.snapshot.sources).reduce((sum, source) => sum + Buffer.byteLength(source.content), 0);
  const add = 107 - Object.keys(f.snapshot.sources).length;
  const sizes = [537648, 538207];
  const remaining = 2308455 - baseBytes - sizes.reduce((sum, size) => sum + size, 0);
  sizes.push(...Array.from({length: add - 2}, (_, index) => Math.floor(remaining / (add - 2)) +
    (index < remaining % (add - 2) ? 1 : 0)));
  for (const [index, size] of sizes.entries()) {
    const line = '// byte-scale source transport fixture; no behavioral claim\n';
    f.snapshot.sources[`scale-${index}`] = {path: `fixtures/scale-${index}.txt`, ref: f.snapshot.head_sha,
      authority: 'untrusted', kind: 'source', content: line.repeat(Math.ceil(size / line.length)).slice(0, size)};
  }
  // The fixture tests the paging driver directly. Collection/signing still
  // retain their old bounds until their separate integration is qualified.
  delete f.snapshot.digest; f.snapshot.digest = digest(f.snapshot);
  const model = responder(f); const result = await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask});
  assert.equal(result.report.coverage.sources.length, 107);
  assert.equal(result.source_bank.entries.filter(entry => entry.kind === 'source').reduce((sum, entry) => sum + entry.bytes, 0), 2308455);
  assert.ok(model.packets.length > 20);
  assert.ok(model.packets.every(packet => !Object.hasOwn(packet.source_bank.entries[0], 'text')));
  assert.ok(model.packets.every(packet => packet.pages.length <= 4));
  assert.equal(result.source_view.rounds.length, model.packets.length - 1);
});

test('an early complete claim and stale or invalid page requests cannot bypass actual source delivery', async () => {
  const f = await pagedFixture();
  for (const mutate of [
    (value, packet) => ({...value, kind: 'report', page_request: null,
      report: {...modelTemplate(f.snapshot), gates: modelTemplate(f.snapshot).gates.map(gate => ({...gate, state: 'satisfied'}))}}),
    value => ({...value, page_request: {...value.page_request, bank_digest: '0'.repeat(64)}}),
    value => ({...value, page_request: {...value.page_request, pages: [{entry: 99999, page: 0}]}}),
    value => ({...value, page_request: {...value.page_request, pages: [{entry: 0, page: 0}, {entry: 0, page: 0}]}}),
  ]) {
    const model = responder(f, (value, {packet}) => mutate(value, packet));
    await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask}));
  }
});

test('malformed phase responses and missing authenticated execution are failures rather than partial reports', async () => {
  const f = await pagedFixture();
  for (const mutate of [
    value => ({...value, observations: 1}), value => ({...value, observations: 'x'.repeat(2001)}),
    value => ({...value, concerns: Array(9).fill({})}), value => ({...value, concerns: null}),
    value => ({...value, request_sources: null}), value => ({...value, extra: true}),
    value => ({...value, kind: 'unknown', page_request: null}),
    value => ({...value, report: {}}), value => ({...value, request_sources: ['src/extra.js']}),
    value => ({...value, page_request: null}),
    value => ({...value, page_request: false}), value => ({...value, page_request: 0}),
    value => ({...value, page_request: ''}), value => ({...value, page_request: []}),
    value => ({...value, kind: 'source_request', page_request: null, request_sources: []}),
    value => ({...value, kind: 'source_request', page_request: null, request_sources: ['src/extra.js']}),
  ]) {
    const model = responder(f, mutate);
    await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask}), /Invalid paged review/);
  }
  for (const corrupt of [
    response => null,
    response => ({...response, provenance: null}),
    response => ({...response, provenance: {...response.provenance, role: 'challenger'}}),
    response => ({...response, provenance: {...response.provenance, phase: 'grading'}}),
    response => ({...response, provenance: {...response.provenance, request_digest: 'invalid'}}),
    response => ({...response, provenance: {...response.provenance, response_digest: '0'.repeat(64)}}),
  ]) {
    const model = responder(f);
    await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: async task => corrupt(await model.ask(task))}),
      /authenticated response/);
  }
});

test('source requests cannot replace old bytes, reorder proof identities or alter the frozen change', async () => {
  for (const mutate of [
    snapshot => {},
    snapshot => {snapshot.head_sha = 'c'.repeat(40);},
    snapshot => {Object.values(snapshot.sources)[0].content += 'substituted bytes';},
    snapshot => {snapshot.sources['1'] = {...Object.values(snapshot.sources)[0]};},
  ]) {
    const f = await pagedFixture();
    const model = responder(f, value => ({...value, kind: 'source_request', report: null, page_request: null,
      request_sources: ['src/additional.js']}));
    await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask,
      addSources: async () => {mutate(f.snapshot); refresh(f.snapshot);}}), /altered frozen evidence|no new source/);
  }
});

test('page and source exhaustion stop after their exact allowed deliveries without resampling a judgment', async () => {
  const f = await pagedFixture();
  const repeated = responder(f, (value, {packet}) => ({...value, kind: 'page_request', report: null,
    page_request: {bank_digest: packet.source_bank.bank_digest, pages: [{entry: 0, page: 0}]}}));
  await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: repeated.ask}), /budget/);
  assert.equal(repeated.packets.length, MAX_VIEW_ROUNDS + 1);
  const g = await pagedFixture(); let reads = 0;
  const requests = responder(g, value => ({...value, kind: 'source_request', report: null, page_request: null,
    request_sources: [`src/dependency-${reads}.js`]}));
  await assert.rejects(inspectPaged({snapshot: g.snapshot, role: 'examiner', ask: requests.ask, addSources: async paths => {
    g.snapshot.sources[`dependency-${reads++}`] = {path: paths[0], ref: g.snapshot.head_sha,
      kind: 'source', authority: 'untrusted', content: 'complete bounded dependency\n'};
    refresh(g.snapshot);
  }}), /source investigation budget/);
  assert.equal(reads, MAX_SOURCE_BATCHES);
});

test('growing the source bank cannot renew a role page-delivery budget', async () => {
  const f = await pagedFixture(); let delivered = 0; let added = false;
  const model = responder(f, (value, {packet}) => {
    if (packet.pages.length) delivered++;
    if (delivered === 64 && !added) {
      added = true;
      return {...value, kind: 'source_request', report: null, page_request: null, request_sources: ['src/additional.js']};
    }
    return {...value, kind: 'page_request', report: null,
      page_request: {bank_digest: packet.source_bank.bank_digest, pages: [{entry: 0, page: 0}]}};
  });
  await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask, addSources: async paths => {
    f.snapshot.sources['additional-source'] = {path: paths[0], ref: f.snapshot.head_sha,
      kind: 'source', authority: 'untrusted', content: 'complete new immutable source\n'};
    refresh(f.snapshot);
  }}), /page delivery budget/);
  assert.equal(delivered, MAX_VIEW_ROUNDS);
  const original = model.packets[0].source_bank.bank_digest;
  const firstNew = model.packets.find(packet => packet.source_bank.bank_digest !== original);
  assert.equal(firstNew.review_context.page_deliveries_remaining, MAX_VIEW_ROUNDS - 64);
});

test('oversized earlier evidence is refused intact before invocation and another role progress is never borrowed', async () => {
  const f = await pagedFixture(); let calls = 0;
  const ask = async () => {calls++; throw new Error('must not invoke');};
  const drafts = [{findings: [], evidence: [{quote: 'x'.repeat(MAX_PROMPT_BYTES)}]}];
  await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask, drafts}), /complete context exceeds/);
  assert.equal(drafts[0].evidence[0].quote.length, MAX_PROMPT_BYTES, 'no prior evidence was cut to fit');
  await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask,
    progress: [{role: 'challenger', observations: 'another independent role'}]}), /independent progress/);
  assert.equal(calls, 0);
});

test('provisional concern proofs retain native coordinate normalization and reject unbound causes', async () => {
  const f = await pagedFixture(); const file = f.snapshot.files[0];
  f.snapshot.sources[file.head_source].content = Array.from({length: 80}, (_, index) => `native line ${index + 1}`).join('\n');
  refresh(f.snapshot);
  const index = Object.keys(f.snapshot.sources).indexOf(file.head_source);
  const concern = {id: 'causal-observation', title: 'Provisional observation', path: file.path,
    cause: 'A concrete cause requires current-source inspection.', obligation: 'Preserve the observed boundary.',
    evidence: [`proof-${index}-53`, `proof-${index}-41`]};
  const draft = concernDraft(f.snapshot, [concern]);
  assert.deepEqual(draft.findings[0].evidence, [`proof-${index}-41`]);
  assert.equal(draft.evidence[0].quote, f.snapshot.sources[file.head_source].content.split('\n').slice(40).join('\n'));
  const trusted = proofCatalog(f.snapshot).find(proof => f.snapshot.sources[proof.source].kind === 'contract');
  for (const invalid of [
    {...concern, id: '_invalid'}, {...concern, title: ''}, {...concern, cause: 'x'.repeat(2001)},
    {...concern, path: 'unknown.js'}, {...concern, evidence: []}, {...concern, evidence: [concern.evidence[0], concern.evidence[0]]},
    {...concern, evidence: ['proof-9999-1']}, {...concern, evidence: [trusted.id]}, {...concern, extra: true},
  ]) assert.throws(() => concernDraft(f.snapshot, [invalid]));
});

test('a completed role reruns only after new immutable evidence and retains at most two complete cycles', async () => {
  const f = await pagedFixture(); const model = responder(f);
  const first = await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask});
  const continuation = result => ({drafts: [...result.drafts, result.report], progress: result.page_progress,
    sourceHistory: [...result.source_history, {bank: result.source_bank, exposure: result.source_view}], previousUsage: result.usage});
  await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask, ...continuation(first)}), /cannot be resampled/);
  f.snapshot.sources['new-evidence'] = {path: 'src/new-evidence.js', ref: f.snapshot.head_sha, authority: 'untrusted',
    kind: 'source', content: 'module.exports = "new complete evidence";\n'}; refresh(f.snapshot);
  const second = await inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask, ...continuation(first)});
  assert.equal(second.page_progress.filter(item => item.cycle_start).length, 2);
  f.snapshot.sources['newer-evidence'] = {...f.snapshot.sources['new-evidence'], path: 'src/newer-evidence.js'}; refresh(f.snapshot);
  await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask, ...continuation(second)}), /cycle budget/);
  await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask, sourceHistory: null}), /epoch history/);
  await assert.rejects(inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask, previousUsage: null}), /execution history/);
});

test('existing own causal identities can be investigated again but cannot silently change their obligation', async () => {
  for (const change of [false, true]) {
    const f = await pagedFixture(); const file = f.snapshot.files[0];
    const proof = proofCatalog(f.snapshot).find(item => item.source === file.head_source);
    const concern = {id: 'existing-concern', title: 'Existing provisional concern', path: file.path,
      cause: 'Investigate the actual changed caller boundary.', obligation: 'Preserve the accepted boundary.', evidence: [proof.id]};
    const prior = concernDraft(f.snapshot, [concern]);
    const model = responder(f, (value, {packet}) => {
      if (packet.proofs.some(item => item.id === proof.id)) value.concerns = [{...concern,
        obligation: change ? 'A silently changed obligation.' : concern.obligation}];
      if (value.kind === 'report') value.report.resolutions.push({id: concern.id, state: 'dismissed',
        reason: 'Current-source evidence resolves the provisional boundary question.', evidence: [proof.id]});
      return value;
    });
    const attempt = inspectPaged({snapshot: f.snapshot, role: 'examiner', ask: model.ask, drafts: [prior]});
    if (change) await assert.rejects(attempt, /changed provisional concern/);
    else assert.equal((await attempt).report.resolutions[0].id, concern.id);
  }
});
