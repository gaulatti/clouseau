'use strict';
// Receipt verification under the protected local_review.binding setting. Kept apart from local-receipt.test.cjs so a change here does not resend that file as review evidence.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('../test/local-review-fixture.cjs');
const {issueReceipt, verifyReceipt, validateTrust, reviewDecision, marker, loadReceipt, verifySources,
  screenReceipt, screenSources, attestable} = require('./local-receipt.cjs');
const {ChunkedRecordError} = require('./chunked-record.cjs');
const {digest} = require('./acceptance.cjs');
const {hostedFiles} = require('../test/hosted-files.cjs');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('binding "diff": the live lockfile summary must equal the signed one whatever revision it names, and a substituted summary is still rejected', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const {repository} = require('../test/local-git-fixture.cjs');
  const {git, collectLocal} = require('./local-git.cjs');
  const lockfixture = require('../test/fixtures/lockfiles.cjs');
  await repository(async f => {
    fs.writeFileSync(path.join(f.directory, 'package-lock.json'), lockfixture.npmHead());
    fs.rmSync(path.join(f.directory, 'go.sum'));
    fs.writeFileSync(path.join(f.directory, 'Pipfile.lock'), '{"_meta":{},"default":{"tool":{"version":"==1.0.0","hashes":["sha256:a"]}}}\n');
    git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'chore: dependencies']);
    const {snapshot} = collectLocal({...f, request: 'Update dependencies.', technical: {}});
    const live = {};
    const serve = async args => {
      const key = `${args.ref}:${args.path}`;
      if (live[key] !== undefined) return live[key];
      let text;
      try { text = git(f.directory, ['show', key]); } catch { throw Object.assign(new Error('Not Found'), {status: 404}); }
      return {data: {encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text)}};
    };
    const github = {rest: {repos: {getContent: serve}}};
    const repo = {owner: 'example', repo: 'local-fixture'};
    const pr = {changed_files: snapshot.files.length, base: {sha: snapshot.base_sha},
      head: {sha: snapshot.head_sha, repo: {owner: {login: 'example'}, name: 'local-fixture'}}};
    const files = require('../test/hosted-files.cjs').hostedFiles(snapshot).map(file => /(?:package-lock\.json|Pipfile\.lock|go\.sum)$/.test(file.filename) ? {...file, patch: undefined} : file);
    const options = {github, repo, pr, files, snapshot, config: {readme: 'README.md', repository_policy: 'AGENTS.md'}};
    await verifySources(options);
    // Under binding "diff" the summary of the live change must equal the signed one, whatever revision it names: an
    // update that leaves the lockfiles unchanged keeps it, and the same recomputation still rejects a substituted summary.
    git(f.directory, ['commit', '-q', '--allow-empty', '-m', 'chore: an update that changes no file']);
    const moved = {...pr, head: {...pr.head, sha: git(f.directory, ['rev-parse', 'HEAD']).trim()}};
    const diffBound = {...options, pr: moved, config: {...options.config, local_review: {binding: 'diff'}}};
    await verifySources(diffBound);
    await assert.rejects(verifySources({...options, pr: moved}), /execution receipt/);
    const [id, source] = Object.entries(snapshot.sources).find(([, item]) => item.kind === 'lockfile-summary' && item.path === 'package-lock.json');
    const removedId = Object.entries(snapshot.sources).find(([, item]) => item.kind === 'lockfile-summary' && item.path === 'go.sum')[0];
    assert.ok(removedId);
    const mutate = change => { const copy = structuredClone(snapshot); change(copy, copy.sources[id]); return copy; };
    // A fabricated summary that hides a dependency swap is not the summary of the repository bytes.
    await assert.rejects(verifySources({...diffBound, snapshot: mutate((copy, item) => { item.content = item.content.replaceAll('RISK[', 'info['); })}), /differs from the repository lockfiles/);
  }, directory => {
    fs.writeFileSync(path.join(directory, 'package-lock.json'), lockfixture.npmBase());
    fs.writeFileSync(path.join(directory, 'go.sum'), 'example.com/mod v1.0.0 h1:abc=\n');
  });
});

test('binding "diff": the signed revisions stand in for the live ones, full-file sources are not compared, and the diff decides', async () => {
  const f = await fixture();
  assert.doesNotThrow(() => validateTrust({...f.trust, binding: 'diff'}));
  for (const binding of ['tree', '', null, true]) assert.throws(() => validateTrust({...f.trust, binding}), /binding must be "diff"/);
  const trust = {...f.trust, binding: 'diff'};
  const bundle = issueReceipt(f.issue);
  const moved = {...f.expected, trust, headSha: 'd'.repeat(40), baseSha: 'e'.repeat(40)};
  assert.equal(verifyReceipt(bundle, moved).decision, 'auto_approve');
  // Without the binding the same move is today's refusal.
  assert.throws(() => verifyReceipt(bundle, {...moved, trust: f.trust}), error => error.reason === 'revision_head');
  // The signed revisions must still be commit ids, and every other binding still holds.
  const forged = structuredClone(bundle.payload); forged.record.snapshot.head_sha = 'not-a-sha';
  assert.throws(() => verifyReceipt({...bundle, payload: forged}, moved), /signature|changed/);
  for (const [name, value] of Object.entries({repository: 'example/other', configDigest: '0'.repeat(64), policyDigest: '0'.repeat(64), author: 'someone-else'})) {
    assert.throws(() => verifyReceipt(bundle, {...moved, [name]: value}), /changed|PR author/, name);
  }
  const files = hostedFiles(f.snapshot);
  const reads = [];
  const github = {rest: {repos: {getContent: async args => {reads.push(args); return f.github.rest.repos.getContent(args);}}}};
  const pr = {changed_files: 1, base: {sha: 'e'.repeat(40)}, head: {sha: 'd'.repeat(40), repo: {owner: {login: f.repo.owner}, name: f.repo.repo}}};
  const options = {github, repo: f.repo, pr, files, snapshot: f.snapshot, config: {readme: 'README.md', repository_policy: '.github/clouseau.md', local_review: {binding: 'diff'}}};
  await verifySources(options);
  assert.deepEqual(reads, [], 'no signed full-file source is fetched from the live revisions');
  // Today the same live revisions refuse the signed sources.
  await assert.rejects(verifySources({...options, config: {...options.config, local_review: {}}}), /outside exact repository revisions|evidence omitted/);
  // The diff still decides, and the evidence must still be bound to the signed revisions.
  await assert.rejects(verifySources({...options, files: [{...files[0], patch: `${files[0].patch}\n+extra`}]}), error => error.code === 'RECEIPT_PATCH_MISMATCH');
  const verification = structuredClone(f.snapshot); verification.sources.verification.ref = 'd'.repeat(40);
  await assert.rejects(verifySources({...options, snapshot: verification}), /execution receipt/);
  const foreign = structuredClone(f.snapshot); const key = Object.keys(foreign.sources).find(id => id.endsWith(':src/upload.test.js')); foreign.sources[key].ref = 'd'.repeat(40);
  await assert.rejects(verifySources({...options, snapshot: foreign}), /outside exact repository revisions/);
  const substituted = structuredClone(f.snapshot); substituted.files[0].head_source = substituted.files[0].base_source;
  await assert.rejects(verifySources({...options, snapshot: substituted}), /substituted/);
  // An installation receipt is never diff-bound.
  await assert.rejects(verifySources({...options, installation: {comment_id: 1}}), /./);
});
