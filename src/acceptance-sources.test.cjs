'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {proofCatalog, safePath, refresh, readSource, collectSnapshot, additionalSources} = require('./acceptance-sources.cjs');
const {packetFor} = require('./acceptance-grading.cjs');

test('controller proof IDs bind bounded immutable spans and remain stable when source context grows', () => {
  const snapshot = {sources: {blank: {content: '\n'}, code: {content: Array.from({length: 85}, (_, i) =>
    i < 40 ? '' : `statement ${i + 1}`).join('\n')}}};
  const proofs = proofCatalog(snapshot);
  assert.deepEqual(proofs, [{id: 'proof-1-41', source: 'code', start: 41, end: 80},
    {id: 'proof-1-81', source: 'code', start: 81, end: 85}]);
  snapshot.sources.other = {content: 'additional source'};
  assert.deepEqual(proofCatalog(snapshot).slice(0, 2), proofs);
});

function fixture() {
  const calls = [];
  const github = {rest: {repos: {
    getContent: async args => {calls.push(args); return {data: {content: Buffer.from('A complete fictional source.\n').toString('base64'), encoding: 'base64', size: 30}};},
    listCommits: async () => ({data: [{sha: 'b'.repeat(40), commit: {message: 'fix: preserve durable upload acceptance'}}]}),
  }}, graphql: async () => ({repository: {pullRequest: {closingIssuesReferences: {nodes: [{number: 1, title: 'Repair upload', body: 'Preserve acceptance.'}], pageInfo: {hasNextPage: false}}}}})};
  return {github, calls, repo: {owner: 'example', repo: 'upload-gateway'},
    pr: {number: 3, changed_files: 1, title: 'fix: preserve upload', body: 'Untrusted contributor claim.', base: {sha: 'b'.repeat(40)}, head: {sha: 'a'.repeat(40), repo: {owner: {login: 'external'}, name: 'fork'}}},
    files: [{filename: 'src/upload.rs', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new'}],
    config: {repository_policy: '.github/clouseau.md', readme: 'README.md'},
    technical: {run_id: 42, head_sha: 'a'.repeat(40), conclusion: 'success'}};
}

test('source collection binds complete base/head blobs, authority, precedent, tickets and runtime identity', async () => {
  const f = fixture();
  const snapshot = await collectSnapshot(f);
  assert.equal(snapshot.repository, 'example/upload-gateway');
  assert.equal(snapshot.head_sha, f.pr.head.sha); assert.equal(snapshot.base_sha, f.pr.base.sha);
  assert.match(snapshot.digest, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.sources[`${f.pr.base.sha}:README.md`].authority, 'trusted');
  assert.equal(snapshot.sources[`${f.pr.head.sha}:src/upload.rs`].authority, 'untrusted');
  assert.equal(snapshot.files[0].base_source, `${f.pr.base.sha}:src/upload.rs`);
  assert.equal(snapshot.sources.verification.authority, 'trusted');
  assert.equal(JSON.parse(snapshot.sources.verification.content).run_id, 42);
  assert.equal(snapshot.history[0].commits[0].message, 'fix: preserve durable upload acceptance');
  assert.equal(snapshot.tickets[0].number, 1);
  assert.equal(snapshot.claims.description, f.pr.body);
  const digest = snapshot.digest;
  await additionalSources({...f, snapshot, paths: ['src/naming.rs']});
  assert.notEqual(snapshot.digest, digest);
  assert.equal(snapshot.sources[`${f.pr.head.sha}:src/naming.rs`].authority, 'untrusted');
  const count = f.calls.length;
  await additionalSources({...f, snapshot, paths: ['src/naming.rs']});
  assert.equal(f.calls.length, count, 'immutable evidence is not refetched');
  assert.ok(f.calls.every(call => [f.pr.head.sha, f.pr.base.sha].includes(call.ref)));
  assert.ok(f.calls.filter(call => call.ref === f.pr.head.sha).every(call => call.owner === 'external' && call.repo === 'fork'));
  assert.ok(f.calls.filter(call => call.ref === f.pr.base.sha).every(call => call.owner === 'example'));
});

test('renamed, added and removed files use only their applicable immutable sources', async () => {
  for (const status of ['renamed', 'added', 'removed']) {
    const f = fixture(); f.files[0].status = status;
    if (status === 'renamed') f.files[0].previous_filename = 'src/old.rs';
    const snapshot = await collectSnapshot(f);
    assert.equal(Boolean(snapshot.files[0].base_source), status !== 'added');
    assert.equal(Boolean(snapshot.files[0].head_source), status !== 'removed');
    assert.equal(snapshot.history.length, status === 'added' ? 0 : 1);
    if (status === 'renamed') assert.ok(snapshot.files[0].base_source.endsWith(':src/old.rs'));
  }
});

test('linked requirements survive source collection, proof selection and atomic grading without gaining authority', async () => {
  const f = fixture();
  const request = {number: 27, title: 'Support the active native coverage consumer',
    body: 'The existing consumer produces Istanbul JSON. Preserve its complete source inventory.',
    url: 'https://github.com/example/upload-gateway/issues/27', author: {login: 'maintainer'}};
  f.github.graphql = async () => ({repository: {pullRequest: {closingIssuesReferences: {
    nodes: [request], pageInfo: {hasNextPage: false}}}}});
  const snapshot = await collectSnapshot(f);
  const proof = proofCatalog(snapshot).find(item => snapshot.sources[item.source].kind === 'requirement');
  assert.ok(proof, 'a linked request must be citable, not stranded outside the proof catalog');
  const source = snapshot.sources[proof.source];
  assert.equal(source.authority, 'untrusted', 'issue authorship cannot grant contract or execution authority');
  assert.deepEqual(JSON.parse(source.content), request);
  const location = {subject: request.title, obligation: 'Preserve exact native coverage', context: {},
    target: {reason: 'The linked request describes the active consumer limitation.', evidence: [proof.id]}};
  const report = {evidence: [proof]};
  const packet = packetFor(location, report, snapshot);
  assert.equal(packet.evidence[0].text, source.content);
  assert.equal(packet.evidence[0].authority, 'untrusted');
  assert.match(packet.evidence[0].text, /Preserve its complete source inventory/);
  request.body = 'Updated requirement; do not reuse the prior assessment.';
  const updated = await collectSnapshot(f);
  const next = proofCatalog(updated).find(item => updated.sources[item.source].kind === 'requirement');
  assert.notEqual(updated.digest, snapshot.digest);
  assert.notEqual(next.source, proof.source, 'changed issue content gets a new immutable source identity');
  assert.notEqual(updated.sources[next.source].ref, source.ref);
});

test('bounded source reader refuses path traversal, binary data, truncation and invalid UTF-8', async () => {
  for (const value of [null, '', '/tmp/code', '../code', 'a/../code', 'a/./code', '.git/config', 'a//b', 'a\\b', 'a\0b', 'x'.repeat(500)]) assert.equal(safePath(value), false);
  assert.equal(safePath('src/module.rs'), true);
  const f = fixture();
  await assert.rejects(readSource({...f, snapshot: {sources: {}}, filename: '../private', ref: f.pr.head.sha}), /Unsafe/);
  await assert.rejects(readSource({...f, snapshot: {sources: {}, head_sha: f.pr.head.sha}, filename: 'src/upload.rs', ref: f.pr.head.sha}), /head repository/);
  for (const data of [{}, {content: '', encoding: 'utf8'}, {content: '', encoding: 'base64', size: 300001},
    {content: Buffer.from('x'.repeat(300001)).toString('base64'), encoding: 'base64'},
    {content: Buffer.from('a\0b').toString('base64'), encoding: 'base64'},
    {content: Buffer.from([0xff]).toString('base64'), encoding: 'base64'}]) {
    f.github.rest.repos.getContent = async () => ({data});
    await assert.rejects(readSource({...f, snapshot: {sources: {}}, filename: 'src/module.rs', ref: f.pr.head.sha}));
  }
});

test('incomplete evidence, unsafe prior paths, oversized packets and truncated linked requirements fail closed', async () => {
  for (const mutate of [
    f => {f.files = [];}, f => {f.pr.changed_files = 2;}, f => {f.files[0].filename = '../code';},
    f => {f.files[0].patch = '';}, f => {f.files[0].status = 'binary';}, f => {f.files[0].previous_filename = '../code';},
    f => {f.pr.head.repo = null;}, f => {f.pr.head.repo.owner = null;}, f => {delete f.pr.head.repo.owner.login;},
    f => {delete f.pr.head.repo.name;},
    f => {f.github.graphql = async () => ({repository: {pullRequest: {closingIssuesReferences: {nodes: [], pageInfo: {hasNextPage: true}}}}});},
  ]) {
    const f = fixture(); mutate(f); await assert.rejects(collectSnapshot(f));
  }
  assert.throws(() => refresh({sources: {large: {content: 'x'.repeat(900001)}}}), /source budget/);
  for (const paths of [null, [], ['same', 'same'], Array(9).fill('file')]) {
    await assert.rejects(additionalSources({...fixture(), snapshot: {sources: {}}, paths}), /one to eight/);
  }
});
