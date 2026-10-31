'use strict';

const fs = require('node:fs');
const {readPull} = require('./pull-read.cjs');
const path = require('node:path');
const {digest, validateApproval, approvalHold} = require('./acceptance.cjs');
const {collectSnapshot, refresh} = require('./acceptance-sources.cjs');
const {reviewChange, combine, validateInspection} = require('./acceptance-review.cjs');
const {priorState, reconcile, publication} = require('./acceptance-ledger.cjs');
const {pollSchedule, graceSeconds, WAITING_REASON, withRateLimit, RateLimitHold, heldReason, headShaOf} = require('./verification-wait.cjs');

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

function verifyRecord(record, assessment, config, engine = null) {
  if (engine && (digest(record.engine) !== digest(engine) || digest(assessment.engine) !== digest(engine))) {
    throw new Error('Acceptance record belongs to a different frozen engine');
  }
  if (record.local_receipt) {
    require('./local-receipt.cjs').verifyReceipt(record.local_receipt, {
      engine, trust: config.local_review, repository: record.snapshot.repository, author: record.local_author,
      headSha: assessment.head_sha, baseSha: assessment.base_sha,
      configDigest: digest(config), policyDigest: policyDigest(),
    });
    for (const field of ['snapshot', 'result', 'controls']) {
      if (digest(record[field]) !== digest(record.local_receipt.payload.record[field])) throw new Error('Local review record was substituted');
    }
    if (digest(record.previous.findings) !== digest(record.local_receipt.payload.record.previous.findings)) throw new Error('Local review history was substituted');
  }
  if (assessment.version !== 2 || digest(record) !== assessment.record_digest ||
      record.snapshot.config_digest !== digest(config) || record.snapshot.policy_digest !== policyDigest() ||
      record.snapshot.head_sha !== assessment.head_sha || record.snapshot.base_sha !== assessment.base_sha ||
      (!record.local_receipt && record.snapshot.number !== assessment.number) || record.snapshot.digest !== refresh(structuredClone(record.snapshot)).digest) {
    throw new Error('Stale or altered acceptance record');
  }
  const reviews = record.result.reviews;
  if (reviews.length !== 2 || reviews.map(item => item.role).join(',') !== 'examiner,challenger') throw new Error('Both independent acceptance reviews are required');
  for (const review of reviews) {
    const view = validateInspection(review.report, record.snapshot, review.drafts);
    review.scores = validateApproval(review.report, view);
  }
  record.result.decision = combine(reviews);
  const state = reconcile(record.result, record.snapshot, record.previous.findings);
  if (state.unresolved.length && ['auto_approve', 'owner_decision'].includes(record.result.decision)) record.result.decision = 'review_incomplete';
  if (assessment.decision !== decided(record.result, record.controls || Boolean(record.local_authorization))) throw new Error('Acceptance decision differs from the deterministic record');
  return {state, ...publication({...record.result, decision: assessment.decision},
    {...record.snapshot, number: assessment.number}, state)};
}

function localRecord(verified, {engine, authorization, previous, technical, author, artifact, bundle}) {
  return {...verified, ...(engine ? {engine} : {}), ...(authorization ? {local_authorization: authorization} : {}), previous, technical,
    local_author: author, local_artifact: artifact, local_receipt: bundle};
}

const COMPACT_KEYS = ['local_artifact', 'local_author', 'local_receipt_reference', 'previous', 'technical', 'version'];

function createAcceptancePolicy(config, legacy, engine = null) {
  if (config.local_review?.central_source && !require('./central-version.cjs').acceptsEngine(config.local_review, engine)) {
    throw new Error('Protected central-source integration requires this run frozen engine identity');
  }
  // A transported compact local record is expanded only from its immutable signed
  // receipt, then verifyRecord binds the result to the assessed record digest.
  async function rehydrate(record, assessment, {github, repo}) {
    if (!record.local_receipt_reference) {
      if (assessment.record_reference_digest !== undefined) throw new Error('Stale or altered acceptance record');
      return record;
    }
    if (digest(record) !== assessment.record_reference_digest) throw new Error('Stale or altered acceptance record');
    if (engine && (digest(record.engine) !== digest(engine) || digest(assessment.engine) !== digest(engine))) {
      throw new Error('Acceptance record belongs to a different frozen engine');
    }
    const extra = Object.keys(record).filter(key => !COMPACT_KEYS.includes(key));
    if (record.local_receipt_reference !== true || Object.hasOwn(record, 'local_receipt') || Object.hasOwn(record, 'snapshot') ||
        COMPACT_KEYS.some(key => !Object.hasOwn(record, key)) || extra.some(key => !['engine', 'local_authorization'].includes(key))) {
      throw new Error('Invalid compact local review record');
    }
    const receipts = require('./local-receipt.cjs');
    const bundle = await receipts.loadReceipt({github, repo, ref: record.local_artifact});
    const verified = receipts.verifyReceipt(bundle, {engine, trust: config.local_review,
      repository: `${repo.owner}/${repo.repo}`, author: record.local_author, headSha: assessment.head_sha,
      baseSha: assessment.base_sha, configDigest: digest(config), policyDigest: policyDigest()});
    return localRecord(verified.record, {engine: record.engine, authorization: record.local_authorization,
      previous: record.previous, technical: record.technical, author: record.local_author,
      artifact: record.local_artifact, bundle});
  }

  async function assess({github, context, fetchImpl, retryWait, report, recordPath = RECORD, receiptOnly = false}) {
    const repo = context.repo;
    const number = numberFor(context);
    const {data: pr} = await readPull(github, repo, number);
    const identity = {version: 2, number, head_sha: pr.head.sha, base_sha: pr.base.sha, ...(engine ? {engine} : {})};
    if (pr.state !== 'open' || pr.draft || pr.base.ref !== config.base_branch) return {...identity, decision: 'not_ready', reason: 'PR is not ready for the protected base branch'};
    const technical = await legacy.technicalRun(github, repo, pr, {receipt: true});
    const technicalBlock = technical.pending ? {decision: 'pending_technical', verification: technical.state, reason: 'Waiting for all tests and exact 100% coverage'} :
      technical.failure ? {decision: 'blocked_technical', reason: technical.failure} : null;
    const observations = [];
    const snapshots = {};
    let snapshot;
    fs.mkdirSync(path.dirname(recordPath), {recursive: true});
    const diagnostic = value => {
      if (snapshot) snapshots[snapshot.digest] ??= structuredClone(snapshot);
      fs.writeFileSync(`${recordPath}.diagnostic.json`, JSON.stringify({...value, snapshots}, null, 2) + '\n');
    };
    try {
      const receipts = require('./local-receipt.cjs');
      const receiptRef = receipts.marker(pr.body);
      // A signed local quality review is reusable even when independent CI
      // cannot yet authorize acceptance. Unstamped changes retain the existing
      // technical precondition before any paid investigation.
      if (!receiptRef && technicalBlock) return {...identity, ...technicalBlock};
      const files = await github.paginate(github.rest.pulls.listFiles, {...repo, pull_number: number, per_page: 100});
      const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number: number, per_page: 100});
      const previous = priorState(comments, `${repo.owner}/${repo.repo}`, number);
      if (receiptRef) {
        const bundle = await receipts.loadReceipt({github, repo, ref: receiptRef});
        const verified = receipts.verifyReceipt(bundle, {engine, trust: config.local_review,
          repository: `${repo.owner}/${repo.repo}`, author: pr.user.login, headSha: pr.head.sha, baseSha: pr.base.sha,
          configDigest: digest(config), policyDigest: policyDigest()});
        await receipts.verifySources({github, repo, pr, snapshot: verified.record.snapshot, config, files, reviewerSha: bundle.payload.reviewer_sha});
        // The pre-PR stage tolerates unresolved evidence that CI would not: a signed review
        // is reused only when hosted approval's affirmative-evidence rule also holds.
        const hold = verified.record.result.reviews.map(review => approvalHold(review.report, verified.record.snapshot)).find(Boolean);
        if (hold) return {...identity, decision: 'review_incomplete', review_source: 'authenticated_local', provider_api_calls: 0,
          reason: `Authenticated local review held: ${hold}.`};
        const controls = legacy.scopeReason(files, pr);
        const authorization = controls === legacy.REVIEW_CONTROL_REASON ? await legacy.purposeConfirmation(github, repo, pr, comments) : null;
        if (digest(previous.findings) !== digest(verified.record.previous.findings) || controls && !authorization) {
          throw new Error('Local receipt cannot replace changed review history or protected-control authorization');
        }
        if (technicalBlock) {
          if (report) report('Authenticated local Clouseau quality review verified. Independent CI acceptance remains blocked. CI AI calls: 0.');
          return {...identity, ...technicalBlock, review_source: 'authenticated_local', provider_api_calls: 0,
            reason: `Authenticated local quality review verified without an AI rerun; independent CI acceptance remains blocked: ${technicalBlock.reason}`};
        }
        const record = localRecord(verified.record, {engine, authorization, previous, technical, author: pr.user.login,
          artifact: receiptRef, bundle});
        // The signed bundle already lives at an immutable reference. Transport
        // only the run-specific facts; the write boundary rehydrates and
        // independently re-verifies the complete record from that reference.
        const compact = {version: 2, local_receipt_reference: true, local_artifact: receiptRef,
          local_author: pr.user.login, previous, technical, ...(engine ? {engine} : {}),
          ...(authorization ? {local_authorization: authorization} : {})};
        fs.writeFileSync(recordPath, JSON.stringify(compact, null, 2) + '\n');
        if (report) report('Authenticated local Clouseau review verified. CI AI calls: 0.');
        return {...identity, decision: authorization ? 'owner_decision' : 'auto_approve', record_digest: digest(record),
          record_reference_digest: digest(compact), review_source: 'authenticated_local', provider_api_calls: 0,
          reason: 'Authenticated passing local review; source, scores and CI verification validated without an AI rerun.'};
      }
      if (receiptOnly || config.local_review?.mode === 'required') {
        return {...identity, decision: 'review_incomplete', cause: 'local_receipt_required',
          reason: 'This repository requires an authenticated local Clouseau review receipt.'};
      }
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
      const record = {version: 2, ...(engine ? {engine} : {}), snapshot, result, previous, controls: Boolean(controls), technical};
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
      const engineMismatch = error.message.startsWith('Invalid local review receipt: engine mismatch;');
      const {cause, reason} = engineMismatch ? {cause: 'engine_mismatch', reason: error.message} : require('./incomplete.cjs').classify(error);
      return {...identity, decision: 'review_incomplete', cause,
        ...(engineMismatch ? {review_source: 'authenticated_local_rejected', provider_api_calls: 0} : {}), reason};
    }
  }

  async function assessWhenReady({wait = ms => new Promise(resolve => setTimeout(resolve, ms)), maxPolls = 260, queuedGraceSeconds = graceSeconds(config), ...options}) {
    const schedule = pollSchedule(queuedGraceSeconds);
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      let result;
      try {result = await withRateLimit(() => assess(options), {wait, report: options.report});}
      catch (error) {
        if (!(error instanceof RateLimitHold)) throw error;
        // The shared budget is exhausted until reset: an explicit, classified hold; the next verification
        // completion (or a re-run after the stated time) reassesses the PR.
        return {version: 2, number: numberFor(options.context), head_sha: headShaOf(options.context),
          decision: 'review_incomplete', cause: 'github_rate_limit', reason: heldReason(error), retry_after: new Date(error.resetAt).toISOString()};
      }
      if (result.decision !== 'pending_technical') return result;
      const {stalled, delay} = schedule(result.verification);
      if (stalled) return {...result, reason: WAITING_REASON};
      await wait(delay);
    }
    throw new Error('Verification did not finish before the assessment deadline');
  }

  async function gate({github, context, core, assessment = JSON.parse(process.env.ASSESSMENT), recordPath = RECORD, ...options}) {
    const hold = reason => legacy.gate({github, context, core, ...options,
      assessment: {...assessment, decision: 'blocked_technical', reason}});
    if (!assessment.record_digest) {
      if (assessment.decision === 'review_incomplete') await require('./incomplete.cjs').post({github, context, assessment});
      if (assessment.decision === 'pending_technical') await require('./incomplete.cjs').postPending({github, context, assessment});
      else await require('./incomplete.cjs').resolvePending({github, context, number: assessment.number});
      return hold(`${assessment.reason} This run produced no acceptance record (decision: ${assessment.decision}), so it cannot approve or merge. ` +
        'It is reassessed automatically when PR verification completes where the workflow has the verification trigger; otherwise re-run it ' +
        'once verification has completed, or push a new head if re-running does not produce a record.');
    }
    const record = await rehydrate(JSON.parse(fs.readFileSync(recordPath, 'utf8')), assessment, {github, repo: context.repo});
    const {body, pages} = verifyRecord(record, assessment, config, engine);
    await require('./incomplete.cjs').resolvePending({github, context, number: assessment.number});
    if (record.snapshot.repository !== `${context.repo.owner}/${context.repo.repo}`) throw new Error('Acceptance record belongs to a different repository');
    const {data: pr} = await readPull(github, context.repo, numberFor(context));
    if (record.local_receipt && record.local_author !== pr.user.login) throw new Error('Local receipt author changed');
    const branchUpdate = require('./branch-update.cjs');
    if (branchUpdate.baseOnlyMoved(pr, assessment, config.base_branch)) {
      throw await branchUpdate.surface({github, repo: context.repo, pr, assessment, baseBranch: config.base_branch});
    }
    if (pr.head.sha !== assessment.head_sha || pr.base.sha !== assessment.base_sha) throw new Error('PR changed after acceptance investigation');
    const technical = await legacy.technicalRun(github, context.repo, pr, {receipt: true});
    if (digest(technical) !== digest(record.technical)) throw new Error('Verification changed after acceptance investigation');
    const comments = await github.paginate(github.rest.issues.listComments, {...context.repo, issue_number: pr.number, per_page: 100});
    if (record.snapshot.intent_confirmation && digest(record.snapshot.intent_confirmation) !==
        digest(await legacy.purposeConfirmation(github, context.repo, pr, comments))) {
      throw new Error('Accepted purpose confirmation changed; reassess the current evidence');
    }
    if (record.local_authorization && digest(record.local_authorization) !==
        digest(await legacy.purposeConfirmation(github, context.repo, pr, comments))) {
      throw new Error('Local review owner authorization changed; confirm this exact revision again');
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
    let published = links.length ? `${body}\n\nComplete factor inputs and evidence citations: ${links.join(' · ')}` : body;
    if (record.local_receipt) published += `\n\nAuthenticated local review: ` +
      `[signed evidence](https://github.com/${record.snapshot.repository}/blob/${record.local_artifact}/clouseau-review.json). ` +
      'CI verified the signature, source, scores and passing tests/coverage. **CI AI review calls: 0.**';
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
      // The private-plan path cannot delegate freshness to unavailable native
      // protection. Revalidate the exact record at its atomic write boundary.
      verifyAcceptance: async () => {
        const currentRecord = await rehydrate(JSON.parse(fs.readFileSync(recordPath, 'utf8')), assessment, {github, repo: context.repo});
        const latest = verifyRecord(currentRecord, assessment, config, engine);
        const {data: currentPr} = await readPull(github, context.repo, pr.number);
        if (branchUpdate.baseOnlyMoved(currentPr, assessment, config.base_branch)) {
          throw await branchUpdate.surface({github, repo: context.repo, pr: currentPr, assessment, baseBranch: config.base_branch});
        }
        if (currentPr.head.sha !== assessment.head_sha || currentPr.base.sha !== assessment.base_sha ||
            currentRecord.local_receipt && currentRecord.local_author !== currentPr.user.login) throw new Error('Acceptance author or revision changed before private merge');
        if (currentRecord.local_receipt) {
          const currentFiles = await github.paginate(github.rest.pulls.listFiles,
            {...context.repo, pull_number: pr.number, per_page: 100});
          await require('./local-receipt.cjs').verifySources({github, repo: context.repo, pr: currentPr,
            snapshot: currentRecord.snapshot, config, files: currentFiles,
            reviewerSha: currentRecord.local_receipt.payload.reviewer_sha});
        }
        const currentTechnical = await legacy.technicalRun(github, context.repo, currentPr, {receipt: true});
        if (digest(currentTechnical) !== digest(currentRecord.technical)) throw new Error('Verification changed before private merge');
        const currentComments = await github.paginate(github.rest.issues.listComments,
          {...context.repo, issue_number: pr.number, per_page: 100});
        for (const authorization of [currentRecord.snapshot.intent_confirmation, currentRecord.local_authorization].filter(Boolean)) {
          if (digest(authorization) !== digest(await legacy.purposeConfirmation(github, context.repo, currentPr, currentComments))) {
            throw new Error('Exact recorded purpose authorization changed before private merge');
          }
        }
        if (digest(priorState(currentComments, currentRecord.snapshot.repository, pr.number).findings) !== digest(latest.state.findings)) {
          throw new Error('Acceptance findings changed before private merge');
        }
      },
      assessment: {...assessment, decision: assessment.decision === 'owner_decision' ? 'second_opinion' : 'auto_approve'}});
  }

  async function finalize({assessment = JSON.parse(process.env.ASSESSMENT), ...options}) {
    if (engine && digest(assessment.engine) !== digest(engine)) throw new Error('Merge assessment belongs to a different frozen engine');
    return legacy.finalize({...options, assessment});
  }

  return {...legacy, assess, assessWhenReady, gate, finalize, rehydrate};
}

module.exports = {RECORD, policyDigest, numberFor, decided, verifyRecord, createAcceptancePolicy};
