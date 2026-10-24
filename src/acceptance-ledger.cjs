'use strict';

const {digest, FACTORS, RULES} = require('./acceptance.cjs');

const MARKER = '<!-- clouseau-acceptance:v2 -->';
const STATE = /<!-- clouseau-state:([A-Za-z0-9+/=]+) -->/;

function clean(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;').replaceAll('`', '&#96;').replaceAll('@', '').replace(/[\r\n]+/g, ' ');
}

function score(min, max) {
  return min === max ? min.toFixed(2) : `${min.toFixed(2)}–${max.toFixed(2)}`;
}

function priorState(comments, repository, number) {
  const comment = [...comments].reverse().find(item => item.user?.login === 'github-actions[bot]' && item.body.includes(MARKER));
  if (!comment) return {comment: null, findings: []};
  const encoded = comment.body.match(STATE);
  if (!encoded || encoded[1].length > 60000) throw new Error('The previous acceptance ledger is incomplete');
  const value = JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8'));
  if (value.version !== 2 || value.repository !== repository || value.number !== number ||
      !/^[a-f0-9]{40}$/.test(value.head_sha) || !Array.isArray(value.findings) ||
      value.findings.some(item => !/^[a-f0-9]{64}$/.test(item.id) || typeof item.blocking !== 'boolean' ||
        !['confirmed', 'investigating', 'outstanding', 'corrected', 'dismissed', 'advisory_closed'].includes(item.state) ||
        !item.title || !item.path || !item.cause || !item.obligation)) {
    throw new Error('The previous acceptance ledger failed identity validation');
  }
  return {comment: comment.id, findings: value.findings};
}

function reconcile(result, snapshot, previous = []) {
  const records = new Map();
  const previousById = new Map(previous.map(item => [item.id, item]));
  const roots = new Map();
  const normalized = text => text.trim().toLowerCase().replace(/\s+/g, ' ');
  const related = (candidate, kind) => previousById.get(candidate.id) || (snapshot.review_manifest_version && previous.find(old =>
    old.kind === kind && normalized(old.obligation) === normalized(candidate.obligation) &&
    (old.path === candidate.path || snapshot.files.some(file => file.path === candidate.path && snapshot.sources[file.base_source]?.path === old.path))));
  const basis = (report, ids) => [...new Set(ids.map(id => {
    const proof = report.evidence.find(item => item.id === id);
    const source = snapshot.sources[proof.source];
    // Line offsets, title wording and commit identity do not make new evidence.
    return digest({kind: source.kind, content: normalized(source.content.split('\n').slice(proof.start - 1, proof.end).join('\n'))});
  }))].sort();
  const remember = (id, report, ids) => {
    const entries = roots.get(id) || []; entries.push({report, basis: basis(report, ids)}); roots.set(id, entries);
  };
  for (const review of result.reviews) {
    for (const [index, unit] of review.report.units.entries()) {
      const current = review.scores.units[index];
      if (current.disposition === 'accepted') continue;
      const old = related({...unit, path: unit.paths[0]}, 'product');
      const cause = `The material unit does not establish the required product acceptance: ${unit.title}`;
      const id = old?.kind === 'product' ? old.id : digest({repository: snapshot.repository, kind: 'product',
        obligation: unit.obligation.trim().toLowerCase().replace(/\s+/g, ' '), title: unit.title.trim().toLowerCase().replace(/\s+/g, ' ')});
      records.set(id, {id, kind: 'product', title: unit.title, path: unit.paths[0], cause, obligation: unit.obligation,
        blocking: true, state: current.disposition === 'rework' ? 'confirmed' : 'investigating'});
      if (snapshot.review_manifest_version) remember(id, review.report, Object.values(unit.fit).flatMap(factor => factor.evidence));
    }
    for (const [index, finding] of review.report.findings.entries()) {
      const current = review.scores.findings[index];
      const old = related(finding, 'technical');
      const id = old && old.kind !== 'product' ? old.id : digest({repository: snapshot.repository, path: finding.path,
        cause: finding.cause.trim().toLowerCase().replace(/\s+/g, ' '), obligation: finding.obligation.trim().toLowerCase().replace(/\s+/g, ' ')});
      const blocking = current.disposition !== 'nonblocking';
      const existing = records.get(id);
      const record = {id, kind: 'technical', title: finding.title, path: finding.path, cause: finding.cause,
        obligation: finding.obligation, blocking, state: blocking ? current.disposition === 'blocking' ? 'confirmed' : 'investigating' : 'advisory_closed'};
      if (!existing || blocking) records.set(id, record);
      if (snapshot.review_manifest_version) remember(id, review.report, finding.evidence);
    }
  }
  const unresolved = [];
  for (const old of previous) {
    const active = records.get(old.id);
    if (active?.blocking) {
      if (snapshot.review_manifest_version && ['corrected', 'dismissed'].includes(old.state)) {
        const entries = roots.get(old.id);
        const priorBasis = new Set(old.closed_basis || old.basis || []);
        const fresh = priorBasis.size && entries.every(({report}) => {
          const reopening = report.reopenings.find(item => item.id === old.id);
          return reopening && basis(report, reopening.evidence).some(value => !priorBasis.has(value));
        });
        if (!fresh) { records.set(old.id, old); unresolved.push(old.id); }
      }
      continue;
    }
    const resolutions = result.reviews.map(review => review.report.resolutions.find(item => item.id === old.id));
    if (old.blocking && !resolutions.every(Boolean)) {
      records.set(old.id, {...old, state: 'outstanding'}); unresolved.push(old.id);
    } else if (old.blocking) {
      records.set(old.id, {...old, blocking: false, state: resolutions.every(item => item.state === 'corrected') ? 'corrected' : 'dismissed',
        ...(snapshot.review_manifest_version ? {closed_basis: [...new Set(result.reviews.flatMap((review, i) => basis(review.report, resolutions[i].evidence)))].sort(),
          resolution: resolutions.map(item => item.reason).join(' | ')} : {})});
    } else if (!active) records.set(old.id, {...old});
  }
  if (snapshot.review_manifest_version) for (const [id, record] of records) {
    const old = previousById.get(id);
    const entries = roots.get(id);
    const evidence = entries ? [...new Set(entries.flatMap(item => item.basis))].sort() : record.basis || [];
    const events = [...(old?.events || [])];
    if (!old || old.state !== record.state || old.path !== record.path) {
      const reopening = entries?.map(item => item.report.reopenings.find(value => value.id === id)).find(Boolean);
      events.push({head_sha: snapshot.head_sha, state: record.state, path: record.path,
        reason: reopening?.reason || record.resolution || record.cause});
    }
    if (events.length > 32) throw new Error('Finding history exceeds the bounded review budget; investigate without dropping decisions');
    records.set(id, {...record, basis: evidence, events});
  }
  return {findings: [...records.values()], unresolved};
}

function overview(result, snapshot, state) {
  const decisions = {
    auto_approve: ['Approved', 'Automatic approval and protected merge, after the independent CI checks pass.'],
    repair_required: ['Repair required', 'The implementation agent fixes the findings and runs verification and review again.'],
    blocked_integrity: ['Test integrity repair required', 'Repair the test or evidence problem before requesting approval.'],
    review_incomplete: ['Review incomplete', 'Investigate the missing or uncertain evidence before requesting approval.'],
    owner_decision: ['Owner decision required', 'The owner decides the purpose or authority question; all technical checks remain mandatory.'],
  };
  const [title, next] = decisions[result.decision];
  const summary = Array.from(clean(result.reviews[0].report.summary));
  const lines = [MARKER, `## Clouseau — ${title}`, '',
    summary.slice(0, 500).join('') + (summary.length > 500 ? '…' : ''), '',
    '| Assessment | Lowest score | Required |', '|---|---:|---:|'];
  for (const [name, label] of [['fit', 'Fits the repository'], ['need', 'Solves a demonstrated need'],
    ['proportionality', 'Keeps scope and complexity appropriate']]) {
    const units = result.reviews.flatMap(review => review.scores.units);
    lines.push(`| ${label} | ${score(Math.min(...units.map(unit => unit.min[name])), Math.min(...units.map(unit => unit.max[name])))} / 100 | ${RULES.product_threshold} |`);
  }
  lines.push('', 'Each material change must pass independently. Scores retain uncertainty; rounding does not decide approval.');
  if (new Set(result.reviews.map(review => review.scores.decision)).size > 1) {
    lines.push('', '**Reviewer disagreement:** ' + result.reviews.map(review => `${clean(review.role)}: ${decisions[review.scores.decision][0]}`).join('; ') + '.');
  }
  const rejected = new Set();
  for (const review of result.reviews) for (const [index, unit] of review.report.units.entries()) {
    const value = review.scores.units[index];
    if (value.disposition === 'accepted') continue;
    rejected.add(`**Change requiring attention: ${clean(unit.title)}** — ${clean(unit.obligation)} ` +
      `Acceptance: ${score(value.min.acceptance, value.max.acceptance)} / 100. ${clean(unit.alternative)}`);
  }
  for (const unit of rejected) lines.push('', unit);
  if (result.decision === 'owner_decision') {
    const questions = new Set(result.reviews.flatMap(review => review.report.decisions)
      .map(decision => `${clean(decision.question)} Options: ${decision.options.map(clean).join('; ')}.`));
    if (!questions.size) questions.add('Confirm this exact revision’s changes to protected review controls.');
    for (const question of questions) lines.push('', `**Owner decision:** ${question}`);
  }
  const findings = new Map();
  for (const review of result.reviews) for (const [index, finding] of review.report.findings.entries()) {
    const identity = digest([finding.path, finding.cause.trim().toLowerCase().replace(/\s+/g, ' '),
      finding.obligation.trim().toLowerCase().replace(/\s+/g, ' ')]);
    if (!findings.has(identity)) findings.set(identity, {finding, report: review.report, scores: []});
    findings.get(identity).scores.push(review.scores.findings[index]);
  }
  if (!findings.size) lines.push('', '**Technical findings:** None.');
  for (const {finding, report, scores} of findings.values()) {
    const min = Math.max(...scores.map(value => value.min));
    const max = Math.max(...scores.map(value => value.max));
    const status = min >= RULES.defect_threshold ? 'Blocking' : max >= RULES.defect_threshold ? 'Investigate' : 'Optional';
    const citation = report.evidence.find(item => item.id === finding.evidence[0]);
    const source = snapshot.sources[citation.source];
    const evidence = /^[a-f0-9]{40}$/.test(source.ref) && ['source', 'contract'].includes(source.kind)
      ? `[${clean(source.path)}:${citation.start}](https://github.com/${snapshot.repository}/blob/${source.ref}/${source.path.split('/').map(encodeURIComponent).join('/')}#L${citation.start}-L${citation.end})`
      : clean(citation.id);
    lines.push('', `**${status}: ${clean(finding.title)}**`, '',
      `${clean(finding.cause)} ${clean(finding.consequence)}`, '',
      `**Score:** ${score(min, max)} / 100. Findings at ${RULES.defect_threshold} or above block approval.`,
      `**Affected area:** ${clean(finding.path)}. **Trigger:** ${clean(finding.trigger)}`,
      `**Evidence:** ${evidence}. **Required outcome:** ${clean(finding.obligation)}`);
    if (status === 'Optional') lines.push(`**Expected benefit:** ${scores.some(value => value.xg === 1) ? 'Verified' : 'Not established'}. Optional priority: ${Math.max(...scores.map(value => value.priority)).toFixed(2)} / 100.`);
  }
  const gates = new Set();
  for (const review of result.reviews) for (const gate of review.report.gates) {
    if (['satisfied', 'inapplicable'].includes(gate.state)) continue;
    const detail = `**Check requiring attention — ${clean(gate.name.replaceAll('_', ' '))}:** ${clean(gate.reason)}`;
    gates.add(detail);
  }
  for (const gate of gates) lines.push('', gate);
  if (state.unresolved.length) {
    lines.push('', '**Outstanding prior blockers:** ' + state.findings.filter(finding => state.unresolved.includes(finding.id))
      .map(finding => `${clean(finding.title)} (${clean(finding.path)})`).join('; ') + '.');
  }
  lines.push('', `**Next action:** ${next}`, '', `Reviewed revision: \`${snapshot.head_sha.slice(0, 7)}\`. CI, merge and deployment are reported separately.`);
  return lines;
}

function render(result, snapshot, state, {compact = false, unbounded = false} = {}) {
  const sources = new Map();
  for (const review of result.reviews) for (const evidence of review.report.evidence) {
    if (!sources.has(evidence.source)) sources.set(evidence.source, {id: `S${sources.size + 1}`, lines: new Set()});
    const source = sources.get(evidence.source);
    for (let line = evidence.start; line <= evidence.end; line++) source.lines.add(line);
  }
  const lines = overview(result, snapshot, state);
  if (!compact) lines.push('', '<details><summary>Scoring and evidence</summary>', '',
    `Revision: \`${snapshot.head_sha}\` · Policy: \`${snapshot.policy_digest}\``, '',
    'Scores are policy indices. Product acceptance requires at least 80 in every dimension; a technical finding at or above 70 blocks. Uncertainty crossing a threshold requires investigation. Display rounding never decides eligibility.', '');
  if (!compact) lines.push('Fit = 35 outcome + 25 workflow + 20 domain + 10 boundary + 10 operating model. Need = 100 × max(binding, evidence × (.50 value + .30 unmetness + .20 timeliness)). Proportionality = 100 × (1 − greatest excess). Unit acceptance = min(Fit, Need, Proportionality).', '',
    'Technical Q = 100 × confidence × min(1, max(necessity, activation × severity × (1 + .25 irreversibility + .20 reach + .20 detection + .20 propagation + .15 recurrence))). xG affects optional priority only; it never creates a blocker.', '');
  if (!compact) for (const review of result.reviews) {
    lines.push(`### ${clean(review.role)}`, '', clean(review.report.summary), '',
      '| Unit | Fit | Need | Proportionality | Acceptance | Disposition |', '|---|---:|---:|---:|---:|---|');
    for (const unit of review.scores.units) {
      lines.push(`| ${clean(unit.id)} | ${score(unit.min.fit, unit.max.fit)} | ${score(unit.min.need, unit.max.need)} | ${score(unit.min.proportionality, unit.max.proportionality)} | ${score(unit.min.acceptance, unit.max.acceptance)} | ${unit.disposition} |`);
    }
    lines.push('', '| Finding | Score | BR | xG | Optional priority | Disposition |', '|---|---:|---:|---:|---:|---|');
    for (const [index, finding] of review.report.findings.entries()) {
      const value = review.scores.findings[index];
      lines.push(`| ${clean(finding.title)} | ${score(value.min, value.max)} | ${finding.blast_radius} | ${value.xg} | ${value.priority.toFixed(2)} | ${value.disposition} |`);
    }
    if (!review.report.findings.length) lines.push('| No admitted technical findings | — | — | — | — | — |');
    lines.push('', '| Gate | State | Evidence |', '|---|---|---|');
    for (const gate of review.report.gates) lines.push(`| ${gate.name} | ${gate.state} | ${clean(gate.reason)} |`);
    for (const unit of review.report.units) {
      lines.push('', `<details><summary>Inputs: ${clean(unit.title)}</summary>`, '', '| Group | Factor | Range | Reason | Citations |', '|---|---|---:|---|---|');
      for (const group of ['fit', 'need', 'excess']) for (const name of FACTORS[group]) {
        const factor = unit[group][name];
        lines.push(`| ${group} | ${name} | ${score(factor.min, factor.max)} | ${clean(factor.reason)} | ${clean(factor.evidence.join(', '))} |`);
      }
      lines.push('', '</details>');
    }
    for (const finding of review.report.findings) {
      lines.push('', `<details><summary>Inputs: ${clean(finding.title)}</summary>`, '',
        `Cause: ${clean(finding.cause)} · Trigger: ${clean(finding.trigger)} · Consequence: ${clean(finding.consequence)}`, '',
        '| Factor | Range | Reason | Citations |', '|---|---:|---|---|');
      for (const name of FACTORS.defect) {
        const factor = finding.factors[name];
        lines.push(`| ${name} | ${score(factor.min, factor.max)} | ${clean(factor.reason)} | ${clean(factor.evidence.join(', '))} |`);
      }
      lines.push('', '</details>');
    }
    lines.push('', '<details><summary>Immutable evidence register</summary>', '', '| Id | Source | Lines |', '|---|---|---|');
    for (const evidence of review.report.evidence) lines.push(`| ${clean(evidence.id)} | ${sources.get(evidence.source).id} | ${evidence.start}–${evidence.end} |`);
    lines.push('', '</details>');
    for (const resolution of review.report.resolutions) lines.push('', `Disposition ${clean(resolution.id)}: **${resolution.state}** — ${clean(resolution.reason)} (${clean(resolution.evidence.join(', '))})`);
  }
  if (!compact) {
    lines.push('', '<details><summary>Literal immutable source excerpts</summary>', '',
      'Each cited source line appears once. The per-review registers retain every evidence ID and exact line range.', '');
    for (const [name, source] of sources) {
      lines.push('', `**${source.id} — ${clean(name)}**`, '');
      const content = snapshot.sources[name].content.split('\n');
      for (const number of [...source.lines].sort((a, b) => a - b)) lines.push(`L${number}: ${clean(content[number - 1])}`);
    }
    lines.push('', '</details>');
  }
  if (!compact && state.findings.length) {
    lines.push('', '| Persistent finding | State | Blocking | Path |', '|---|---|---|---|');
    for (const finding of state.findings) {
      lines.push(`| ${clean(finding.title)} (${finding.id}) | ${finding.state} | ${finding.blocking} | ${clean(finding.path)} |`);
      for (const event of finding.events || []) lines.push('', `History ${finding.id}: ${clean(event.head_sha)} — **${clean(event.state)}** — ${clean(event.reason)}`);
    }
  }
  if (state.unresolved.length) lines.push('', `Outstanding prior blockers: ${state.unresolved.join(', ')}. Absence from a new review is not a resolution.`);
  if (!compact) lines.push('', '</details>');
  const value = {version: 2, repository: snapshot.repository, number: snapshot.number, head_sha: snapshot.head_sha, findings: state.findings};
  lines.push('', `<!-- clouseau-state:${Buffer.from(JSON.stringify(value)).toString('base64')} -->`);
  const body = lines.join('\n');
  if (body.length > 64000 && !unbounded) throw new Error('Complete acceptance ledger exceeds the comment budget; retain it as an artifact and require investigation');
  return body;
}

function publication(result, snapshot, state) {
  const full = render(result, snapshot, state, {unbounded: true});
  if (full.length <= 64000) return {body: full, pages: []};
  const identity = digest(full);
  const content = full.replace(MARKER, '').replace(STATE, '');
  const chunks = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + 50000, content.length);
    if (end < content.length && /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(content.slice(end - 1, end + 1))) end--;
    chunks.push(content.slice(start, end)); start = end;
  }
  const pages = chunks.map((chunk, index) =>
    `<!-- clouseau-evidence:v2 ${snapshot.head_sha} ${identity} ${index + 1} -->\n` +
    `### Acceptance evidence ${index + 1}/${chunks.length}\nRevision: ${snapshot.head_sha} · Ledger: ${identity}\n\n${chunk}`);
  const body = render(result, snapshot, state, {compact: true});
  return {body, pages};
}

module.exports = {MARKER, clean, score, priorState, reconcile, render, publication};
