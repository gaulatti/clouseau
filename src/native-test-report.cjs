'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {pipeline} = require('node:stream/promises');

const hashFile = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
async function describe(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return {path: filename, bytes: fs.statSync(filename).size, sha256: hash.digest('hex')};
}

async function reportTests({label, artifacts, args, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr}) {
  if (!/^[a-z][a-z0-9-]*$/.test(label) || !Array.isArray(args) || !args.includes('--test') ||
      args.some(arg => typeof arg !== 'string' || arg === '--test-reporter' || arg.startsWith('--test-reporter=') && arg !== '--test-reporter=lcov')) {
    throw new Error('Native test reporting requires a label, --test and unchanged test arguments; dot/spec reporters are controller-owned');
  }
  const root = path.resolve(artifacts);
  fs.mkdirSync(root, {recursive: true});
  const directory = fs.mkdtempSync(path.join(root, `${label}-`));
  fs.chmodSync(directory, 0o700);
  const spec = path.join(directory, 'native.spec.log');
  const outPath = path.join(directory, 'native.stdout');
  const errPath = path.join(directory, 'native.stderr');
  const out = fs.openSync(outPath, 'wx', 0o600), err = fs.openSync(errPath, 'wx', 0o600);
  const argv = ['--test-reporter=dot', '--test-reporter-destination=stdout',
    '--test-reporter=spec', `--test-reporter-destination=${spec}`, ...args];
  const started = new Date().toISOString();
  const reporter = {path: __filename, sha256: hashFile(__filename)};
  fs.writeFileSync(path.join(directory, 'started.json'), JSON.stringify({version: 1, run_id: path.basename(directory),
    started_at: started, reporter, cwd, executable: process.execPath, node_version: process.version, argv}) + '\n', {flag: 'wx', mode: 0o600});
  const child = spawn(process.execPath, argv, {cwd, stdio: ['inherit', 'pipe', 'pipe']});
  let spawnError = null;
  child.once('error', error => {spawnError = {code: error.code, message: error.message};});
  child.stdout.on('data', chunk => {fs.writeFileSync(out, chunk); stdout.write(chunk);});
  child.stderr.on('data', chunk => {fs.writeFileSync(err, chunk); stderr.write(chunk);});
  const forwardedSignals = [];
  const handlers = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'].map(signal => [signal, () => {forwardedSignals.push(signal); child.kill(signal);}]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const [code, signal] = await new Promise(resolve => child.once('close', (...result) => resolve(result)));
  for (const [name, handler] of handlers) process.off(name, handler);
  fs.closeSync(out); fs.closeSync(err);
  const nativeCode = spawnError ? null : code;
  const traces = {stdout: await describe(outPath), stderr: await describe(errPath), spec: fs.existsSync(spec) ? await describe(spec) : null};
  const manifest = {version: 1, run_id: path.basename(directory), started_at: started, finished_at: new Date().toISOString(),
    reporter, cwd, executable: process.execPath, node_version: process.version, forwarded_signals: forwardedSignals, native_pid: child.pid ?? null, argv, native_exit_code: nativeCode, native_signal: signal, spawn_error: spawnError, traces};
  const manifestPath = path.join(directory, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  if (nativeCode !== 0) {
    stderr.write(`\nNative tests failed (${signal || spawnError?.code || code}); full same-run trace follows.\n`);
    if (traces.spec) await pipeline(fs.createReadStream(spec), stderr, {end: false});
    if (spawnError) stderr.write(`${spawnError.code}: ${spawnError.message}\n`);
  }
  const reference = traces.spec ? `Native trace: ${spec} sha256=${traces.spec.sha256}` : 'Native trace unavailable; inspect retained stdout/stderr';
  await new Promise(resolve => stderr.write('', resolve));
  await new Promise(resolve => stdout.write(`\n${reference}\nNative manifest: ${manifestPath} sha256=${hashFile(manifestPath)}\n`, resolve));
  if (!traces.spec && code === 0) throw new Error('Native reporter produced no complete trace');
  return {code: spawnError ? 1 : code, signal, spawnError, manifestPath};
}

async function main() {
  const [label, artifacts, separator, ...args] = process.argv.slice(2);
  if (separator !== '--') throw new Error('Usage: native-test-report.cjs LABEL ARTIFACT_DIRECTORY -- NODE_TEST_ARGUMENTS');
  const result = await reportTests({label, artifacts, args});
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code;
}
if (require.main === module) main().catch(error => {process.stderr.write(`${error.message}\n`); process.exitCode = 1;});
module.exports = {reportTests};
