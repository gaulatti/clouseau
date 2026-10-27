'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fixture} = require('../test/bootstrap-fixture.cjs');
const {harness} = require('../test/bootstrap-cli-fixture.cjs');
const {git} = require('./local-git.cjs');
const bootstrap = require('./installation-bootstrap.cjs');
const cli = require('./installation-cli.cjs');
const {verifyReceipt} = require('./local-receipt.cjs');

test('initial review executes real Python tests and native coverage before signing, without inheriting provider credentials', () => fixture(async f => {
  const manifestFile = path.join(f.temporary, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(f.manifest));
  const args = {directory: f.directory, manifest: manifestFile, 'grant-comment': String(f.grant.comment_id)};
  const runtime = {api: f.api, installed: () => f.reviewer, state: f.state, clock: () => f.now, ask: harness()};
  const previous = process.env.CLOUSEAU_FIXTURE_PROVIDER_KEY;
  process.env.CLOUSEAU_FIXTURE_PROVIDER_KEY = 'fixture-must-not-reach-contributor-tests';
  try {
    const result = await cli.runReview(args, runtime);
    assert.equal(result.decision, 'auto_approve');
    assert.equal(result.installation_only, true);
    assert.equal(result.ordinary_pr_approval, false);
    assert.equal(result.manual_owner_acceptance_required, true);
    assert.equal(result.provider_api_calls, 0);
    assert.equal(runtime.ask.calls(), 2, 'semantic answers are explicitly deterministic test fixtures');
    const record = JSON.parse(fs.readFileSync(result.record));
    assert.deepEqual(record.technical.exact_coverage, {lines: [4, 4], branches: [2, 2]});
    assert.equal(record.technical.commands.length, 2);
    assert.equal(record.technical.commands.every(command => command.exit_code === 0), true);
    assert.equal(git(f.directory, ['status', '--porcelain']), '');
    const signed = JSON.parse(fs.readFileSync(result.receipt));
    assert.equal((await bootstrap.verifyInstallationReceipt(signed, f.options())).decision, 'auto_approve');
    assert.throws(() => verifyReceipt(signed, {trust: f.config.local_review, repository: f.manifest.repository,
      author: f.manifest.identity.github_actor, headSha: f.head, baseSha: f.base,
      reviewerSha: f.reviewer.sha, reviewerDigest: f.reviewer.digest,
      configDigest: f.manifest.config_digest, policyDigest: f.manifest.policy_digest, now: f.now}), /owner authority/);

    // A genuine behavior regression remains visible to both AI roles; a negative
    // quality judgment stays unsigned. No native artifact is hand-edited.
    fs.writeFileSync(path.join(f.directory, 'app/handler.py'), 'def accept(value):\n    return value\n');
    git(f.directory, ['add', 'app/handler.py']); git(f.directory, ['commit', '-qm', 'test: reproduce missing-input regression']);
    const changed = bootstrap.prepareManifest({directory: f.directory, base: f.base, request: f.request,
      enrollment: f.enrolled.public_identity, reviewer: f.reviewer, now: f.now});
    f.live.comment.commit_id = changed.head_sha;
    f.live.comment.body = bootstrap.grantBody(changed);
    fs.writeFileSync(manifestFile, JSON.stringify(changed));
    const observedFailure = harness(true);
    const rejected = await cli.runReview(args, {...runtime, ask: observedFailure});
    const failedRecord = JSON.parse(fs.readFileSync(rejected.record));
    assert.equal(observedFailure.calls(), 2, 'failed behavior is assessed rather than suppressing AI');
    assert.equal(failedRecord.technical.verification_status, 'failed');
    assert.equal(failedRecord.technical.commands[0].exit_code, 1);
    assert.match(failedRecord.technical.commands[0].stderr, /ValueError not raised/);
    assert.notEqual(rejected.decision, 'auto_approve');
    assert.equal(rejected.receipt, null);
  } finally {
    if (previous === undefined) delete process.env.CLOUSEAU_FIXTURE_PROVIDER_KEY;
    else process.env.CLOUSEAU_FIXTURE_PROVIDER_KEY = previous;
  }
}, {nativePython: true}));
