'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {fixture: core} = require('./bootstrap-fixture.cjs');
const {git} = require('../src/local-git.cjs');
const {digest} = require('../src/acceptance.cjs');
const bootstrap = require('../src/installation-bootstrap.cjs');

function harness(negative = false, {engineSource = false} = {}) {
  let calls = 0;
  const ask = async task => {
    calls++;
    let value;
    if (task.phase === 'investigation') {
      const packet = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
      const report = packet.template;
      report.gates.forEach(gate => {gate.state = negative && gate.name === 'test_integrity' ? 'violated' : 'satisfied';});
      value = engineSource && !Object.values(packet.evidence.sources).some(source => source.path === '.clouseau-ci/src/config.cjs') ?
        {kind: 'source_request', report: null, request_sources: ['.clouseau-ci/src/config.cjs']} :
        {kind: 'report', report, request_sources: []};
    } else value = {answers: Object.fromEntries(Object.keys(task.schema.properties.answers.properties)
      .map(id => [id, id.includes('_excess_') ? 'level0' : 'level4']))};
    return {value, provenance: {harness: 'codex', role: task.role, phase: task.phase, session: `fictional-cli-bootstrap-${calls}`,
      request_digest: digest(task), response_digest: digest(value), transport_digest: digest({fixture_only: value})}};
  };
  ask.calls = () => calls;
  return ask;
}

async function fixture(run, options = {}) {
  return core(async f => {
    f.manifestFile = path.join(f.temporary, 'manifest.json');
    f.requestFile = path.join(f.temporary, 'requirement.txt');
    fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest), {mode: 0o600});
    fs.writeFileSync(f.requestFile, f.request);
    f.reviewArgs = {directory: f.directory, manifest: f.manifestFile, 'grant-comment': String(f.grant.comment_id)};
    f.reviewRuntime = {api: f.api, installed: () => f.reviewer, state: f.state, clock: () => f.now,
      ask: harness(false, options), verify: () => ({fixture_only: true, exact_coverage: {lines: [1, 1], branches: [2, 2]}})};
    f.refresh = async () => {
      f.head = git(f.directory, ['rev-parse', 'HEAD']).trim();
      f.manifest = bootstrap.prepareManifest({directory: f.directory, base: f.base, request: f.request,
        enrollment: f.enrolled.public_identity, reviewer: f.reviewer, now: f.now});
      f.live.comment.commit_id = f.head; f.live.comment.body = bootstrap.grantBody(f.manifest);
      f.grant = await bootstrap.verifyGrant({api: f.api, manifest: f.manifest, commentId: f.live.comment.id, now: f.now});
      fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
    };
    f.revise = async index => {
      fs.appendFileSync(path.join(f.directory, 'README.md'), `Installation evidence revision ${index}.\n`);
      git(f.directory, ['add', 'README.md']); git(f.directory, ['commit', '-qm', `docs: refine installation evidence ${index}`]);
      await f.refresh();
    };
    f.remote = async () => {
      const record = await f.record();
      const bundle = f.sign(record);
      const artifactRef = 'a'.repeat(40);
      const prefix = `repos/${f.manifest.repository}`;
      const nativeTree = ref => git(f.directory, ['ls-tree', '-r', '-z', ref]).split('\0').filter(Boolean).map(line => {
        const [header, filename] = line.split('\t'); const [mode, type, sha] = header.split(' ');
        return {path: filename, mode, type, sha};
      });
      const state = {bundle, artifactRef, calls: [], content: new Map(), comments: [],
        baseTree: {truncated: false, tree: nativeTree(f.base)}, headTree: {truncated: false, tree: nativeTree(f.head)},
        pr: {number: 7, state: 'open', draft: false, auto_merge: null, user: {login: 'fixture-owner', type: 'User'},
          body: `<!-- clouseau-installation-review:v1 ${artifactRef} -->`,
          changed_files: record.snapshot.files.length, head: {sha: f.head, ref: 'install/clouseau',
            repo: {id: 42, full_name: f.manifest.repository, owner: {login: 'fixture-owner'}, name: 'bootstrap-fixture'}},
          base: {sha: f.base, ref: 'main'}},
        files: require('./hosted-files.cjs').hostedFiles(record.snapshot),
        runs: [{id: 51, run_attempt: 1, head_sha: f.head, head_branch: 'install/clouseau', head_repository: {id: 42},
          pull_requests: [{number: 7}], event: 'pull_request', status: 'completed', conclusion: 'success',
          html_url: `https://github.com/${f.manifest.repository}/actions/runs/51`}],
        jobs: [{id: 61, name: 'verify', conclusion: 'success', steps: [{name: 'Enforce 100% line and branch coverage', conclusion: 'success'}]}],
      };
      const api = async (method, endpoint, body) => {
        state.calls.push({method, endpoint});
        if (method !== 'GET') throw new Error('Read-only checker attempted a GitHub write');
        if (endpoint === `${prefix}/pulls/7`) return structuredClone(state.pr);
        if (endpoint.startsWith(`${prefix}/pulls/7/files?`)) return structuredClone(state.files);
        if (endpoint.startsWith(`${prefix}/issues/7/comments?`)) return structuredClone(state.comments);
        if (endpoint === `${prefix}/git/trees/${f.base}?recursive=1`) return structuredClone(state.baseTree);
        if (endpoint === `${prefix}/git/trees/${f.head}?recursive=1`) return structuredClone(state.headTree);
        if (endpoint.startsWith(`${prefix}/contents/`)) {
          const match = /^repos\/[^/]+\/[^/]+\/contents\/(.+)\?ref=(.+)$/.exec(endpoint);
          const filename = match[1].split('/').map(decodeURIComponent).join('/'); const ref = decodeURIComponent(match[2]);
          const key = `${ref}:${filename}`;
          if (state.content.has(key)) return structuredClone(state.content.get(key));
          const value = filename === 'clouseau-review.json' && ref === artifactRef ? JSON.stringify(state.bundle) : git(f.directory, ['show', `${ref}:${filename}`]);
          return {encoding: 'base64', size: Buffer.byteLength(value), content: Buffer.from(value).toString('base64')};
        }
        if (endpoint.startsWith(`${prefix}/actions/workflows/ci.yml/runs?`)) return {workflow_runs: structuredClone(state.runs)};
        if (endpoint.startsWith(`${prefix}/actions/runs/51/jobs?`)) return {jobs: structuredClone(state.jobs)};
        return f.api(method, endpoint, body);
      };
      return {state, api, args: {repository: f.manifest.repository, 'pull-request': '7'},
        runtime: {api, installed: () => f.reviewer, clock: () => f.now, maxPolls: 1, pause: async () => {}}};
    };
    return run(f);
  }, options);
}

module.exports = {fixture, harness};
