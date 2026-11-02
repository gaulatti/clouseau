'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {git, SourceNotFound} = require('./local-git.cjs');
const {digest} = require('./acceptance.cjs');
const {invoke} = require('./local-harness.cjs');
const {repository} = require('../test/local-git-fixture.cjs');
const {options, stateDirectory, initializeIdentity, executeVerification, reviewStatus, installation, readHistory, runReview, publishReceipt, main} = require('./local-cli.cjs');
const fixtureInstallation = () => ({sha: 'e'.repeat(40), digest: require('./local-version.cjs').engineDigest(), clean: true});

function nativeFixture(directory, gap = false) {
  const location = {start: {line: 1, column: 0}, end: {line: 1, column: 10}};
  return Object.fromEntries(['handler.js', 'new.js'].map(filename => {
    const source = path.join(directory, 'src', filename);
    return [source, {path: source, statementMap: {0: location}, s: {0: 1}, fnMap: {}, f: {},
      branchMap: {0: {type: 'if', line: 1, loc: location, locations: [location, location]}}, b: {0: [1, gap ? 0 : 1]}}];
  }));
}

function fakeHarness(negative = false) {
  let calls = 0;
  return async task => {
    let value;
    if (task.phase === 'investigation') {
      const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
      const report = packet.template;
      report.gates.forEach(gate => {gate.state = negative && gate.name === 'test_integrity' ? 'violated' : 'satisfied';});
      value = {kind: 'report', report, request_sources: []};
    } else value = {answers: Object.fromEntries(Object.keys(task.schema.properties.answers.properties)
      .map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))};
    return {value, provenance: {harness: 'codex', role: task.role, phase: task.phase, session: `fictional-session-${++calls}`,
      request_digest: digest(task), response_digest: digest(value), transport_digest: digest({fixture_only: value})}};
  };
}

test('CLI argument and identity setup are explicit and never return private material', async t => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-identity-fixture-'));
  try {
    assert.equal(options(['review', '--directory', 'fixture']).directory, 'fixture');
    for (const argv of [['review', '--unknown', 'a'], ['review', '--directory'], ['review', 'directory', 'a'],
      ['review', '--directory', 'a', '--directory', 'b']]) assert.throws(() => options(argv), /Invalid/);
    assert.throws(() => initializeIdentity(state, 'invalid/user'), /actor/);
    assert.throws(() => initializeIdentity(state), /actor/);
    const identity = initializeIdentity(state, 'fixture-author');
    assert.equal(identity.public_identity.github_actor, 'fixture-author');
    assert.ok(!JSON.stringify(identity).includes('PRIVATE KEY'));
    assert.equal(fs.statSync(identity.identity_file).mode & 0o777, 0o600);
    // External action bundles have no .git metadata. Exercise the Git boundary
    // in a real temporary repository, independently of the engine's location.
    const runner = path.join(state, 'runner'); fs.mkdirSync(runner);
    git(runner, ['init', '-q', '-b', 'main']);
    git(runner, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'test: runner fixture']);
    const expectedSha = git(runner, ['rev-parse', 'HEAD']).trim();
    const execute = require('node:child_process').execFileSync;
    t.mock.method(require('node:child_process'), 'execFileSync', (program, args, settings) => {
      assert.equal(program, 'git');
      return execute(program, ['-C', runner, ...args.slice(2)], settings);
    });
    assert.equal(installation().sha, expectedSha); assert.equal(installation().clean, true);
    fs.writeFileSync(path.join(runner, 'uncommitted'), 'fixture');
    assert.equal(installation().clean, false);
    t.mock.restoreAll();
    assert.ok(stateDirectory().endsWith('/.local/share/clouseau'));
    const initialized = await main(['init-identity'], {identityDirectory: state, execute: () => 'fixture-author\n'});
    assert.equal(initialized.public_identity.github_actor, 'fixture-author');
    t.mock.method(require('node:child_process'), 'execFileSync', (program, args) => {
      assert.equal(program, 'gh'); assert.deepEqual(args, ['api', 'user', '--jq', '.login']); return 'fixture-author\n';
    });
    assert.equal((await main(['init-identity'], {identityDirectory: state})).public_identity.github_actor, 'fixture-author');
    t.mock.restoreAll();
    await assert.rejects(main(['unknown']), /Usage/);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});

test('local verifier records real command outcomes and native coverage gaps independently', () => repository(f => {
  const config = JSON.parse(fs.readFileSync(path.join(f.directory, '.clouseau-local.json')));
  const report = path.join(f.directory, 'coverage.json');
  fs.writeFileSync(report, JSON.stringify(nativeFixture(f.directory)));
  const receipt = executeVerification({directory: f.directory, config});
  assert.deepEqual(receipt.exact_coverage, {lines: [2, 2], branches: [4, 4]});
  assert.equal(receipt.commands[0].exit_code, 0);
  assert.equal(receipt.coverage_reports, undefined, 'version 1 keeps its existing evidence shape');
  fs.writeFileSync(report, JSON.stringify(nativeFixture(f.directory, true)));
  assert.equal(executeVerification({directory: f.directory, config}).coverage.status, 'below_threshold');
  const failed = executeVerification({directory: f.directory,
    config: {...config, verification: [[process.execPath, '-e', 'process.exit(3)']]}});
  assert.equal(failed.verification_status, 'failed'); assert.equal(failed.commands[0].exit_code, 3);
  const missing = executeVerification({directory: f.directory,
    config: {...config, verification: [['/nonexistent-fixture-command']]}});
  assert.equal(missing.verification_status, 'failed'); assert.equal(missing.commands[0].error.code, 'ENOENT');
}));

test('verification evidence keeps a bounded tail of each stream and binds the whole output by digest', () => repository(f => {
  const config = JSON.parse(fs.readFileSync(path.join(f.directory, '.clouseau-local.json')));
  const verbose = (lines, code) => [process.execPath, '-e',
    `for (let i = 0; i < ${lines}; i++) process.stderr.write('test_case_' + i + ' ... ok\\n'); process.stdout.write('Ran ${lines} tests\\nDONE'); process.exit(${code})`];
  const lines = 300; const full = Array.from({length: lines}, (_, i) => `test_case_${i} ... ok\n`).join('');
  const passed = executeVerification({directory: f.directory, config: {...config, verification: [verbose(lines, 0)]}}).commands[0];
  assert.equal(passed.stderr, full.slice(-128)); assert.equal(passed.stderr_bytes, Buffer.byteLength(full));
  assert.equal(passed.stderr_digest, digest(full), 'the digest still covers the complete stream');
  assert.equal(passed.stdout, `Ran ${lines} tests\nDONE`); assert.equal(passed.stdout_bytes, undefined, 'a short stream is kept whole and unmarked');
  const failed = executeVerification({directory: f.directory, config: {...config, verification: [verbose(lines, 1)]}}).commands[0];
  assert.equal(failed.exit_code, 1); assert.equal(failed.stderr, full.slice(-4096)); assert.equal(failed.stderr_bytes, Buffer.byteLength(full));
  const emoji = executeVerification({directory: f.directory, config: {...config, verification: [[process.execPath, '-e',
    "process.stdout.write('\\u{1F600}'.repeat(200) + 'y')"]]}}).commands[0];
  assert.equal(emoji.stdout, '\u{1F600}'.repeat(63) + 'y', 'a cut inside an emoji drops its orphaned half');
  const missing = executeVerification({directory: f.directory, config: {...config, verification: [['/nonexistent-fixture-command']]}}).commands[0];
  assert.equal(missing.stderr, ''); assert.equal(missing.error.code, 'ENOENT');
  // Regression ceiling: forty green suites of 14 KB of verbose output used to put ~560 KB into the prompt and the receipt twice.
  const suites = executeVerification({directory: f.directory, config: {...config, verification: Array.from({length: 40}, () => verbose(lines, 0))}});
  assert.ok(Buffer.byteLength(JSON.stringify(suites)) < 40 * 1100, `verification evidence ${Buffer.byteLength(JSON.stringify(suites))} bytes`);
}));

test('v2 local verification binds every native artifact and allows only aggregate-measured branches', () => repository(f => {
  const original = JSON.parse(fs.readFileSync(path.join(f.directory, '.clouseau-local.json')));
  const frontend = path.join(f.directory, 'frontend'); fs.mkdirSync(frontend);
  const source = path.join(frontend, 'linear.js'); fs.writeFileSync(source, 'module.exports = 1;\n');
  const location = {start: {line: 1}, end: {line: 1}};
  const linear = {[source]: {path: source, statementMap: {0: location}, s: {0: 1}, fnMap: {}, f: {}, branchMap: {}, b: {}}};
  const first = path.join(f.directory, 'coverage.json');
  const second = path.join(f.directory, 'frontend.json');
  fs.writeFileSync(first, JSON.stringify(nativeFixture(f.directory)));
  fs.writeFileSync(second, JSON.stringify(linear));
  const config = {...original, version: 2, coverage: [original.coverage,
    {format: 'istanbul', report: 'frontend.json', source_directory: 'frontend'}]};
  const result = executeVerification({directory: f.directory, config});
  assert.deepEqual(result.exact_coverage, {lines: [3, 3], branches: [4, 4]});
  assert.equal(result.coverage_reports.length, 2);
  assert.deepEqual(result.coverage_reports[1].exact_coverage, {lines: [1, 1], branches: [0, 0]});
  assert.equal(result.coverage_reports[0].report_digest, digest(fs.readFileSync(first, 'utf8')));
  assert.equal(result.coverage_reports[1].report_digest, digest(fs.readFileSync(second, 'utf8')));
  assert.equal(result.local_config_digest, digest(config));
  assert.equal(result.report_digest, digest(result.coverage_reports.map(({exact_coverage, ...entry}) => entry)));
  linear[source].s[0] = 0; fs.writeFileSync(second, JSON.stringify(linear));
  assert.equal(executeVerification({directory: f.directory, config}).coverage.status, 'below_threshold');
  assert.deepEqual(executeVerification({directory: f.directory,
    config: {...config, coverage: [config.coverage[1]]}}).exact_coverage, {lines: [1, 0], branches: [0, 0]});
  fs.unlinkSync(second);
  const incomplete = executeVerification({directory: f.directory, config});
  assert.equal(incomplete.coverage.status, 'unavailable');
  assert.equal(incomplete.exact_coverage, null);
  assert.equal(incomplete.coverage_reports[0].report_digest, digest(fs.readFileSync(first, 'utf8')));
  assert.equal(incomplete.coverage_reports[1].report_digest, null);
  assert.deepEqual(incomplete.coverage_reports.map(part => part.exact_coverage), [null, null],
    'a missing component cannot acquire invented counts or a passing aggregate');
  let calls = 0;
  assert.throws(() => executeVerification({directory: f.directory,
    config: {...config, coverage: []}, run: () => {calls++;}}), /Invalid local-only/);
  assert.throws(() => executeVerification({directory: f.directory,
    config: {...config, exclude: ['frontend']}, run: () => {calls++;}}), /Invalid local-only/);
  assert.equal(calls, 0, 'invalid accepted recipe stops before executing any command');
}));

test('a measurement failure without a message is still recorded as unavailable coverage with a stable reason', t => repository(f => {
  const config = JSON.parse(fs.readFileSync(path.join(f.directory, '.clouseau-local.json')));
  fs.writeFileSync(path.join(f.directory, 'coverage.json'), JSON.stringify(nativeFixture(f.directory)));
  t.mock.method(require('./coverage-gate.cjs'), 'measure', () => {throw new Error('');});
  const result = executeVerification({directory: f.directory, config});
  assert.equal(result.coverage.status, 'unavailable');
  assert.equal(result.coverage.error, 'Native coverage could not be measured');
  assert.equal(result.exact_coverage, null);
}));

test('local native artifact loading records duplicate-key data as unavailable rather than fabricating counters', () => repository(f => {
  const config = JSON.parse(fs.readFileSync(path.join(f.directory, '.clouseau-local.json')));
  const report = nativeFixture(f.directory);
  const name = Object.keys(report)[0];
  const duplicate = JSON.stringify(report).slice(0, -1) + ',' + JSON.stringify(name) + ':' + JSON.stringify(report[name]) + '}';
  fs.writeFileSync(path.join(f.directory, 'coverage.json'), duplicate);
  const result = executeVerification({directory: f.directory, config});
  assert.equal(result.coverage.status, 'unavailable');
  assert.match(result.coverage.error, /Duplicate coverage JSON key/);
  assert.equal(result.exact_coverage, null);
}));

test('agent-only local review needs no CI config or provider keys and does not resample unchanged findings', () => repository(async f => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-run-fixture-'));
  try {
    const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
    const args = {directory: f.directory, base: f.base, 'request-file': request, harness: 'claude'};
    const deps = {state, ask: fakeHarness(), verify: () => ({fixture_execution_only: true}), installed: fixtureInstallation};
    const report = await main(['review', '--directory', f.directory, '--base', f.base, '--request-file', request, '--harness', 'claude'], deps);
    assert.equal(report.decision, 'auto_approve'); assert.equal(report.receipt, null);
    assert.equal(report.provider_api_calls, 0); assert.equal(report.harness_invocations, 2);
    assert.equal(git(f.directory, ['status', '--porcelain']), '');
    await assert.rejects(runReview(args, deps), /already run/);
    await assert.rejects(runReview({directory: f.directory}, deps), /requirement file/);
    fs.writeFileSync(request, ''); await assert.rejects(runReview(args, deps), /nonempty/);
    fs.writeFileSync(request, 'Reject missing input.');
    await assert.rejects(runReview({...args, output: path.join(f.directory, 'report.json')},
      {...deps, state: path.join(state, 'other-cache')}), /outside the source/);
    await assert.rejects(runReview({...args, identity: 'unused'}, {...deps, installed: () => ({sha: 'e'.repeat(40), clean: false})}), /unmodified/);
    fs.writeFileSync(path.join(f.directory, 'src/new.js'), 'uncommitted');
    await assert.rejects(runReview(args, deps), /Commit/);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}));

test('a completed negative local review retains evidence and never produces a signed passing receipt', () => repository(async f => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-negative-fixture-'));
  try {
    const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
    const result = await runReview({directory: f.directory, base: f.base, 'request-file': request},
      {state, ask: fakeHarness(true), verify: () => ({fixture_execution_only: true}), installed: fixtureInstallation});
    assert.equal(result.decision, 'blocked_integrity'); assert.equal(result.receipt, null);
    assert.equal(JSON.parse(fs.readFileSync(result.record)).result.reviews.length, 2);
    fs.writeFileSync(request, 'A renamed request cannot erase a failed review.');
    await assert.rejects(runReview({directory: f.directory, base: f.base, 'request-file': request},
      {state, ask: async () => {throw new Error('Do not resample');}, installed: fixtureInstallation}), /non-passing local review/);
    await assert.rejects(runReview({directory: f.directory, base: f.base, 'request-file': request},
      {state, ask: async () => {throw new Error('Do not resample');}, installed: () => ({...fixtureInstallation(), sha: 'f'.repeat(40)})}), /non-passing local review/);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}));

test('a failed first harness request remains inspectable and cannot be blindly sampled again', () => repository(async f => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-transport-failure-'));
  try {
    const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
    const args = {directory: f.directory, base: f.base, 'request-file': request};
    let calls = 0;
    const deps = {state, verify: () => ({}), installed: fixtureInstallation, ask: async () => {
      calls++;
      return invoke(process.execPath, ['-e', 'process.stdout.write("fictional-private-stdout", () => process.stderr.write("fictional-private-diagnostic", () => process.exit(1)))'], {input: ''});
    }};
    await assert.rejects(runReview(args, deps), error => {
      assert.match(error.message, /Local harness failed.*preserved review evidence:/);
      assert.ok(!error.message.includes('fictional-private'));
      return true;
    });
    await assert.rejects(runReview(args, deps), /already run/);
    assert.equal(calls, 1);
    const cache = path.join(state, 'reviews', fs.readdirSync(path.join(state, 'reviews'))[0]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cache, 'observations.jsonl'), 'utf8')).status, 'started');
    const snapshot = JSON.parse(fs.readFileSync(path.join(cache, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.repository, 'example/local-fixture');
    assert.equal(snapshot.head_sha, git(f.directory, ['rev-parse', 'HEAD']).trim());
    assert.equal(fs.statSync(path.join(cache, 'snapshot.json')).mode & 0o777, 0o600);
    const failure = path.join(cache, 'failure.json');
    const diagnostic = JSON.parse(fs.readFileSync(failure)).harness;
    assert.equal(diagnostic.stderr, 'fictional-private-diagnostic');
    assert.equal(diagnostic.stdout_tail, 'fictional-private-stdout');
    assert.equal(diagnostic.stdout_digest, digest('fictional-private-stdout'));
    assert.deepEqual(diagnostic.controller_kill_reasons, []);
    assert.equal(fs.statSync(failure).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(cache, 'receipt.json')), false);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}));

for (const central of [false, true]) test(`central=${central}: signed local runner requires protected enrollment and publishes its artifact outside the reviewed commit`, async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-signed-fixture-'));
  try {
    const identity = initializeIdentity(state, 'fixture-author');
    const reviewerSha = 'e'.repeat(40);
    const config = {...require('../test/fixtures/config.json'), version: 2, repository_policy: 'AGENTS.md', readme: 'README.md',
      acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash', repair_attempts: 2},
      local_review: {mode: 'required', reviewer_digest: 'e'.repeat(64), max_age_seconds: 3600, keys: [identity.public_identity]}};
    if (central) {delete config.local_review.reviewer_digest; config.local_review.central_source = {...require('./central-version.cjs').SOURCE};}
    // Only the central variant treats the changed source as a protected control, to prove the local warning at every stage.
    if (central) config.sensitive_paths = ['src/new.js'];
    await repository(async f => {
      const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
      const args = {directory: f.directory, base: f.base, 'request-file': request, identity: identity.identity_file};
      const warned = value => {
        if (!central) return assert.equal(value.warnings, undefined);
        assert.equal(value.warnings.length, 1);
        assert.match(value.warnings[0], /^Protected review controls changed \(src\/new\.js\): CI cannot accept a local receipt .*\(\/approve-intent\) and will report review_incomplete/);
      };
      const deps = {state, ask: fakeHarness(), verify: () => ({fixture_execution_only: true}),
        installed: () => ({sha: reviewerSha, digest: 'e'.repeat(64), clean: true})};
      const result = await runReview(args, deps);
      assert.ok(result.receipt); assert.equal(result.decision, 'auto_approve'); warned(result);
      const issued = JSON.parse(fs.readFileSync(result.receipt)).payload; assert.equal(issued.expires_at - issued.issued_at, 3600);
      // Local artifacts are compact JSON: indentation alone was ~15% of a receipt and of the cached record and snapshot.
      for (const filename of [result.receipt, result.record, path.join(path.dirname(result.receipt), 'snapshot.json')]) {
        const text = fs.readFileSync(filename, 'utf8');
        assert.equal(text.indexOf('\n'), text.length - 1, `${path.basename(filename)} is a single line`);
        assert.equal(text, JSON.stringify(JSON.parse(text)) + '\n');
      }
      const reused = await runReview({...args, identity: undefined}, {...deps,
        ask: async () => {throw new Error('A verified cached review must not call AI');}});
      assert.equal(reused.reused, true); assert.equal(reused.harness_invocations, 0); warned(reused);
      // A new central commit may retain identical engine bytes. Its old signed
      // receipt must remain intact while a fresh review signs the new exact SHA.
      const advancedDeps = {...deps, installed: () => ({sha: 'f'.repeat(40), digest: 'e'.repeat(64), clean: true})};
      const advanced = await runReview(args, advancedDeps);
      assert.equal(advanced.harness_invocations, 2); assert.equal(advanced.reviewer_sha, 'f'.repeat(40));
      assert.notEqual(advanced.receipt, result.receipt);
      assert.equal(JSON.parse(fs.readFileSync(result.receipt)).payload.reviewer_sha, reviewerSha);
      assert.equal(JSON.parse(fs.readFileSync(advanced.receipt)).payload.reviewer_sha, 'f'.repeat(40));
      const advancedReused = await runReview(args, {...advancedDeps, ask: async () => {throw new Error('Exact current review must reuse');}});
      assert.equal(advancedReused.reused, true); assert.equal(advancedReused.harness_invocations, 0);
      const bare = path.join(state, 'artifacts.git'); git(state, ['init', '-q', '--bare', bare]);
      git(f.directory, ['config', `url.${bare}.insteadOf`, 'https://github.com/example/local-fixture.git']);
      const published = await main(['publish', '--directory', f.directory, '--receipt', result.receipt]);
      assert.equal(published.artifact_commit.length, 40); assert.match(published.marker, /clouseau-local-review:v1/); warned(published);
      assert.equal(JSON.parse(git(bare, ['show', `${published.artifact_commit}:clouseau-review.json`])).payload.record.snapshot.head_sha,
        result.head_sha);
      assert.equal(git(f.directory, ['rev-parse', 'HEAD']).trim(), result.head_sha);
      git(f.directory, ['config', '--unset', `url.${bare}.insteadOf`]);
      fs.chmodSync(identity.identity_file, 0o644);
      await assert.rejects(runReview(args, {...deps, state: path.join(state, 'fresh')}), /permissions must be private/);
      fs.chmodSync(identity.identity_file, 0o600);
      let installations = 0;
      await assert.rejects(runReview(args, {...deps, state: path.join(state, 'engine-changed'),
        installed: () => ({sha: installations++ ? 'f'.repeat(40) : reviewerSha, digest: 'e'.repeat(64), clean: true})}), /installation changed/);
    }, directory => {
      fs.mkdirSync(path.join(directory, '.github'));
      fs.writeFileSync(path.join(directory, '.github/clouseau.json'), JSON.stringify(config));
    });
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});

test('local history is bounded and a missing concern cannot disappear on a changed revision', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-history-fixture-'));
  try {
    const filename = path.join(state, 'ledger.json');
    fs.writeFileSync(filename, '{}'); assert.throws(() => readHistory(filename, 'example/repo', 'main'), /Invalid local finding history/);
    fs.writeFileSync(filename, 'x'.repeat(250001)); assert.throws(() => readHistory(filename, 'example/repo', 'main'), /budget/);
    await repository(async f => {
      const request = path.join(state, 'request.txt'); fs.writeFileSync(request, 'Reject missing input.');
      git(f.directory, ['update-ref', 'refs/remotes/origin/main', f.base]);
      const args = {'request-file': request};
      const cwd = process.cwd(); process.chdir(f.directory);
      try {
        const deps = {state, ask: fakeHarness(), verify: () => ({fixture_execution_only: true}), installed: fixtureInstallation};
        await runReview(args, deps);
        const ledger = path.join(state, 'ledgers', `${digest({repository: 'example/local-fixture', branch: 'main'})}.json`);
        const previous = JSON.parse(fs.readFileSync(ledger));
        const legacy = {...previous}; delete legacy.reviewer_sha;
        fs.writeFileSync(ledger, JSON.stringify(legacy)); assert.equal(readHistory(ledger, previous.repository, previous.branch).reviewer_sha, undefined);
        fs.writeFileSync(ledger, JSON.stringify({...previous, reviewer_sha: 'main'}));
        assert.throws(() => readHistory(ledger, previous.repository, previous.branch), /Invalid/);
        previous.findings = [{id: 'a'.repeat(64), blocking: true, path: 'src/handler.js',
          title: 'Input guard', cause: 'Unvalidated input', obligation: 'Reject missing input'}];
        fs.writeFileSync(ledger, JSON.stringify(previous));
        git(f.directory, ['commit', '--allow-empty', '-qm', 'test: new fixture revision']);
        const held = await runReview(args, deps);
        assert.equal(held.decision, 'review_incomplete'); assert.equal(held.receipt, null);
        assert.equal(require('./local-receipt.cjs').reviewDecision(JSON.parse(fs.readFileSync(held.record))).decision, 'review_incomplete');
        assert.equal(JSON.parse(fs.readFileSync(held.record)).local_previous.findings[0].id, 'a'.repeat(64));
        previous.findings[0].path = '../escape'; fs.writeFileSync(ledger, JSON.stringify(previous));
        assert.throws(() => readHistory(ledger, previous.repository, previous.branch), /Invalid/);
      } finally {process.chdir(cwd);}
    });
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});

test('a workstation with multiple enrolled identities must explicitly choose its signer', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-many-identities-'));
  try {
    const identities = [initializeIdentity(state, 'fixture-author'), initializeIdentity(state, 'another-author')];
    const config = {...require('../test/fixtures/config.json'), version: 2,
      acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash', repair_attempts: 2},
      local_review: {mode: 'optional', reviewer_digest: 'e'.repeat(64), max_age_seconds: 3600,
        keys: identities.map(item => item.public_identity)}};
    await repository(async f => {
      const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
      await assert.rejects(runReview({directory: f.directory, base: f.base, 'request-file': request}, {state, installed: fixtureInstallation}), /Multiple enrolled/);
    }, directory => {
      fs.mkdirSync(path.join(directory, '.github'));
      fs.writeFileSync(path.join(directory, '.github/clouseau.json'), JSON.stringify(config));
    });
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});

test('unregistered local signing and source changes stop before any receipt can be issued', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-denied-fixture-'));
  try {
    const identity = initializeIdentity(state, 'fixture-author');
    await repository(async f => {
      const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
      const args = {directory: f.directory, base: f.base, 'request-file': request, identity: identity.identity_file};
      const deps = {state, ask: async () => {throw new Error('Must not invoke a harness');}, verify: () => ({}),
        installed: () => ({sha: 'e'.repeat(40), clean: true})};
      await assert.rejects(runReview(args, deps), /already be enrolled/);
      await assert.rejects(runReview({...args, identity: undefined}, {...deps, verify: () => {
        git(f.directory, ['commit', '--allow-empty', '-qm', 'test: fixture source changed']); return {};
      }}), /Source changed during/);
    });
  } finally {fs.rmSync(state, {recursive: true, force: true});}
});


test('operator additional checks execute after the accepted recipe and cannot rewrite coverage evidence', () => repository(async f => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-additional-fixture-'));
  try {
    const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
    const plan = path.join(state, 'checks.json');
    const extra = [[process.execPath, '-e', "require('node:assert').throws(()=>require('./src/handler.js')(null), /Missing input/)"]];
    fs.writeFileSync(plan, JSON.stringify(extra));
    fs.writeFileSync(path.join(f.directory, 'coverage.json'), JSON.stringify(nativeFixture(f.directory)));
    const args = {directory: f.directory, base: f.base, 'request-file': request, 'additional-checks': plan};
    const deps = {state, ask: fakeHarness(), installed: fixtureInstallation};
    const first = await runReview(args, deps);
    const record = JSON.parse(fs.readFileSync(first.record));
    const technical = JSON.parse(record.snapshot.sources.verification.content);
    const accepted = JSON.parse(git(f.directory, ['show', `${f.base}:.clouseau-local.json`]));
    assert.deepEqual(technical.commands.map(command => command.argv), [...accepted.verification, ...extra]);
    assert.equal(technical.local_config_digest, digest(accepted));
    assert.deepEqual(technical.exact_coverage, {lines: [2, 2], branches: [4, 4]});
    extra.push([process.execPath, '-e', "require('node:assert').equal(require('./src/new.js'), 1)"]);
    fs.writeFileSync(plan, JSON.stringify(extra));
    const second = await runReview(args, deps);
    assert.notEqual(first.record, second.record); assert.ok(fs.existsSync(first.record));
    await assert.rejects(runReview(args, deps), /already run/);
    const reportPath = path.join(f.directory, 'coverage.json');
    const gap = JSON.stringify(nativeFixture(f.directory, true)); fs.writeFileSync(reportPath, gap);
    const attemptedRepair = [[process.execPath, '-e', `require('node:fs').writeFileSync('coverage.json', ${JSON.stringify(JSON.stringify(nativeFixture(f.directory)))})`]];
    assert.throws(() => executeVerification({directory: f.directory, config: accepted, additional: attemptedRepair}), /changed accepted coverage artifacts/);
    assert.notEqual(fs.readFileSync(reportPath, 'utf8'), gap, 'a rewritten report is rejected even when its replacement claims full coverage');
    fs.writeFileSync(path.join(f.directory, 'coverage.json'), JSON.stringify(nativeFixture(f.directory)));
    const extraFailed = executeVerification({directory: f.directory, config: accepted,
      additional: [[process.execPath, '-e', 'process.exit(7)']]});
    assert.equal(extraFailed.verification_status, 'failed');
    assert.equal(extraFailed.commands.at(-1).exit_code, 7);
    assert.throws(() => executeVerification({directory: f.directory, config: accepted,
      additional: [[process.execPath, '-e', 'require("node:fs").appendFileSync("coverage.json", " ")']]}), /changed accepted coverage artifacts/);
    for (const value of ['x'.repeat(8001), '{}', JSON.stringify(Array(9).fill(['node'])), '[[]]']) {
      fs.writeFileSync(plan, value);
      await assert.rejects(runReview(args, deps), /Additional local checks|local-only Clouseau configuration/);
    }
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}));

test('a malformed harness report retains a private validation failure and never reaches grading or signing', () => repository(async f => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-malformed-report-'));
  try {
    const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
    const args = {directory: f.directory, base: f.base, 'request-file': request};
    let calls = 0;
    await assert.rejects(runReview(args, {state, installed: fixtureInstallation, verify: () => ({}), ask: async task => {
      calls++; assert.equal(task.phase, 'investigation');
      return {value: {kind: 'unexpected', report: null, request_sources: []}};
    }}), /Invalid local investigation response.*preserved review evidence/);
    const cache = path.join(state, 'reviews', fs.readdirSync(path.join(state, 'reviews'))[0]);
    const failure = JSON.parse(fs.readFileSync(path.join(cache, 'failure.json')));
    assert.equal(failure.harness, null);
    assert.match(failure.failure, /Invalid local investigation response/);
    assert.equal(calls, 1); assert.equal(fs.existsSync(path.join(cache, 'receipt.json')), false);
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}));


test('partial native coverage and a real failing exact gate still reach both local AI roles with honest evidence', () => repository(async f => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-partial-quality-fixture-'));
  try {
    fs.writeFileSync(path.join(f.directory, 'coverage.json'), JSON.stringify(nativeFixture(f.directory, true)));
    const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input while preserving accepted input.');
    const extra = path.join(state, 'checks.json');
    fs.writeFileSync(extra, JSON.stringify([[process.execPath, path.join(__dirname, '..', 'bin', 'coverage-gate.cjs'), 'check',
      path.join(f.directory, 'coverage.json'), path.join(f.directory, 'src'), 'istanbul']]));
    const ask = fakeHarness(); const roles = [];
    const result = await runReview({directory: f.directory, base: f.base, 'request-file': request, 'additional-checks': extra}, {
      state, installed: fixtureInstallation, ask: async task => {
        if (task.phase === 'investigation') {
          roles.push(task.role);
          const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
          const source = Object.values(packet.evidence.sources).find(item => item.path === 'verification');
          const observed = JSON.parse(source.content);
          assert.equal(observed.verification_status, 'failed');
          assert.equal(observed.commands.at(-1).exit_code, 1);
          assert.match(observed.commands.at(-1).stderr, /require exactly 100%/);
          assert.deepEqual(observed.exact_coverage, {lines: [2, 2], branches: [4, 2]});
          assert.equal(observed.coverage.status, 'below_threshold');
        }
        return ask(task);
      },
    });
    assert.deepEqual(roles, ['examiner', 'challenger']);
    assert.equal(result.decision, 'auto_approve');
    assert.equal(result.harness_invocations, 2);
    assert.equal(result.local_verification.commands, 'failed');
    assert.equal(result.local_verification.coverage.status, 'below_threshold');
    assert.equal(result.decision_scope, 'review_reuse_only');
    assert.equal(result.independent_ci_required, true);
    assert.equal(result.merge_authority, false);
    assert.equal(result.receipt, null, 'unenrolled fixture cannot create an eligible approval signature');
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}));


test('quality scope never presents absent historical local verification as a technical pass', () => {
  const summary = reviewStatus();
  assert.equal(summary.decision_scope, 'review_reuse_only');
  assert.equal(summary.local_verification.commands, 'unavailable');
  assert.deepEqual(summary.local_verification.coverage, {status: 'unavailable', passed: false});
  assert.equal(summary.independent_ci_required, true);
  assert.equal(summary.merge_authority, false);
});

test('a missing source path fails with a structured status instead of a raw git command', () => repository(async f => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-source-missing-'));
  try {
    const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
    const args = {directory: f.directory, base: f.base, 'request-file': request};
    const result = await runReview(args, {state, installed: fixtureInstallation, verify: () => ({}), ask: async () => { throw new SourceNotFound('gone/file.test.tsx'); }});
    assert.deepEqual({status: result.status, reason: result.reason, path: result.path}, {status: 'failed', reason: 'source_not_found', path: 'gone/file.test.tsx'});
    const failure = JSON.parse(fs.readFileSync(path.join(result.evidence, 'failure.json')));
    assert.deepEqual({status: failure.status, reason: failure.reason, path: failure.path, harness: failure.harness},
      {status: 'failed', reason: 'source_not_found', path: 'gone/file.test.tsx', harness: null});
    assert.ok(!/git -C/.test(JSON.stringify(failure)));
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}));

test('a mistyped --harness fails naming the valid values before anything is recorded and never blocks the head', () => repository(async f => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-bad-harness-'));
  try {
    const request = path.join(state, 'requirement.txt'); fs.writeFileSync(request, 'Reject missing input.');
    const args = {directory: f.directory, base: f.base, 'request-file': request};
    const deps = {state, ask: fakeHarness(), verify: () => ({fixture_execution_only: true}), installed: fixtureInstallation};
    for (const harness of ['bogus', 'claud']) {
      await assert.rejects(runReview({...args, harness}, {...deps, ask: async () => {throw new Error('Must not invoke a harness');}}),
        error => { assert.match(error.message, /Unsupported --harness .*codex, claude/); return true; });
    }
    assert.deepEqual(fs.readdirSync(state), ['requirement.txt'], 'an invalid invocation records no ledger, journal or cache');
    assert.equal((await runReview({...args, harness: 'claude'}, deps)).decision, 'auto_approve');
  } finally {fs.rmSync(state, {recursive: true, force: true});}
}));
