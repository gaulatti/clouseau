'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const {digest} = require('./acceptance.cjs');
const {git, githubRepository, readLocalConfig, collectLocal, assertUnchanged} = require('./local-git.cjs');
const {localReview} = require('./local-review.cjs');
const {askHarness} = require('./local-harness.cjs');
const {issueReceipt, verifyReceipt} = require('./local-receipt.cjs');
const {engineDigest} = require('./local-version.cjs');
const {SOURCE, acceptsEngine} = require('./central-version.cjs');
const {reconcile} = require('./acceptance-ledger.cjs');
const {refresh, safePath} = require('./acceptance-sources.cjs');
const {coverageParts} = require('./coverage-plan.cjs');
const {AGENTS, AwaitingAgent, createExchange, respond} = require('./local-agent.cjs');
const gate = require('./coverage-gate.cjs');

const root = path.join(__dirname, '..');
const stateDirectory = () => path.join(os.homedir(), '.local/share/clouseau');

function options(argv) {
  const [command, ...args] = argv;
  const parsed = {command};
  const allowed = ['directory', 'base', 'harness', 'agent', 'request-file', 'output', 'identity', 'receipt', 'additional-checks',
    'agent-request', 'answer', 'session'];
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].slice(2);
    if (!args[i].startsWith('--') || !allowed.includes(name) || !args[i + 1] || parsed[name]) throw new Error('Invalid Clouseau local arguments');
    parsed[name] = args[i + 1];
  }
  return parsed;
}

function initializeIdentity(directory = stateDirectory(), githubActor) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(githubActor || '')) throw new Error('An authenticated GitHub actor is required for identity enrollment');
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({type: 'spki', format: 'pem'});
  const id = digest(publicKey).slice(0, 24);
  const filename = path.join(directory, `${id}.json`);
  const publicIdentity = {id, issuer: `local-${id}`, github_actor: githubActor, public_key: publicKey, revoked: false};
  fs.writeFileSync(filename, JSON.stringify({...publicIdentity,
    private_key: keys.privateKey.export({type: 'pkcs8', format: 'pem'})}), {mode: 0o600, flag: 'wx'});
  return {identity_file: filename, public_identity: publicIdentity};
}

function verificationEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)));
}

function executeVerification({directory, config, additional = [], run = cp.spawnSync}) {
  const env = verificationEnvironment();
  const parts = coverageParts(config, {allowUnsupported: true});
  const commands = [];
  const directoryRoot = fs.realpathSync(directory);
  const observe = part => {
    try {
      const filename = path.join(directory, part.report);
      const resolved = fs.realpathSync(filename);
      if (!resolved.startsWith(directoryRoot + path.sep)) return {report_digest: null, error: 'Coverage artifact escapes the checkout'};
      const stat = fs.statSync(filename, {bigint: true});
      if (!stat.isFile()) return {report_digest: null, error: 'Coverage artifact is not a regular file'};
      return {report_digest: digest(fs.readFileSync(filename, 'utf8')),
        stamp: digest([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String))};
    } catch (error) {
      return {report_digest: null, error: error.code || 'Coverage artifact is unavailable'};
    }
  };
  const before = parts.map(observe);
  const execute = argv => {
    let result;
    try {result = run(argv[0], argv.slice(1), {cwd: directory, encoding: 'utf8', timeout: 300000, maxBuffer: 3000000, env}) || {status: null, error: new Error('Verification process returned no result')};}
    catch (error) {result = {status: null, error};}
    const stdout = result.stdout || ''; const stderr = result.stderr || '';
    // Signing material must never become model evidence, including on failure.
    if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(stdout + stderr)) throw new Error('Private signing material appeared in verification output; it cannot enter review evidence');
    commands.push({argv, exit_code: Number.isInteger(result.status) ? result.status : null,
      stdout_digest: digest(stdout), stderr_digest: digest(stderr), stdout, stderr,
      ...(result.error ? {error: {code: result.error.code || null, message: result.error.message}} : {}),
      ...(result.signal ? {signal: result.signal} : {})});
  };
  for (const argv of config.verification) execute(argv);
  const observed = parts.map(observe);
  const reports = parts.map((part, index) => ({...part, report_digest: observed[index].report_digest}));
  const fresh = observed.every((part, index) => !part.error && part.stamp !== before[index].stamp);
  let measured = null;
  let coverageError = observed.find(part => part.error)?.error;
  if (!coverageError) {
    try {
      measured = config.version === 1 ?
        gate.measure(gate.readReport(parts[0].format, path.join(directory, parts[0].report)), path.join(directory, parts[0].source_directory), parts[0].format, directory) :
        gate.measurePlan(parts, directory);
    } catch (error) {coverageError = error.message || 'Native coverage could not be measured';}
  }
  for (const argv of additional) execute(argv);
  if (additional.length && observed.some((part, index) => digest(part) !== digest(observe(parts[index])))) {
    throw new Error('Additional checks changed accepted coverage artifacts');
  }
  const counts = measured && (config.version === 1 ? measured : measured.totals);
  const exact = counts && counts.lines[0] > 0 && ['lines', 'branches'].every(metric => counts[metric][0] === counts[metric][1]);
  const verification = {commands, verification_status: commands.every(command => command.exit_code === 0 && !command.error) ? 'passed' : 'failed',
    exact_coverage: counts, coverage: {status: coverageError ? 'unavailable' : exact ? 'exact' : 'below_threshold',
      passed: Boolean(exact && fresh), artifact_freshness: fresh ? 'observed_current_run' : 'unverified',
      ...(coverageError ? {error: coverageError} : {})}, local_config_digest: digest(config)};
  if (config.version === 1) return {...verification, report_digest: reports[0].report_digest};
  return {...verification, coverage_reports: reports.map((part, index) => ({...part,
    exact_coverage: measured ? measured.parts[index].counts : null})), report_digest: digest(reports)};
}

function reviewStatus(technical = {}) {
  return {decision_scope: 'review_reuse_only', independent_ci_required: true, merge_authority: false,
    local_verification: {commands: technical.verification_status || 'unavailable', coverage: technical.coverage || {status: 'unavailable', passed: false}}};
}

function installation() {
  return {sha: git(root, ['rev-parse', 'HEAD']).trim(), digest: engineDigest(), clean: !git(root, ['status', '--porcelain']).trim()};
}

function readHistory(filename, repository, branch) {
  if (!fs.existsSync(filename)) return null;
  const text = fs.readFileSync(filename, 'utf8');
  if (text.length > 250000) throw new Error('Local finding history exceeds its evidence budget');
  const value = JSON.parse(text);
  if (value.version !== 1 || value.repository !== repository || value.branch !== branch ||
    !/^[a-f0-9]{40}$/.test(value.head_sha) || !/^[a-f0-9]{40}$/.test(value.base_sha) ||
    (value.reviewer_sha !== undefined && !/^[a-f0-9]{40}$/.test(value.reviewer_sha)) ||
    !/^[a-f0-9]{64}$/.test(value.reviewer_digest) || !/^[a-f0-9]{64}$/.test(value.request_digest) ||
    !/^[a-f0-9]{64}$/.test(value.cache_id) || typeof value.has_receipt !== 'boolean' ||
    !['auto_approve', 'repair_required', 'review_incomplete', 'owner_decision', 'blocked_integrity'].includes(value.decision) ||
    !Array.isArray(value.findings) || value.findings.some(item =>
      !/^[a-f0-9]{64}$/.test(item.id) || typeof item.blocking !== 'boolean' || !safePath(item.path) ||
      !['title', 'cause', 'obligation'].every(key => typeof item[key] === 'string' && item[key].length > 0 && item[key].length <= 2000))) {
    throw new Error('Invalid local finding history; preserve it and investigate before reviewing');
  }
  return value;
}

async function runReview(args, {ask = askHarness, verify = executeVerification, state = stateDirectory(), installed = installation} = {}) {
  const directory = path.resolve(args.directory || process.cwd());
  if (!args['request-file']) throw new Error('An explicit requirement file is required');
  const agent = args.agent;
  if (agent && args.harness) throw new Error('Choose either --agent (inside an AI harness) or --harness (headless), not both');
  if (agent && !AGENTS.includes(agent)) throw new Error(`Supported agent harnesses: ${AGENTS.join(', ')}`);
  const base =args.base || `origin/${readLocalConfig(JSON.parse(git(directory, ['show', 'HEAD:.clouseau-local.json']))).base_branch}`;
  const config = readLocalConfig(JSON.parse(git(directory, ['show', `${base}:.clouseau-local.json`])));
  const head = git(directory, ['rev-parse', 'HEAD']).trim();
  const repo = githubRepository(directory);
  const repository = `${repo.owner}/${repo.repo}`;
  if (git(directory, ['status', '--porcelain']).trim()) throw new Error('Commit the complete change before local review');
  const reviewer = installed();
  const reviewerSha = reviewer.sha;
  const engine = {...SOURCE, sha: reviewer.sha, digest: reviewer.digest};
  const request = fs.readFileSync(args['request-file'], 'utf8');
  if (!request.trim() || request.length > 20000) throw new Error('A bounded, nonempty requirement is required');
  const additionalText = args['additional-checks'] ? fs.readFileSync(args['additional-checks'], 'utf8') : '[]';
  if (additionalText.length > 8000) throw new Error('Additional local checks exceed the input budget');
  const additional = JSON.parse(additionalText);
  if (!Array.isArray(additional) || additional.length > 8) throw new Error('Additional local checks require at most eight argument arrays');
  if (additional.length) readLocalConfig({...config, verification: additional});
  const requestDigest = additional.length ? digest({request, additional}) : digest(request);
  let ciConfig = null;
  if (git(directory, ['ls-tree', base, '--', '.github/clouseau.json']).trim()) {
    const parsed = JSON.parse(git(directory, ['show', `${base}:.github/clouseau.json`]));
    ciConfig = require('./config.cjs').validateConfig(parsed);
  }
  let identityPath = args.identity;
  if (!identityPath && ciConfig?.local_review) {
    const available = ciConfig.local_review.keys.filter(key => !key.revoked)
      .map(key => path.join(state, `${key.id}.json`)).filter(filename => fs.existsSync(filename));
    if (available.length > 1) throw new Error('Multiple enrolled identities are installed; select one explicitly');
    identityPath = available[0];
  }
  if (identityPath && !reviewer.clean) throw new Error('Signing requires an unmodified Clouseau checkout');
  const baseSha = git(directory, ['rev-parse', base]).trim();
  const branch = git(directory, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const historyPath = path.join(state, 'ledgers', `${digest({repository, branch})}.json`);
  const previous = readHistory(historyPath, repository, branch);
  const priorFindings = previous?.findings || [];
  const sameRevision = previous && previous.head_sha === head && previous.base_sha === baseSha && previous.reviewer_digest === reviewer.digest;
  if (sameRevision && previous.decision !== 'auto_approve') {
    throw new Error('This revision already has a non-passing local review; repair the implementation or trusted evidence before reassessing');
  }
  let cacheId = digest({repository, head, base: baseSha, reviewerSha, reviewerDigest: reviewer.digest,
    request, config, ciConfig, harness: agent ? `agent:${agent}` : args.harness || 'codex', priorFindings, ...(additional.length ? {additional} : {})});
  if (sameRevision && previous.reviewer_sha === reviewerSha && previous.request_digest === requestDigest) cacheId = previous.cache_id;
  const cache = path.join(state, 'reviews', cacheId);
  const journal = path.join(cache, 'observations.jsonl');
  const cachedReceipt = path.join(cache, 'receipt.json');
  if (ciConfig?.local_review && fs.existsSync(cachedReceipt)) {
    const bundle = JSON.parse(fs.readFileSync(cachedReceipt, 'utf8'));
    const key = ciConfig.local_review.keys.find(item => item.id === bundle.payload.key_id);
    const verified = verifyReceipt(bundle, {engine, trust: ciConfig.local_review, repository,
      author: key?.github_actor, headSha: head, baseSha: git(directory, ['rev-parse', base]).trim(),
      reviewerDigest: reviewer.digest, configDigest: digest(ciConfig),
      policyDigest: digest(fs.readFileSync(path.join(root, 'policy/change-acceptance.md'), 'utf8'))});
    assertUnchanged(directory, verified.record.snapshot);
    return {decision: 'auto_approve', record: path.join(cache, 'record.json'), receipt: cachedReceipt,
      head_sha: head, base_sha: verified.record.snapshot.base_sha, reviewer_sha: bundle.payload.reviewer_sha,
      provider_api_calls: 0, harness_invocations: 0, reused: true, ...reviewStatus(verified.record.technical)};
  }
  const agentDirectory = path.join(cache, 'agent');
  // An unfinished agent exchange resumes from its recorded evidence; any other prior journal means the input already ran.
  const resuming = Boolean(agent) && fs.existsSync(path.join(agentDirectory, 'technical.json')) &&
    !fs.existsSync(path.join(agentDirectory, 'completed.json'));
  if (fs.existsSync(journal) && !resuming) throw new Error(`This exact review input has already run; inspect ${cache}. Change the implementation or evidence before another AI review.`);
  const output = path.resolve(args.output || path.join(cache, 'record.json'));
  if (output.startsWith(directory + path.sep)) throw new Error('Store review evidence outside the source checkout');
  let identity = null;
  if (identityPath) {
    if (fs.statSync(identityPath).mode & 0o077) throw new Error('Signing identity permissions must be private');
    identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    if (!ciConfig?.local_review || !acceptsEngine(ciConfig.local_review, engine) ||
      !ciConfig.local_review.keys.some(key => !key.revoked && key.id === identity.id &&
        key.issuer === identity.issuer && key.github_actor === identity.github_actor && key.public_key === identity.public_key)) {
      throw new Error('The signer and reviewer revision must already be enrolled in the protected CI configuration');
    }
  }
  const technicalPath = path.join(agentDirectory, 'technical.json');
  let technical;
  if (resuming) technical = JSON.parse(fs.readFileSync(technicalPath, 'utf8'));
  else {
    technical = verify({directory, config, additional});
    if (agent) {
      // The agent exchange spans several commands; persist the one real verification so later commands cannot rerun it.
      technical = JSON.parse(JSON.stringify(technical));
      fs.mkdirSync(agentDirectory, {recursive: true, mode: 0o700});
      fs.writeFileSync(technicalPath, JSON.stringify(technical), {mode: 0o600});
    }
  }
  if (git(directory, ['rev-parse', 'HEAD']).trim() !== head) throw new Error('Source changed during local verification');
  const collected = collectLocal({directory, base, request, technical, ciConfig, reviewerSha});
  collected.snapshot.prior_findings = priorFindings;
  refresh(collected.snapshot);
  fs.mkdirSync(cache, {recursive: true, mode: 0o700});
  if (agent) {
    const frozen = path.join(agentDirectory, 'snapshot.digest');
    if (!fs.existsSync(frozen)) fs.writeFileSync(frozen, collected.snapshot.digest, {mode: 0o600});
    else if (fs.readFileSync(frozen, 'utf8') !== collected.snapshot.digest) {
      throw new Error(`Source or evidence changed since this agent exchange began; evidence preserved in ${agentDirectory}`);
    }
  }
  const exchange = agent ? createExchange({directory: agentDirectory, agent,
    journal: entry => fs.appendFileSync(journal, JSON.stringify(entry) + '\n', {mode: 0o600})}) : null;
  let result;
  try {
    result = await localReview({...collected, ask: async task => {
    fs.writeFileSync(path.join(cache, 'snapshot.json'), JSON.stringify(collected.snapshot, null, 2) + '\n', {mode: 0o600});
    if (exchange) return exchange.ask(task);
    fs.appendFileSync(journal, JSON.stringify({role: task.role, phase: task.phase, status: 'started',
      request_digest: digest(task)}) + '\n', {mode: 0o600});
    const response = await ask({...task, harness: args.harness || 'codex'});
    fs.appendFileSync(journal, JSON.stringify({role: task.role, phase: task.phase, ...response}) + '\n', {mode: 0o600});
    return response;
    }});
  } catch (error) {
    if (error instanceof AwaitingAgent) {
      return {status: 'awaiting_agent', ...error.info, reviewer_sha: reviewerSha, provider_api_calls: 0, harness_invocations: 0,
        respond: `clouseau respond --agent-request ${error.info.request_file} --answer ${error.info.answer_file} --session FRESH_SESSION_ID`,
        then: 'Repeat the identical review command. If Clouseau main advanced, the review restarts under the new revision.'};
    }
    fs.writeFileSync(path.join(cache, 'failure.json'), JSON.stringify({failure: error.message,
      harness: error.harnessDiagnostic || null}, null, 2) + '\n', {mode: 0o600});
    error.message += `; preserved review evidence: ${cache}`; throw error;
  }
  if (agent) fs.writeFileSync(path.join(agentDirectory, 'completed.json'), '{}\n', {mode: 0o600});
  assertUnchanged(directory, collected.snapshot);
  const findings = reconcile(result, collected.snapshot, priorFindings);
  if (findings.unresolved.length && result.decision === 'auto_approve') result.decision = 'review_incomplete';
  const record = {version: 2, snapshot: collected.snapshot, result, previous: {comment: null, findings: []},
    local_previous: {findings: priorFindings}, controls: false, technical};
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n', {mode: 0o600});
  let receipt = null;
  if (result.decision === 'auto_approve' && identity) {
    if (digest(installed()) !== digest(reviewer)) throw new Error('Clouseau installation changed during review; no receipt issued');
    const bundle = issueReceipt({record, privateKey: identity.private_key, keyId: identity.id,
      issuer: identity.issuer, reviewerSha, reviewerDigest: reviewer.digest});
    verifyReceipt(bundle, {engine, trust: ciConfig.local_review, repository: collected.snapshot.repository, author: identity.github_actor,
      headSha: head, baseSha: collected.snapshot.base_sha, reviewerSha, reviewerDigest: reviewer.digest,
      configDigest: collected.snapshot.config_digest, policyDigest: collected.snapshot.policy_digest});
    receipt = path.join(cache, 'receipt.json');
    fs.writeFileSync(receipt, JSON.stringify(bundle, null, 2) + '\n', {mode: 0o600});
  }
  fs.mkdirSync(path.dirname(historyPath), {recursive: true, mode: 0o700});
  fs.writeFileSync(historyPath, JSON.stringify({version: 1, repository, branch, head_sha: head, base_sha: baseSha,
    reviewer_sha: reviewerSha, reviewer_digest: reviewer.digest, request_digest: requestDigest, cache_id: cacheId,
    has_receipt: Boolean(receipt), decision: result.decision, findings: findings.findings}), {mode: 0o600});
  return {decision: result.decision, record: output, receipt, head_sha: head,
    base_sha: collected.snapshot.base_sha, reviewer_sha: reviewerSha, provider_api_calls: 0,
    harness_invocations: result.usage.length, ...reviewStatus(technical)};
}

function publishReceipt({directory, receipt}) {
  const bundle = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  const {payload} = bundle;
  assertUnchanged(directory, payload.record.snapshot);
  const blob = git(directory, ['hash-object', '-w', '--stdin'], JSON.stringify(bundle) + '\n').trim();
  const tree = git(directory, ['mktree'], `100644 blob ${blob}\tclouseau-review.json\n`).trim();
  const commit = git(directory, ['-c', 'user.name=Clouseau', '-c', 'user.email=clouseau@localhost', 'commit-tree', tree],
    `Authenticated local review of ${payload.record.snapshot.head_sha}\n`).trim();
  git(directory, ['push', 'origin', `${commit}:refs/tags/clouseau-review/${payload.nonce}`]);
  return {artifact_commit: commit, marker: `<!-- clouseau-local-review:v1 ${commit} -->`};
}

async function main(argv, runtime = {}) {
  if (argv[0] === 'public-identity' || argv[0]?.startsWith('installation-')) return require('./installation-cli.cjs').main(argv, runtime);
  const args = options(argv);
  if (args.command === 'init-identity') return initializeIdentity(runtime.identityDirectory,
    (runtime.execute || cp.execFileSync)('gh', ['api', 'user', '--jq', '.login'], {encoding: 'utf8'}).trim());
  if (args.command === 'review') return runReview(args, runtime);
  if (args.command === 'respond') return respond({request: args['agent-request'], answer: args.answer, session: args.session});
  if (args.command === 'publish' && args.directory && args.receipt) return publishReceipt(args);
  throw new Error('Usage: clouseau init-identity | review --request-file FILE [--directory PATH --base REF --agent claude|codex|opencode | --harness codex|claude --identity FILE --additional-checks FILE] | respond --agent-request FILE --answer FILE --session ID | publish --directory PATH --receipt FILE');
}

module.exports = {options, stateDirectory, initializeIdentity, verificationEnvironment, executeVerification, reviewStatus, installation, readHistory, runReview, publishReceipt, main};
