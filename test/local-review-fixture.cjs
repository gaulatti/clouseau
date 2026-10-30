'use strict';
const {CASES, prepareCase} = require('./acceptance-cases.cjs');
const {modelTemplate} = require('../src/acceptance-review.cjs');
const {refresh} = require('../src/acceptance-sources.cjs');
const {localReview} = require('../src/local-review.cjs');
const crypto = require('node:crypto');
const {digest} = require('../src/acceptance.cjs');

async function fixture() {
  const f = await prepareCase(CASES[0]);
  Object.assign(f.snapshot, {number: 0, prior_findings: []}); refresh(f.snapshot);
  let calls = 0;
  f.ask = async task => {
    calls++;
    let value;
    if (task.phase === 'investigation') {
      const report = modelTemplate(f.snapshot);
      report.gates.forEach(gate => {gate.state = 'satisfied';});
      value = {kind: 'report', report, request_sources: []};
    } else value = {answers: Object.fromEntries(Object.keys(task.schema.properties.answers.properties)
      .map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))};
    return {value, provenance: {harness: 'codex', role: task.role, phase: task.phase, session: `fictional-session-${calls}`,
      request_digest: digest(task), response_digest: digest(value), transport_digest: digest({fixture_only: value})}};
  };
  f.result = await localReview({...f, ask: f.ask});
  f.record = {version: 2, snapshot: f.snapshot, result: f.result, previous: {comment: null, findings: []},
    controls: false, technical: JSON.parse(f.snapshot.sources.verification.content)};
  const keys = crypto.generateKeyPairSync('ed25519');
  f.privateKey = keys.privateKey.export({type: 'pkcs8', format: 'pem'});
  f.trust = {mode: 'required', reviewer_sha: 'e'.repeat(40), reviewer_digest: require('../src/local-version.cjs').engineDigest(), max_age_seconds: 172800,
    keys: [{id: 'test-runner', issuer: 'fictional-runner', github_actor: 'fixture-author', revoked: false,
      public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}]};
  f.issue = {record: f.record, privateKey: f.privateKey, keyId: 'test-runner', issuer: 'fictional-runner',
    reviewerSha: f.trust.reviewer_sha, now: 10000000, nonce: 'f'.repeat(64)};
  f.expected = {trust: f.trust, repository: f.snapshot.repository, author: 'fixture-author', headSha: f.snapshot.head_sha,
    baseSha: f.snapshot.base_sha, reviewerSha: f.trust.reviewer_sha, configDigest: f.snapshot.config_digest,
    policyDigest: f.snapshot.policy_digest, now: 10000000};
  return f;
}
module.exports = {fixture};
