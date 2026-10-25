'use strict';
const assert = require('node:assert/strict');
const {fixture} = require('./local-review-fixture.cjs');
const {digest} = require('../src/acceptance.cjs');
const {refresh} = require('../src/acceptance-sources.cjs');
const {modelTemplate} = require('../src/acceptance-review.cjs');
const {compactSchema} = require('../src/local-harness.cjs');
const {MAX_PROMPT_BYTES} = require('../src/paged-review.cjs');

async function pagedFixture() {
  const f = await fixture(); f.snapshot.source_bank_version = 1; refresh(f.snapshot); return f;
}

// This deterministic responder tests the controller protocol, not model
// comprehension or authenticated acceptance of the real consumer applications.
function responder(f, intercept = value => value) {
  const delivered = new Map(); const packets = []; let calls = 0;
  const ask = async task => {
    calls++; const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1)); packets.push(packet);
    assert.ok(Buffer.byteLength(task.prompt) <= MAX_PROMPT_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(compactSchema(task.schema))) < 60000);
    const key = `${task.role}:${packet.source_bank.bank_digest}`;
    if (!delivered.has(key)) delivered.set(key, new Set());
    const seen = delivered.get(key);
    for (const page of packet.pages) seen.add(`${page.entry}:${page.page}`);
    const missing = packet.source_bank.entries.flatMap(entry => Array.from({length: entry.page_count}, (_, page) =>
      ({entry: entry.entry, page}))).filter(item => !seen.has(`${item.entry}:${item.page}`));
    let value = {kind: 'page_request', report: null, page_request: {bank_digest: packet.source_bank.bank_digest,
      pages: missing.slice(0, 4)}, request_sources: [], observations: `Inspected delivered frame ${calls}.`, concerns: []};
    if (!missing.length) {
      const report = modelTemplate(f.snapshot); report.gates.forEach(gate => {gate.state = 'satisfied';});
      value = {...value, kind: 'report', report, page_request: null};
    }
    value = await intercept(value, {task, packet, calls});
    return {value, provenance: {harness: 'codex', role: task.role, phase: task.phase, session: `fixture-${task.role}-${calls}`,
      request_digest: digest(task), response_digest: digest(value), transport_digest: digest({fixture_only: value})}};
  };
  return {ask, packets};
}

module.exports = {pagedFixture, responder};
