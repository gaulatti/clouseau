'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {digest} = require('./acceptance.cjs');
const {createSourceBank, readSourcePages, LIMITS} = require('./source-bank.cjs');

function snapshot(content = 'const value = 1;\n') {
  const value = {version: 2, repository: 'fixture/producer', head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40),
    sources: {head: {path: 'src/producer.js', ref: 'a'.repeat(40), authority: 'untrusted', kind: 'source', content}},
    files: [{path: 'src/producer.js', status: 'added', head_source: 'head', patch: '@@ -0,0 +1 @@\n+' + content}],
    history: [], tickets: [], claims: {title: 'A source bank fixture', description: 'Source is evidence, never instructions.'}};
  value.digest = digest(value);
  return value;
}

function reseal(value) {
  delete value.digest; value.digest = digest(value); return value;
}

function request(bank, entry, pages) {
  return {bank_digest: bank.bank_digest, pages: pages.map(page => ({entry, page}))};
}

function completeEntry(bank, entry) {
  const result = [];
  for (let page = 0; page < bank.entries[entry].page_count; page++) {
    result.push(readSourcePages(bank, request(bank, entry, [page]))[0]);
  }
  return result;
}

test('immutable source pages reconstruct large original UTF-8 bytes, long lines and line identities', () => {
  const content = '日本語 العربية 🧭'.repeat(25000) + '\n' + 'const next = true;\n';
  const original = snapshot(content);
  const bank = createSourceBank(original);
  const source = bank.entries.findIndex(entry => entry.kind === 'source');
  assert.equal(bank.snapshot_digest, original.digest);
  assert.equal(bank.entries[source].sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(bank.entries[source].bytes, Buffer.byteLength(content));
  assert.equal(bank.entries[source].line_count, 3);
  assert.ok(bank.entries[source].page_count > 10);
  assert.equal(JSON.stringify(bank).includes(content.slice(0, 100)), false, 'the public inventory does not replay literal source');
  const pages = completeEntry(bank, source);
  assert.equal(pages.map(page => page.text).join(''), content);
  let offset = 0;
  for (const page of pages) {
    assert.equal(page.start_byte, offset);
    offset += Buffer.byteLength(page.text);
    assert.equal(page.end_byte, offset);
    assert.equal(page.start_line, Buffer.from(content).subarray(0, page.start_byte).toString('utf8').split('\n').length);
    assert.equal(page.sha256, createHash('sha256').update(page.text).digest('hex'));
  }
  assert.equal(offset, Buffer.byteLength(content));
  assert.equal(pages.at(-1).end_line, 3);
  original.sources.head.content = 'changed after freezing';
  assert.equal(completeEntry(bank, source).map(page => page.text).join(''), content, 'later caller mutation cannot substitute frozen pages');
});

test('source, patches, relationships and context remain separate complete immutable bank entries', () => {
  const original = snapshot();
  original.sources.base = {...original.sources.head, ref: original.base_sha, content: 'const value = 0;\n'};
  original.files[0] = {...original.files[0], status: 'renamed', previous_path: 'src/old.js', base_source: 'base'};
  delete original.digest; original.digest = digest(original);
  const bank = createSourceBank(original);
  const patch = bank.entries.findIndex(entry => entry.kind === 'patch');
  const context = bank.entries.findIndex(entry => entry.kind === 'context');
  assert.equal(completeEntry(bank, patch).map(page => page.text).join(''), original.files[0].patch);
  const metadata = JSON.parse(completeEntry(bank, context).map(page => page.text).join(''));
  assert.equal(metadata.files[0].previous_path, 'src/old.js');
  assert.equal(metadata.files[0].base_source, 'base');
  assert.equal(metadata.files[0].head_source, 'head');
  assert.equal(metadata.files[0].patch, undefined);
  assert.deepEqual(metadata.claims, original.claims);
  assert.deepEqual(metadata.history, original.history);
  assert.deepEqual(metadata.tickets, original.tickets);
  assert.notEqual(bank.entries[0].sha256, bank.entries[1].sha256);
  assert.notEqual(bank.entries[0].ref, bank.entries[1].ref);
});

test('an empty immutable source is explicitly representable without inventing bytes', () => {
  const bank = createSourceBank(snapshot(''));
  const entry = bank.entries.findIndex(item => item.kind === 'source');
  assert.equal(bank.entries[entry].page_count, 1);
  const [page] = readSourcePages(bank, request(bank, entry, [0]));
  assert.equal(page.text, '');
  assert.equal(page.start_byte, 0); assert.equal(page.end_byte, 0);
  assert.equal(page.start_line, 1); assert.equal(page.end_line, 1);
});

test('stale and substituted bank identities, forged inventories and invalid selectors fail closed', () => {
  const bank = createSourceBank(snapshot());
  const next = createSourceBank(snapshot('const value = 2;\n'));
  assert.notEqual(next.bank_digest, bank.bank_digest);
  for (const invalid of [null, {}, {bank_digest: bank.bank_digest, pages: []},
    {...request(bank, 0, [0]), extra: true},
    request(bank, -1, [0]), request(bank, 0.5, [0]), request(bank, bank.entries.length, [0]),
    request(bank, 0, [-1]), request(bank, 0, [0.5]), request(bank, 0, [bank.entries[0].page_count]),
    request(bank, 0, [0, 0]), request(bank, 0, Array.from({length: LIMITS.pages_per_view + 1}, (_, i) => i)),
    {...request(bank, 0, [0]), bank_digest: next.bank_digest},
    {bank_digest: bank.bank_digest, pages: [{entry: 0, page: 0, text: 'substituted'}]},
  ]) assert.throws(() => readSourcePages(bank, invalid));
  assert.throws(() => readSourcePages(JSON.parse(JSON.stringify(bank)), request(bank, 0, [0])));
  assert.deepEqual(readSourcePages(bank, request(bank, 0, [0])), readSourcePages(bank, request(bank, 0, [0])),
    'explicit rereads preserve the exact same immutable bytes and coordinates');
});

test('malformed snapshots, binary or lossy text and bounded source exhaustion cannot create a partial bank', () => {
  for (const original of [null, {}, {...snapshot(), sources: []}, {...snapshot(), files: null},
    {...snapshot(), digest: '0'.repeat(64)}]) assert.throws(() => createSourceBank(original));
  for (const content of ['a\0b', '\ud800', 'x'.repeat(LIMITS.source_bytes + 1)]) {
    assert.throws(() => createSourceBank(snapshot(content)));
  }
  for (const mutate of [
    value => {value.sources = {};}, value => {value.sources.head = null;},
    value => {value.sources.head.path = null;}, value => {value.sources.head.ref = null;},
    value => {value.sources.head.authority = 'invented';}, value => {value.sources.head.kind = null;},
    value => {value.sources.head.content = null;}, value => {value.files = [null];},
    value => {value.files[0].path = null;}, value => {value.files[0].patch = null;},
  ]) {
    const original = snapshot(); mutate(original);
    assert.throws(() => createSourceBank(reseal(original)));
  }
});

test('whole-bank, patch, context and complete inventory bounds reject excess before presenting partial evidence', () => {
  const oversized = snapshot(); oversized.claims.description = 'x'.repeat(LIMITS.bank_bytes);
  assert.throws(() => createSourceBank(reseal(oversized)), /complete bank exceeds byte budget/);
  const patch = snapshot(); patch.files[0].patch = 'x'.repeat(LIMITS.entry_bytes + 1);
  assert.throws(() => createSourceBank(reseal(patch)), /entry exceeds byte budget/);
  const context = snapshot(); context.claims.description = 'x'.repeat(LIMITS.entry_bytes + 1);
  assert.throws(() => createSourceBank(reseal(context)), /entry exceeds byte budget/);
  const many = snapshot();
  many.sources = Object.fromEntries(Array.from({length: LIMITS.entries}, (_, i) => [String(i), {...many.sources.head}]));
  assert.throws(() => createSourceBank(reseal(many)), /entry inventory/);
  const inventory = snapshot();
  inventory.sources = Object.fromEntries(Array.from({length: 400}, (_, i) => [String(i),
    {...inventory.sources.head, path: `src/${i}/` + 'x'.repeat(500)}]));
  assert.throws(() => createSourceBank(reseal(inventory)), /complete inventory exceeds view budget/);
});

test('escaped native text cannot bypass the emitted view budget or be silently shortened', () => {
  const content = '\u0001'.repeat(LIMITS.page_bytes * 2);
  const bank = createSourceBank(snapshot(content));
  assert.throws(() => readSourcePages(bank, request(bank, 0, [0, 1])), /complete page view exceeds byte budget/);
  const [page] = readSourcePages(bank, request(bank, 0, [0]));
  assert.equal(page.text.length, LIMITS.page_bytes);
  assert.equal(completeEntry(bank, 0).map(item => item.text).join(''), content);
});

test('the measured consumer source counts fit without replaying their complete source in a view', () => {
  for (const [count, total, largest] of [[107, 2308455, [537648, 538207]], [19, 796672, [341520, 368135]]]) {
    const original = snapshot();
    const remainder = total - largest.reduce((sum, size) => sum + size, 0);
    const sizes = [...largest, ...Array.from({length: count - 2}, (_, index) =>
      Math.floor(remainder / (count - 2)) + (index < remainder % (count - 2) ? 1 : 0))];
    // Deterministic byte-scale fixtures qualify storage/transport bounds, not
    // the real applications' behavior or their authenticated review acceptance.
    original.sources = Object.fromEntries(sizes.map((size, index) => [`source-${index}`, {...original.sources.head,
      path: `application/source-${index}.txt`, ref: index % 2 ? original.head_sha : original.base_sha,
      content: String(index % 10).repeat(size)}]));
    original.files = [{path: 'application/source-1.txt', status: 'modified', base_source: 'source-0',
      head_source: 'source-1', patch: '@@ byte-scale transport fixture only @@'}];
    const bank = createSourceBank(reseal(original));
    const sources = bank.entries.filter(entry => entry.kind === 'source');
    assert.equal(sources.length, count);
    assert.equal(sources.reduce((sum, entry) => sum + entry.bytes, 0), total);
    assert.equal(Buffer.byteLength(JSON.stringify(bank)) < LIMITS.manifest_bytes, true);
    for (const entry of sources) {
      const pages = completeEntry(bank, entry.entry);
      const reconstructed = pages.map(page => page.text).join('');
      assert.equal(reconstructed, original.sources[entry.source].content);
      assert.equal(createHash('sha256').update(reconstructed).digest('hex'), entry.sha256);
      for (const page of pages) assert.ok(Buffer.byteLength(JSON.stringify([page])) < LIMITS.view_bytes);
    }
  }
});
