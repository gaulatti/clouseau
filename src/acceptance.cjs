'use strict';

const path = require('node:path');
const {createHash} = require('node:crypto');

const FACTORS = Object.freeze({
  defect: ['necessity', 'confidence', 'severity', 'activation', 'irreversibility', 'reach', 'detection', 'propagation', 'recurrence'],
});
const GATES = Object.freeze(['scope_authority', 'test_integrity', 'security_isolation', 'compatibility_recovery', 'review_completeness']);
const STATES = Object.freeze(['satisfied', 'violated', 'unresolved', 'inapplicable']);
const RULES = Object.freeze({version: 4, defect_threshold: 70, xg_bonus: 20});
const MAX_CITATION_LINES = 40;

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

function point(value) {
  keys(value, ['value', 'evidence', 'reason']);
  requireThat(Number.isFinite(value.value) && 0 <= value.value && value.value <= 1, 'factor value');
  requireThat(text(value.reason), 'factor explanation');
  unique(value.evidence, 'factor citations');
  requireThat(value.evidence.length > 0, 'factor without evidence');
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function impactOf(finding) {
  const v = name => finding.factors[name].value;
  return 1 + 0.25 * v('irreversibility') + 0.20 * v('reach') + 0.20 * v('detection') + 0.20 * v('propagation') + 0.15 * v('recurrence');
}

function findingScore(finding) {
  const v = name => finding.factors[name].value;
  return 100 * v('confidence') * Math.min(1, Math.max(v('necessity'), v('activation') * v('severity') * impactOf(finding)));
}

function scoreReport(report) {
  const findings = report.findings.map(finding => {
    const score = findingScore(finding);
    const xg = Object.values(finding.opportunity).every(value => value === true) ? 1 : 0;
    const priority = Math.min(100, score + RULES.xg_bonus * xg / finding.blast_radius ** 2);
    return {id: finding.id, score, xg, priority, disposition: score >= RULES.defect_threshold ? 'blocking' : 'nonblocking'};
  });
  const integrity = report.gates.find(gate => gate.name === 'test_integrity');
  const blocked = report.gates.some(gate => gate.state === 'violated') || findings.some(finding => finding.disposition === 'blocking');
  const decision = integrity.state === 'violated' ? 'blocked_integrity' : blocked ? 'repair_required' : 'auto_approve';
  return {rules: RULES, findings, decision};
}

// Only languages whose tests name the module under test by an import; same-package
// and inline-test languages (Go, Java, C) cannot be linked this way and are not judged here.
const CODE = /\.(?:[cm]?[jt]sx?|py|rs|rb|php|vue|svelte)$/;
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|specs?|e2e|stories)\/|\.(?:test|spec|stories)\.[a-z0-9]+$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py)$/i;
const isTestPath = name => TEST_PATH.test(name);
const FIXTURE_PATH = /(?:^|\/)(?:__fixtures__|fixtures?|__mocks__|mocks?|testdata|__snapshots__)\//i;
// Everything except documentation, data, configuration, lockfiles, workflows and fixtures can change
// behaviour, in any language; tests are included because weakening one is a behaviour change to the suite.
const INERT = /(?:^|\/)(?:LICENSE|NOTICE|CODEOWNERS|CHANGELOG|README)(?:\.(?:md|txt|rst))?$|(?:^|\/)\.[^/]*ignore$|\.(?:md|mdx|txt|rst|json|jsonc|ya?ml|toml|ini|lock|csv|tsv|svg|png|jpe?g|gif|ico|webp|pdf|snap)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;
const isExecutablePath = name => !INERT.test(name) && !FIXTURE_PATH.test(name) && !/\.d\.ts$|\.config\.[a-z]+$/.test(name);
const isCodePath = name => CODE.test(name) && isExecutablePath(name) && !isTestPath(name);

// A module is linked to a test only by an import-like line naming it. A word in
// a test title or an unrelated assertion in the same change is not linkage.
function moduleStem(name) {
  const parts = name.split('/'); const base = parts.pop().replace(/\.[^.]+$/, '');
  return base === 'index' && parts.length ? parts.pop() : base;
}

// A statement that imports, not a title or comment that merely contains the word.
const IMPORT = /^\s*(?:(?:export\b.*\s)?from\b|import\b|use\b|pub\s+use\b|mod\b|require(?:_relative)?\b|include\b|load\b)|\b(?:require|import)\(/;

const JS_PATH = /\.[cm]?[jt]sx?$/;
const EXTENSION = /\.[cm]?[jt]sx?$/;

// Module specifiers of a JavaScript/TypeScript source, from whole statements once comments are
// removed: `import ... from`, `export ... from`, side-effect `import`, and declarations initialised by
// require()/import(). A quoted path in a test title or a comment is not an import.
function specifiersOf(content) {
  const text = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const pattern = /^\s*(?:(?:import|export)\b[^;'"`]*?\bfrom\s*|import\s*|(?:(?:const|let|var)\b[^;=]*=\s*)?(?:await\s+)?(?:require|import)\s*\(\s*)(['"`])([^'"`\n]+)\1/gm;
  const found = [...text.matchAll(pattern)].map(match => match[2]);
  // A declaration may initialise several bindings: `const a = require('./a'), b = require('./b');`.
  for (const declaration of text.matchAll(/^\s*(?:const|let|var)\b[^;]*;/gm)) {
    for (const call of declaration[0].matchAll(/\b(?:require|import)\s*\(\s*(['"`])([^'"`\n]+)\1/g)) found.push(call[2]);
  }
  return [...new Set(found)];
}

// Known files a specifier can name: relative paths, `.js`-for-`.ts` suffixes, `/index`, and the
// `@/`, `~/` and `src/` aliases (matched by path tail, since the alias map is not supplied).
function resolveSpecifier(from, specifier, known) {
  const bare = value => value.replace(EXTENSION, '');
  const alias = /^(?:@|~)\//.test(specifier) || specifier.startsWith('src/');
  if (!specifier.startsWith('.') && !alias) return [];
  const target = (specifier.startsWith('.') ? bare(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))) : bare(specifier.replace(/^(?:@|~)\//, ''))).replace(/\/index$/, '');
  return known.filter(candidate => {
    const stem = bare(candidate);
    const full = stem.replace(/\/index$/, '');
    return specifier.startsWith('.') ? full === target : full === target || full.endsWith(`/${target}`);
  });
}

// Principled coverage: a changed JS/TS file is covered when a supplied test imports it directly, or
// imports a supplied file (a changed caller, a barrel) that imports it, transitively. Only supplied
// files can be intermediates; a file with no path from any test is not covered.
function reachedByTests(snapshot) {
  const sources = Object.values(snapshot.sources).filter(source => source.ref === snapshot.head_sha && source.kind === 'source' && JS_PATH.test(source.path));
  const known = [...new Set([...sources.map(source => source.path), ...snapshot.files.map(file => file.path), ...(snapshot.test_imports || []).map(item => item.path)])];
  const edges = new Map(sources.map(source => [source.path, specifiersOf(source.content)]));
  const roots = [...sources.filter(source => isTestPath(source.path)).map(source => source.path), ...(snapshot.test_imports || []).filter(item => isTestPath(item.path)).map(item => item.path)];
  for (const item of snapshot.test_imports || []) edges.set(item.path, item.specifiers);
  const reached = new Map();
  for (const root of new Set(roots)) {
    const seen = new Set(); const queue = [root];
    while (queue.length) {
      const from = queue.shift();
      for (const specifier of edges.get(from) || []) for (const target of resolveSpecifier(from, specifier, known)) {
        if (seen.has(target)) continue;
        seen.add(target); if (!isTestPath(target)) queue.push(target);
        reached.set(target, [...(reached.get(target) || []), root]);
      }
    }
  }
  return reached;
}

// Controller-computed linkage shown to the reviewers: which supplied or discovered tests exercise each
// changed code file, directly or through supplied callers and barrels. A reviewer must not report
// "no test imports this file" for a file listed here.
function coveringTests(snapshot) {
  const reached = reachedByTests(snapshot);
  return Object.fromEntries(snapshot.files.filter(file => file.status !== 'removed' && isCodePath(file.path))
    .map(file => [file.path, (reached.get(file.path) || []).slice(0, 5)]));
}

// A change is non-behavioural only when everything it adds or removes is shown to be inert:
// blank lines, comment-only lines, anchored type-only declarations, and import/re-export statements
// whose normalized VALUE specifiers (module path and imported names) are identical on the removed and
// added sides (re-ordered or re-wrapped). Anything else, including any trailing code on a line, is behavioural.
const IMPORT_STATEMENT = /(?:^|(?<=[\s;]))(?:import(?:\s+type)?\s*(?:[\w$]+\s*,?\s*)?(?:\*\s*as\s+[\w$]+|\{[^{}]*\})?\s*from\s*|import\s*|export(?:\s+type)?\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^{}]*\})\s*from\s*)(['"])[^'"\n]+\1[ \t]*;?/g;
const TYPE_NAME = String.raw`[\w$]+`;
const INERT_PARTS = [
  String.raw`;?`,
  String.raw`\/\/.*`,
  String.raw`\/\*(?:(?!\*\/).)*\*\/`,
  String.raw`(?:export\s+)?(?:declare\s+)?type\s+${TYPE_NAME}(?:<[^>;{}()]*>)?\s*=\s*[^;(){}\x60]*;?`,
  String.raw`(?:export\s+)?(?:declare\s+)?interface\s+${TYPE_NAME}(?:<[^>;{}()]*>)?(?:\s+extends\s+[\w$.,<> ]+)?\s*\{\s*(?:${TYPE_NAME}\??:\s*[\w$<>\[\]|& '".]+[;,]?\s*)*\}`,
];
const INERT_LINE = new RegExp(`^(?:${INERT_PARTS.join('|')})$`);

function importSpecifiers(statement) {
  const module = /(['"])([^'"\n]+)\1/.exec(statement)[2];
  const clause = statement.slice(0, statement.lastIndexOf(module)).replace(/\s*from\s*['"]?$/, '').replace(/['"]$/, '');
  if (/^(?:import|export)\s+type\b/.test(statement)) return [];
  const body = clause.replace(/^(?:import|export)\s*/, '').trim();
  if (!body || !/from\s*['"]/.test(statement)) return [`${module}|side-effect`];
  const found = [];
  const named = /\{([^{}]*)\}/.exec(body);
  const head = body.replace(/\{[^{}]*\}/, '').replace(/,\s*$/, '').trim();
  if (head) found.push(`${module}|${head.replace(/\s+/g, ' ')}`);
  for (const item of (named ? named[1] : '').split(',').map(value => value.trim().replace(/\s+/g, ' ')).filter(Boolean)) {
    if (!/^type\s/.test(item)) found.push(`${module}|${item}`);
  }
  return found;
}

// A file added whole carries its text twice, in the patch and in its head source. The local
// collector stores the patch header only and marks the body as the head source; this restores the
// exact patch, so every consumer sees the same bytes whichever form was stored.
function patchOf(snapshot, file) {
  if (file.patch_body !== 'head_source') return file.patch;
  const lines = snapshot.sources[file.head_source].content.split('\n');
  const final = lines[lines.length - 1] === '';
  if (final) lines.pop();
  return `${file.patch}${lines.map(line => `+${line}`).join('\n')}\n${final ? '' : '\\ No newline at end of file\n'}`;
}

function nonBehavioural(patch) {
  if (typeof patch !== 'string') return false;
  // Contiguous runs of one sign are one edit. A multi-line block comment is dropped only when the run
  // itself opens it at a line start and closes it at a line end; a ` * ` line without its opener in the
  // run is code-shaped and stays behavioural.
  const runs = {'-': [], '+': []}; let run = null;
  for (const line of patch.split('\n')) {
    const sign = /^(?:\+\+\+|---)/.test(line) ? null : /^[+-]/.test(line) ? line[0] : null;
    if (sign && run?.sign === sign) run.lines.push(line.slice(1));
    else {run = sign ? {sign, lines: [line.slice(1)]} : null; if (run) runs[sign].push(run);}
  }
  const side = sign => {
    const text = runs[sign].map(item => item.lines.join('\n').replace(/^[ \t]*\/\*(?:(?!\*\/)[\s\S])*\*\/[ \t]*$/gm, '')).join('\n');
    const specifiers = [];
    const rest = text.replace(IMPORT_STATEMENT, statement => {specifiers.push(...importSpecifiers(statement.trim())); return '';});
    return {specifiers: specifiers.sort(), inert: rest.split('\n').map(line => line.trim()).every(line => line === '' || INERT_LINE.test(line))};
  };
  const removed = side('-'); const added = side('+');
  return removed.inert && added.inert && JSON.stringify(removed.specifiers) === JSON.stringify(added.specifiers);
}

function linked(snapshot, name, reached) {
  if (JS_PATH.test(name)) return reached.has(name);
  const stem = moduleStem(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const token = new RegExp(`(?:^|[\\s'"\`/.:])${stem}(?=$|[\\s'"\`.;,)/])`);
  return Object.values(snapshot.sources).some(source => source.ref === snapshot.head_sha && source.kind === 'source' && isTestPath(source.path) &&
    !JS_PATH.test(source.path) && source.content.split('\n').some(line => IMPORT.test(line) && token.test(line)));
}

// Approval needs affirmative, per-file behavioural evidence. An unresolved
// integrity or completeness gate, or changed production code with no supplied
// test that imports it, is missing verification and holds automatic approval.
// A test for one file never satisfies a different changed file.
function approvalHold(report, snapshot) {
  const gate = name => report.gates.find(item => item.name === name).state;
  // The test gate matters when production code changed, or when a test change removes lines (an
  // added assertion that duplicates coverage is harmless). Documentation, data and fixtures have
  // no behaviour to test. A model's "unresolved" without a missing source behind it is an opinion:
  // completeness holds only when the review records, or the controller omitted, missing evidence.
  const executable = snapshot.files.filter(file => isExecutablePath(file.path));
  const testMatters = executable.some(file => (!isTestPath(file.path) && !nonBehavioural(patchOf(snapshot, file))) || (isTestPath(file.path) && /^-(?!--)/m.test(patchOf(snapshot, file))));
  const missing = (snapshot.omitted_sources || []).length > 0 ||
    [...(report.coverage?.sources || []), ...(report.coverage?.dependencies || [])].some(item => item.state === 'missing');
  if (testMatters && gate('test_integrity') === 'unresolved') return 'test integrity is unresolved';
  if (executable.length && missing && gate('review_completeness') === 'unresolved') return 'review completeness is unresolved';
  const reached = reachedByTests(snapshot);
  const bare = snapshot.files.filter(file => file.status !== 'removed' && isCodePath(file.path) && !nonBehavioural(patchOf(snapshot, file)) && !linked(snapshot, file.path, reached)).map(file => file.path);
  if (bare.length) return `no supplied test imports changed production code: ${bare.join(', ')}`;
  return null;
}

function validateEvidence(report, snapshot) {
  keys(report, ['version', 'snapshot', 'summary', 'evidence', 'units', 'findings', 'gates', 'accounting', 'resolutions',
    ...(snapshot.review_manifest_version ? ['coverage', 'reopenings'] : [])]);
  requireThat(report.version === RULES.version && report.snapshot === snapshot.digest && text(report.summary), 'stale identity or missing summary');
  requireThat(Array.isArray(report.evidence) && report.evidence.length > 0, 'missing evidence register');
  const evidence = new Map();
  for (const item of report.evidence) {
    keys(item, ['id', 'source', 'start', 'end', 'quote']);
    requireThat(text(item.id) && !evidence.has(item.id), 'duplicate evidence id');
    const source = snapshot.sources[item.source];
    requireThat(source && Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) &&
      item.start >= 1 && item.end >= item.start && item.end - item.start < MAX_CITATION_LINES, 'citation source or lines');
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
    for (const factor of Object.values(value)) {point(factor); citations(factor.evidence);}
  };
  requireThat(Array.isArray(report.units) && report.units.length > 0, 'empty acceptance plan');
  const unitIds = new Set();
  for (const unit of report.units) {
    keys(unit, ['id', 'title', 'kind', 'paths', 'obligation']);
    requireThat(text(unit.id) && !unitIds.has(unit.id) && text(unit.title) && text(unit.obligation) &&
      ['capability', 'mechanism'].includes(unit.kind), 'acceptance unit identity');
    unitIds.add(unit.id);
    unique(unit.paths, 'unit paths');
    requireThat(unit.paths.length > 0 && unit.paths.every(name => snapshot.paths.includes(name)), 'unit outside changed paths');
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
  if (snapshot.review_manifest_version) validateCompleteness(report, snapshot, evidence, citations);
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


// The manifest accounts for supplied context and explicitly unresolved boundaries.
// It cannot prove semantic attention, but omitted material evidence cannot be
// disguised by a satisfied generic gate or a passing test-coverage percentage.
function validateCompleteness(report, snapshot, evidence, citations) {
  keys(report.coverage, ['sources', 'dependencies']);
  const manifest = report.coverage;
  requireThat(Array.isArray(manifest.sources) && manifest.sources.length === Object.keys(snapshot.sources).length &&
    new Set(manifest.sources.map(item => item.source)).size === manifest.sources.length, 'incomplete source inventory');
  requireThat(Array.isArray(manifest.dependencies) && new Set(manifest.dependencies.map(item => item.path)).size === manifest.dependencies.length,
    'invalid dependency inventory');
  let missing = false;
  const check = (item, dependency) => {
    keys(item, [dependency ? 'path' : 'source', 'state', 'reason', 'evidence']);
    requireThat(['inspected', 'excluded', 'missing'].includes(item.state) && text(item.reason), 'source disposition');
    unique(item.evidence, 'source disposition citations');
    if (item.state === 'missing') { missing = true; requireThat(item.evidence.length === 0, 'missing source cannot claim inspection evidence'); return; }
    citations(item.evidence);
    const selected = item.evidence.map(id => snapshot.sources[evidence.get(id).source]);
    requireThat(item.state === 'excluded' || selected.some(source => dependency ? source.path === item.path && source.ref === snapshot.head_sha :
      source === snapshot.sources[item.source]), 'inspection lacks direct immutable evidence');
  };
  for (const item of manifest.sources) {
    requireThat(Object.hasOwn(snapshot.sources, item.source), 'unknown inventoried source');
    check(item, false);
    const changed = snapshot.files.some(file => [file.base_source, file.head_source].includes(item.source));
    requireThat(!changed || item.state !== 'excluded' || !snapshot.sources[item.source].content.trim(), 'changed source cannot be excluded');
  }
  for (const item of manifest.dependencies) {
    requireThat(typeof item.path === 'string' && item.path.length > 0 && item.path.length < 500 &&
      !item.path.startsWith('/') && !item.path.includes('\0') && !item.path.includes('\\') && !item.path.split('/').some(part => !part || ['.', '..', '.git'].includes(part)),
      'unsafe dependency path');
    check(item, true);
  }
  requireThat(!missing || report.gates.find(gate => gate.name === 'review_completeness').state === 'unresolved',
    'missing material source requires unresolved completeness');
  requireThat(Array.isArray(report.reopenings), 'missing reopening register');
  const reopened = new Set();
  for (const item of report.reopenings) {
    keys(item, ['id', 'reason', 'evidence']);
    requireThat(!reopened.has(item.id) && text(item.reason) && snapshot.prior_findings?.some(old => old.id === item.id &&
      ['corrected', 'dismissed'].includes(old.state)), 'invalid finding reopening');
    citations(item.evidence);
    requireThat(item.evidence.some(id => {
      const source = snapshot.sources[evidence.get(id).source];
      return source.ref === snapshot.head_sha && ['source', 'contract'].includes(source.kind);
    }), 'reopening lacks current-revision repository evidence');
    reopened.add(item.id);
  }
}

// Investigators supply facts, not numeric claims. Their placeholder range is
// not an assertion of a binding obligation and cannot yield an approval score.
function validateFacts(report, snapshot) {
  validateEvidence(report, snapshot);
}

function validateReport(report, snapshot) {
  validateEvidence(report, snapshot);
  return scoreReport(report);
}

// Hosted CI decision: the scores plus the controller's affirmative-evidence hold.
function validateApproval(report, snapshot, holdSnapshot = snapshot) {
  const scores = validateReport(report, snapshot);
  const hold = approvalHold(report, holdSnapshot);
  return hold && scores.decision === 'auto_approve' ? {...scores, decision: 'review_incomplete', hold} : scores;
}

module.exports = {patchOf, JS_PATH, coveringTests, nonBehavioural, specifiersOf, resolveSpecifier, isExecutablePath, isCodePath, moduleStem, approvalHold, validateApproval, isTestPath, FACTORS, GATES, STATES, RULES, MAX_CITATION_LINES, digest, impactOf, findingScore, scoreReport, validateFacts, validateReport};
