'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {readTextBlob} = require('./source-blob.cjs');

function native(bytes) {
  return {encoding: 'base64', size: bytes.length, content: bytes.toString('base64'),
    sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};
}
function fixture(bytes) {
  const blob = native(bytes); const state = {data: blob, blob, reads: []};
  return {state, options: {repo: {owner: 'fixture', repo: 'producer'}, ref: 'a'.repeat(40), filename: 'locks/native.lock',
    github: {rest: {repos: {getContent: async args => {state.reads.push(args); return {data: state.data};}},
      git: {getBlob: async args => {state.reads.push(args); return {data: state.blob};}}}}}};
}

test('native inline and Git blob routes preserve complete UTF-8 bytes, BOM and empty sources', async () => {
  for (const content of ['', '\ufeff日本語 🧭\n', 'x'.repeat(2000000)]) {
    const f = fixture(Buffer.from(content));
    f.state.data = {...f.state.data, content: f.state.data.content.replace(/.{76}/g, '$&\n')};
    assert.equal(await readTextBlob(f.options), content);
  }
  const bytes = Buffer.from('日本語 🧭'.repeat(90000)); const f = fixture(bytes);
  f.state.data = {encoding: 'none', type: 'file', size: bytes.length, sha: f.state.blob.sha};
  assert.equal(await readTextBlob(f.options), bytes.toString('utf8'));
  assert.deepEqual(f.state.reads, [{...f.options.repo, path: f.options.filename, ref: f.options.ref},
    {...f.options.repo, file_sha: f.state.blob.sha}]);
  const absentHash = fixture(Buffer.from('Native Contents fixture without optional hash.'));
  delete absentHash.state.data.sha;
  assert.equal(await readTextBlob(absentHash.options), 'Native Contents fixture without optional hash.');
});

test('unavailable, stale, oversized, truncated and nontextual source is rejected before it enters the bank', async () => {
  for (const data of [null, {}, {size: -1}, {size: 0.5}, {size: 2000001},
    {size: 1, encoding: 'utf8', content: 'x'}, {size: 1, encoding: 'base64', content: null},
    {size: 1, encoding: 'base64', content: 'eA== extra'}, {size: 2, encoding: 'base64', content: 'eA=='},
    {size: 1, encoding: 'base64', content: 'eA==', sha: 'b'.repeat(40)},
    {size: 1, encoding: 'base64', content: 'eA==', sha: null},
    {size: 0, encoding: 'none', type: 'dir', sha: 'a'.repeat(40)},
    {size: 0, encoding: 'none', type: 'file', sha: 'main'}]) {
    const f = fixture(Buffer.from('x')); f.state.data = data;
    await assert.rejects(readTextBlob(f.options), /source blob/);
    assert.equal(f.state.reads.length, 1);
  }
  for (const bytes of [Buffer.from([0xff]), Buffer.from('a\0b')]) {
    await assert.rejects(readTextBlob(fixture(bytes).options));
  }
  const f = fixture(Buffer.from('Immutable native Git blob.'));
  f.state.data = {encoding: 'none', type: 'file', size: f.state.blob.size, sha: f.state.blob.sha};
  for (const change of [null, {sha: 'b'.repeat(40)}, {size: 1}, {content: Buffer.from('Substituted native text.').toString('base64')}]) {
    const original = native(Buffer.from('Immutable native Git blob.'));
    f.state.blob = change === null ? null : {...original, ...change};
    await assert.rejects(readTextBlob(f.options), /source blob/);
  }
});
