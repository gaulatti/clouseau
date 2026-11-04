'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const {Writable} = require('node:stream');
const {reportTests} = require('./native-test-report.cjs');
const reporter = path.join(__dirname, 'native-test-report.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const environment = () => {const env = {...process.env}; delete env.NODE_TEST_CONTEXT; return env;};
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-native-report-'));
  const write = (name, text) => {fs.writeFileSync(path.join(root, name), text); return path.join(root, name);};
  return {root, write, artifacts: path.join(root, 'artifacts'), cleanup: () => fs.rmSync(root, {recursive: true, force: true})};
}
function execute(f, name, args) {
  return cp.spawnSync(process.execPath, [reporter, name, f.artifacts, '--', ...args],
    {cwd: f.root, env: environment(), encoding: 'utf8', timeout: 20000});
}
function manifests(f) {
  return fs.readdirSync(f.artifacts).sort().map(name => {
    const filename = path.join(f.artifacts, name, 'manifest.json');
    return {filename, ...JSON.parse(fs.readFileSync(filename, 'utf8'))};
  });
}
function checkTrace(record) {
  for (const trace of Object.values(record.traces).filter(Boolean)) {
    const bytes = fs.readFileSync(trace.path); assert.equal(bytes.length, trace.bytes); assert.equal(sha(bytes), trace.sha256);
  }
}

test('one native execution selects the exact files and retains all per-case stdout/stderr behind compact success and immutable run references', () => {
  const f = fixture();
  try {
    const marker = path.join(f.root, 'executions');
    const first = f.write('first.test.cjs', `const{test}=require('node:test');const fs=require('node:fs');
      test('first actual native case',()=>{fs.appendFileSync(${JSON.stringify(marker)},'first\\n');console.log('complete stdout 💡');console.error('complete stderr');});`);
    const second = f.write('second.test.cjs', "require('node:test').test('second actual native case',()=>{});");
    f.write('excluded.spec.cjs', "throw Error('This unselected source must never execute');");
    const run = execute(f, 'success', ['--test', first, second]);
    assert.equal(run.status, 0, run.stderr); assert.equal(run.signal, null);
    assert.match(run.stdout, /Native tests passed/);
    assert.doesNotMatch(run.stderr, /MaxListenersExceededWarning/);
    assert.match(run.stdout, /Native trace: .*sha256=[a-f0-9]{64}/);
    assert.doesNotMatch(run.stdout, /first actual native case|complete stdout/);
    const record = manifests(f)[0]; checkTrace(record);
    assert.ok(run.stdout.startsWith(fs.readFileSync(record.traces.stdout.path, 'utf8')));
    assert.equal(run.stderr, fs.readFileSync(record.traces.stderr.path, 'utf8'));
    const started = JSON.parse(fs.readFileSync(path.join(path.dirname(record.filename), 'started.json')));
    assert.equal(started.run_id, record.run_id); assert.deepEqual(started.argv, record.argv);
    const spec = fs.readFileSync(record.traces.spec.path, 'utf8');
    assert.match(spec, /first actual native case/); assert.match(spec, /second actual native case/);
    assert.match(spec, /complete stdout 💡/); assert.match(spec, /complete stderr/);
    assert.doesNotMatch(spec, /unselected source/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'first\n', 'the second report must not rerun tests');
    assert.deepEqual(record.argv.slice(-3), ['--test', first, second]);
    assert.equal(record.native_exit_code, 0); assert.equal(record.native_signal, null);
    assert.ok(run.stdout.includes(`${record.traces.spec.path} sha256=${record.traces.spec.sha256}`));
    assert.ok(run.stdout.includes(`${record.filename} sha256=${sha(fs.readFileSync(record.filename))}`));
    const original = fs.readFileSync(record.filename);
    const again = execute(f, 'success', ['--test', second]); assert.equal(again.status, 0);
    assert.equal(manifests(f).length, 2); assert.deepEqual(fs.readFileSync(record.filename), original); checkTrace(record);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'first\n');
  } finally {f.cleanup();}
});

test('a real assertion failure preserves native exit1 and complete middle/prefix/tail diagnostics from the same run', () => {
  const f = fixture();
  try {
    const detail = 'native failure prefix\n' + 'full failure diagnostic 💡\n'.repeat(150) + 'native failure tail';
    const file = f.write('failure.test.cjs', `const{test}=require('node:test');const assert=require('node:assert/strict');
      test('real failing native case',()=>{console.log('original stdout before failure');console.error('original stderr before failure');assert.fail(${JSON.stringify(detail)});});`);
    const run = execute(f, 'failure', ['--test', file]);
    assert.equal(run.status, 1); assert.equal(run.signal, null);
    for (const text of ['real failing native case', 'native failure prefix', 'full failure diagnostic 💡', 'native failure tail',
      'original stdout before failure', 'original stderr before failure']) assert.ok(run.stderr.includes(text), text);
    const record = manifests(f)[0]; checkTrace(record); assert.equal(record.native_exit_code, 1);
    const spec = fs.readFileSync(record.traces.spec.path, 'utf8');
    assert.ok(run.stderr.includes(spec), 'the entire native formatted failure trace is emitted verbatim');
    assert.equal(spec.split('full failure diagnostic 💡').length - 1, 150);
  } finally {f.cleanup();}
});

test('native line/branch flags and the original LCOV destination still fail an uncovered branch even when every assertion passes', () => {
  const f = fixture();
  try {
    const source = fs.realpathSync(f.write('subject.cjs', 'module.exports = value => value ? 1 : 0;\n'));
    const file = f.write('coverage.test.cjs', "const{test}=require('node:test');const assert=require('node:assert/strict');const run=require('./subject.cjs');test('passing assertion with real coverage gap',()=>assert.equal(run(true),1));\n");
    const report = path.join(f.root, 'original.lcov');
    const args = ['--experimental-test-coverage', '--test', '--test-reporter=lcov', `--test-reporter-destination=${report}`,
      '--test-coverage-lines=100', '--test-coverage-branches=100', `--test-coverage-include=${source}`, file];
    const run = execute(f, 'coverage', args);
    assert.equal(run.status, 1); assert.match(run.stderr, /coverage|branch/);
    assert.match(fs.readFileSync(report, 'utf8'), /BRDA:.*0/m);
    const record = manifests(f)[0]; checkTrace(record); assert.deepEqual(record.argv.slice(2), args);
  } finally {f.cleanup();}
});

test('the actual archive script retains successful and failing traces outside the deleted Git-free bundle', () => {
  for (const fail of [false, true]) {
    const f = fixture();
    const git = (...args) => cp.execFileSync('git', ['-C', f.root, ...args], {stdio: 'pipe'});
    try {
      fs.mkdirSync(path.join(f.root, 'src')); fs.mkdirSync(path.join(f.root, 'scripts'));
      fs.copyFileSync(reporter, path.join(f.root, 'src/native-test-report.cjs'));
      fs.copyFileSync(path.join(__dirname, '../scripts/verify-archive'), path.join(f.root, 'scripts/verify-archive'));
      f.write('src/test_native.py', 'import unittest\nclass Native(unittest.TestCase):\n def test_native(self): self.assertTrue(True)\n');
      f.write('src/actual.test.cjs', `require('node:test').test('archived actual native case',()=>{console.log('archive trace survives teardown');${fail ? "throw Error('archive failure sentinel');" : ''}});`);
      f.write('.gitignore', '.clouseau-work/\n');
      git('init', '-q'); git('add', '.'); git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','test: freeze archive fixture');
      const run = cp.spawnSync('bash', ['scripts/verify-archive'], {cwd: f.root, env: environment(), encoding: 'utf8', timeout: 20000});
      assert.equal(run.status, fail ? 1 : 0, run.stderr);
      f.artifacts = path.join(f.root, '.clouseau-work/verification-runs');
      const record = manifests(f)[0]; checkTrace(record);
      assert.equal(fs.existsSync(record.cwd), false, 'the actual temporary archive must be removed');
      assert.equal(record.reporter.path, path.join(record.cwd, 'src/native-test-report.cjs'));
      assert.equal(record.reporter.sha256, sha(fs.readFileSync(reporter)));
      assert.notEqual(record.reporter.path, reporter, 'the helper must execute from the archive, never the original checkout');
      assert.ok(fs.readFileSync(record.traces.spec.path, 'utf8').includes('archive trace survives teardown'));
      if (fail) assert.match(run.stderr, /archive failure sentinel/);
    } finally {f.cleanup();}
  }
});

test('reporter argument validation is explicit and a native argument failure remains a failed retained run', async () => {
  const f = fixture();
  try {
    for (const args of [{label: '../escape', args: ['--test']}, {label: 'native', args: []},
      {label: 'native', args: null}, {label: 'native', args: [1, '--test']}, {label: 'native', args: ['--test', '--test-reporter=spec']}, {label: 'native', args: ['--test', '--test-reporter', 'spec']}]) {
      await assert.rejects(reportTests({...args, artifacts: f.artifacts}), /reporting requires/);
    }
    const run = execute(f, 'arguments', ['--test', '--no-such-node-option']);
    assert.notEqual(run.status, 0); assert.match(run.stderr, /bad option/);
    const record = manifests(f)[0]; checkTrace(record); assert.equal(record.traces.spec, null);
    assert.ok(run.stderr.startsWith(fs.readFileSync(record.traces.stderr.path, 'utf8')));
    const missing = cp.spawnSync(process.execPath, [reporter], {env: environment(), encoding: 'utf8'});
    assert.equal(missing.status, 1); assert.match(missing.stderr, /Usage:/);
  } finally {f.cleanup();}
});

test('native interruption signals preserve the actual child exit or signal and retained diagnostics', async () => {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
    const f = fixture(); let worker = null;
    try {
      const ready = path.join(f.root, 'ready.json');
      const file = f.write('signal.test.cjs', `const fs=require('node:fs');require('node:test').test('interrupted actual case',async()=>{
        console.error('native signal diagnostic');fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));await new Promise(r=>setTimeout(r,10000));});`);
      const child = cp.spawn('bash', ['-c', 'ulimit -c 0\nexec "$@"', '--', process.execPath, reporter, 'signal', f.artifacts, '--', '--test', file], {cwd: f.root, env: environment()});
      let stderr = ''; child.stderr.on('data', chunk => {stderr += chunk;}); child.stdout.resume();
      const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
      // The file exists before its content is written; wait for the complete record.
      const started = () => {try {return JSON.parse(fs.readFileSync(ready)).pid;} catch {return null;}};
      for (let count = 0; !started() && count < 500; count++) await new Promise(resolve => setTimeout(resolve, 10));
      worker = started();
      assert.ok(worker, 'the actual native test must start before interruption');
      child.kill(signal); const result = await closed;
      const record = manifests(f)[0]; checkTrace(record);
      assert.equal(result.code, record.native_exit_code, JSON.stringify({result, record, stderr}));
      assert.equal(result.signal, record.native_signal);
      assert.ok(record.native_signal === signal || record.native_exit_code !== 0);
      assert.ok(record.forwarded_signals.includes(signal));
      assert.match(stderr, /Native tests failed/);
    } finally {
      if (worker) {try {process.kill(worker, 'SIGTERM');} catch (error) {if (error.code !== 'ESRCH') throw error;}}
      f.cleanup();
    }
  }
});

test('a zero native exit without a report is a reporting failure rather than a fabricated success artifact', () => {
  const f = fixture();
  try {
    const run = execute(f, 'no-report', ['--test', '--version']);
    assert.equal(run.status, 1); assert.match(run.stderr, /no complete trace/);
    const record = manifests(f)[0]; assert.equal(record.native_exit_code, 0); assert.equal(record.traces.spec, null);
    const raw = fs.readFileSync(record.traces.stdout.path, 'utf8');
    assert.ok(raw.startsWith(process.version)); assert.ok(run.stdout.startsWith(raw));
  } finally {f.cleanup();}
});


test('a real native spawn failure is retained as an execution error without inventing an exit status', async () => {
  const f = fixture();
  const chunks = []; const stream = () => new Writable({write(chunk, encoding, done) {chunks.push(chunk.toString()); done();}});
  try {
    const result = await reportTests({label: 'spawn-error', artifacts: f.artifacts, cwd: path.join(f.root, 'missing'),
      args: ['--test'], stdout: stream(), stderr: stream()});
    assert.equal(result.code, 1); assert.equal(result.spawnError.code, 'ENOENT');
    const record = manifests(f)[0]; checkTrace(record); assert.equal(record.native_pid, null);
    assert.equal(record.native_exit_code, null); assert.equal(record.traces.spec, null);
    assert.ok(chunks.join('').includes('ENOENT'));
  } finally {f.cleanup();}
});
