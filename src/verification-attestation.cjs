'use strict';
// A signed local receipt may attest the repository's whole declared verification.
//
// Local side: `evaluate` runs after the recipe's commands and refuses (throws) unless EVERY declared command ran and passed on the exact
// head, native coverage was observed in this run, and the coverage gate CI would enforce (exact, changed_lines or declared) passes.
// Only then does the signed verification record carry `attestation`. A review that cannot attest is never signed.
//
// CI side: `receiptAttests` answers whether the pull request's receipt is fully valid (signature, head, base, engine, expiry, sources)
// AND carries that attestation. Any other answer is false and the repository's own verification runs exactly as before.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const temporaryDirectories = require('./temp-dirs.cjs');

const VERSION = 1;
const GATE_MODES = ['exact', 'changed_lines', 'declared'];

const describe = command => {
  const text = command.argv.join(' ');
  const shown = text.length > 120 ? `${text.slice(0, 117)}...` : text;
  if (command.error) return `${shown} could not run (${command.error.code || command.error.message}); install the tool it needs`;
  if (command.signal) return `${shown} was stopped by ${command.signal}`;
  if (command.exit_code === null) return `${shown} did not exit`;
  return `${shown} exited ${command.exit_code}`;
};

// The attestation of a verification record, or null. A record attests only when it says so AND its own facts agree.
function attestationOf(technical) {
  const claim = technical?.attestation;
  const ok = claim && claim.version === VERSION && GATE_MODES.includes(claim.coverage_mode) && claim.gate === 'passed' &&
    Array.isArray(technical.commands) && technical.commands.length > 0 && claim.commands === technical.commands.length &&
    technical.verification_status === 'passed' && technical.commands.every(command => command.exit_code === 0 && !command.error && !command.signal) &&
    technical.coverage?.status !== 'unavailable' && technical.coverage?.artifact_freshness === 'observed_current_run' &&
    typeof technical.local_config_digest === 'string' && claim.recipe === technical.local_config_digest;
  return ok ? claim : null;
}

// Baseline totals of the base revision, measured the way the CI job measures them: the same recipe on a clean checkout of the base.
// The checkout lives under the work directory, not the system temp directory, so a recipe step that bind-mounts it into a
// container (Docker Compose under Colima, which shares only the home directory by default) sees the files.
function withBaseline({directory, baseSha, config, parts, verify, exec, gate, work}, use) {
  const temporary = temporaryDirectories.create('clouseau-base-', work);
  const tree = path.join(temporary, 'tree');
  try {
    exec('git', ['-C', directory, 'worktree', 'add', '--detach', tree, baseSha], {stdio: 'pipe'});
    const result = verify({directory: tree, config});
    if (result.verification_status !== 'passed') {
      throw new Error(`the base revision's own verification failed (${result.commands.filter(item => item.exit_code !== 0 || item.error).map(describe).join('; ')}), so no coverage baseline exists`);
    }
    const file = path.join(temporary, 'baseline.json');
    fs.writeFileSync(file, JSON.stringify(gate.measurePlan(parts, tree).totals));
    return use(file);
  } finally {
    try {exec('git', ['-C', directory, 'worktree', 'remove', '--force', tree], {stdio: 'pipe'});} catch { /* the temporary directory is removed next */ }
    temporaryDirectories.dispose(temporary);
  }
}

// Returns `technical` with its attestation, or throws naming exactly why a signature must not be issued.
function evaluate({directory, config, technical, ciConfig, baseSha, verify, exec = cp.execFileSync, work = temporaryDirectories.workDirectory()}) {
  const refuse = problems => {throw new Error(`Local verification is not complete on this head, so no receipt is signed: ${problems.join('; ')}`);};
  const failed = technical.commands.filter(command => command.exit_code !== 0 || command.error || command.signal);
  if (failed.length) refuse(failed.map(describe));
  if (technical.coverage.status === 'unavailable') refuse([`native coverage is unavailable (${technical.coverage.error || 'no report'}); install the coverage tool the recipe needs`]);
  if (technical.coverage.artifact_freshness !== 'observed_current_run') refuse(['the coverage report was not produced by this run']);
  const gate = require('./coverage-gate.cjs');
  const changed = require('./coverage-changed.cjs');
  const mode = changed.modeOf(ciConfig);
  try {
    if (mode === 'exact') {
      if (!technical.coverage.passed) throw new Error('line and branch coverage is not exactly 100%');
    } else {
      const parts = require('./coverage-plan.cjs').coverageParts(config);
      if (mode === 'declared') gate.declaredPlan(parts, directory, baseSha);
      else withBaseline({directory, baseSha, config, parts, verify, exec, gate, work}, file => gate.changedPlan(parts, directory, baseSha, file));
    }
  } catch (error) {
    refuse([`the ${mode} coverage gate fails: ${error.message}`]);
  }
  return {...technical, attestation: {version: VERSION, recipe: technical.local_config_digest, commands: technical.commands.length,
    coverage_mode: mode, gate: 'passed'}};
}

// CI: does this pull request carry a receipt that is valid in every respect and attests verification? Never throws on a
// receipt that does not verify; that is simply `false` (the repository then runs its checks itself). With `explain`, the
// answer is `{attests, rejected, detail}`: `rejected` is the fixed receipt class (receipt-rejection.cjs) when a claimed
// receipt was refused, else null, and `detail` holds only the values that class may show. The decision is the same.
async function receiptAttests(options) {
  const verdict = await attestationVerdict(options);
  return options.explain ? verdict : verdict.attests;
}

async function attestationVerdict({github, repo, pr, config, engine}) {
  const no = (rejected = null, detail = {}) => ({attests: false, rejected, detail});
  if (!config.local_review) return no();
  const receipts = require('./local-receipt.cjs');
  const {digest} = require('./acceptance.cjs');
  const {policyDigest} = require('./acceptance-controller.cjs');
  const screened = await receipts.screenReceipt({github, repo, pr, engine, trust: config.local_review, configDigest: digest(config), policyDigest: policyDigest()});
  if (!screened.ref) return no(screened.rejected ?? null, screened.detail ?? {});
  const files = await github.paginate(github.rest.pulls.listFiles, {...repo, pull_number: pr.number, per_page: 100});
  const rejected = await receipts.screenSources({github, repo, pr, snapshot: screened.verified.record.snapshot, config, files,
    reviewerSha: screened.bundle.payload.reviewer_sha});
  if (rejected) return no(rejected);
  const {sources} = screened.verified.record.snapshot;
  // The attested recipe must be the accepted base's own `.clouseau-local.json`, which screenSources bound to the base revision.
  // Under the protected `binding: "diff"` the receipt names its own base, so its recipe must also equal the live base's recipe:
  // a base move that changed the declared verification never lets CI skip the new one.
  const diff = config.local_review.binding === 'diff';
  const base = diff ? screened.verified.record.snapshot.base_sha : pr.base.sha;
  const recipe = Object.values(sources).find(item => item.path === '.clouseau-local.json' && item.ref === base);
  let technical = null;
  let accepted = null;
  try {
    technical = JSON.parse(sources.verification.content);
    accepted = digest(JSON.parse(recipe.content));
    if (diff) {
      const {data} = await github.rest.repos.getContent({...repo, path: '.clouseau-local.json', ref: pr.base.sha});
      if (digest(JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'))) !== accepted) return no();
    }
  } catch { return no(); }
  return {attests: attestationOf(technical) !== null && technical.local_config_digest === accepted, rejected: null, detail: {}};
}

// The decision the `attested` action operation publishes for a workflow's `if:` conditions.
async function decide({github, context, config, engine}) {
  const number = context.payload.pull_request?.number;
  if (!Number.isInteger(number)) throw new Error('A pull request context is required');
  const {data: pr} = await require('./pull-read.cjs').readPull(github, context.repo, number);
  if (pr.state !== 'open' || pr.draft || pr.base.ref !== config.base_branch) return false;
  return receiptAttests({github, repo: context.repo, pr, config, engine});
}

module.exports = {VERSION, GATE_MODES, attestationOf, evaluate, receiptAttests, decide};
