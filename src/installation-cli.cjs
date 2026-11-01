'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {digest} = require('./acceptance.cjs');
const {git, collectLocal, assertUnchanged, readLocalConfig} = require('./local-git.cjs');
const {refresh} = require('./acceptance-sources.cjs');
const {localReview} = require('./local-review.cjs');
const {askHarness, assertHarness} = require('./local-harness.cjs');
const {reconcile, priorState} = require('./acceptance-ledger.cjs');
const {issueReceipt, loadReceipt, verifySources} = require('./local-receipt.cjs');
const {validateConfig} = require('./config.cjs');
const {SOURCE} = require('./central-version.cjs');
const normal = require('./local-cli.cjs');
const bootstrap = require('./installation-bootstrap.cjs');
const {cliApi, githubFromApi} = require('./installation-github.cjs');

const COMMANDS = {
  'public-identity': ['identity'],
  'installation-engine': [],
  'installation-prepare': ['directory', 'base', 'request-file', 'identity', 'output'],
  'installation-authorize': ['manifest'],
  'installation-review': ['directory', 'manifest', 'grant-comment', 'harness', 'identity', 'output'],
  'installation-publish': ['directory', 'receipt'],
  'installation-check': ['repository', 'pull-request'],
};
const requireInput = (condition, message) => { if (!condition) throw new Error(`Initial installation: ${message}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function options(argv) {
  const [command, ...values] = argv;
  requireInput(Object.hasOwn(COMMANDS, command), 'unknown installation command');
  const args = {command};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index].slice(2);
    requireInput(values[index].startsWith('--') && COMMANDS[command].includes(key) && values[index + 1] && !args[key], 'invalid command arguments');
    args[key] = values[index + 1];
  }
  return args;
}

function readJson(filename, limit) {
  requireInput(filename, 'an explicit manifest or receipt file is required');
  const stat = fs.lstatSync(filename);
  requireInput(stat.isFile() && stat.size <= limit, 'complete regular metadata file required within its size budget');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function writeJson(filename, value, directory, replace = false) {
  const output = path.resolve(filename);
  requireInput(output !== directory && !output.startsWith(directory + path.sep), 'store installation evidence outside the checkout');
  fs.mkdirSync(path.dirname(output), {recursive: true, mode: 0o700});
  fs.writeFileSync(output, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: replace ? 'w' : 'wx'});
  return output;
}

function positive(value) {
  requireInput(/^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value)), 'a positive native GitHub identifier is required');
  return Number(value);
}

function verification({directory, config}) {
  // Contributor setup never inherits CI provider or repository-write tokens.
  // The established same-account workstation trust boundary remains unchanged.
  const env = normal.verificationEnvironment();
  return normal.executeVerification({directory, config, run: (program, argv, settings) => cp.spawnSync(program, argv, {...settings, env})});
}

async function runReview(args, {api, installed, state, clock, ask = askHarness, verify = verification}) {
  if (args.harness) assertHarness(args.harness);
  const directory = path.resolve(args.directory || process.cwd());
  const manifest = bootstrap.validateManifest(readJson(args.manifest, 60000), clock());
  const reviewer = installed();
  bootstrap.assertManifestLocal(directory, manifest, reviewer, clock());
  const grant = await bootstrap.verifyGrant({api, manifest, commentId: positive(args['grant-comment']), now: clock()});
  const exported = bootstrap.exportIdentity({identity: args.identity, state, directory});
  const {identity} = bootstrap.readIdentity(exported.identity_file);
  requireInput(digest(exported.public_identity) === digest(manifest.identity), 'identity differs from the explicit owner enrollment');
  const {local, config} = bootstrap.candidateConfiguration(directory, manifest.head_sha);
  const branch = git(directory, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const historyPath = path.join(state, 'installation-ledgers', `${digest({repository: manifest.repository, branch})}.json`);
  const previous = normal.readHistory(historyPath, manifest.repository, branch);
  if (previous) {
    requireInput(Number.isSafeInteger(previous.installation_attempts) && previous.installation_attempts >= 1 && previous.installation_attempts <= 3,
      'invalid preserved installation attempt history');
    const unchanged = previous.head_sha === manifest.head_sha && previous.base_sha === manifest.base_sha &&
      previous.reviewer_digest === reviewer.digest && previous.request_digest === digest(manifest.request);
    requireInput(!unchanged || previous.decision === 'auto_approve', 'this unchanged revision already has a negative review; repair it before reassessment');
  }
  const attempts = (previous?.installation_attempts || 0) + 1;
  requireInput(attempts <= 3, 'the initial installation exhausted its two repair cycles; retain the evidence and resolve the implementation attempt');
  const prior = previous?.findings || [];
  const cache = path.join(state, 'installation-reviews', digest({manifest, grant, harness: args.harness || 'codex', prior}));
  const journal = path.join(cache, 'observations.jsonl');
  requireInput(!fs.existsSync(journal), `this exact installation review already ran; inspect ${cache}`);
  const output = path.resolve(args.output || path.join(cache, 'record.json'));
  requireInput(output !== directory && !output.startsWith(directory + path.sep), 'store installation evidence outside the checkout');
  requireInput(!fs.existsSync(output), 'preserve the existing report and choose a new output path');
  const technical = verify({directory, config: local});
  const collected = collectLocal({directory, base: manifest.base_sha, request: manifest.request, technical, ciConfig: config,
    reviewerSha: reviewer.sha, installation: grant});
  collected.snapshot.prior_findings = prior;
  refresh(collected.snapshot);
  fs.mkdirSync(cache, {recursive: true, mode: 0o700});
  const pending = {version: 1, repository: manifest.repository, branch, head_sha: manifest.head_sha, base_sha: manifest.base_sha,
    reviewer_digest: reviewer.digest, request_digest: digest(manifest.request), cache_id: path.basename(cache),
    has_receipt: false, decision: 'review_incomplete', findings: prior, installation_attempts: attempts};
  // Preserve failed or incomplete harness attempts even when a new grant has
  // different timestamps. Renewing metadata is not new implementation evidence.
  writeJson(historyPath, pending, directory, true);
  const result = await localReview({...collected, ask: async task => {
    fs.appendFileSync(journal, JSON.stringify({role: task.role, phase: task.phase, status: 'started', request_digest: digest(task)}) + '\n', {mode: 0o600});
    const response = await ask({...task, harness: args.harness || 'codex'});
    fs.appendFileSync(journal, JSON.stringify({role: task.role, phase: task.phase, ...response}) + '\n', {mode: 0o600});
    return response;
  }});
  assertUnchanged(directory, collected.snapshot);
  const findings = reconcile(result, collected.snapshot, prior);
  if (findings.unresolved.length && result.decision === 'auto_approve') result.decision = 'review_incomplete';
  const record = {version: 2, snapshot: collected.snapshot, result, previous: {comment: null, findings: []},
    local_previous: {findings: prior}, controls: true, installation: grant, technical};
  writeJson(output, record, directory);
  const history = {...pending, decision: result.decision, findings: findings.findings};
  writeJson(historyPath, history, directory, true);
  let receipt = null;
  if (result.decision === 'auto_approve') {
    requireInput(digest(installed()) === digest(reviewer), 'shared engine changed during review; no receipt issued');
    bootstrap.assertManifestLocal(directory, manifest, reviewer, clock());
    const timestamp = clock();
    const bundle = issueReceipt({record, privateKey: identity.private_key, keyId: identity.id, issuer: identity.issuer,
      reviewerSha: reviewer.sha, reviewerDigest: reviewer.digest, now: timestamp,
      lifetime: Math.min(config.local_review.max_age_seconds, manifest.expires_at - Math.floor(timestamp / 1000))});
    await bootstrap.verifyInstallationReceipt(bundle, {api, grant, author: identity.github_actor,
      reviewerSha: reviewer.sha, reviewerDigest: reviewer.digest, now: clock()});
    receipt = writeJson(path.join(cache, 'receipt.json'), bundle, directory);
    writeJson(historyPath, {...history, has_receipt: true}, directory, true);
  }
  return {decision: result.decision, installation_only: true, manual_owner_acceptance_required: true,
    ordinary_pr_approval: false, record: output, receipt, head_sha: manifest.head_sha, base_sha: manifest.base_sha,
    reviewer_sha: reviewer.sha, provider_api_calls: 0, harness_invocations: result.usage.length, ...normal.reviewStatus(technical)};
}

async function remoteConfiguration(api, manifest) {
  const tree = async ref => {
    const value = await api('GET', `repos/${manifest.repository}/git/trees/${ref}?recursive=1`);
    requireInput(value.truncated === false && Array.isArray(value.tree), 'complete immutable control inventory is unavailable');
    return value.tree;
  };
  const base = await tree(manifest.base_sha);
  requireInput(!base.some(file => ['.clouseau-local.json', '.github/clouseau.json'].includes(file.path)), 'accepted configuration exists; bootstrap cannot replace ordinary policy');
  const head = await tree(manifest.head_sha);
  const contents = new Map();
  for (const file of manifest.files) {
    const entry = head.find(item => item.path === file.path);
    requireInput(entry?.type === 'blob' && ['100644', '100755'].includes(entry.mode), 'frozen controls must be regular immutable files');
    const value = await api('GET', `repos/${manifest.repository}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}?ref=${manifest.head_sha}`);
    requireInput(value.encoding === 'base64' && typeof value.content === 'string' && Number.isSafeInteger(value.size) &&
      value.size >= 0 && value.size <= 300000, 'complete frozen control source is unavailable');
    const bytes = Buffer.from(value.content, 'base64');
    requireInput(bytes.length === value.size && require('node:crypto').createHash('sha256').update(bytes).digest('hex') === file.sha256, 'authorized control source changed');
    contents.set(file.path, new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  }
  const local = readLocalConfig(JSON.parse(contents.get('.clouseau-local.json')));
  const config = validateConfig(JSON.parse(contents.get('.github/clouseau.json')));
  bootstrap.bindConfiguration(local, config, manifest.identity, manifest.reviewer_digest);
  requireInput(digest(local) === manifest.local_config_digest && digest(config) === manifest.config_digest &&
    digest(bootstrap.controlPaths(local, config, head.map(file => file.path))) === digest(manifest.files.map(file => file.path)),
  'authorized recipe, policy or complete control inventory differs');
  return config;
}

function readyPull(pr, manifest) {
  requireInput(pr.state === 'open' && !pr.draft && !pr.auto_merge && pr.user?.type === 'User' &&
    pr.user.login === manifest.identity.github_actor && pr.head?.repo?.full_name === manifest.repository &&
    Number.isSafeInteger(pr.number) && pr.number > 0 && Number.isSafeInteger(pr.head.repo.id) && pr.head.repo.id > 0 &&
    pr.base?.ref === manifest.base_branch && pr.base.sha === manifest.base_sha && pr.head.sha === manifest.head_sha,
  'initial trust requires a ready owner-authored exact-revision internal PR with automatic merge disabled');
}

async function check(args, {api, installed, clock, maxPolls = 240, pause = wait}) {
  requireInput(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(args.repository || ''), 'an explicit GitHub repository is required');
  const [owner, name] = args.repository.split('/');
  const repo = {owner, repo: name};
  const number = positive(args['pull-request']);
  const github = githubFromApi(api);
  const getPull = async () => {
    const pr = (await github.rest.pulls.get({...repo, pull_number: number})).data;
    requireInput(pr.number === number, 'native PR identity differs from the requested pull request');
    return pr;
  };
  const pr = await getPull();
  const ref = bootstrap.installationMarker(pr.body);
  const bundle = await loadReceipt({github, repo, ref});
  const grant = bundle?.payload?.record?.installation;
  requireInput(grant?.manifest?.repository === args.repository, 'the signed installation belongs to another repository or is incomplete');
  const manifest = grant.manifest;
  readyPull(pr, manifest);
  const reviewer = installed();
  requireInput(reviewer.clean, 'trusted read-only checker source is modified');
  const expected = {api, grant, author: pr.user.login, reviewerSha: reviewer.sha, reviewerDigest: reviewer.digest, now: clock()};
  const verified = await bootstrap.verifyInstallationReceipt(bundle, expected);
  const config = await remoteConfiguration(api, manifest);
  const repository = await api('GET', `repos/${args.repository}`);
  const base = await api('GET', `repos/${args.repository}/branches/${encodeURIComponent(manifest.base_branch)}`);
  requireInput(!(repository.private && !base.protected) || (['manual', 'automatic'].includes(config.merge_mode) && repository.allow_auto_merge === false),
    'unprotected private installations require explicit manual or strict owner automatic mode and disabled repository auto-merge');
  const files = await github.paginate(github.rest.pulls.listFiles, {...repo, pull_number: number, per_page: 100});
  await verifySources({github, repo, pr, snapshot: verified.record.snapshot, config, files, reviewerSha: reviewer.sha, installation: grant});
  const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number: number, per_page: 100});
  const previous = priorState(comments, manifest.repository, number);
  requireInput(previous.comment === null && previous.findings.length === 0, 'initial trust cannot discard an existing review ledger');
  const policy = require('./policy.cjs').createPolicy(config,
    {engine: {...SOURCE, sha: reviewer.sha, digest: reviewer.digest}});
  let technical;
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    readyPull(await getPull(), manifest);
    technical = await policy.technicalRun(github, repo, pr, {receipt: true});
    if (!technical.pending) break;
    await pause(15000);
  }
  requireInput(technical && !technical.pending && !technical.failure && technical.event === 'pull_request' &&
    technical.head_sha === manifest.head_sha && technical.conclusion === 'success' &&
    Number.isSafeInteger(technical.run_id) && technical.run_id > 0 && Number.isSafeInteger(technical.attempt) && technical.attempt > 0 &&
    Number.isSafeInteger(technical.job?.id) && technical.job.id > 0,
  'independent exact-head PR-event CI verification is pending, failed or incomplete');
  await bootstrap.verifyInstallationReceipt(bundle, {...expected, now: clock()});
  readyPull(await getPull(), manifest);
  return {installation_verified: true, manual_owner_acceptance_required: true, ordinary_pr_approval: false,
    auto_merge_authorized: false, head_sha: manifest.head_sha, base_sha: manifest.base_sha,
    reviewer_sha: reviewer.sha, reviewer_digest: reviewer.digest, record_digest: digest(verified.record),
    provider_api_calls: 0, technical};
}

async function main(argv, runtime = {}) {
  const args = options(argv);
  const context = {api: runtime.api || cliApi(runtime.execute), installed: runtime.installed || normal.installation,
    state: runtime.state || normal.stateDirectory(), clock: runtime.clock || Date.now, ...runtime};
  const directory = path.resolve(args.directory || process.cwd());
  if (args.command === 'public-identity') return bootstrap.exportIdentity({identity: args.identity, state: context.state});
  if (args.command === 'installation-engine') {
    const reviewer = context.installed();
    return {reviewer_sha: reviewer.sha, reviewer_digest: reviewer.digest, unmodified: reviewer.clean};
  }
  if (args.command === 'installation-prepare') {
    requireInput(args['request-file'] && args.output, 'preparation requires --request-file and --output outside the checkout');
    const exported = bootstrap.exportIdentity({identity: args.identity, state: context.state, directory});
    const manifest = bootstrap.prepareManifest({directory, base: args.base, request: fs.readFileSync(args['request-file'], 'utf8'),
      enrollment: exported.public_identity, reviewer: context.installed(), now: context.clock()});
    return {manifest: writeJson(args.output, manifest, directory), pending_owner_authorization: true,
      manifest_digest: digest(manifest), authorization_body: bootstrap.grantBody(manifest)};
  }
  if (args.command === 'installation-authorize') return bootstrap.authorizeManifest({api: context.api,
    manifest: bootstrap.validateManifest(readJson(args.manifest, 60000), context.clock()), now: context.clock()});
  if (args.command === 'installation-review') return runReview(args, context);
  if (args.command === 'installation-publish') {
    const bundle = readJson(args.receipt, require('./local-receipt.cjs').MAX_RECEIPT_BYTES);
    const grant = bundle?.payload?.record?.installation;
    requireInput(grant, 'a signed installation receipt is required');
    const reviewer = context.installed();
    bootstrap.assertManifestLocal(directory, grant.manifest, reviewer, context.clock());
    await bootstrap.verifyInstallationReceipt(bundle, {api: context.api, grant, author: grant.actor,
      reviewerSha: reviewer.sha, reviewerDigest: reviewer.digest, now: context.clock()});
    const {artifact_commit} = (context.publish || normal.publishReceipt)({directory, receipt: args.receipt});
    return {artifact_commit, installation_only: true, marker: `<!-- clouseau-installation-review:v1 ${artifact_commit} -->`};
  }
  return check(args, context);
}

module.exports = {options, readJson, writeJson, positive, verification, runReview, remoteConfiguration, readyPull, check, main};
