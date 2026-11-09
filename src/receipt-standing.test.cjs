'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {githubReader, RECEIPT_RESPONSE_LIMIT} = require('./receipt-standing.cjs');
const {MAX_RECEIPT_BYTES} = require('./local-receipt.cjs');

// A `gh` on PATH that prints a git blob response whose base64 content has `size` bytes, wrapped every 60 characters as GitHub does.
function fakeGh(t, size) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-fake-gh-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const content = Buffer.alloc(size, 7).toString('base64').replace(/(.{60})/g, '$1\n');
  fs.writeFileSync(path.join(directory, 'blob.json'), JSON.stringify({sha: 'b'.repeat(40), size, encoding: 'base64', content}));
  fs.writeFileSync(path.join(directory, 'gh'), `#!/bin/sh\nexec cat "${directory}/blob.json"\n`, {mode: 0o755});
  const previous = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${previous}`;
  t.after(() => {process.env.PATH = previous;});
}

const blob = reader => reader.rest.git.getBlob({owner: 'o', repo: 'r', file_sha: 'b'.repeat(40)});

test('the read limit covers the largest receipt blob GitHub can return, base64 and line wrapping included', () => {
  const wrapped = Math.ceil(MAX_RECEIPT_BYTES / 3) * 4 + Math.ceil(Math.ceil(MAX_RECEIPT_BYTES / 3) * 4 / 60) * 2;
  assert.ok(RECEIPT_RESPONSE_LIMIT > wrapped && RECEIPT_RESPONSE_LIMIT > 1024 * 1024);
});

test('a receipt blob larger than the default 1 MiB gh output buffer is read through the real gh process', async t => {
  fakeGh(t, 1200000);
  const {data} = await blob(githubReader(cp.execFileSync));
  assert.equal(Buffer.from(data.content, 'base64').length, 1200000);
});

test('a receipt blob at the receipt size cap is read in full', async t => {
  fakeGh(t, MAX_RECEIPT_BYTES);
  const {data} = await blob(githubReader(cp.execFileSync));
  assert.equal(Buffer.from(data.content, 'base64').length, MAX_RECEIPT_BYTES);
});

test('a response over the limit fails naming the limit, without a fallback or a status', async t => {
  fakeGh(t, MAX_RECEIPT_BYTES + 200000);
  await assert.rejects(blob(githubReader(cp.execFileSync)), error => error.status === undefined &&
    error.message.includes(`${RECEIPT_RESPONSE_LIMIT}-byte`) && error.message.includes(`${MAX_RECEIPT_BYTES}-byte receipt size cap`) &&
    !/spawnSync gh ENOBUFS/.test(error.message));
});
