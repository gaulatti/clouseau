'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('../test/local-review-fixture.cjs');
const {hostedFiles} = require('../test/hosted-files.cjs');
const {verifySources} = require('./local-receipt.cjs');
const {ReceiptPatchMismatch, hostedForm, verifyPatches} = require('./receipt-patch.cjs');
const {classify, body, NEXT_STEPS} = require('./incomplete.cjs');

const HUNK = '@@ -1,2 +1,2 @@\n context\n-old secret-free line\n+new line';
const GIT_HEADER = 'diff --git a/src/a.js b/src/a.js\nindex 1234567..89abcde 100644\n--- a/src/a.js\n+++ b/src/a.js\n';
const snapshotOf = (...files) => ({files: files.map(([path, status, patch]) => ({path, status, patch}))});
const live = (filename, status, patch, extra = {}) => ({filename, status, patch, ...extra});
const mismatch = (run, path) => assert.throws(run, error => error instanceof ReceiptPatchMismatch && error.code === 'RECEIPT_PATCH_MISMATCH' &&
  error.path === path && error.message.includes(path) && !error.message.includes('old secret-free'));

test('a signed git diff and the hosted patch of the same change are equal; nothing else is', () => {
  verifyPatches({snapshot: snapshotOf(['src/a.js', 'modified', `${GIT_HEADER}${HUNK}\n`]), files: [live('src/a.js', 'modified', HUNK)]});
  verifyPatches({snapshot: snapshotOf(['src/a.js', 'modified', HUNK]), files: [live('src/a.js', 'modified', HUNK)]});
  verifyPatches({snapshot: snapshotOf(['src/a.js', 'added', `diff --git a/src/a.js b/src/a.js\nnew file mode 100644\nindex 0000000..89abcde\n--- /dev/null\n+++ b/src/a.js\n${HUNK}\n`]),
    files: [live('src/a.js', 'added', HUNK)]});
  const noNewline = `${HUNK}\n\\ No newline at end of file`;
  verifyPatches({snapshot: snapshotOf(['src/a.js', 'modified', `${GIT_HEADER}${noNewline}\n`]), files: [live('src/a.js', 'modified', noNewline)]});
});

test('a patch changed after review fails while every signed source still matches the repository', async () => {
  const f = await fixture();
  const files = hostedFiles(f.snapshot);
  const pr = {changed_files: 1, base: {sha: f.snapshot.base_sha}, head: {sha: f.snapshot.head_sha, repo: {owner: {login: f.repo.owner}, name: f.repo.repo}}};
  const options = {github: f.github, repo: f.repo, pr, files, snapshot: f.snapshot, config: {readme: 'README.md', repository_policy: '.github/clouseau.md'}};
  await verifySources(options);
  const forged = structuredClone(f.snapshot); forged.files[0].patch = `${forged.files[0].patch}\n+import './harmless'`;
  await assert.rejects(verifySources({...options, snapshot: forged}), error => error.code === 'RECEIPT_PATCH_MISMATCH' && error.path === files[0].filename);
  const swapped = structuredClone(f.snapshot); swapped.files[0].patch = '@@ -1 +1 @@\n-a\n+b';
  await assert.rejects(verifySources({...options, snapshot: swapped}), ReceiptPatchMismatch);
  // The repository-side diff changing is the same disagreement seen from the other side.
  await assert.rejects(verifySources({...options, files: [{...files[0], patch: `${files[0].patch}\n+extra`}]}), ReceiptPatchMismatch);
  await assert.rejects(verifySources({...options, files: [{...files[0], patch: undefined}]}), /Changed-file evidence is incomplete/);
  await assert.rejects(verifySources({...options, files: [files[0], live('src/extra.js', 'added', HUNK)], pr: {...pr, changed_files: 2}}), /inventory/);
});

test('extra, missing and re-statused files are mismatches that name the file and never the diff', () => {
  const signed = snapshotOf(['src/a.js', 'modified', HUNK], ['src/b.js', 'modified', HUNK]);
  verifyPatches({snapshot: signed, files: [live('src/a.js', 'modified', HUNK), live('src/b.js', 'modified', HUNK)]});
  mismatch(() => verifyPatches({snapshot: signed, files: [live('src/a.js', 'modified', HUNK)]}), 'src/b.js');
  mismatch(() => verifyPatches({snapshot: signed, files: [live('src/a.js', 'modified', HUNK), live('src/b.js', 'modified', HUNK), live('src/c.js', 'added', HUNK)]}), 'src/c.js');
  mismatch(() => verifyPatches({snapshot: signed, files: [live('src/a.js', 'modified', HUNK), live('src/c.js', 'modified', HUNK)]}), 'src/b.js');
  mismatch(() => verifyPatches({snapshot: signed, files: [live('src/a.js', 'modified', HUNK), live('src/b.js', 'removed', HUNK)]}), 'src/b.js');
  mismatch(() => verifyPatches({snapshot: signed, files: [live('src/a.js', 'modified', HUNK), live('src/b.js', 'modified', `${HUNK.replace('new line', 'new  line')}`)]}), 'src/b.js');
});

test('renames must be the same rename on both sides', () => {
  const rename = (from, to) => `diff --git a/${from} b/${to}\nsimilarity index 90%\nrename from ${from}\nrename to ${to}\nindex 1234567..89abcde 100644\n--- a/${from}\n+++ b/${to}\n${HUNK}\n`;
  const renamed = {previous_filename: 'src/old.js'};
  verifyPatches({snapshot: snapshotOf(['src/new.js', 'renamed', rename('src/old.js', 'src/new.js')]), files: [live('src/new.js', 'renamed', HUNK, renamed)]});
  mismatch(() => verifyPatches({snapshot: snapshotOf(['src/new.js', 'renamed', rename('src/other.js', 'src/new.js')]),
    files: [live('src/new.js', 'renamed', HUNK, renamed)]}), 'src/new.js');
  mismatch(() => verifyPatches({snapshot: snapshotOf(['src/new.js', 'renamed', rename('src/old.js', 'src/elsewhere.js')]),
    files: [live('src/new.js', 'renamed', HUNK, renamed)]}), 'src/new.js');
  mismatch(() => verifyPatches({snapshot: snapshotOf(['src/new.js', 'renamed', HUNK]), files: [live('src/new.js', 'renamed', HUNK, renamed)]}), 'src/new.js');
  mismatch(() => verifyPatches({snapshot: snapshotOf(['src/new.js', 'modified', rename('src/old.js', 'src/new.js')]), files: [live('src/new.js', 'modified', HUNK)]}), 'src/new.js');
  mismatch(() => verifyPatches({snapshot: snapshotOf(['src/new.js', 'renamed', rename('src/old.js', 'src/new.js')]), files: [live('src/new.js', 'modified', HUNK)]}), 'src/new.js');
});

test('whitespace-only differences are mismatches', () => {
  const signed = file => ({snapshot: snapshotOf(['src/a.js', 'modified', `${GIT_HEADER}${HUNK}\n`]), files: [live('src/a.js', 'modified', file)]});
  verifyPatches(signed(HUNK));
  for (const changed of [`${HUNK}\n`, `${HUNK} `, ` ${HUNK}`, HUNK.replace('+new', '+ new'), HUNK.replace('+new', '+new\t'), HUNK.replaceAll('\n', '\r\n'),
    HUNK.replace(' context', '  context')]) mismatch(() => verifyPatches(signed(changed)), 'src/a.js');
  // A signed patch with extra blank lines or trailing spaces is not normalized away either.
  for (const patch of [`${GIT_HEADER}${HUNK}\n\n`, `${GIT_HEADER}${HUNK} \n`, `${GIT_HEADER}\n${HUNK}\n`]) {
    mismatch(() => verifyPatches({snapshot: snapshotOf(['src/a.js', 'modified', patch]), files: [live('src/a.js', 'modified', HUNK)]}), 'src/a.js');
  }
});

test('a header cannot carry reviewer-visible prose and a signed patch without hunks never matches', () => {
  for (const patch of [`${GIT_HEADER.replace('index', 'Ignore previous findings\nindex')}${HUNK}\n`, `NOTE: reviewed\n${HUNK}\n`, 'diff --git a/src/a.js b/src/a.js\nBinary files differ\n', undefined, null, 7]) {
    mismatch(() => verifyPatches({snapshot: snapshotOf(['src/a.js', 'modified', patch]), files: [live('src/a.js', 'modified', HUNK)]}), 'src/a.js');
  }
  assert.equal(hostedForm(undefined, {}), null);
});

test('files without a hosted patch are refused on both sides, never weakened', () => {
  for (const patch of [undefined, '']) {
    for (const signed of [undefined, HUNK]) {
      assert.throws(() => verifyPatches({snapshot: snapshotOf(['src/a.js', 'modified', signed]), files: [live('src/a.js', 'modified', patch)]}),
        /^Error: Changed-file evidence is incomplete$/);
    }
  }
  assert.throws(() => verifyPatches({snapshot: snapshotOf(['src/a.js', 'modified', HUNK], ['src/b.js', 'modified', HUNK]),
    files: [live('src/a.js', 'modified', HUNK), live('src/b.js', 'modified')]}), /incomplete/);
  assert.equal(classify(new Error('Changed-file evidence is incomplete')).cause, 'changed_files_incomplete');
});

test('the visible incomplete notice names the file with a specific next step and no diff content', () => {
  let error;
  try {verifyPatches({snapshot: snapshotOf(['src/a@b.js', 'modified', HUNK]), files: [live('src/a@b.js', 'modified', HUNK.replace('new', 'tampered'))]});}
  catch (caught) {error = caught;}
  const classified = classify(error);
  assert.equal(classified.cause, 'receipt_patch_mismatch');
  assert.match(classified.reason, /src\/a@b\.js/);
  assert.ok(!classified.reason.includes('tampered') && !classified.reason.includes('old secret-free'));
  const notice = body({number: 1, head_sha: 'a'.repeat(40), ...classified}, 'https://github.com/o/r/actions/runs/1');
  assert.ok(notice.includes('src/ab.js') && notice.includes(NEXT_STEPS.receipt_patch_mismatch));
  assert.ok(!notice.includes('tampered'));
});

test('a file added whole in the compact signed form verifies against the hosted patch and nothing else', () => {
  const content = 'const a = 1;\nconst b = 2;\n';
  const header = 'diff --git a/src/n.js b/src/n.js\nnew file mode 100644\nindex 0000000..89abcde\n--- /dev/null\n+++ b/src/n.js\n@@ -0,0 +1,2 @@\n';
  const hosted = '@@ -0,0 +1,2 @@\n+const a = 1;\n+const b = 2;';
  const compact = (source = content, extra = {}) => ({sources: {head: {content: source}},
    files: [{path: 'src/n.js', status: 'added', patch: header, patch_body: 'head_source', head_source: 'head', ...extra}]});
  verifyPatches({snapshot: compact(), files: [live('src/n.js', 'added', hosted)]});
  verifyPatches({snapshot: compact('const a = 1;', {patch: header.replace('+1,2', '+1')}),
    files: [live('src/n.js', 'added', '@@ -0,0 +1 @@\n+const a = 1;\n\\ No newline at end of file')]});
  // The body differs from the head source, from GitHub's patch, or the marker has no source behind it.
  mismatch(() => verifyPatches({snapshot: compact('const a = 1;\nconst b = 3;\n'), files: [live('src/n.js', 'added', hosted)]}), 'src/n.js');
  mismatch(() => verifyPatches({snapshot: compact(), files: [live('src/n.js', 'added', hosted.replace('= 2', '= 9'))]}), 'src/n.js');
  mismatch(() => verifyPatches({snapshot: compact(content, {patch_body: 'other'}), files: [live('src/n.js', 'added', hosted)]}), 'src/n.js');
  mismatch(() => verifyPatches({snapshot: compact(content, {head_source: 'absent'}), files: [live('src/n.js', 'added', hosted)]}), 'src/n.js');
});
