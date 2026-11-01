'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {chunkedFixture} = require('../test/chunked-fixture.cjs');
const {PART_SCHEME, PART_BYTES, partName, isRoot, splitRecord, joinRecord} = require('./receipt-parts.cjs');
const {issueReceipt, verifyReceipt, loadReceipt} = require('./local-receipt.cjs');
const {publishReceipt} = require('./local-cli.cjs');
const {RECORD_LIMIT} = require('./chunked-record.cjs');

const clone = value => structuredClone(value);
const sha1 = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

test('a record is cut into byte slices a root describes, and joins back to exactly the same record', () => {
  const record = {a: 'é'.repeat(5000), b: [1, 2, 3], c: {d: '😀'.repeat(300)}};
  for (const size of [1, 7, 4096, 10000000]) {
    const {root, parts} = splitRecord(record, size);
    assert.equal(root.scheme, PART_SCHEME);
    assert.equal(root.parts.length, parts.length);
    assert.equal(root.bytes, Buffer.byteLength(JSON.stringify(record)));
    assert.ok(parts.every(part => part.length <= size && part.length > 0));
    assert.equal(isRoot(root), true);
    assert.deepEqual(joinRecord(root, parts), record);
  }
  // Slices cut through multi-byte characters, which only the whole is valid UTF-8.
  const {parts} = splitRecord({x: 'é'}, 5);
  assert.throws(() => JSON.parse(parts[0].toString('utf8')));
  assert.equal(partName(0), 'clouseau-review.part-0001');
  assert.equal(partName(11), 'clouseau-review.part-0012');
  assert.equal(PART_BYTES, 2000000);
  for (const bad of [0, -1, 1.5, '3']) assert.throws(() => splitRecord({}, bad), /partBytes/);
  for (const value of [null, undefined, 'x', 1, {}, {scheme: 'other'}]) assert.equal(isRoot(value), false);
});

test('a root that is malformed, or parts that differ from it in any way, never join', () => {
  const {root, parts} = splitRecord({payload: 'x'.repeat(100)}, 40);
  const bad = (value, list, message) => assert.throws(() => joinRecord(value, list), error => error instanceof Error && message.test(error.message));
  bad({...root, extra: 1}, parts, /malformed multi-part record root/);
  bad({...root, parts: []}, parts, /malformed multi-part record root/);
  bad({...root, parts: 'x'}, parts, /malformed multi-part record root/);
  bad({...root, sha256: 'z'}, parts, /malformed multi-part record root/);
  bad({...root, bytes: root.bytes + 1}, parts, /malformed multi-part record root/);
  bad({...root, bytes: 0.5}, parts, /malformed multi-part record root/);
  bad({...root, parts: [null, ...root.parts.slice(1)]}, parts, /malformed multi-part record root/);
  bad({...root, parts: [{...root.parts[0], extra: 1}, ...root.parts.slice(1)]}, parts, /malformed multi-part record root/);
  bad({...root, parts: [{...root.parts[0], bytes: 0}, ...root.parts.slice(1)]}, parts, /malformed multi-part record root/);
  bad({...root, parts: [{...root.parts[0], sha256: 'z'}, ...root.parts.slice(1)]}, parts, /malformed multi-part record root/);
  bad(root, parts.slice(1), /missing or extra/);
  bad(root, [...parts, parts[0]], /missing or extra/);
  bad(root, 'parts', /missing or extra/);
  bad(root, [parts[1], parts[0], ...parts.slice(2)], /part 1 differs from the signed root/);
  bad(root, ['not bytes', ...parts.slice(1)], /part 1 differs/);
  const altered = Buffer.from(parts[0]); altered[0] ^= 1;
  bad(root, [altered, ...parts.slice(1)], /part 1 differs/);
  // Every part matches its own digest but the whole does not (a signed root over a different whole).
  bad({...root, sha256: 'f'.repeat(64)}, parts, /differs from the signed root/);
  // A joined text that is not JSON is an error too.
  const text = Buffer.from('not json at all');
  const forged = {scheme: PART_SCHEME, bytes: text.length, sha256: crypto.createHash('sha256').update(text).digest('hex'),
    parts: [{bytes: text.length, sha256: crypto.createHash('sha256').update(text).digest('hex')}]};
  assert.throws(() => joinRecord(forged, [text]), SyntaxError);
});

async function large() {
  const f = await chunkedFixture();
  f.record.padding = 'x'.repeat(RECORD_LIMIT + 100000);
  return {f, bundle: issueReceipt(f.issue)};
}

test('a multi-part receipt verifies, and any change to its envelope or its parts is rejected', async () => {
  const {f, bundle} = await large();
  assert.deepEqual(Object.keys(bundle), ['payload', 'signature', 'parts']);
  assert.ok(bundle.parts.length >= 2 && Buffer.byteLength(JSON.stringify({payload: bundle.payload, signature: bundle.signature})) < 2000);
  assert.equal(verifyReceipt(bundle, f.expected).decision, 'auto_approve');
  const fails = (change, pattern) => {
    const copy = clone(bundle); change(copy);
    assert.throws(() => verifyReceipt(copy, f.expected), pattern);
  };
  fails(copy => {delete copy.parts;}, /multi-part receipt needs its parts/);
  fails(copy => {copy.parts = 'x';}, /malformed multi-part record parts/);
  fails(copy => {copy.parts.pop();}, /missing or extra/);
  fails(copy => {copy.parts.reverse();}, /differs from the signed root/);
  fails(copy => {copy.parts[0] = Buffer.from('tampered').toString('base64');}, /differs from the signed root/);
  fails(copy => {copy.parts[1] = 7;}, /differs from the signed root|argument must be/);
  fails(copy => {copy.extra = 1;}, /malformed signature envelope/);
  // Parts on a receipt that is not a multi-part one are not an envelope extension.
  const small = await chunkedFixture();
  const plain = issueReceipt(small.issue);
  assert.equal(plain.parts, undefined);
  assert.throws(() => verifyReceipt({...plain, parts: []}, small.expected), /multi-part receipt needs its parts/);
  // A root cannot be re-signed over a different record: the record digest is that of the joined record.
  const forged = clone(bundle); forged.payload.record_digest = '0'.repeat(64);
  assert.throws(() => verifyReceipt(forged, f.expected), /untrusted, revoked or invalid signature/);
});

test('the parts of a receipt are loaded from the same immutable commit, large ones through their Git blob', async () => {
  const {f, bundle} = await large();
  const files = {'clouseau-review.json': Buffer.from(JSON.stringify({payload: bundle.payload, signature: bundle.signature}))};
  bundle.parts.forEach((part, index) => {files[partName(index)] = Buffer.from(part, 'base64');});
  const repo = {owner: 'fixture', repo: 'consumer'}; const ref = 'c'.repeat(40);
  const seen = [];
  const github = {rest: {repos: {getContent: async args => {
    seen.push(args.path); assert.deepEqual([args.owner, args.repo, args.ref], ['fixture', 'consumer', ref]);
    const bytes = files[args.path];
    // The Contents API omits the content of a file above 1 MB; the loader then reads its exact blob.
    return {data: bytes.length > 1000000 ? {type: 'file', encoding: 'none', size: bytes.length, sha: sha1(bytes), path: args.path}
      : {encoding: 'base64', content: bytes.toString('base64'), size: bytes.length}};
  }}, git: {getBlob: async ({file_sha: sha}) => {
    const bytes = Object.values(files).find(item => sha1(item) === sha);
    return {data: {encoding: 'base64', content: bytes.toString('base64'), size: bytes.length, sha}};
  }}}};
  const loaded = await loadReceipt({github, repo, ref});
  assert.deepEqual(seen, ['clouseau-review.json', ...bundle.parts.map((_, index) => partName(index))]);
  assert.deepEqual(loaded, bundle);
  assert.equal(verifyReceipt(loaded, f.expected).decision, 'auto_approve');
  // A root without parts listed is not loaded.
  files['clouseau-review.json'] = Buffer.from(JSON.stringify({payload: {record: {scheme: PART_SCHEME, parts: []}}, signature: 'x'}));
  await assert.rejects(loadReceipt({github, repo, ref}), /malformed multi-part record root/);
  // An ordinary receipt loads as before, with no parts.
  files['clouseau-review.json'] = Buffer.from(JSON.stringify({payload: {record: {version: 3}}, signature: 'x'}));
  assert.equal((await loadReceipt({github, repo, ref})).parts, undefined);
});

test('publishing stores the envelope and every part as files of one commit, byte for byte', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-parts-'));
  try {
    const git = (directory, ...args) => cp.execFileSync('git', ['-C', directory, ...args], {encoding: 'utf8', input: undefined});
    const bare = path.join(state, 'artifacts.git'); cp.execFileSync('git', ['init', '-q', '--bare', bare]);
    const work = path.join(state, 'work'); fs.mkdirSync(work);
    git(work, 'init', '-q'); git(work, 'config', 'user.email', 'a@b'); git(work, 'config', 'user.name', 'n');
    git(work, 'remote', 'add', 'origin', bare);
    fs.writeFileSync(path.join(work, 'f.txt'), 'x\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'one');
    const head = git(work, 'rev-parse', 'HEAD').trim();
    const record = {snapshot: {head_sha: head}, padding: 'é'.repeat(3000)};
    const {root, parts} = splitRecord(record, 2000);
    const bundle = {payload: {nonce: 'f'.repeat(64), record: root}, signature: 'sig', parts: parts.map(part => part.toString('base64'))};
    const receipt = path.join(state, 'receipt.json'); fs.writeFileSync(receipt, JSON.stringify(bundle));
    const published = publishReceipt({directory: work, receipt});
    const listing = git(bare, 'ls-tree', '--name-only', published.artifact_commit).trim().split('\n');
    assert.deepEqual(listing, ['clouseau-review.json', ...parts.map((_, index) => partName(index))]);
    assert.deepEqual(JSON.parse(git(bare, 'show', `${published.artifact_commit}:clouseau-review.json`)), {payload: bundle.payload, signature: 'sig'});
    parts.forEach((part, index) => assert.ok(cp.execFileSync('git', ['-C', bare, 'cat-file', 'blob', `${published.artifact_commit}:${partName(index)}`]).equals(part)));
    assert.match(published.marker, /clouseau-local-review:v1/);
    // A single receipt publishes exactly as it always did: one file, the bundle as written.
    const single = {payload: {nonce: 'e'.repeat(64), record}, signature: 'sig'}; fs.writeFileSync(receipt, JSON.stringify(single));
    const one = publishReceipt({directory: work, receipt});
    assert.equal(git(bare, 'ls-tree', '--name-only', one.artifact_commit).trim(), 'clouseau-review.json');
    assert.equal(git(bare, 'show', `${one.artifact_commit}:clouseau-review.json`), JSON.stringify(single) + '\n');
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});
