'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {repository} = require('../test/local-git-fixture.cjs');
const {collectLocal, git, assertUnchanged} = require('./local-git.cjs');
const {refresh, additionalSources, selectSourceBank} = require('./acceptance-sources.cjs');
const {createSourceBank, readSourcePages} = require('./source-bank.cjs');
const {digest} = require('./acceptance.cjs');

const largeLock = bytes => '# Native-scale complete lockfile fixture.\n' +
  'entry: stable\n'.repeat(Math.ceil(bytes / 14)).slice(0, bytes - Buffer.byteLength('# Native-scale complete lockfile fixture.\n'));

test('Git collection retains large base/head blobs and patch bytes before selecting bounded review', () => repository(f => {
  const text = largeLock(538207); const filename = path.join(f.directory, 'pnpm-lock.yaml');
  fs.writeFileSync(filename, text); fs.writeFileSync(path.join(f.directory, 'src/bom.js'), '\ufeffmodule.exports = 1;\n');
  fs.writeFileSync(path.join(f.directory, 'src/empty.js'), '');
  git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'test: complete large source and empty-file fixtures']);
  const collected = collectLocal({...f, request: 'Inspect the complete frozen fixture.', technical: {fixture_only: true}});
  const {snapshot} = collected;
  assert.equal(snapshot.source_bank_version, 1);
  assert.equal(snapshot.sources[`${snapshot.base_sha}:pnpm-lock.yaml`].content, largeLock(537648));
  assert.equal(snapshot.sources[`${snapshot.head_sha}:pnpm-lock.yaml`].content, text);
  assert.equal(snapshot.sources[`${snapshot.head_sha}:src/bom.js`].content.charCodeAt(0), 0xfeff);
  const bank = createSourceBank(snapshot);
  for (const entry of bank.entries.filter(item => item.kind === 'source')) {
    const pages = [];
    for (let page = 0; page < entry.page_count; page++) pages.push(readSourcePages(bank,
      {bank_digest: bank.bank_digest, pages: [{entry: entry.entry, page}]})[0]);
    assert.equal(pages.map(item => item.text).join(''), snapshot.sources[entry.source].content);
  }
  const lock = snapshot.files.find(item => item.path === 'pnpm-lock.yaml');
  assert.equal(lock.patch, git(f.directory, ['diff', '--no-ext-diff', '--no-textconv', snapshot.base_sha, snapshot.head_sha, '--', 'pnpm-lock.yaml']));
  assertUnchanged(f.directory, snapshot);
}, directory => fs.writeFileSync(path.join(directory, 'pnpm-lock.yaml'), largeLock(537648))));

test('invalid Git UTF-8 cannot become replacement text in a review snapshot', () => repository(f => {
  fs.writeFileSync(path.join(f.directory, 'src/invalid.js'), Buffer.from([0xff, 0x0a]));
  git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'test: invalid UTF-8 fixture']);
  assert.throws(() => collectLocal({...f, request: 'Inspect original bytes.', technical: {}}), /encoded data was not valid/);
}));

test('new immutable dependencies can select paging without changing old signed snapshot identities', () => repository(async f => {
  const {snapshot} = collectLocal({...f, request: 'Inspect the accepted change.', technical: {}});
  assert.equal(Object.hasOwn(snapshot, 'source_bank_version'), false);
  const original = structuredClone(snapshot); const identity = original.digest;
  assert.equal(refresh(structuredClone(original)).digest, identity);
  const content = largeLock(368135);
  const github = {rest: {repos: {getContent: async args => {
    assert.equal(args.ref, snapshot.head_sha);
    return {data: {encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64')}};
  }}}};
  await additionalSources({github, repo: snapshot.head_repository, snapshot, paths: ['package-lock.json']});
  assert.equal(snapshot.source_bank_version, 1); assert.notEqual(snapshot.digest, identity);
  assert.equal(refresh(structuredClone(original)).digest, identity);
  const rebuilt = createSourceBank(snapshot);
  assert.equal(rebuilt.entries.find(item => item.path === 'package-lock.json').bytes, 368135);
  const tampered = structuredClone(snapshot); tampered.source_bank_version = 2;
  assert.throws(() => refresh(tampered), /Unsupported/);
  const legacyLarge = {...original, claims: {description: 'x'.repeat(900001)}};
  assert.throws(() => refresh(legacyLarge), /source budget/);
  selectSourceBank(legacyLarge); refresh(legacyLarge);
  assert.equal(legacyLarge.source_bank_version, 1);
  assert.equal(legacyLarge.digest, digest(Object.fromEntries(Object.entries(legacyLarge).filter(([key]) => key !== 'digest'))));
}));
