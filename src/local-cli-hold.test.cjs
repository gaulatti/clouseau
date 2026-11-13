'use strict';
// `clouseau review` applies the receipt hold CI applies to a signed local receipt (receipt-hold.cjs) before it signs one:
// gaulatti/clouseau#236 was signed as a chunked review whose units recorded each other's files as missing, and CI refused
// it as receipt_completeness. Every test here runs the real review command against a real Git checkout.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {git, gitContents} = require('./local-git.cjs');
const {digest, approvalHold, FACTORS} = require('./acceptance.cjs');
const {repository} = require('../test/local-git-fixture.cjs');
const {initializeIdentity, runReview, recordedMissing, heldNotice} = require('./local-cli.cjs');
const {issueReceipt, verifyReceipt} = require('./local-receipt.cjs');
const {supplyTests} = require('./acceptance-sources.cjs');
const controller = require('./acceptance-controller.cjs');
const {holdRule, openSeams, HOLD_RULES} = require('./receipt-hold.cjs');

const REVIEWER = 'e'.repeat(40);
const installed = () => ({sha: REVIEWER, digest: 'e'.repeat(64), clean: true});

// One harness for single-snapshot and chunked reviews. `gates` edits the gates of every report; `missing(paths)` names the
// dependencies a report records as missing, given the paths it owns; `seam` is the state every integration answer gives.
function harness({gates = () => {}, missing = () => [], seam = 'checked', finding = false} = {}) {
  let calls = 0;
  return async task => {
    const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
    let value;
    if (task.phase === 'investigation') {
      const report = packet.template;
      report.gates.forEach(gate => {gate.state = 'satisfied';});
      const absent = missing(report.accounting.map(item => item.path));
      report.coverage.dependencies = absent.map(file => ({path: file, state: 'missing', reason: 'Owned by another unit; not supplied here.'}));
      if (absent.length) report.gates.find(gate => gate.name === 'review_completeness').state = 'unresolved';
      gates(report.gates);
      // A blocking defect with every gate satisfied: the review is repair_required, which human_review "signed" signs.
      if (finding && task.role === 'examiner') {
        const [anchor] = report.accounting[0].evidence;
        report.findings.push({id: 'fictional-defect', title: 'Fictional defect', anchor,
          cause: 'The changed path no longer preserves the accepted contract.', trigger: 'A fictional input.', consequence: 'A fictional regression.',
          obligation: 'Restore the accepted contract.', evidence: [anchor],
          factors: Object.fromEntries(FACTORS.defect.map(factor => [factor, {evidence: [anchor], reason: 'Established by the cited source.'}])),
          blast_radius: 1, opportunity: {mechanical: false, beneficial: false, within_scope: false, verified: false},
          repair_paths: [report.accounting[0].path]});
      }
      value = {kind: 'report', report, request_sources: []};
    } else if (task.phase === 'integration') {
      value = {dispositions: packet.seams.map(item => ({seam: item.id, state: seam, reason: 'Recorded by the fixture harness.'}))};
    } else value = {answers: Object.fromEntries(Object.keys(task.schema.properties.answers.properties)
      .map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))};
    return {value, provenance: {harness: 'codex', role: task.role, phase: task.phase, session: `fictional-hold-session-${++calls}`,
      request_digest: digest(task.prompt), response_digest: digest(value), transport_digest: digest({fixture_only: value})}};
  };
}

// A signing setup: an enrolled identity and the protected configuration, optionally chunked. `prepare(directory)` runs on the
// base before it is committed; `change(directory)` adds to the change after the fixture's own head commit.
async function signing({chunked, humanReview = false, prepare = () => {}, change} = {}, run) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-hold-state-'));
  try {
    const identity = initializeIdentity(state, 'fixture-author');
    const config = {...require('../test/fixtures/config.json'), version: 2, repository_policy: 'AGENTS.md', readme: 'README.md',
      acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash', repair_attempts: 2},
      local_review: {mode: 'required', reviewer_digest: 'e'.repeat(64), max_age_seconds: 3600, keys: [identity.public_identity], ...(chunked ? {chunked} : {}), ...(humanReview ? {binding: 'diff', human_review: 'signed'} : {})}};
    await repository(async f => {
      if (change) {change(f.directory); git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'feat: add a caller']);}
      const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
      const review = ask => runReview({directory: f.directory, base: f.base, 'request-file': request, identity: identity.identity_file},
        {state, ask, attest: technical => technical, verify: () => ({}), installed});
      await run({f, state, identity, config, review});
    }, directory => {
      fs.mkdirSync(path.join(directory, '.github'));
      fs.writeFileSync(path.join(directory, '.github/clouseau.json'), JSON.stringify(config));
      prepare(directory);
    });
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}

const receipts = state => fs.existsSync(path.join(state, 'reviews')) ?
  fs.readdirSync(path.join(state, 'reviews')).filter(id => fs.existsSync(path.join(state, 'reviews', id, 'receipt.json'))) : [];
const quietly = async run => {
  const written = []; const write = process.stderr.write;
  process.stderr.write = chunk => {written.push(String(chunk)); return true;};
  try {return {value: await run(), stderr: written.join('')};} finally {process.stderr.write = write;}
};
const untested = directory => fs.rmSync(path.join(directory, 'test/handler.test.js'));

// A chunked change whose files cannot share a unit (each costs more than half the unit ceiling): a caller of the handler.
const filler = (name, size) => Array.from({length: Math.ceil(size / 40)}, (_, i) => `const ${name}${i} = ${i}; // fictional filler\n`).join('').slice(0, size);
const CHUNKED = {force: true, params: {C: 20000, S: 10000}};
const bigHandler = directory => fs.writeFileSync(path.join(directory, 'src/handler.js'),
  `${filler('h', 12000)}\nmodule.exports = input => { if (!input) throw Error("Missing input"); return true; };\n`);
const caller = directory => {
  fs.writeFileSync(path.join(directory, 'src/caller.js'), `const handler = require('./handler.js');\n${filler('c', 12000)}\nmodule.exports = value => handler(value);\n`);
  bigHandler(directory);
};
const coverCaller = directory => fs.writeFileSync(path.join(directory, 'test/handler.test.js'),
  "require('../src/handler.js');\nrequire('../src/new.js');\nrequire('../src/caller.js');\n");

test('a chunked review whose units record another changed file as missing is never signed and names the units and files (#236)', () =>
  signing({chunked: CHUNKED, prepare: coverCaller, change: caller}, async ({state, review}) => {
    const changed = ['src/caller.js', 'src/handler.js', 'src/new.js'];
    const ask = harness({missing: owned => changed.filter(file => !owned.includes(file)).slice(0, 1)});
    const {value: result, stderr} = await quietly(() => review(ask));
    const record = JSON.parse(fs.readFileSync(result.record));
    assert.ok(record.partition.units.length > 1, 'the change is reviewed in units');
    assert.equal(record.result.decision, 'auto_approve', 'the scored review alone would have been signed');
    assert.equal(result.decision, 'review_incomplete'); assert.equal(result.receipt, null); assert.deepEqual(receipts(state), []);
    assert.equal(result.receipt_hold.rule, 'completeness');
    assert.equal(result.receipt_hold.reason, 'review completeness is unresolved');
    const units = new Set(record.partition.units.map(unit => unit.id));
    assert.ok(result.receipt_hold.missing.length > 0);
    for (const row of result.receipt_hold.missing) {
      assert.ok(units.has(row.unit), `a recorded unit: ${row.unit}`); assert.ok(changed.includes(row.path), row.path);
      const owner = record.partition.units.find(unit => unit.id === row.unit);
      assert.ok(!owner.owned.includes(row.path), 'the file another unit owns');
      assert.match(stderr, new RegExp(`${row.path.replace('.', '\\.')} \\(unit ${row.unit}, ${row.role}\\)`));
    }
    assert.match(stderr, /Local review held \(completeness\): CI would refuse this receipt.*No receipt issued; decision review_incomplete\./);
    // The history records the held outcome, so the same revision is not reassessed without a repair.
    await assert.rejects(review(harness()), /already has a non-passing local review/);
  }));

test('a single-snapshot review whose report records a dependency as missing is held as completeness and names it', () =>
  signing({}, async ({state, review}) => {
    const {value: result} = await quietly(() => review(harness({missing: () => ['src/elsewhere.js']})));
    assert.equal(result.decision, 'review_incomplete'); assert.equal(result.receipt, null); assert.deepEqual(receipts(state), []);
    assert.deepEqual(result.receipt_hold, {rule: 'completeness', reason: 'review completeness is unresolved',
      missing: [{role: 'examiner', path: 'src/elsewhere.js'}, {role: 'challenger', path: 'src/elsewhere.js'}]});
  }));

test('a changed production file that no supplied or discovered test imports is never signed, and its path is named', () =>
  signing({prepare: untested}, async ({state, review}) => {
    const {value: result, stderr} = await quietly(() => review(harness()));
    assert.equal(JSON.parse(fs.readFileSync(result.record)).result.decision, 'auto_approve');
    assert.equal(result.decision, 'review_incomplete'); assert.equal(result.receipt, null); assert.deepEqual(receipts(state), []);
    assert.deepEqual(result.receipt_hold, {rule: 'untested', reason: 'no supplied test imports changed production code: src/handler.js, src/new.js',
      files: ['src/handler.js', 'src/new.js']});
    assert.match(stderr, /Local review held \(untested\): CI would refuse this receipt because no supplied or discovered test imports src\/handler\.js, src\/new\.js\./);
  }));

test('under human_review "signed" a review that requires a human is held like a pass: untested, it is never signed', async () => {
  await signing({humanReview: true, prepare: untested}, async ({state, review}) => {
    const {value: result} = await quietly(() => review(harness({finding: true})));
    assert.equal(JSON.parse(fs.readFileSync(result.record)).result.decision, 'repair_required');
    assert.equal(result.decision, 'review_incomplete'); assert.equal(result.receipt, null); assert.deepEqual(receipts(state), []);
    assert.equal(result.receipt_hold.rule, 'untested'); assert.deepEqual(result.receipt_hold.files, ['src/handler.js', 'src/new.js']);
  });
  // The same review with the base's test in place is signed as a review that requires a human.
  await signing({humanReview: true}, async ({state, review}) => {
    const result = await review(harness({finding: true}));
    assert.equal(result.decision, 'repair_required'); assert.ok(result.receipt); assert.equal(receipts(state).length, 1);
    assert.equal(result.receipt_hold, undefined);
  });
});

test('an unresolved test integrity gate on changed production code is never signed', () =>
  signing({}, async ({state, review}) => {
    const ask = harness({gates: gates => {gates.find(gate => gate.name === 'test_integrity').state = 'unresolved';}});
    const {value: result, stderr} = await quietly(() => review(ask));
    assert.equal(result.decision, 'review_incomplete'); assert.equal(result.receipt, null); assert.deepEqual(receipts(state), []);
    assert.deepEqual(result.receipt_hold, {rule: 'integrity', reason: 'test integrity is unresolved'});
    assert.match(stderr, /Local review held \(integrity\)/);
  }));

test('a chunked review whose integration pass left a seam open is never signed, and the seam and its units are named', () =>
  signing({chunked: CHUNKED, prepare: coverCaller, change: caller}, async ({state, review}) => {
    const {value: result, stderr} = await quietly(() => review(harness({seam: 'missing'})));
    const record = JSON.parse(fs.readFileSync(result.record));
    assert.ok(record.seams.length > 0, 'the caller and the handler are joined by a seam');
    assert.equal(record.result.decision, 'auto_approve');
    assert.equal(result.decision, 'review_incomplete'); assert.equal(result.receipt, null); assert.deepEqual(receipts(state), []);
    assert.equal(result.receipt_hold.rule, 'open_seams');
    const expected = record.seams.flatMap(seam => ['examiner', 'challenger'].map(role => ({role, seam: seam.id, units: [seam.a.unit, seam.b.unit]})));
    assert.deepEqual(result.receipt_hold.seams.map(({role, seam, units}) => ({role, seam, units})).sort((x, y) => x.role.localeCompare(y.role)),
      expected.sort((x, y) => x.role.localeCompare(y.role)));
    assert.ok(result.receipt_hold.seams.every(row => row.state === 'missing' && row.units[0] !== row.units[1]));
    assert.match(stderr, new RegExp(`integration left seams open: ${record.seams[0].id} missing between units ${record.seams[0].a.unit} and ${record.seams[0].b.unit}`));
  }));

test('the same chunked change with every seam checked is signed: the open-seams rule holds only open seams', () =>
  signing({chunked: CHUNKED, prepare: coverCaller, change: caller}, async ({review}) => {
    const result = await review(harness());
    assert.equal(result.decision, 'auto_approve'); assert.ok(result.receipt); assert.equal(result.receipt_hold, undefined);
  }));

test('an existing test at the base that imports the changed files is found by the git-backed discovery, so nothing holds', () =>
  signing({}, async ({f, review}) => {
    const result = await review(harness());
    const record = JSON.parse(fs.readFileSync(result.record));
    assert.ok(!Object.values(record.snapshot.sources).some(source => source.path === 'test/handler.test.js'), 'the test is not in the reviewed snapshot');
    assert.equal(approvalHold(record.result.reviews[0].report, record.snapshot), 'no supplied test imports changed production code: src/handler.js, src/new.js',
      'the snapshot alone would hold');
    assert.equal(result.decision, 'auto_approve'); assert.ok(result.receipt); assert.equal(result.receipt_hold, undefined);
    // What CI's discovery would derive through the GitHub API, the checkout derives through Git: the test is the importer.
    const held = await controller.receiptHold({github: gitContents(f.directory), repo: record.snapshot.head_repository, snapshot: record.snapshot, reviews: record.result.reviews});
    assert.equal(held.hold, undefined);
    assert.deepEqual(held.discovery.test_imports, [{path: 'test/handler.test.js', specifiers: ['../src/handler.js', '../src/new.js']}]);
  }));

test('a review CI would accept signs exactly as before: the same record, the same receipt bytes and the same output', async t => {
  const now = 1790000000000; const nonce = Buffer.alloc(32, 7);
  t.mock.method(Date, 'now', () => now);
  t.mock.method(crypto, 'randomBytes', size => Buffer.alloc(size, 7));
  await signing({}, async ({state, identity, config, review}) => {
    const {value: result, stderr} = await quietly(() => review(harness()));
    assert.equal(stderr.includes('Local review held'), false);
    assert.deepEqual(Object.keys(result), ['decision', 'record', 'receipt', 'head_sha', 'base_sha', 'reviewer_sha', 'provider_api_calls',
      'harness_invocations', 'reused_calls', 'decision_scope', 'independent_ci_required', 'merge_authority', 'local_verification'], 'no new output field');
    assert.equal(result.decision, 'auto_approve');
    const text = fs.readFileSync(result.record, 'utf8'); const record = JSON.parse(text);
    assert.equal(text, JSON.stringify(record) + '\n');
    assert.equal(Object.hasOwn(record, 'discovery'), false, 'the discovery never enters the signed record');
    assert.equal(Object.hasOwn(record.snapshot, 'test_imports'), false, 'nor the signed snapshot');
    // The receipt is byte for byte what issueReceipt makes of the record as written, with the same clock and nonce.
    const expected = issueReceipt({record, privateKey: JSON.parse(fs.readFileSync(identity.identity_file, 'utf8')).private_key,
      keyId: identity.public_identity.id, issuer: identity.public_identity.issuer, reviewerSha: REVIEWER, reviewerDigest: 'e'.repeat(64),
      reviewerSemantics: require('./review-semantics.cjs').semanticsDigest(), lifetime: config.local_review.max_age_seconds, attestation: undefined,
      chunked: null, now, nonce: nonce.toString('hex')});
    assert.equal(fs.readFileSync(result.receipt, 'utf8'), JSON.stringify(expected) + '\n');
    assert.equal(verifyReceipt(expected, {trust: config.local_review, repository: record.snapshot.repository, author: 'fixture-author',
      headSha: record.snapshot.head_sha, baseSha: record.snapshot.base_sha, reviewerSha: REVIEWER, reviewerDigest: 'e'.repeat(64),
      configDigest: record.snapshot.config_digest, policyDigest: record.snapshot.policy_digest, now}).decision, 'auto_approve');
    const history = JSON.parse(fs.readFileSync(path.join(state, 'ledgers', fs.readdirSync(path.join(state, 'ledgers'))[0]), 'utf8'));
    assert.equal(history.decision, 'auto_approve'); assert.equal(history.has_receipt, true);
  });
});

test('the git-backed client answers the GitHub shapes supplyTests reads: blob tree with sizes, base64 content, 404 and directories', () =>
  repository(async f => {
    const github = gitContents(f.directory);
    const head = git(f.directory, ['rev-parse', 'HEAD']).trim();
    const {data: tree} = await github.rest.git.getTree({owner: 'ignored', repo: 'ignored', tree_sha: f.base, recursive: 'true'});
    const listed = git(f.directory, ['ls-tree', '-r', '-l', f.base]).trim().split('\n').map(line => {
      const [meta, name] = line.split('\t'); const [, type, , size] = meta.split(/ +/); return {path: name, type, size: Number(size)};
    });
    assert.equal(tree.truncated, false);
    assert.deepEqual(tree.tree, listed.filter(entry => entry.type === 'blob'));
    assert.ok(tree.tree.some(entry => entry.path === 'test/handler.test.js' && entry.size === fs.statSync(path.join(f.directory, 'test/handler.test.js')).size));
    assert.ok(!tree.tree.some(entry => entry.path === 'src/new.js'), 'the tree is the base, not the head');
    assert.ok(tree.tree.every(entry => Object.keys(entry).join(',') === 'path,type,size'));
    const {data} = await github.rest.repos.getContent({owner: 'ignored', repo: 'ignored', path: 'src/handler.js', ref: head});
    assert.equal(data.encoding, 'base64');
    assert.equal(Buffer.from(data.content, 'base64').toString('utf8'), fs.readFileSync(path.join(f.directory, 'src/handler.js'), 'utf8'));
    assert.equal(data.size, fs.statSync(path.join(f.directory, 'src/handler.js')).size);
    await assert.rejects(github.rest.repos.getContent({path: 'src/absent.js', ref: head}), error => error.status === 404);
    await assert.rejects(github.rest.repos.getContent({path: 'src/new.js', ref: f.base}), error => error.status === 404, 'absent at that ref');
    await assert.rejects(github.rest.repos.getContent({path: 'src/handler.js', ref: 'f'.repeat(40)}), error => error.status === 404, 'unknown ref');
    await assert.rejects(github.rest.git.getTree({tree_sha: 'f'.repeat(40), recursive: 'true'}), error => error.status === 404);
    // Any other git failure is not GitHub's 404: a directory that is no repository fails with git's own error.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-not-a-repository-'));
    try {
      await assert.rejects(gitContents(outside).rest.git.getTree({tree_sha: 'HEAD', recursive: 'true'}),
        error => error.status !== 404 && /not a git repository/i.test(String(error.stderr)));
    } finally {fs.rmSync(outside, {recursive: true, force: true});}
    assert.deepEqual((await github.rest.repos.getContent({path: 'src', ref: head})).data, [], 'a directory is a listing, as GitHub answers');
    // Above GitHub's 1 MB contents limit the API returns no content; the evidence reader then omits the file by its size.
    fs.writeFileSync(path.join(f.directory, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    git(f.directory, ['add', '.']); git(f.directory, ['commit', '-qm', 'test: add a large file']);
    const large = await github.rest.repos.getContent({path: 'large.txt', ref: 'HEAD'});
    assert.deepEqual(large.data, {encoding: 'none', content: '', size: 1024 * 1024 + 1});
    // A submodule is a `commit` entry, never a blob: GitHub's blobs only, as the discovery reads them.
    git(f.directory, ['update-index', '--add', '--cacheinfo', `160000,${f.base},vendor/module`]);
    git(f.directory, ['commit', '-qm', 'test: add a submodule entry']);
    assert.match(git(f.directory, ['ls-tree', '-r', 'HEAD', '--', 'vendor']), /^160000 commit /);
    const withModule = (await github.rest.git.getTree({tree_sha: git(f.directory, ['rev-parse', 'HEAD']).trim(), recursive: 'true'})).data.tree;
    assert.ok(withModule.some(entry => entry.path === 'large.txt' && entry.size === 1024 * 1024 + 1));
    assert.ok(!withModule.some(entry => entry.path.startsWith('vendor')));
    // Through the shared discovery: the base test is read as the importer of both changed files.
    const snapshot = {base_sha: f.base, head_sha: head, head_repository: {owner: 'example', repo: 'local-fixture'}, paths: ['src/handler.js', 'src/new.js'],
      sources: {}, files: [{path: 'src/handler.js', status: 'modified'}, {path: 'src/new.js', status: 'added'}]};
    await supplyTests({github, repo: {owner: 'example', repo: 'local-fixture'}, snapshot,
      files: snapshot.files.map(file => ({filename: file.path, status: file.status})), baseSha: f.base, headSha: head});
    assert.deepEqual(snapshot.covering_tests, {'src/handler.js': ['test/handler.test.js'], 'src/new.js': ['test/handler.test.js']});
  }));

// CI's receipt hold reads the same rules it read before they were shared with `clouseau review`.
test('CI receipt hold: the shared rule names and open-seams predicate give exactly what the inline code gave', () => {
  const inlineRule = hold => {
    const [rule] = hold.split(': ');
    return {rule: {'test integrity is unresolved': 'integrity', 'review completeness is unresolved': 'completeness',
      'no supplied test imports changed production code': 'untested'}[rule], file: hold.slice(rule.length + 2)};
  };
  for (const hold of ['test integrity is unresolved', 'review completeness is unresolved', 'no supplied test imports changed production code: src/a.js',
    'no supplied test imports changed production code: src/a.js, src/b.ts', 'an unknown hold']) {
    assert.deepEqual(holdRule(hold), inlineRule(hold), hold);
  }
  assert.deepEqual(Object.values(HOLD_RULES), ['integrity', 'completeness', 'untested']);
  const inlineOpen = review => review.integration.some(entry => entry.dispositions.some(row => row.state !== 'checked'));
  const row = (seam, state) => ({seam, state, reason: 'r'});
  for (const integration of [[], [{seams: ['s1'], dispositions: [row('s1', 'checked')]}],
    [{seams: ['s1', 's2'], dispositions: [row('s1', 'checked'), row('s2', 'finding')]}],
    [{seams: ['s1'], dispositions: [row('s1', 'checked')]}, {seams: ['s3'], unreviewed: true, dispositions: [row('s3', 'missing')]}]]) {
    assert.equal(openSeams({integration}).length > 0, inlineOpen({integration}), JSON.stringify(integration));
  }
  assert.deepEqual(openSeams({integration: [{seams: ['s1', 's2'], dispositions: [row('s1', 'missing'), row('s2', 'checked')]}]}), [row('s1', 'missing')]);
  // The controller still exports the one discovery and receipt hold it uses.
  assert.equal(controller.receiptHold, require('./receipt-hold.cjs').receiptHold);
  assert.equal(controller.withDiscovery, require('./receipt-hold.cjs').withDiscovery);
  assert.equal(controller.discoverImporters, require('./receipt-hold.cjs').discoverImporters);
});

test('a completeness hold on a source the controller omitted names it as omitted, beside what a review recorded missing', () => {
  const report = missing => ({coverage: {sources: [], dependencies: missing.map(file => ({path: file, state: 'missing'}))}});
  const record = {snapshot: {sources: {}, omitted_sources: [{path: 'src/large.js', reason: 'would exceed the evidence budget'}]},
    result: {reviews: []}};
  const omittedOnly = recordedMissing(record, [{role: 'examiner', report: report([])}]);
  assert.deepEqual(omittedOnly, [{omitted: true, path: 'src/large.js', reason: 'would exceed the evidence budget'}]);
  assert.equal(heldNotice({rule: 'completeness', missing: omittedOnly}),
    'Local review held (completeness): CI would refuse this receipt because review completeness is unresolved; recorded missing: ' +
    'src/large.js (omitted). No receipt issued; decision review_incomplete.');
  const both = recordedMissing(record, [{role: 'challenger', report: report(['src/other.js'])}]);
  assert.match(heldNotice({rule: 'completeness', missing: both}), /recorded missing: src\/other\.js \(challenger\), src\/large\.js \(omitted\)\./);
});
