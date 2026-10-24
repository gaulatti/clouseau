'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {git, collectLocal} = require('../src/local-git.cjs');
const {initializeIdentity} = require('../src/local-cli.cjs');
const {readIdentity, prepareManifest, grantBody, verifyGrant} = require('../src/installation-bootstrap.cjs');
const {engineDigest} = require('../src/local-version.cjs');
const {digest} = require('../src/acceptance.cjs');
const {refresh} = require('../src/acceptance-sources.cjs');
const {localReview} = require('../src/local-review.cjs');
const {issueReceipt} = require('../src/local-receipt.cjs');

const NOW = 10_000_000;

async function fixture(run, {nativePython = false, centralSource = false, engineSource = false} = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clouseau-bootstrap-fixture-'));
  const directory = path.join(temporary, 'repository');
  const state = path.join(temporary, 'runner');
  fs.mkdirSync(directory);
  try {
    git(directory, ['init', '-q', '-b', 'main']);
    git(directory, ['config', 'user.name', 'Fixture Owner']);
    git(directory, ['config', 'user.email', 'fixture@example.invalid']);
    git(directory, ['remote', 'add', 'origin', 'https://github.com/fixture-owner/bootstrap-fixture.git']);
    fs.mkdirSync(path.join(directory, nativePython ? 'app' : 'src'));
    fs.writeFileSync(path.join(directory, 'README.md'), 'Preserve accepted input and reject missing input.\n');
    if (nativePython) {
      fs.writeFileSync(path.join(directory, '.gitignore'), '.coverage\ncoverage.json\n__pycache__/\n');
      fs.writeFileSync(path.join(directory, 'app/handler.py'), 'def accept(value):\n    if not value:\n        raise ValueError("Missing input")\n    return value\n');
      fs.mkdirSync(path.join(directory, 'tests'));
      fs.writeFileSync(path.join(directory, 'tests/test_handler.py'), 'import os, unittest\nfrom app.handler import accept\nclass AcceptedInput(unittest.TestCase):\n    def test_retains_input(self):\n        self.assertEqual(accept("accepted"), "accepted")\n        self.assertNotIn("CLOUSEAU_FIXTURE_PROVIDER_KEY", os.environ)\n    def test_rejects_missing(self):\n        with self.assertRaisesRegex(ValueError, "Missing input"):\n            accept("")\n');
    } else fs.writeFileSync(path.join(directory, 'src/handler.js'), 'module.exports = input => { if (!input) throw Error("Missing"); return input; };\n');
    git(directory, ['add', '.']);
    git(directory, ['commit', '-qm', 'feat: establish application purpose']);
    const base = git(directory, ['rev-parse', 'HEAD']).trim();
    git(directory, ['update-ref', 'refs/remotes/origin/main', base]);

    const enrolled = initializeIdentity(state, 'fixture-owner');
    const reviewer = {sha: 'e'.repeat(40), digest: engineDigest(), clean: true};
    const local = {version: 1, base_branch: 'main', readme: 'README.md', repository_policy: 'AGENTS.md',
      verification: nativePython ? [['python3', '-m', 'coverage', 'run', '--branch', '--source=app', '-m', 'unittest', 'discover', '-s', 'tests'],
        ['python3', '-m', 'coverage', 'json', '-o', 'coverage.json']] : [['node', '--version']],
      coverage: {format: nativePython ? 'coveragepy' : 'istanbul', report: 'coverage.json', source_directory: nativePython ? 'app' : 'src'}};
    const config = {version: 2, base_branch: 'main', workflow: 'ci.yml',
      verification: {job: 'verify', steps: ['Enforce 100% line and branch coverage']}, manual_reviewer: 'fixture-owner',
      repository_policy: '.github/clouseau.md', readme: 'README.md', sensitive_paths: [], deployment: null,
      acceptance: {examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed', grading_model: 'deepseek-flash', repair_attempts: 2},
      local_review: {mode: 'optional', reviewer_digest: reviewer.digest, max_age_seconds: 3600, keys: [enrolled.public_identity]}};
    if (centralSource) {
      delete config.local_review.reviewer_digest;
      config.local_review.central_source = {repository: 'gaulatti/clouseau', ref: 'refs/heads/main'};
    }
    fs.mkdirSync(path.join(directory, '.github/workflows'), {recursive: true});
    fs.mkdirSync(path.join(directory, 'docs'));
    for (const [name, text] of Object.entries({
      '.clouseau-local.json': JSON.stringify(local), '.github/clouseau.json': JSON.stringify(config),
      '.github/clouseau.md': 'Install shared acceptance without waiving tests or exact coverage.\n',
      '.github/workflows/ci.yml': 'name: verification\non: pull_request\n',
      '.github/workflows/metadata.yaml': 'name: trusted metadata\non: pull_request_target\n',
      'AGENTS.md': 'Run verification and the shared local review before ready pull requests.\n',
      'CLAUDE.md': 'Preserve the accepted purpose and signed review protocol.\n',
      'CODEOWNERS': '* @fixture-owner\n', '.github/CODEOWNERS': '* @fixture-owner\n', 'docs/CODEOWNERS': '* @fixture-owner\n',
    })) fs.writeFileSync(path.join(directory, name), text);
    git(directory, ['add', '.']); git(directory, ['commit', '-qm', 'ci: install shared acceptance controls']);
    const head = git(directory, ['rev-parse', 'HEAD']).trim();
    const request = 'Install shared Clouseau controls while preserving the existing application purpose and exact verification.';
    const manifest = prepareManifest({directory, base, request, enrollment: enrolled.public_identity, reviewer, now: NOW});
    const live = {
      actor: {login: 'fixture-owner', type: 'User'},
      repository: {full_name: manifest.repository, default_branch: 'main'},
      permission: {permission: 'admin', user: {login: 'fixture-owner', type: 'User'}},
      base: {protected: true, commit: {sha: base}}, engine: {protected: true, commit: {sha: reviewer.sha}},
      comparison: {status: 'identical'},
      comment: {id: 31, commit_id: head, user: {login: 'fixture-owner', type: 'User'}, body: grantBody(manifest)},
    };
    const calls = [];
    const api = async (method, endpoint, body) => {
      calls.push({method, endpoint, ...(body ? {body} : {})});
      if (method === 'POST' && endpoint === `repos/${manifest.repository}/commits/${head}/comments`) {
        live.comment = {...live.comment, body: body.body}; return structuredClone(live.comment);
      }
      const routes = {
        user: 'actor', [`repos/${manifest.repository}`]: 'repository',
        [`repos/${manifest.repository}/collaborators/fixture-owner/permission`]: 'permission',
        [`repos/${manifest.repository}/branches/main`]: 'base', 'repos/gaulatti/clouseau/branches/main': 'engine',
        [`repos/gaulatti/clouseau/compare/${reviewer.sha}...${live.engine.commit?.sha}`]: 'comparison',
        [`repos/${manifest.repository}/comments/${live.comment.id}`]: 'comment',
      };
      if (method !== 'GET' || !Object.hasOwn(routes, endpoint)) throw new Error(`Unexpected fixture API ${method} ${endpoint}`);
      return structuredClone(live[routes[endpoint]]);
    };
    const grant = await verifyGrant({api, manifest, commentId: live.comment.id, now: NOW});
    const f = {temporary, directory, state, enrolled, reviewer, local, config, base, head, request, manifest, live, calls, api, grant, now: NOW};
    f.options = () => ({api, grant: f.grant, author: 'fixture-owner', reviewerSha: reviewer.sha, reviewerDigest: reviewer.digest, now: NOW});
    f.record = async (mutateSnapshot = () => {}, mutateRequestedSources = () => {}) => {
      const technical = {fixture_only: true, exact_coverage: {lines: [1, 1], branches: [2, 2]}};
      const collected = collectLocal({directory, base, request, technical, ciConfig: config, reviewerSha: reviewer.sha, installation: f.grant});
      mutateSnapshot(collected.snapshot);
      refresh(collected.snapshot);
      let count = 0;
      const ask = async task => {
        let value;
        if (task.phase === 'investigation') {
          const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
          const report = packet.template; report.gates.forEach(gate => {gate.state = 'satisfied';});
          value = engineSource && !Object.values(packet.evidence.sources).some(source => source.path === '.clouseau-ci/src/config.cjs') ?
            {kind: 'source_request', report: null, request_sources: ['.clouseau-ci/src/config.cjs']} :
            {kind: 'report', report, request_sources: []};
        } else value = {answers: Object.fromEntries(Object.keys(task.schema.properties.answers.properties)
          .map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))};
        return {value, provenance: {harness: 'codex', role: task.role, phase: task.phase,
          session: `fictional-bootstrap-session-${++count}`, request_digest: digest(task), response_digest: digest(value),
          transport_digest: digest({fixture_only: value})}};
      };
      const result = await localReview({...collected, ask, addSources: async paths => {
        await collected.addSources(paths); mutateRequestedSources(collected.snapshot); refresh(collected.snapshot);
      }});
      return {version: 2, snapshot: collected.snapshot, result, controls: true, installation: f.grant,
        technical, previous: {comment: null, findings: []}};
    };
    f.sign = record => issueReceipt({record, privateKey: readIdentity(enrolled.identity_file).identity.private_key,
      keyId: enrolled.public_identity.id, issuer: enrolled.public_identity.issuer,
      reviewerSha: reviewer.sha, reviewerDigest: reviewer.digest, now: NOW});
    await run(f);
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
}

module.exports = {fixture, NOW};
