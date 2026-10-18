'use strict';

const {createHash} = require('node:crypto');

const FACTORS = Object.freeze({
  fit: ['outcome', 'workflow', 'domain', 'boundary', 'operating_model'],
  need: ['binding', 'evidence', 'value', 'unmetness', 'timeliness'],
  excess: ['abstraction', 'surface', 'authority', 'dependencies', 'collateral', 'generalization'],
  defect: ['necessity', 'confidence', 'severity', 'activation', 'irreversibility', 'reach', 'detection', 'propagation', 'recurrence'],
});
const GATES = Object.freeze(['scope_authority', 'test_integrity', 'security_isolation', 'compatibility_recovery', 'review_completeness']);
const STATES = Object.freeze(['satisfied', 'violated', 'unresolved', 'inapplicable']);
const RULES = Object.freeze({version: 2, product_threshold: 80, defect_threshold: 70, xg_bonus: 20});

function requireThat(condition, message) {
  if (!condition) throw new Error(`Invalid acceptance evidence: ${message}`);
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
}

function keys(value, names) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...names].sort().join('\0'), `expected fields ${names.join(', ')}`);
}

function unique(values, label) {
  requireThat(Array.isArray(values) && values.every(text) && new Set(values).size === values.length, label);
}

function range(value) {
  keys(value, ['min', 'max', 'evidence', 'reason']);
  requireThat(Number.isFinite(value.min) && Number.isFinite(value.max) &&
    0 <= value.min && value.min <= value.max && value.max <= 1, 'factor range');
  requireThat(text(value.reason), 'factor explanation');
  unique(value.evidence, 'factor citations');
  requireThat(value.evidence.length > 0, 'factor without evidence');
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function productScore(unit, bound) {
  const f = name => unit.fit[name][bound];
  const n = name => unit.need[name][bound];
  const fit = 35 * f('outcome') + 25 * f('workflow') + 20 * f('domain') + 10 * f('boundary') + 10 * f('operating_model');
  const need = 100 * Math.max(n('binding'), n('evidence') * (0.50 * n('value') + 0.30 * n('unmetness') + 0.20 * n('timeliness')));
  // Excess is adverse: the upper excess bound produces the lower acceptance bound.
  const opposite = bound === 'min' ? 'max' : 'min';
  const proportionality = 100 * (1 - Math.max(...FACTORS.excess.map(name => unit.excess[name][opposite])));
  return {fit, need, proportionality, acceptance: Math.min(fit, need, proportionality)};
}

function findingScore(finding, bound) {
  const v = name => finding.factors[name][bound];
  const impact = 1 + 0.25 * v('irreversibility') + 0.20 * v('reach') + 0.20 * v('detection') + 0.20 * v('propagation') + 0.15 * v('recurrence');
  return 100 * v('confidence') * Math.min(1, Math.max(v('necessity'), v('activation') * v('severity') * impact));
}

function scoreReport(report) {
  const units = report.units.map(unit => {
    const min = productScore(unit, 'min');
    const max = productScore(unit, 'max');
    return {id: unit.id, min, max, disposition: min.acceptance >= RULES.product_threshold ? 'accepted' :
      max.acceptance < RULES.product_threshold ? 'rework' : 'investigate'};
  });
  const findings = report.findings.map(finding => {
    const min = findingScore(finding, 'min');
    const max = findingScore(finding, 'max');
    const xg = Object.values(finding.opportunity).every(value => value === true) ? 1 : 0;
    const priority = Math.min(100, max + RULES.xg_bonus * xg / finding.blast_radius ** 2);
    return {id: finding.id, min, max, xg, priority, disposition: min >= RULES.defect_threshold ? 'blocking' :
      max < RULES.defect_threshold ? 'nonblocking' : 'investigate'};
  });
  const integrity = report.gates.find(gate => gate.name === 'test_integrity');
  // A purpose question needs a material user outcome outside the accepted
  // purpose. Unnecessary machinery serving an accepted outcome is rework,
  // even if an inspector proposes asking the owner to authorize that machinery.
  const newOutcome = units.some((unit, index) => report.units[index].kind === 'capability' && unit.max.fit < RULES.product_threshold);
  const decisions = report.decisions.filter(item => item.kind !== 'purpose' || newOutcome);
  const scopeDecision = decisions.length > 0 && report.gates.find(gate => gate.name === 'scope_authority').state !== 'satisfied';
  const blocked = report.gates.some(gate => gate.state === 'violated' && !(scopeDecision && gate.name === 'scope_authority')) || findings.some(finding => finding.disposition === 'blocking');
  const incomplete = report.gates.some(gate => gate.state === 'unresolved' && !(scopeDecision && gate.name === 'scope_authority')) ||
    units.some(unit => unit.disposition === 'investigate') || findings.some(finding => finding.disposition === 'investigate');
  const rework = units.some(unit => unit.disposition === 'rework');
  const decision = integrity.state === 'violated' ? 'blocked_integrity' : blocked ? 'repair_required' :
    incomplete ? 'review_incomplete' : decisions.length ? 'owner_decision' : rework ? 'repair_required' : 'auto_approve';
  return {rules: RULES, units, findings, decision};
}

function validateEvidence(report, snapshot, graded) {
  keys(report, ['version', 'snapshot', 'summary', 'evidence', 'units', 'findings', 'gates', 'accounting', 'decisions', 'resolutions']);
  requireThat(report.version === RULES.version && report.snapshot === snapshot.digest && text(report.summary), 'stale identity or missing summary');
  requireThat(Array.isArray(report.evidence) && report.evidence.length > 0, 'missing evidence register');
  const evidence = new Map();
  for (const item of report.evidence) {
    keys(item, ['id', 'source', 'start', 'end', 'quote']);
    requireThat(text(item.id) && !evidence.has(item.id), 'duplicate evidence id');
    const source = snapshot.sources[item.source];
    requireThat(source && Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) &&
      item.start >= 1 && item.end >= item.start && item.end - item.start < 40, 'citation source or lines');
    const lines = source.content.split('\n');
    requireThat(item.end <= lines.length, 'citation extends beyond source');
    const selected = lines.slice(item.start - 1, item.end).join('\n');
    requireThat(typeof item.quote === 'string' && item.quote.trim().length > 0 && selected.trim() && selected.includes(item.quote), 'citation does not match immutable source');
    evidence.set(item.id, item);
  }
  const citations = values => {
    unique(values, 'citation references');
    requireThat(values.length > 0 && values.every(id => evidence.has(id)), 'missing or unknown citation');
  };
  const factors = (value, group) => {
    keys(value, FACTORS[group]);
    for (const factor of Object.values(value)) {range(factor); citations(factor.evidence);}
  };
  requireThat(Array.isArray(report.units) && report.units.length > 0, 'empty acceptance plan');
  const unitIds = new Set();
  for (const unit of report.units) {
    keys(unit, ['id', 'title', 'kind', 'paths', 'obligation', 'fit', 'need', 'excess', 'alternative']);
    requireThat(text(unit.id) && !unitIds.has(unit.id) && text(unit.title) && text(unit.obligation) &&
      ['capability', 'mechanism'].includes(unit.kind), 'acceptance unit identity');
    unitIds.add(unit.id);
    unique(unit.paths, 'unit paths');
    requireThat(unit.paths.length > 0 && unit.paths.every(name => snapshot.paths.includes(name)), 'unit outside changed paths');
    factors(unit.fit, 'fit'); factors(unit.need, 'need'); factors(unit.excess, 'excess');
    if (graded && unit.need.binding.max > 0) requireThat(unit.need.binding.evidence.some(id =>
      snapshot.sources[evidence.get(id).source].authority === 'trusted' &&
      snapshot.sources[evidence.get(id).source].kind === 'contract'), 'binding obligation lacks trusted contract authority');
    requireThat(typeof unit.alternative === 'string' && unit.alternative.length <= 2000, 'invalid narrower alternative');
    if (Object.values(unit.excess).some(value => value.max > 0)) requireThat(text(unit.alternative), 'excess without a feasible narrower alternative');
  }
  requireThat(Array.isArray(report.findings), 'missing findings register');
  const findingIds = new Set();
  for (const finding of report.findings) {
    keys(finding, ['id', 'title', 'path', 'cause', 'trigger', 'consequence', 'obligation', 'evidence', 'factors', 'blast_radius', 'opportunity', 'repair_paths']);
    requireThat(text(finding.id) && !findingIds.has(finding.id) && snapshot.paths.includes(finding.path), 'finding identity or causal path');
    findingIds.add(finding.id);
    for (const name of ['title', 'cause', 'trigger', 'consequence', 'obligation']) requireThat(text(finding[name]), `missing finding ${name}`);
    citations(finding.evidence); factors(finding.factors, 'defect');
    requireThat(finding.evidence.some(id => snapshot.sources[evidence.get(id).source].path === finding.path ||
      snapshot.files.some(file => file.path === finding.path &&
        [file.base_source, file.head_source].includes(evidence.get(id).source))), 'finding lacks changed-path causal evidence');
    requireThat([0, 1].includes(finding.factors.confidence.max), 'uncertain causal evidence must retain a possible blocking upper bound');
    requireThat(Number.isFinite(finding.blast_radius) && finding.blast_radius >= 1 && finding.blast_radius <= 10, 'repair blast radius');
    keys(finding.opportunity, ['mechanical', 'beneficial', 'within_scope', 'verified']);
    requireThat(Object.values(finding.opportunity).every(value => typeof value === 'boolean'), 'opportunity evidence');
    unique(finding.repair_paths, 'repair paths');
    requireThat(finding.repair_paths.length > 0 && finding.repair_paths.every(name => snapshot.paths.includes(name)), 'repair exceeds initial envelope');
  }
  requireThat(Array.isArray(report.gates) && report.gates.length === GATES.length &&
    new Set(report.gates.map(gate => gate.name)).size === GATES.length, 'missing or repeated gates');
  for (const gate of report.gates) {
    keys(gate, ['name', 'state', 'reason', 'evidence']);
    requireThat(GATES.includes(gate.name) && STATES.includes(gate.state) && text(gate.reason), 'invalid gate'); citations(gate.evidence);
    requireThat(!['test_integrity', 'review_completeness', 'scope_authority'].includes(gate.name) || gate.state !== 'inapplicable', 'required gate cannot be inapplicable');
  }
  requireThat(Array.isArray(report.accounting) && report.accounting.length === snapshot.paths.length &&
    new Set(report.accounting.map(item => item.path)).size === snapshot.paths.length, 'incomplete changed-file accounting');
  for (const item of report.accounting) {
    keys(item, ['path', 'units', 'reason', 'evidence']);
    requireThat(snapshot.paths.includes(item.path) && text(item.reason), 'unknown accounted path');
    unique(item.units, 'accounting units'); citations(item.evidence);
    requireThat(item.units.length > 0 && item.units.every(id => unitIds.has(id) &&
      report.units.find(unit => unit.id === id).paths.includes(item.path)), 'accounting lacks a covering acceptance unit');
    requireThat(item.evidence.some(id => snapshot.sources[evidence.get(id).source].path === item.path ||
      snapshot.files.some(file => file.path === item.path && [file.base_source, file.head_source].includes(evidence.get(id).source))),
      'accounting lacks direct changed-file evidence');
  }
  requireThat(Array.isArray(report.decisions), 'missing authority decisions');
  for (const item of report.decisions) {
    keys(item, ['kind', 'question', 'options', 'evidence']);
    requireThat(['purpose', 'authority', 'tradeoff'].includes(item.kind) && text(item.question), 'unsupported human handoff');
    unique(item.options, 'decision options'); requireThat(item.options.length >= 2 && item.options.length <= 4, 'decision needs concrete options');
    citations(item.evidence);
  }
  requireThat(Array.isArray(report.resolutions), 'missing prior-finding dispositions');
  const resolved = new Set();
  for (const item of report.resolutions) {
    keys(item, ['id', 'state', 'reason', 'evidence']);
    requireThat(!resolved.has(item.id) && snapshot.prior_findings?.some(finding => finding.id === item.id) &&
      ['corrected', 'dismissed'].includes(item.state) && text(item.reason), 'invalid prior-finding disposition');
    citations(item.evidence);
    requireThat(item.evidence.some(id => snapshot.sources[evidence.get(id).source].ref === snapshot.head_sha), 'resolution lacks current-revision evidence');
    resolved.add(item.id);
  }
}

// Fact validation makes no numeric claim and cannot yield an approval score.
// Positive binding grades are still checked in final validation and the gate.
function validateFacts(report, snapshot) {
  validateEvidence(report, snapshot, false);
}

function validateReport(report, snapshot) {
  validateEvidence(report, snapshot, true);
  return scoreReport(report);
}

module.exports = {FACTORS, GATES, STATES, RULES, digest, productScore, findingScore, scoreReport, validateFacts, validateReport};
