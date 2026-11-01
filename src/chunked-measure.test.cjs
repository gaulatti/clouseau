'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const table = require('../test/fixtures/alcantara-02618a9.json');
const {PARAMS, CODEX_LIMIT, RECEIPT_LIMIT, MeasureRefusal, scaledTable, withLargeFile, filler, combinedSnapshot, changeTable,
  buildRecord, signAndVerify, measure, render, main} = require('../test/chunked-measure.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {checkOwnership, PartitionRefusal} = require('./review-partition.cjs');
const {RECORD_LIMIT, ChunkedRecordError, chunkedVerifier} = require('./chunked-record.cjs');

const snapshot = combinedSnapshot(table);
const built = buildRecord(snapshot, PARAMS);
const report = measure(table);

const refuses = (run, Type, code) => assert.throws(run, error => {
  assert.ok(error instanceof Type, error.stack);
  assert.equal(error.cause_code ?? error.code, code);
  return true;
});

test('the fixture has the measured shape: 85 files, exact sizes, a derived lockfile, compact added files', () => {
  assert.equal(snapshot.files.length, 85);
  assert.equal(snapshot.files.filter(file => file.status === 'added').length, 63);
  assert.equal(snapshot.files.filter(file => file.status === 'modified').length, 22);
  for (const entry of table.files.filter(item => item.derived_size === undefined)) {
    const file = snapshot.files.find(item => item.path === entry.path);
    assert.equal(file.head_source ? snapshot.sources[file.head_source].content.length : 0, entry.head_size, entry.path);
    assert.equal(file.base_source ? snapshot.sources[file.base_source].content.length : 0, entry.base_size, entry.path);
    assert.equal(file.patch_body === 'head_source', entry.status === 'added');
  }
  const lock = snapshot.files.find(file => file.lockfile);
  assert.equal(lock.path, 'pnpm-lock.yaml');
  assert.equal(snapshot.sources[lock.head_source].authority, 'derived');
  assert.ok(snapshot.sources[lock.head_source].content.length < 250000);
  assert.equal(combinedSnapshot(table).digest, snapshot.digest, 'generation is deterministic');
  assert.equal(filler('x', 0), '');
  assert.equal(combinedSnapshot(table, {imports: false}).files.length, 85);
  assert.equal(combinedSnapshot({files: [table.files[0]]}).files.length, 1);
});

test('without compact storage and the derived lockfile the change is about 3.1M characters, over the 900K budget', () => {
  const raw = table.files.reduce((total, entry) => total + entry.base_size + entry.head_size + (entry.full_patch_chars ?? entry.patch_chars), 0);
  assert.ok(raw * 1.03 > 3000000 && raw * 1.03 < 3300000, String(raw * 1.03));
  assert.throws(() => refresh(structuredClone(snapshot)), /exceeds the source budget/);
  assert.ok(report.combined_chars < PARAMS.cap);
});

test('the plan owns every changed path once and every unit view is inside the unit, shared and manifest caps', () => {
  const {plan, views} = built;
  assert.equal(plan.scheme, 'clouseau-partition/1');
  assert.ok(plan.units.length >= 4 && plan.units.length <= PARAMS.max_units);
  assert.equal(checkOwnership(plan, snapshot.paths), true);
  assert.deepEqual(plan.units.flatMap(unit => unit.owned).sort(), [...snapshot.paths].sort());
  assert.deepEqual(changeTable(snapshot).map(file => file.path), snapshot.files.map(file => file.path));
  views.forEach((view, index) => {
    const sizes = report.units[index];
    assert.ok(plan.units[index].cost <= PARAMS.C);
    assert.ok(sizes.view_chars <= 900000, `${view.unit.id} view`);
    assert.ok(sizes.shared_chars <= 100000);
    assert.ok(sizes.manifest_chars <= 60000);
    assert.ok(sizes.foreign_chars <= 180000);
    assert.ok(sizes.prompt_chars < CODEX_LIMIT);
    assert.equal(view.digest, plan.units[index].view_digest);
  });
  assert.ok(report.units.some(unit => unit.foreign_hunks > 0), 'cross-unit imports produce foreign hunks');
});

test('the merge accepts a full set of fake unit reports and the chunked record verifies, signed, under the record cap', () => {
  const {record, hooks} = built;
  const merged = hooks.merge({unitReports: record.result.reviews[0].unit_reports.map(({unit}, index) => ({unit, report: built.reports[index]})), snapshot});
  assert.equal(merged.snapshot, snapshot.digest);
  assert.equal(merged.accounting.length, snapshot.files.length);
  const reviews = chunkedVerifier(record, {params: PARAMS, hooks}).reviews();
  assert.deepEqual(reviews.map(review => review.role), ['examiner', 'challenger']);
  assert.ok(report.record_bytes < RECORD_LIMIT);
  assert.ok(report.receipt_bytes < RECEIPT_LIMIT);
  assert.equal(report.calls, built.plan.units.length * 2 + 2);
  const {verified} = signAndVerify(record, snapshot, {params: PARAMS, hooks});
  assert.equal(verified.decision, 'auto_approve');
});

test('a smaller unit ceiling gives more units and the same coverage', () => {
  const small = measure(table, {C: 300000});
  assert.ok(small.units.length > report.units.length);
  assert.equal(small.units.reduce((total, unit) => total + unit.files, 0), 85);
});

test('the report prints the plan; the command line handles arguments, refusals and defaults', () => {
  const text = render(report);
  assert.match(text, /^4 units, 85 files, C 450000/m);
  assert.match(text, /largest unit prompt \d+ of 1048576 chars/);
  assert.match(text, /^record \d+ of 2850000 bytes/m);
  const run = (argv, files = table.files) => {
    let out = '';
    const code = main(argv, {readFile: name => { assert.equal(name, argv.find(arg => !arg.startsWith('--') && arg.endsWith('.json')) ?? require('node:path').join(__dirname, '../test/fixtures/alcantara-02618a9.json')); return JSON.stringify({files}); },
      stdout: {write: chunk => { out += chunk; }}});
    return {code, out};
  };
  assert.equal(run(['table.json', '--ceiling', '300000', '--shared', '100000']).code, 0);
  assert.match(run(['--max-units', '2']).out, /^refused too_many_units: /);
  assert.equal(run(['--max-units', '2']).code, 2);
  assert.match(run(['--cap', '1000000']).out, /^refused combined_snapshot_too_large: /);
  assert.match(run(['table.json', '--cap', '3000000', '--max-units', '100'], scaledTable(table, 2).files).out, /^refused chunked_record_invalid|^refused record_too_large|^refused combined_snapshot_too_large/);
  assert.throws(() => run(['--bogus', '1']), /unknown option --bogus/);
  assert.throws(() => main(['t.json'], {readFile: () => '{', stdout: {write() {}}}), SyntaxError);
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => { written.push(String(chunk)); return true; };
  try { assert.equal(main([]), 0); } finally { process.stdout.write = original; }
  assert.match(written.join(''), /^clouseau-partition\/1 /);
});

// Known size gaps: the tenet is that a PR is never refused for its size. Each test pins the refusal the CURRENT code still
// makes, so the integrator (PR 7) removes the site and then deletes or inverts the test.
const big = {...PARAMS, cap: 3000000, max_units: 100};
const large = rows => combinedSnapshot(rows, {cap: 50000000});

test('known size gap: a 170-file change exceeds the combined snapshot cap (acceptance-sources.cjs:40, protected cap at most 3,000,000)', () => {
  refuses(() => measure(scaledTable(table, 2)), MeasureRefusal, 'combined_snapshot_too_large');
});

test('known size gap: more units than max_units is a hold (review-partition.cjs:126, too_many_units)', () => {
  refuses(() => buildRecord(large(scaledTable(table, 4)), {...big, max_units: 8}), PartitionRefusal, 'too_many_units');
});

test('known size gap: a record above 95% of the receipt cannot be signed (chunked-record.cjs:60, record_too_large)', () => {
  const rows = large(scaledTable(table, 2));
  const second = buildRecord(rows, big);
  refuses(() => signAndVerify(second.record, rows, {params: big, hooks: second.hooks}), ChunkedRecordError, 'record_too_large');
});

test('known size gap: roughly 500 changed paths overflow the 60,000-character manifest (review-units.cjs:113, manifest_too_large)', () => {
  assert.ok(scaledTable(table, 6).files.length > 400);
  refuses(() => buildRecord(large(scaledTable(table, 6)), big), Error, 'manifest_too_large');
});

test('known size gap: a single file over the 300,000-byte per-file bound is refused (review-partition.cjs:59, file_over_bound)', () => {
  refuses(() => measure(withLargeFile(table, 350000), {max_units: 100}), PartitionRefusal, 'file_over_bound');
});

test('known size gap: a file above the 450,000 ceiling is its own unit, above the 800,000 unit budget it is refused (review-partition.cjs:114, unit_exceeds_budget)', () => {
  const modified = (size, patch) => ({files: [...table.files, {path: 'big/modified.ts', status: 'modified', previous: null, base_size: size, head_size: size, patch_chars: patch}]});
  const own = measure(modified(200000, 100000));
  assert.ok(own.units.some(unit => unit.files === 1 && unit.cost > PARAMS.C && unit.cost <= 800000));
  refuses(() => buildRecord(large(modified(299000, 250000)), big), PartitionRefusal, 'unit_exceeds_budget');
});
