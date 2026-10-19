'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {digest, validateReport} = require('./acceptance.cjs');
const {collectSnapshot, refresh} = require('./acceptance-sources.cjs');
const {reviewChange, combine, validateInspection} = require('./acceptance-review.cjs');
const {priorState, reconcile, publication} = require('./acceptance-ledger.cjs');

const RECORD = 'work/clouseau-acceptance.json';
const policyDigest = () => digest(fs.readFileSync(path.join(__dirname, '../policy/change-acceptance.md'), 'utf8'));

function numberFor(context) {
  const value = context.payload.pull_request?.number || (context.payload.issue?.pull_request && context.payload.issue.number) || process.env.PR_NUMBER;
  if (!/^[1-9][0-9]*$/.test(String(value))) throw new Error('A PR number is required');
  return Number(value);
}

function decided(result, controls) {
  return controls && result.decision === 'auto_approve' ? 'owner_decision' : result.decision;
}

function verifyRecord(record, assessment, config) {
  if (assessment.version !== 2 || digest(record) !== assessment.record_digest ||
      record.snapshot.config_digest !== digest(config) || record.snapshot.policy_digest !== policyDigest() ||
      record.snapshot.head_sha !== assessment.head_sha || record.snapshot.base_sha !== assessment.base_sha ||
      record.snapshot.number !== assessment.number || record.snapshot.digest !== refresh(structuredClone(record.snapshot)).digest) {
    throw new Error('Stale or altered acceptance record');
  }
  const reviews = record.result.reviews;
  if (reviews.length !== 2 || reviews.map(item => item.role).join(',') !== 'examiner,challenger') throw new Error('Both independent acceptance reviews are required');
  for (const review of reviews) {
    const view = validateInspection(review.report, record.snapshot, review.drafts);
    review.scores = validateReport(review.report, view);
  }
  record.result.decision = combine(reviews);
  const state = reconcile(record.result, record.snapshot, record.previous.findings);
  if (state.unresolved.length && ['auto_approve', 'owner_decision'].includes(record.result.decision)) record.result.decision = 'review_incomplete';
  if (assessment.decision !== decided(record.result, record.controls)) throw new Error('Acceptance decision differs from the deterministic record');
  return {state, ...publication({...record.result, decision: assessment.decision}, record.snapshot, state)};
}

function createAcceptancePolicy(config, legacy) {
  async function assess({github, context, fetchImpl, retryWait, report, recordPath = RECORD}) {
    const repo = context.repo;
    const number = numberFor(context);
    const {data: pr} = await github.rest.pulls.get({...repo, pull_number: number});
    const identity = {version: 2, number, head_sha: pr.head.sha, base_sha: pr.base.sha};
    if (pr.state !== 'open' || pr.draft || pr.base.ref !== config.base_branch) return {...identity, decision: 'not_ready', reason: 'PR is not ready for the protected base branch'};
    const technical = await legacy.technicalRun(github, repo, pr, {receipt: true});
    if (technical.pending) return {...identity, decision: 'pending_technical', reason: 'Waiting for all tests and exact 100% coverage'};
    if (technical.failure) return {...identity, decision: 'blocked_technical', reason: technical.failure};
    const observations = [];
    const snapshots = {};
    let snapshot;
    fs.mkdirSync(path.dirname(recordPath), {recursive: true});
    const diagnostic = value => {
      if (snapshot) snapshots[snapshot.digest] ??= structuredClone(snapshot);
      fs.writeFileSync(`${recordPath}.diagnostic.json`, JSON.stringify({...value, snapshots}, null, 2) + '\n');
    };
    try {
      const files = await github.paginate(github.rest.pulls.listFiles, {...repo, pull_number: number, per_page: 100});
      const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number: number, per_page: 100});
      const previous = priorState(comments, `${repo.owner}/${repo.repo}`, number);
      const intentConfirmation = await legacy.purposeConfirmation(github, repo, pr, comments);
      snapshot = await collectSnapshot({github, repo, pr, files, config, technical, intentConfirmation});
      snapshot.prior_findings = previous.findings;
      const repair = require('./acceptance-repair.cjs');
      const reservations = repair.history(comments, snapshot.repository, number);
      snapshot.repair_history = reservations;
      refresh(snapshot);
      const result = await reviewChange({github, repo, snapshot, config: config.acceptance, fetchImpl, wait: retryWait, log: report,
        observe: observation => {observations.push(observation); diagnostic({identity, observations});}});
      const state = reconcile(result, snapshot, previous.findings);
      if (state.unresolved.length && ['auto_approve', 'owner_decision'].includes(result.decision)) result.decision = 'review_incomplete';
      const controls = legacy.scopeReason(files, pr);
      const decision = decided(result, Boolean(controls));
      const record = {version: 2, snapshot, result, previous, controls: Boolean(controls), technical};
      // Retain the complete record. Never place the large, model-controlled
      // ledger in workflow outputs or interpolate it into shell commands.
      fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
      publication({...result, decision}, snapshot, state);
      const assessment = {...identity, decision, record_digest: digest(record),
        reason: controls && decision === 'owner_decision' ? controls : `Evidence-bound product and technical acceptance: ${decision}.`};
      if (!record.controls && ['repair_required', 'blocked_integrity'].includes(result.decision)) {
        try {
          const proposal = await repair.propose({record, reservations, fetchImpl, wait: retryWait, log: report});
          fs.writeFileSync(`${recordPath}.repair.json`, JSON.stringify(proposal, null, 2) + '\n');
          assessment.repair_digest = digest(proposal);
        } catch (error) {diagnostic({identity, observations, repair_unavailable: error.message});}
      }
      return assessment;
    } catch (error) {
      diagnostic({identity, observations, failure: error.message, details: error.details || null});
      if (report) report(`Acceptance investigation stopped: ${error.message}`);
      return {...identity, decision: 'review_incomplete', reason: 'Automated review evidence is incomplete; inspect the assessment diagnostic and repair the missing evidence.'};
    }
  }

  async function assessWhenReady({wait = ms => new Promise(resolve => setTimeout(resolve, ms)), maxPolls = 260, ...options}) {
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const result = await assess(options);
      if (result.decision !== 'pending_technical') return result;
      await wait(15000);
    }
    throw new Error('Verification did not finish before the assessment deadline');
  }

  async function gate({github, context, core, assessment = JSON.parse(process.env.ASSESSMENT), recordPath = RECORD, ...options}) {
    const hold = reason => legacy.gate({github, context, core, ...options,
      assessment: {...assessment, decision: 'blocked_technical', reason}});
    if (!assessment.record_digest) return hold(assessment.reason);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    const {body, pages} = verifyRecord(record, assessment, config);
    if (record.snapshot.repository !== `${context.repo.owner}/${context.repo.repo}`) throw new Error('Acceptance record belongs to a different repository');
    const {data: pr} = await github.rest.pulls.get({...context.repo, pull_number: numberFor(context)});
    if (pr.head.sha !== assessment.head_sha || pr.base.sha !== assessment.base_sha) throw new Error('PR changed after acceptance investigation');
    const technical = await legacy.technicalRun(github, context.repo, pr, {receipt: true});
    if (digest(technical) !== digest(record.technical)) throw new Error('Verification changed after acceptance investigation');
    const comments = await github.paginate(github.rest.issues.listComments, {...context.repo, issue_number: pr.number, per_page: 100});
    if (record.snapshot.intent_confirmation && digest(record.snapshot.intent_confirmation) !==
        digest(await legacy.purposeConfirmation(github, context.repo, pr, comments))) {
      throw new Error('Accepted purpose confirmation changed; reassess the current evidence');
    }
    const current = priorState(comments, record.snapshot.repository, pr.number);
    if (digest(current) !== digest(record.previous)) throw new Error('Acceptance history changed; reassess the current record');
    const links = [];
    for (const [index, page] of pages.entries()) {
      const marker = page.split('\n')[0];
      const existing = comments.find(item => item.user?.login === 'github-actions[bot]' && item.body.startsWith(`${marker}\n`));
      const response = existing ? await github.rest.issues.updateComment({...context.repo, comment_id: existing.id, body: page}) :
        await github.rest.issues.createComment({...context.repo, issue_number: pr.number, body: page});
      links.push(`[Evidence ${index + 1}/${pages.length}](https://github.com/${record.snapshot.repository}/pull/${pr.number}#issuecomment-${response.data.id})`);
    }
    const published = links.length ? `${body}\n\nComplete factor inputs and literal evidence: ${links.join(' · ')}` : body;
    if (current.comment === null) await github.rest.issues.createComment({...context.repo, issue_number: pr.number, body: published});
    else await github.rest.issues.updateComment({...context.repo, comment_id: current.comment, body: published});
    await core.summary.addRaw(published).write();
    if (!['auto_approve', 'owner_decision'].includes(assessment.decision)) {
      return hold(`Clouseau ${assessment.decision}: automated investigation or an in-envelope repair is required. Owner confirmation cannot waive this result.`);
    }
    // Legacy native merge mechanics still enforce protection and current
    // technical checks. Only an explicit purpose/authority decision may use
    // the existing exact-revision owner confirmation path.
    return legacy.gate({github, context, core, ...options,
      assessment: {...assessment, decision: assessment.decision === 'owner_decision' ? 'second_opinion' : 'auto_approve'}});
  }

  return {...legacy, assess, assessWhenReady, gate};
}

module.exports = {RECORD, policyDigest, numberFor, decided, verifyRecord, createAcceptancePolicy};
