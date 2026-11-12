'use strict';
// Compatibility declarations under the protected local_review.binding "diff": compared by what they declare, not by their bytes.
// Kept apart from receipt-patch.test.cjs and local-receipt-binding.test.cjs so a change here does not resend those files as review evidence.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {ReceiptPatchMismatch, withoutDeclarations, verifyPatches} = require('./receipt-patch.cjs');
const {verifySources} = require('./local-receipt.cjs');

const HUNK = '@@ -1,2 +1,2 @@\n context\n-old\n+new';
const name = digit => `compat/declarations/${digit.repeat(64)}.json`;
const declaration = (decision, changes) => `${JSON.stringify({version: 1, decision, changes}, null, 2)}\n`;
const change = (file, sha = 'a', mode = 0) => ({path: file, mode, sha256: sha === null ? null : sha.repeat(64)});
// A file added whole, as GitHub reports it: one hunk whose every line is added.
const added = text => {
  const lines = text.replace(/\n$/, '').split('\n');
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}`;
};
const signedOf = (...files) => ({files: files.map(([file, status, patch]) => ({path: file, status, patch})), paths: files.map(([file]) => file).sort()});
const live = (filename, status, patch) => ({filename, status, patch});
const mismatch = (run, file) => assert.throws(run, error => error instanceof ReceiptPatchMismatch && error.path === file);
const SOURCE = ['src/policy.cjs', 'modified', HUNK];

test('a re-declaration that pins new content for the same files with the same verdict is left out of the bound diff', () => {
  const signed = signedOf(SOURCE, [name('1'), 'added', added(declaration('compatible', [change('src/a.cjs'), change('src/policy.cjs')]))]);
  // The merge changed the pinned content of both files: the declaration was deleted and declared again under its new name.
  const redeclared = [live('src/policy.cjs', 'modified', HUNK), live(name('2'), 'added', added(declaration('compatible', [change('src/a.cjs', 'b'), change('src/policy.cjs', 'c')])))];
  const covered = withoutDeclarations({snapshot: signed, files: redeclared});
  assert.deepEqual(covered.files, [redeclared[0]]);
  assert.deepEqual(covered.snapshot.files.map(item => item.path), ['src/policy.cjs']);
  assert.deepEqual(covered.snapshot.paths, ['src/policy.cjs']);
  // Nothing to leave out: the same file list, unchanged.
  const plain = withoutDeclarations({snapshot: signedOf(SOURCE), files: [live(...SOURCE)]});
  assert.deepEqual(plain.files, [live(...SOURCE)]); assert.deepEqual(plain.snapshot.paths, ['src/policy.cjs']);
});

test('a forged verdict, a covered file added or removed, a changed mode or deletion, or a declaration gained or lost voids the receipt', () => {
  const signed = signedOf(SOURCE, [name('1'), 'added', added(declaration('compatible', [change('src/a.cjs'), change('src/policy.cjs')]))]);
  const with_ = (decision, changes) => [live(...SOURCE), live(name('2'), 'added', added(declaration(decision, changes)))];
  for (const files of [
    with_('incompatible', [change('src/a.cjs'), change('src/policy.cjs')]),
    with_('compatible', [change('src/a.cjs'), change('src/b.cjs'), change('src/policy.cjs')]),
    with_('compatible', [change('src/policy.cjs')]),
    with_('compatible', [change('src/a.cjs', 'a', 0o100), change('src/policy.cjs')]),
    with_('compatible', [change('src/a.cjs', null), change('src/policy.cjs')]),
  ]) mismatch(() => withoutDeclarations({snapshot: signed, files}), name('1'));
  mismatch(() => withoutDeclarations({snapshot: signed, files: [live(...SOURCE)]}), name('1'));
  mismatch(() => withoutDeclarations({snapshot: signedOf(SOURCE), files: with_('compatible', [change('src/policy.cjs')])}), name('2'));
  // Two declarations against one that covers the same files: the verdicts are counted per declaration.
  const two = [...with_('compatible', [change('src/a.cjs')]), live(name('3'), 'added', added(declaration('compatible', [change('src/policy.cjs')])))];
  mismatch(() => withoutDeclarations({snapshot: signed, files: two}), name('1'));
});

test('only a well-formed declaration added under its digest name is left out; any other file under the directory is compared as it is', () => {
  const text = declaration('compatible', [change('src/policy.cjs')]);
  const other = declaration('compatible', [change('src/policy.cjs', 'b')]);
  for (const [file, status, patch, livePatch] of [
    ['compat/declarations/notes.md', 'added', added(text), added(other)],
    [`compat/declarations/${'1'.repeat(63)}.json`, 'added', added(text), added(other)],
    [`compat/declarations/sub/${'1'.repeat(64)}.json`, 'added', added(text), added(other)],
    [name('1'), 'modified', HUNK, HUNK.replace('+new', '+newer')],
    [name('1'), 'added', added('{"version": 1, "decision": "maybe", "changes": []}\n'), added('{"version": 1, "decision": "maybe", "changes": [1]}\n')],
    [name('1'), 'added', added('not json\n'), added('not json either\n')],
    [name('1'), 'added', `${added(text)}\n\\ No newline at end of file`, `${added(other)}\n\\ No newline at end of file`],
    [name('1'), 'added', `@@ -1,1 +1,1 @@\n-x\n${added(text).split('\n').slice(1).join('\n')}`, `@@ -1,1 +1,1 @@\n-x\n${added(other).split('\n').slice(1).join('\n')}`],
  ]) {
    const signed = signedOf(SOURCE, [file, status, patch]);
    // Not a declaration: it stays in the bound diff, so its bytes count like any other file's.
    const covered = withoutDeclarations({snapshot: signed, files: [live(...SOURCE), live(file, status, livePatch)]});
    assert.equal(covered.files.length, 2, file); assert.equal(covered.snapshot.files.length, 2, file);
    mismatch(() => verifyPatches({...covered, binding: 'diff'}), file);
  }
  // A declaration with no hunk body, a body without a header, or no patch at all is not one either.
  for (const patch of ['@@ -0,0 +1,0 @@', '+{}', undefined]) {
    assert.equal(withoutDeclarations({snapshot: signedOf(SOURCE), files: [live(...SOURCE), live(name('2'), 'added', patch)]}).files.length, 2);
  }
});

test('end to end: verifySources keeps a re-declared receipt only under binding "diff", and the bytes of anything else still count', async () => {
  const {repository} = require('../test/local-git-fixture.cjs');
  const {git, collectLocal} = require('./local-git.cjs');
  await repository(async f => {
    fs.mkdirSync(path.join(f.directory, 'compat/declarations'), {recursive: true});
    const declared = declaration('compatible', [change('src/handler.js')]);
    fs.writeFileSync(path.join(f.directory, name('1')), declared);
    git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'chore(compat): declare']);
    const {snapshot} = collectLocal({...f, request: 'Reject missing input.', technical: {}});
    const serve = async args => {
      let text;
      try {text = git(f.directory, ['show', `${args.ref}:${args.path}`]);} catch {throw Object.assign(new Error('Not Found'), {status: 404});}
      return {data: {encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text)}};
    };
    const github = {rest: {repos: {getContent: serve}}};
    const files = require('../test/hosted-files.cjs').hostedFiles(snapshot);
    const pr = {changed_files: files.length, base: {sha: snapshot.base_sha}, head: {sha: snapshot.head_sha, repo: {owner: {login: 'example'}, name: 'local-fixture'}}};
    const config = {readme: 'README.md', repository_policy: 'AGENTS.md'};
    const options = {github, repo: {owner: 'example', repo: 'local-fixture'}, pr, files, snapshot, config};
    const diff = {...options, config: {...config, local_review: {binding: 'diff'}}};
    await verifySources(options);
    await verifySources(diff);
    // The merge of the base pinned new content: the declaration is replaced by one under a new name with a new digest.
    const redeclared = files.map(file => file.filename === name('1') ?
      live(name('2'), 'added', added(declaration('compatible', [change('src/handler.js', 'f')]))) : file);
    await verifySources({...diff, files: redeclared});
    // Without the binding nothing changed: the receipt covers the declaration's bytes, as before.
    await assert.rejects(verifySources({...options, files: redeclared}), /inventory/);
    // A forged verdict and a re-covered file void it under the binding too; so does any byte of the source.
    for (const changes of [[change('src/handler.js', 'f'), change('src/new.js')], []]) {
      const forged = files.map(file => file.filename === name('1') ? live(name('2'), 'added', added(declaration('compatible', changes.length ? changes : [change('src/other.js')]))) : file);
      await assert.rejects(verifySources({...diff, files: forged}), ReceiptPatchMismatch);
    }
    const flipped = files.map(file => file.filename === name('1') ? live(name('2'), 'added', added(declaration('incompatible', [change('src/handler.js', 'f')]))) : file);
    await assert.rejects(verifySources({...diff, files: flipped}), ReceiptPatchMismatch);
    const edited = redeclared.map(file => file.filename === 'src/handler.js' ? {...file, patch: `${file.patch}\n+// edited`} : file);
    await assert.rejects(verifySources({...diff, files: edited}), ReceiptPatchMismatch);
    // The pull request's own file count is still the whole list, declarations included.
    await assert.rejects(verifySources({...diff, files: redeclared, pr: {...pr, changed_files: files.length - 1}}), /inventory/);
  });
});
