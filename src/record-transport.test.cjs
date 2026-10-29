'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomBytes, createHash} = require('node:crypto');
const {gzipSync, gunzipSync} = require('node:zlib');
const {digest} = require('./acceptance.cjs');
const transport = require('./record-transport.cjs');
const {RECORD} = require('./acceptance-controller.cjs');

function fixture() {
  const context = {repo: {owner: 'example', repo: 'radio'}, runId: 456};
  const record = {version: 2, snapshot: {repository: 'example/radio', head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40)},
    result: {decision: 'auto_approve', reviews: []}};
  const assessment = {version: 2, number: 3, head_sha: record.snapshot.head_sha, base_sha: record.snapshot.base_sha,
    decision: 'auto_approve', record_digest: digest(record)};
  return {assessment, record, repair: null, context, runAttempt: '2'};
}
const raw = value => gzipSync(Buffer.from(JSON.stringify(value))).toString('base64url');
const envelope = payload => JSON.parse(gunzipSync(Buffer.from(payload, 'base64url')));
function directory(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-record-test-'));
  try {return run(dir);} finally {fs.rmSync(dir, {recursive: true, force: true});}
}

test('bounded record transport preserves the entire record and optional repair data losslessly', () => {
  const f = fixture();
  f.record.result.literal = 'Full model text\n::error::this remains inert data 😀';
  f.assessment.record_digest = digest(f.record);
  const payload = transport.encode(f);
  assert.match(payload, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(transport.decode({...f, payload}), {record: f.record, repair: null});
  f.repair = {proposal: {files: [{path: 'src/radio.ts', content: 'repair\n'}]}};
  f.assessment.repair_digest = digest(f.repair);
  assert.deepEqual(transport.decode({...f, payload: transport.encode(f)}), {record: f.record, repair: f.repair});
});

test('a compact local record travels by its own digest and cannot carry or stand in for a complete record', () => {
  const f = fixture();
  const compact = {version: 2, local_receipt_reference: true, local_artifact: 'd'.repeat(40), local_author: 'contributor',
    previous: {findings: []}, technical: {commands: []}};
  Object.assign(f, {record: compact});
  f.assessment.record_reference_digest = digest(compact);
  const payload = transport.encode(f);
  assert.deepEqual(transport.decode({...f, payload}), {record: compact, repair: null});
  assert.ok(Buffer.byteLength(JSON.stringify(envelope(payload))) < 2000, 'only run facts, not the signed review, are transported');
  for (const record of [{...compact, local_receipt_reference: false}, {...compact, snapshot: f.record.snapshot}, {...compact, local_artifact: 'e'.repeat(40)}]) {
    assert.throws(() => transport.encode({...f, record}), /compact record digest differs/);
  }
  assert.throws(() => transport.encode({...f, repair: {proposal: 'unrequested'}}), /compact record digest differs/);
  assert.throws(() => transport.encode({...f, assessment: {...f.assessment, repair_digest: 'c'.repeat(64)}}), /compact record digest differs/);
  assert.throws(() => transport.decode({...f, assessment: {...f.assessment, record_reference_digest: 'c'.repeat(64)}, payload}), /foreign or stale/);
  assert.throws(() => transport.encode({...f, assessment: {...f.assessment, record_reference_digest: 'invalid'}}), /invalid assessment digest/);
});

test('every repository, run, attempt, revision and assessment digest is bound at receipt', () => {
  const f = fixture(); const payload = transport.encode(f);
  for (const mutate of [
    o => {o.context.repo.repo = 'foreign';}, o => {o.context.runId++;}, o => {o.runAttempt = '3';},
    o => {o.assessment.head_sha = 'c'.repeat(40);}, o => {o.assessment.base_sha = 'c'.repeat(40);},
    o => {o.assessment.record_digest = 'c'.repeat(64);}, o => {o.assessment.repair_digest = 'c'.repeat(64);},
  ]) {
    const changed = structuredClone(f); mutate(changed);
    assert.throws(() => transport.decode({...changed, payload}), /foreign or stale/);
  }
  for (const mutate of [
    o => {o.assessment.version = 1;}, o => {o.context.repo.owner = 'bad/owner';},
    o => {o.context.runId = '0';}, o => {o.runAttempt = '0';},
    o => {o.assessment.head_sha = 'invalid';}, o => {o.assessment.base_sha = 'invalid';},
    o => {o.assessment.record_digest = 'invalid';}, o => {o.assessment.repair_digest = 'invalid';},
  ]) {
    const changed = structuredClone(f); mutate(changed);
    assert.throws(() => transport.decode({...changed, payload}), /incomplete|invalid assessment digest/);
  }
});

test('unexpected envelope fields, format versions and altered source data never reach verification', () => {
  const f = fixture(); const original = envelope(transport.encode(f));
  for (const value of [null, [], {}, {...original, extra: true}, {...original, version: 2},
    {...original, binding: null}, {...original, binding: {...original.binding, extra: true}},
    {...original, record: null}, {...original, record: {}},
    {...original, record: {...f.record, result: {decision: 'auto_approve'}}},
    {...original, repair: {proposal: 'unrequested'}},
  ]) assert.throws(() => transport.decode({...f, payload: raw(value)}), /Invalid review record transport/);
  for (const name of ['repository', 'head_sha', 'base_sha']) {
    const changed = structuredClone(f); changed.record.snapshot[name] = 'foreign';
    changed.assessment.record_digest = digest(changed.record);
    assert.throws(() => transport.encode(changed), /record digest or revision/);
  }
  const changed = structuredClone(f); delete changed.record.snapshot;
  changed.assessment.record_digest = digest(changed.record);
  assert.throws(() => transport.encode(changed), /record digest or revision/);
});

test('repair data must exist exactly when the compact assessment binds its digest', () => {
  const f = fixture(); f.assessment.repair_digest = 'd'.repeat(64);
  assert.throws(() => transport.encode(f), /repair digest differs/);
  f.repair = {proposal: 'altered'};
  assert.throws(() => transport.encode(f), /repair digest differs/);
});

test('incomplete and pending assessments retain their run binding but carry no fabricated review record', () => {
  const f = fixture(); delete f.assessment.record_digest;
  f.assessment.decision = 'review_incomplete'; f.record = null;
  for (const decision of ['review_incomplete', 'pending_technical', 'blocked_technical']) {
    f.assessment.decision = decision;
    f.assessment.review_source = 'authenticated_local'; f.assessment.provider_api_calls = 0;
    const payload = transport.encode(f);
    assert.deepEqual(transport.decode({...f, payload}), {record: null, repair: null},
      'verified quality reuse with outstanding technical checks cannot transport an approval record');
  }
  assert.throws(() => transport.encode({...f, record: {}}), /unexpected review data/);
  assert.throws(() => transport.encode({...f, repair: {}}), /unexpected review data/);
  f.assessment.repair_digest = 'a'.repeat(64);
  assert.throws(() => transport.encode(f), /unexpected review data/);
});

test('encoding and decompression hard limits reject overflow without truncation or gzip bombs', () => {
  const f = fixture();
  f.record.result.large = 'x'.repeat(transport.MAX_EXPANDED_BYTES);
  f.assessment.record_digest = digest(f.record);
  assert.throws(() => transport.encode(f), /expanded limit exceeded/);
  f.record.result.large = randomBytes(310000).toString('base64');
  f.assessment.record_digest = digest(f.record);
  assert.throws(() => transport.encode(f), /compressed limit exceeded/);
  const bomb = gzipSync(Buffer.alloc(transport.MAX_EXPANDED_BYTES + 1)).toString('base64url');
  assert.throws(() => transport.decode({...fixture(), payload: bomb}), /expanded limit exceeded/);
  assert.equal(transport.MAX_COMPRESSED_BYTES * 4 / 3, transport.MAX_ENCODED_BYTES);
  for (const payload of [null, '', 'x'.repeat(transport.MAX_ENCODED_BYTES + 1), 'eA==', '\nAA', 'AB',
    Buffer.from('not gzip').toString('base64url'), gzipSync(Buffer.from('private-response-fragment')).toString('base64url'),
    gzipSync(Buffer.from([0xff])).toString('base64url')]) {
    assert.throws(() => transport.decode({...fixture(), payload}), error => {
      assert.doesNotMatch(error.message, /private-response-fragment/);
      return /Invalid review record transport/.test(error.message);
    });
  }
});

test('only the explicit transport is accepted; artifact mode performs no record I/O', () => {
  transport.validateTransport('artifact', ''); transport.validateTransport('job-output', 'data');
  for (const args of [['unknown', ''], [' artifact', ''], ['artifact', 'data'], ['job-output', null]]) {
    assert.throws(() => transport.validateTransport(...args), /Invalid review record transport/);
  }
  const core = {setOutput() {throw new Error('unexpected output');}, info() {throw new Error('unexpected log');}};
  transport.publish({mode: 'artifact', core});
  transport.receive({mode: 'artifact', payload: ''});
  transport.preserveDiagnostic({mode: 'artifact', core});
});

test('job-output chunks have exactly one canonical bounded representation', () => {
  assert.equal(transport.joinParts(['encoded', '', '', ''], true), 'encoded');
  const full = ['a'.repeat(100000), 'b'.repeat(100000), 'c'.repeat(100000), 'd'.repeat(100000)];
  assert.equal(transport.joinParts(full, true).length, 400000);
  for (const [parts, canonical] of [[full, false], [null, true], [[], true],
    [['encoded', '', '', 3], true], [['a'.repeat(100001), '', '', ''], true],
    [['a', 'b', '', ''], true]]) {
    assert.throws(() => transport.joinParts(parts, canonical), /invalid job-output chunks|noncanonical job-output chunks/);
  }
});

test('publish and receive transfer only bound JSON files; a missing record cannot reuse a stale disk file', () => directory(dir => {
  const f = fixture(); const recordPath = path.join(dir, 'source.json');
  fs.writeFileSync(recordPath, JSON.stringify(f.record));
  const outputs = {};
  const publish = () => transport.publish({...f, mode: 'job-output', recordPath,
    core: {setOutput: (name, value) => {outputs[name] = value;}}});
  publish();
  const received = path.join(dir, 'received/record.json');
  transport.receive({...f, mode: 'job-output', payload: transport.joinParts(JSON.parse(outputs['review-record']), true), recordPath: received});
  assert.deepEqual(JSON.parse(fs.readFileSync(received)), f.record);
  assert.equal(fs.existsSync(`${received}.repair.json`), false);
  f.repair = {proposal: {}}; f.assessment.repair_digest = digest(f.repair);
  fs.writeFileSync(`${recordPath}.repair.json`, JSON.stringify(f.repair)); publish();
  transport.receive({...f, mode: 'job-output', payload: transport.joinParts(JSON.parse(outputs['review-record']), true), recordPath: received});
  assert.deepEqual(JSON.parse(fs.readFileSync(`${received}.repair.json`)), f.repair);
  fs.writeFileSync(recordPath, Buffer.alloc(transport.MAX_EXPANDED_BYTES + 1));
  assert.throws(publish, /source file exceeds/);
  delete f.assessment.record_digest; delete f.assessment.repair_digest;
  publish();
  transport.receive({...f, mode: 'job-output', payload: transport.joinParts(JSON.parse(outputs['review-record']), true), recordPath: received});
  assert.deepEqual(JSON.parse(fs.readFileSync(received)), f.record, 'no fabricated empty record overwrites prior evidence');
}));

test('bounded diagnostic logs reconstruct the exact original bytes and hash without raw model text', () => directory(dir => {
  const recordPath = path.join(dir, 'record.json'); const lines = [];
  const core = {info: line => lines.push(line)};
  transport.preserveDiagnostic({mode: 'job-output', core, recordPath});
  assert.deepEqual(lines, []);
  const bytes = Buffer.from(JSON.stringify({failure: 'negative review must survive', observations: randomBytes(12000).toString('hex')}, null, 2) + '\n');
  fs.writeFileSync(`${recordPath}.diagnostic.json`, bytes);
  transport.preserveDiagnostic({mode: 'job-output', core, recordPath});
  const encoded = lines.slice(1, -1).map((line, index) => {
    assert.match(line, new RegExp(`^CLOUSEAU_DIAGNOSTIC_GZIP_BASE64URL ${index + 1} [A-Za-z0-9_-]{1,4096}$`));
    return line.split(' ')[2];
  }).join('');
  assert.deepEqual(gunzipSync(Buffer.from(encoded, 'base64url')), bytes);
  assert.ok(lines[0].includes(createHash('sha256').update(bytes).digest('hex')));
  assert.equal(lines.at(-1), 'CLOUSEAU_DIAGNOSTIC_GZIP_BASE64URL_END');
  assert.ok(lines.every(line => !line.includes('negative review must survive')));
  fs.rmSync(`${recordPath}.diagnostic.json`); fs.mkdirSync(`${recordPath}.diagnostic.json`);
  assert.throws(() => transport.preserveDiagnostic({mode: 'job-output', core, recordPath}), /EISDIR/);
}));

test('oversized diagnostics remain exact and private on the worker, with an explicit non-artifact failure', () => directory(dir => {
  for (const bytes of [Buffer.alloc(transport.MAX_EXPANDED_BYTES + 1, 65), randomBytes(310000)]) {
    const recordPath = path.join(dir, 'record.json'); const lines = [];
    fs.writeFileSync(`${recordPath}.diagnostic.json`, bytes);
    const options = {...fixture(), mode: 'job-output', core: {info: line => lines.push(line)}, recordPath};
    assert.throws(() => transport.preserveDiagnostic({...options, runAttempt: 'invalid'}), /diagnostic run identity/);
    const previousTmpdir = process.env.TMPDIR;
    try {
      process.env.TMPDIR = process.cwd();
      assert.throws(() => transport.preserveDiagnostic(options), /outside checkout/);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
    assert.throws(() => transport.preserveDiagnostic(options), /Worker-local private evidence; not a GitHub artifact/);
    const retained = lines[0].match(/at (.*?) sha256=/)[1];
    try {
      assert.deepEqual(fs.readFileSync(retained), bytes);
      assert.deepEqual(fs.readFileSync(`${recordPath}.diagnostic.json`), bytes);
      assert.equal(fs.statSync(retained).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(retained)).mode & 0o777, 0o700);
      assert.ok(path.basename(path.dirname(retained)).startsWith('clouseau-review-456-2-'));
      assert.ok(lines[0].includes(createHash('sha256').update(bytes).digest('hex')));
    } finally {fs.rmSync(path.dirname(retained), {recursive: true});}
  }
}));

test('a checkout directly beneath the system temporary directory still retains oversized evidence outside it', () => directory(dir => {
  const cwd = process.cwd(); const recordPath = path.join(dir, 'record.json'); const lines = [];
  fs.writeFileSync(`${recordPath}.diagnostic.json`, Buffer.alloc(transport.MAX_EXPANDED_BYTES + 1));
  try {
    process.chdir(dir);
    assert.throws(() => transport.preserveDiagnostic({...fixture(), recordPath, mode: 'job-output',
      core: {info: line => lines.push(line)}}), /Oversized diagnostic retained/);
    const retained = lines[0].match(/at (.*?) sha256=/)[1];
    assert.notEqual(path.dirname(retained), dir);
    fs.rmSync(path.dirname(retained), {recursive: true});
  } finally {process.chdir(cwd);}
}));

test('the default packaged record path remains usable without changing existing artifacts', () => directory(dir => {
  const cwd = process.cwd();
  try {
    process.chdir(dir); fs.mkdirSync(path.dirname(RECORD), {recursive: true});
    const f = fixture(); fs.writeFileSync(RECORD, JSON.stringify(f.record));
    const outputs = {};
    const core = {setOutput: (name, value) => {outputs[name] = value;}, info() {}};
    transport.publish({...f, mode: 'job-output', core});
    fs.rmSync(RECORD);
    transport.receive({...f, mode: 'job-output', payload: transport.joinParts(JSON.parse(outputs['review-record']), true)});
    assert.deepEqual(JSON.parse(fs.readFileSync(RECORD)), f.record);
    transport.preserveDiagnostic({mode: 'job-output', core});
  } finally {process.chdir(cwd);}
}));
