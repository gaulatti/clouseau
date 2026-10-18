'use strict';

const {digest, FACTORS} = require('./acceptance.cjs');

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
  for (const review of result.reviews) {
    for (const [index, unit] of review.report.units.entries()) {
      const current = review.scores.units[index];
      if (current.disposition === 'accepted') continue;
      const old = previousById.get(unit.id);
      const cause = `The material unit does not establish the required product acceptance: ${unit.title}`;
      const id = old?.kind === 'product' ? old.id : digest({repository: snapshot.repository, kind: 'product',
        obligation: unit.obligation.trim().toLowerCase().replace(/\s+/g, ' '), title: unit.title.trim().toLowerCase().replace(/\s+/g, ' ')});
      records.set(id, {id, kind: 'product', title: unit.title, path: unit.paths[0], cause, obligation: unit.obligation,
        blocking: true, state: current.disposition === 'rework' ? 'confirmed' : 'investigating'});
    }
    for (const [index, finding] of review.report.findings.entries()) {
      const current = review.scores.findings[index];
      const old = previousById.get(finding.id);
      const id = old && old.kind !== 'product' ? old.id : digest({repository: snapshot.repository, path: finding.path,
        cause: finding.cause.trim().toLowerCase().replace(/\s+/g, ' '), obligation: finding.obligation.trim().toLowerCase().replace(/\s+/g, ' ')});
      const blocking = current.disposition !== 'nonblocking';
      const existing = records.get(id);
      const record = {id, kind: 'technical', title: finding.title, path: finding.path, cause: finding.cause,
        obligation: finding.obligation, blocking, state: blocking ? current.disposition === 'blocking' ? 'confirmed' : 'investigating' : 'advisory_closed'};
      if (!existing || blocking) records.set(id, record);
    }
  }
  const unresolved = [];
  for (const old of previous) {
    const active = records.get(old.id);
    if (active?.blocking) continue;
    const resolutions = result.reviews.map(review => review.report.resolutions.find(item => item.id === old.id));
    if (old.blocking && !resolutions.every(Boolean)) {
      records.set(old.id, {...old, state: 'outstanding'}); unresolved.push(old.id);
    } else if (old.blocking) {
      records.set(old.id, {...old, blocking: false, state: resolutions.every(item => item.state === 'corrected') ? 'corrected' : 'dismissed'});
    } else if (!active) records.set(old.id, {...old, state: 'advisory_closed'});
  }
  return {findings: [...records.values()], unresolved};
}

function render(result, snapshot, state) {
  const lines = [MARKER, '## Clouseau acceptance', '', `Decision: **${clean(result.decision)}**`,
    `Revision: \`${snapshot.head_sha}\` · Policy: \`${snapshot.policy_digest}\``, '',
    'Scores are policy indices. Product acceptance requires at least 80 in every dimension; a technical finding at or above 70 blocks. Uncertainty crossing a threshold requires investigation. Display rounding never decides eligibility.', ''];
  lines.push('Fit = 35 outcome + 25 workflow + 20 domain + 10 boundary + 10 operating model. Need = 100 × max(binding, evidence × (.50 value + .30 unmetness + .20 timeliness)). Proportionality = 100 × (1 − greatest excess). Unit acceptance = min(Fit, Need, Proportionality).', '',
    'Technical Q = 100 × confidence × min(1, max(necessity, activation × severity × (1 + .25 irreversibility + .20 reach + .20 detection + .20 propagation + .15 recurrence))). xG affects optional priority only; it never creates a blocker.', '');
  for (const review of result.reviews) {
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
    for (const evidence of review.report.evidence) lines.push(`| ${clean(evidence.id)} | ${clean(evidence.source)} | ${evidence.start}–${evidence.end} |`);
    for (const evidence of review.report.evidence) lines.push('', `${clean(evidence.id)}: ${clean(evidence.quote)}`);
    for (const resolution of review.report.resolutions) lines.push('', `Disposition ${clean(resolution.id)}: **${resolution.state}** — ${clean(resolution.reason)} (${clean(resolution.evidence.join(', '))})`);
    lines.push('', '</details>');
  }
  if (state.findings.length) {
    lines.push('', '| Persistent finding | State | Blocking | Path |', '|---|---|---|---|');
    for (const finding of state.findings) lines.push(`| ${clean(finding.title)} (${finding.id}) | ${finding.state} | ${finding.blocking} | ${clean(finding.path)} |`);
  }
  if (state.unresolved.length) lines.push('', `Outstanding prior blockers: ${state.unresolved.join(', ')}. Absence from a new review is not a resolution.`);
  const value = {version: 2, repository: snapshot.repository, number: snapshot.number, head_sha: snapshot.head_sha, findings: state.findings};
  lines.push('', `<!-- clouseau-state:${Buffer.from(JSON.stringify(value)).toString('base64')} -->`);
  const body = lines.join('\n');
  if (body.length > 64000) throw new Error('Complete acceptance ledger exceeds the comment budget; retain it as an artifact and require investigation');
  return body;
}

module.exports = {MARKER, clean, score, priorState, reconcile, render};
