'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const table = require('../test/fixtures/alcantara-02618a9.json');
const {PARAMS, CODEX_LIMIT, RECEIPT_LIMIT, scaledTable, withLargeFile, filler, combinedSnapshot, changeTable, hooksFor,
  buildRecord, signAndVerify, measure, render, main} = require('../test/chunked-measure.cjs');
const {refresh, BUDGET} = require('./acceptance-sources.cjs');
const {checkOwnership} = require('./review-partition.cjs');
const {RECORD_LIMIT, chunkedVerifier} = require('./chunked-record.cjs');
const {digest} = require('./acceptance.cjs');

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
  assert.ok(report.combined_chars > BUDGET, 'the combined snapshot is not capped; only the units are');
});

test('the plan owns every changed path once and every unit view is inside the unit, shared and manifest caps', () => {
  const {plan, views} = built;
  assert.equal(plan.scheme, 'clouseau-partition/1');
  assert.ok(plan.units.length >= 4);
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

test('foreign hunks are listed in path order whichever order the snapshot lists its files', () => {
  const reversed = {...snapshot, files: [...snapshot.files].reverse()};
  const view = hooksFor(PARAMS).unitView(reversed, built.plan.units[1]);
  assert.deepEqual(view.foreign_hunks.map(hunk => hunk.path), built.views[1].foreign_hunks.map(hunk => hunk.path));
});

test('the merge accepts a full set of fake unit reports and the chunked record verifies, signed, under the record cap', () => {
  const {record, hooks} = built;
  const merged = hooks.merge({unitReports: record.result.reviews[0].unit_reports.map(({unit}, index) => ({unit, report: built.reports[index]})), snapshot});
  assert.equal(merged.snapshot, snapshot.digest);
  assert.equal(merged.accounting.length, snapshot.files.length);
  const reviews = chunkedVerifier(record, {params: PARAMS, hooks}).reviews();
  assert.deepEqual(reviews.map(review => review.role), ['examiner', 'challenger']);
  assert.ok(report.record_bytes < RECORD_LIMIT);
  assert.ok(report.receipt_bytes < RECEIPT_LIMIT && report.receipt_files === 1);
  assert.equal(report.calls, built.plan.units.length * 2 + 2);
  const {verified} = signAndVerify(record, snapshot, {params: PARAMS, hooks});
  assert.equal(verified.decision, 'auto_approve');
});

test('a smaller unit ceiling gives more units and the same coverage', () => {
  const small = measure(table, {C: 300000});
  assert.ok(small.units.length > report.units.length);
  assert.equal(small.units.reduce((total, unit) => total + unit.files, 0), 85);
});

test('the report prints the plan; the command line handles arguments, refusals and defaults', async () => {
  const text = render(report);
  assert.match(text, /^4 units, 85 files, C 450000/m);
  assert.match(text, /largest unit prompt \d+ of 1048576 chars/);
  assert.match(text, /^record \d+ bytes \(\d+\.\d% of the 2850000 single-receipt limit\)/m);
  assert.match(text, /^signed receipt \d+ bytes in 1 file, verified/m);
  const run = async (argv, files = table.files) => {
    let out = '';
    const code = await main(argv, {readFile: name => { assert.equal(name, argv.find(arg => !arg.startsWith('--') && arg.endsWith('.json')) ?? require('node:path').join(__dirname, '../test/fixtures/alcantara-02618a9.json')); return JSON.stringify({files}); },
      stdout: {write: chunk => { out += chunk; }}});
    return {code, out};
  };
  assert.equal((await run(['table.json', '--ceiling', '300000', '--shared', '100000'])).code, 0);
  const many = await run(['table.json'], scaledTable(table, 2).files);
  assert.equal(many.code, 0);
  assert.match(many.out, /^signed receipt \d+ bytes in [2-9] files/m);
  await assert.rejects(run(['--bogus', '1']), /unknown option --bogus/);
  await assert.rejects(main(['t.json'], {readFile: () => '{', stdout: {write() {}}}), SyntaxError);
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => { written.push(String(chunk)); return true; };
  try { assert.equal(await main([]), 0); } finally { process.stdout.write = original; }
  assert.match(written.join(''), /^clouseau-partition\/1 /);
  assert.match(written.join(''), /^exact prompts: 8 unit calls \d+ chars \(largest \d+\), \d+ integration calls \d+ chars/m);
});

// The tenet: a change is never refused for its size. Each size that used to be a refusal is now partitioned into bounded
// units, reviewed, merged and signed; the checks below are the completeness invariants, not just "no error".
const everyViewFits = (measured, snapshot, params = PARAMS) => {
  assert.equal(measured.verified, true);
  for (const unit of measured.units) {
    assert.ok(unit.view_chars <= 900000, `${unit.id} view`);
    assert.ok(unit.shared_chars <= params.S && unit.prompt_chars < CODEX_LIMIT, `${unit.id} shared and prompt`);
    assert.ok(unit.manifest_chars <= 60000, `${unit.id} manifest`);
  }
  assert.equal(measured.files, snapshot.files.length);
};
const coveredOnce = (rows, params = PARAMS) => {
  const snapshot = large(rows);
  const {plan} = buildRecord(snapshot, params);
  assert.equal(checkOwnership(plan, snapshot.paths), true);
  return {snapshot, plan};
};
const large = rows => combinedSnapshot(rows);

test('a 170-file change has a combined snapshot of any size: its units are bounded, the receipt is signed and verified', () => {
  const rows = scaledTable(table, 2);
  const measured = measure(rows);
  everyViewFits(measured, large(rows));
  assert.ok(measured.combined_chars > BUDGET * 3);
  assert.ok(measured.units.length > 4);
  coveredOnce(rows);
});

test('any number of units is planned: nothing holds a change for having many', () => {
  const rows = scaledTable(table, 5);
  const {plan} = coveredOnce(rows);
  assert.ok(plan.units.length > 16);
  const measured = measure(rows);
  assert.equal(measured.units.length, plan.units.length);
  assert.equal(measured.calls, plan.units.length * 2 + 2);
});

test('a record above the single-receipt limit is signed as a multi-part receipt and verifies through the one derivation', () => {
  const rows = scaledTable(table, 2);
  const snapshot = large(rows);
  const built = buildRecord(snapshot, PARAMS);
  assert.ok(Buffer.byteLength(JSON.stringify(built.record)) > RECORD_LIMIT);
  const {bundle, verified} = signAndVerify(built.record, snapshot, {params: PARAMS, hooks: built.hooks});
  assert.ok(bundle.parts.length >= 2);
  assert.equal(verified.decision, 'auto_approve');
  assert.equal(digest(verified.record), digest(built.record));
  const measured = measure(rows);
  assert.equal(measured.receipt_files, 1 + bundle.parts.length);
  assert.ok(measured.record_bytes > measured.record_limit);
});

test('roughly 500 changed paths page their manifest by directory; every unit still sees the whole change', () => {
  const rows = scaledTable(table, 6);
  assert.ok(rows.files.length > 400);
  const {snapshot, plan} = coveredOnce(rows);
  assert.ok(plan.units.length > 10);
  const manifest = buildRecord(snapshot, PARAMS).views[0].change_manifest;
  assert.ok(manifest.some(row => row.dir), 'directories are summarized');
  assert.ok(JSON.stringify(manifest).length <= 60000);
  assert.equal(manifest.reduce((total, row) => total + (row.files ?? 1), 0), rows.files.length);
  const totals = buildRecord(snapshot, PARAMS).views.map(view => view.change_manifest.reduce((total, row) => total + (row.files ?? 1), 0));
  assert.ok(totals.every(total => total === rows.files.length));
});

test('a single file far over the unit ceiling is split into line ranges, each owned once, and still verifies', () => {
  const rows = withLargeFile(table, 2500000);
  const {snapshot, plan} = coveredOnce(rows);
  const holders = plan.units.filter(unit => unit.owned.includes('generated/large-module.ts'));
  assert.ok(holders.length >= 5);
  assert.deepEqual(holders.map(unit => unit.parts['generated/large-module.ts'].index), holders.map((_, index) => index));
  const measured = measure(rows);
  everyViewFits(measured, snapshot);
  // Every line of the file is in exactly one segment: the segment windows tile the file in order.
  const views = buildRecord(snapshot, PARAMS).views.filter(view => view.paths.includes('generated/large-module.ts'));
  const lines = views.map(view => view.sources[view.files.find(file => file.path === 'generated/large-module.ts').head_source].content.replace(/\n$/, '').split('\n'));
  assert.equal(lines.reduce((total, part) => total + part.length, 0), snapshot.sources[`${'a'.repeat(40)}:generated/large-module.ts`].content.split('\n').length - 1);
});

test('a file over the old per-file bound and a file over the old unit budget are both reviewed', () => {
  const over = measure(withLargeFile(table, 350000), {});
  assert.equal(over.verified, true);
  const modified = (size, patch) => ({files: [...table.files, {path: 'big/modified.ts', status: 'modified', previous: null, base_size: size, head_size: size, patch_chars: patch}]});
  const own = measure(modified(200000, 100000));
  assert.ok(own.units.some(unit => unit.files === 1 && unit.cost > PARAMS.C && unit.cost <= 560000));
  const beyond = coveredOnce(modified(299000, 250000));
  assert.ok(beyond.plan.units.filter(unit => unit.owned.includes('big/modified.ts')).length >= 2);
  everyViewFits(measure(modified(299000, 250000)), beyond.snapshot);
});

test('a one-line file larger than any unit is cut into pieces and verifies', () => {
  const minified = {files: [...table.files, {path: 'dist/app.min.js', status: 'modified', previous: null, base_size: 1200000, head_size: 1200000, patch_chars: 2400000}]};
  const snapshot = large(minified);
  const file = snapshot.files.find(item => item.path === 'dist/app.min.js');
  // The filler is many lines; make this file one long line of the same size so the cut is inside a line.
  for (const id of [file.base_source, file.head_source]) snapshot.sources[id].content = `${'v'.repeat(1199999)}\n`;
  file.patch = `diff --git a/dist/app.min.js b/dist/app.min.js\n--- a/dist/app.min.js\n+++ b/dist/app.min.js\n@@ -1,1 +1,1 @@\n-${'v'.repeat(1199999)}\n+${'w'.repeat(1199999)}\n`;
  refresh(snapshot, Number.MAX_SAFE_INTEGER);
  const built = buildRecord(snapshot, PARAMS);
  const holders = built.plan.units.filter(unit => unit.owned.includes('dist/app.min.js'));
  assert.ok(holders.length >= 6);
  const bundle = signAndVerify(built.record, snapshot, {params: PARAMS, hooks: built.hooks});
  assert.equal(bundle.verified.decision, 'auto_approve');
});
