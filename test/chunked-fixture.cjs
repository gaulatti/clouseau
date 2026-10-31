'use strict';
// A local, deliberately simple stand-in for the partition and merge modules (which other changes own), written
// against the pinned contract only: one unit per changed path, unions for the merge, strictest gate wins.
const crypto = require('node:crypto');
const {CASES, prepareCase} = require('./acceptance-cases.cjs');
const {GATES, digest} = require('../src/acceptance.cjs');
const {modelTemplate, materialize} = require('../src/acceptance-review.cjs');
const {refresh} = require('../src/acceptance-sources.cjs');
const {elideQuotes} = require('../src/chunked-record.cjs');
const {FACTORS} = require('../src/acceptance.cjs');

const PARAMS = {C: 450000, S: 100000, cap: 2400000, max_units: 16};
const STRICT = ['violated', 'unresolved', 'satisfied', 'inapplicable'];

function unitView(snapshot, spec) {
  const other = snapshot.files.filter(file => !spec.owned.includes(file.path));
  const hidden = new Set(other.flatMap(file => [file.base_source, file.head_source]));
  const view = {...snapshot, paths: [...spec.owned], files: snapshot.files.filter(file => spec.owned.includes(file.path)),
    sources: Object.fromEntries(Object.entries(snapshot.sources).filter(([id]) => !hidden.has(id)))};
  return refresh(view);
}

function planOf(snapshot, params, groups) {
  const units = groups.map((owned, index) => {
    const spec = {id: `u${index}`, owned, context_ids: [], cost: 1};
    return {...spec, view_digest: unitView(snapshot, spec).digest};
  });
  const plan = {scheme: 'clouseau-partition/1', params: {C: params.C, S: params.S, cap: params.cap}, units};
  return {...plan, plan_digest: digest(plan)};
}

const hooks = {
  partition: ({snapshot, params}) => planOf(snapshot, params, [...snapshot.paths].sort().map(path => [path])),
  unitView,
  seams: () => [],
  merge({unitReports, snapshot}) {
    const prefix = (value, unit) => {
      if (Array.isArray(value)) return value.map(item => prefix(item, unit));
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        key === 'evidence' && Array.isArray(item) && item.every(id => typeof id === 'string') ? item.map(id => `${unit}:${id}`) :
          key === 'id' ? `${unit}:${item}` :
            key === 'units' && item.every(id => typeof id === 'string') ? item.map(id => `${unit}:${id}`) : prefix(item, unit)]));
    };
    const parts = unitReports.map(({unit, report}) => prefix(report, unit));
    const sources = Object.keys(snapshot.sources).map(source => {
      const candidates = parts.flatMap(part => part.coverage.sources.filter(item => item.source === source));
      return candidates.find(item => item.state === 'missing') || candidates.find(item => item.state === 'inspected') || candidates[0];
    });
    return {version: 4, snapshot: snapshot.digest, summary: parts.map(part => part.summary).join(' '),
      evidence: parts.flatMap(part => part.evidence), units: parts.flatMap(part => part.units),
      findings: parts.flatMap(part => part.findings), accounting: parts.flatMap(part => part.accounting),
      resolutions: parts.flatMap(part => part.resolutions),
      gates: GATES.map(name => {
        const gates = parts.map(part => part.gates.find(gate => gate.name === name));
        return {name, state: STRICT.find(state => gates.some(gate => gate.state === state)), reason: gates[0].reason,
          evidence: gates.flatMap(gate => gate.evidence)};
      }),
      coverage: {sources, dependencies: parts.flatMap(part => part.coverage.dependencies)},
      reopenings: parts.flatMap(part => part.reopenings)};
  },
};

function unitReport(view, {finding = false} = {}) {
  const report = modelTemplate(view);
  report.gates.forEach(gate => {gate.state = 'satisfied';});
  const completed = materialize(report, view);
  if (finding) {
    const [evidence] = completed.accounting[0].evidence;
    completed.findings.push({id: 'fictional-defect', title: 'Fictional fixture defect', path: completed.accounting[0].path,
      cause: 'The changed path no longer preserves the accepted contract.', trigger: 'A fictional input.',
      consequence: 'A fictional regression.', obligation: 'Restore the accepted contract.', evidence: [evidence],
      factors: Object.fromEntries(FACTORS.defect.map(name => [name, {value: 0, evidence: [evidence], reason: 'Established by the cited source.'}])),
      blast_radius: 1, opportunity: {mechanical: false, beneficial: false, within_scope: false, verified: false},
      repair_paths: [completed.accounting[0].path]});
  }
  return completed;
}

async function chunkedFixture({params = PARAMS, groups, finding = false, mutate = () => {}} = {}) {
  const {snapshot} = await prepareCase(CASES[1]);
  Object.assign(snapshot, {number: 0, prior_findings: []}); mutate(snapshot); refresh(snapshot);
  const plan = groups ? planOf(snapshot, params, groups) : hooks.partition({snapshot, params});
  const views = plan.units.map(unit => unitView(snapshot, unit));
  const usage = []; let calls = 0;
  const call = (role, phase, unit) => {
    calls++;
    const entry = {harness: 'codex', role, phase, session: `fictional-session-${calls}`, ...(unit ? {unit} : {}),
      request_digest: digest(['request', calls]), response_digest: digest(['response', calls]), transport_digest: digest(['transport', calls])};
    usage.push(entry);
  };
  const reviews = ['examiner', 'challenger'].map(role => {
    const full = plan.units.map((unit, index) => ({unit: unit.id, report: unitReport(views[index], {finding: finding && index === 0})}));
    for (const unit of plan.units) call(role, 'investigation', unit.id);
    call(role, 'integration');
    const merged = hooks.merge({unitReports: full, snapshot});
    const {locations, grade} = require('../src/acceptance-grading.cjs');
    const decisions = locations(merged).map(entry => ({id: entry.id, provider: 'local-harness', answer: 'level0', value: grade('level0').value}));
    if (decisions.length) call(role, 'grading');
    return {role, unit_reports: full.map((item, index) => ({unit: item.unit, report: elideQuotes(item.report, views[index])})),
      integration: [], drafts: [], grading: {provider: 'local-harness', decisions}};
  });
  const result = {version: 2, snapshot: snapshot.digest, policy_digest: snapshot.policy_digest, config_digest: snapshot.config_digest,
    decision: 'auto_approve', reviews, usage, execution_digest: digest(usage)};
  const record = {version: 3, snapshot, partition: plan, seams: [], result, previous: {comment: null, findings: []},
    controls: false, technical: JSON.parse(snapshot.sources.verification.content)};
  const keys = crypto.generateKeyPairSync('ed25519');
  const trust = {mode: 'required', reviewer_digest: require('../src/local-version.cjs').engineDigest(), max_age_seconds: 172800,
    keys: [{id: 'test-runner', issuer: 'fictional-runner', github_actor: 'fixture-author', revoked: false,
      public_key: keys.publicKey.export({type: 'spki', format: 'pem'})}]};
  const chunked = {params, hooks};
  return {snapshot, record, plan, views, chunked, trust, params,
    issue: {record, privateKey: keys.privateKey.export({type: 'pkcs8', format: 'pem'}), keyId: 'test-runner', issuer: 'fictional-runner',
      reviewerSha: 'e'.repeat(40), now: 10000000, nonce: 'f'.repeat(64), chunked},
    expected: {trust, repository: snapshot.repository, author: 'fixture-author', headSha: snapshot.head_sha, baseSha: snapshot.base_sha,
      reviewerSha: 'e'.repeat(40), configDigest: snapshot.config_digest, policyDigest: snapshot.policy_digest, now: 10000000, chunked}};
}

module.exports = {chunkedFixture, hooks, unitView, planOf, PARAMS};
