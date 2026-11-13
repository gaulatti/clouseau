'use strict';

const fs = require('node:fs');
const {readPull} = require('./pull-read.cjs');
const branchConflict = require('./branch-conflict.cjs');
const {noticeText, noticeLine, describe} = require('./receipt-rejection.cjs');
const path = require('node:path');
const {digest, validateApproval, approvalHold, importsOf, LINKABLE_PATH} = require('./acceptance.cjs');
const {collectSnapshot, refresh, supplyTests, UNBOUNDED} = require('./acceptance-sources.cjs');
const hostedChunked = require('./hosted-chunked.cjs');
const wiring = require('./chunked-wiring.cjs');
const {chunkedVerifier, ChunkedRecordError} = require('./chunked-record.cjs');
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

// The local snapshot holds only what the local reviewer fetched. Importers are found with the same discovery the
// hosted review uses, and what it found is stored IN the record (`discovery`), so the assessment, the gate, the
// finalizer and every other path derive the decision from the same inputs: the snapshot plus its discovery. The
// signed receipt itself is not altered.
async function discoverImporters({github, repo, snapshot}) {
  const discovered = structuredClone(snapshot);
  await supplyTests({github, repo, snapshot: discovered, files: discovered.files.map(file => ({filename: file.path, status: file.status})),
    baseSha: discovered.base_sha, headSha: discovered.head_sha});
  const added = Object.entries(discovered.sources).filter(([id]) => !Object.hasOwn(snapshot.sources, id));
  // Files that are imported or import are carried as their specifiers; only a non-JS test, whose linkage reads its text, is carried whole.
  const edges = added.filter(([, source]) => LINKABLE_PATH.test(source.path)).map(([, source]) => ({path: source.path, specifiers: importsOf(source.path, source.content)}));
  return {test_imports: [...(discovered.test_imports ?? []), ...edges],
    sources: Object.fromEntries(added.filter(([, source]) => !LINKABLE_PATH.test(source.path)))};
}

function withDiscovery(snapshot, discovery) {
  return {...snapshot, test_imports: [...(snapshot.test_imports ?? []), ...discovery.test_imports], sources: {...snapshot.sources, ...discovery.sources}};
}

async function receiptHold({github, repo, snapshot, reviews}) {
  const discovery = await discoverImporters({github, repo, snapshot});
  return {discovery, hold: reviews.map(review => approvalHold(review.report, withDiscovery(snapshot, discovery))).find(Boolean)};
}

// The one place that turns a stored record into a decision, and what a disagreement looks like.
class DecisionMismatch extends Error {
  constructor(assessed, derived) {
    super('Acceptance decision differs from the deterministic record');
    this.code = 'DECISION_MISMATCH'; this.assessed = assessed; this.derived = derived;
  }
}

// A hosted chunked record (docs/chunked-hosted.md) stores per-unit reports and the integration entries, never a merged
// report. The reviews are derived here, from the signed-in-place evidence and the protected parameters, by the same
// verifier the chunked local receipts use; the approval hold is then applied exactly as for a single-snapshot record.
function chunkedReviews(record, config) {
  const verifier = chunkedVerifier(record, hostedChunked.verifierOptions(config.acceptance));
  if (record.snapshot.digest !== verifier.snapshotDigest()) throw new ChunkedRecordError('chunked_record_invalid', 'altered evidence snapshot');
  // The single-snapshot approval hold needs a source recorded as missing. A seam the integration pass left open is missing
  // evidence of the same kind (chunked-review.cjs marks the completeness gate; this makes it hold), so it holds approval too.
  const stored = new Map(record.result.reviews.map(review => [review.role, review]));
  return verifier.reviews().map(review => {
    const view = validateInspection(review.report, record.snapshot, review.drafts);
    const scores = validateApproval(review.report, view);
    const open = stored.get(review.role).integration.some(entry => entry.dispositions.some(row => row.state !== 'checked'));
    return {...review, scores: open && scores.decision === 'auto_approve' ? {...scores, decision: 'review_incomplete', hold: 'integration left seams open'} : scores};
  });
}

function verifyRecord(record, assessment, config, engine = null) {
  if (engine && (digest(record.engine) !== digest(engine) || digest(assessment.engine) !== digest(engine))) {
    throw new Error('Acceptance record belongs to a different frozen engine');
  }
  let signed = null;
  if (record.local_receipt) {
    // The receipt's own record: for a multi-part receipt the signed payload holds only the root.
    signed = require('./local-receipt.cjs').verifyReceipt(record.local_receipt, {
      engine, trust: config.local_review, repository: record.snapshot.repository, author: record.local_author, pullNumber: assessment.number,
      headSha: assessment.head_sha, baseSha: assessment.base_sha,
      configDigest: digest(config), policyDigest: policyDigest(), humanReview: humanReviewSigned(config),
    });
    for (const field of ['snapshot', 'result', 'controls', ...(Object.hasOwn(signed.record, 'partition') ? ['partition', 'seams'] : [])]) {
      if (digest(record[field]) !== digest(signed.record[field])) throw new Error('Local review record was substituted');
    }
    if (digest(record.previous.findings) !== digest(signed.record.previous.findings)) throw new Error('Local review history was substituted');
  }
  // New shape if present, else current. A local receipt record keeps its own path.
  // A partitioned local receipt keeps the local path. Its merged reviews are the ones the receipt verification derived from the
  // signed units, and that verification already requires every integration seam checked for a passing review.
  const partitioned = Object.hasOwn(record, 'partition');
  const chunked = !record.local_receipt && partitioned;
  if (assessment.version !== 2 || digest(record) !== assessment.record_digest ||
      record.snapshot.config_digest !== digest(config) || record.snapshot.policy_digest !== policyDigest() ||
      // A receipt bound to its diff (protected `binding: "diff"`) names its own revisions; the assessment's sources check bound
      // that diff to this pull request, and the gate's run-consistency checks below still compare the live pull request.
      (!(record.local_receipt && config.local_review?.binding === 'diff') &&
        (record.snapshot.head_sha !== assessment.head_sha || record.snapshot.base_sha !== assessment.base_sha)) ||
      (!record.local_receipt && record.snapshot.number !== assessment.number) || (!partitioned && record.snapshot.digest !== refresh(structuredClone(record.snapshot)).digest)) {
    throw new Error('Stale or altered acceptance record');
  }
  const reviews = chunked ? chunkedReviews(record, config) : signed && partitioned ? signed.reviews : record.result.reviews;
  const result = reviews === record.result.reviews ? record.result : {...record.result, reviews};
  if (reviews.length !== 2 || reviews.map(item => item.role).join(',') !== 'examiner,challenger') throw new Error('Both independent acceptance reviews are required');
  if (!chunked) for (const review of reviews) {
    const view = validateInspection(review.report, record.snapshot, review.drafts);
    review.scores = validateApproval(review.report, view, record.discovery ? withDiscovery(view, record.discovery) : view);
  }
  result.decision = combine(reviews);
  const state = reconcile(result, record.snapshot, record.previous.findings);
  if (state.unresolved.length && ['auto_approve', 'owner_decision'].includes(result.decision)) result.decision = 'review_incomplete';
  // A signed review that requires a human (protected `human_review: "signed"`), or a receipt for a change the fixed rules send
  // to a human, is the owner-decision hold: a maintainer approves the exact head, or the author repairs.
  const humanHold = Boolean(record.local_receipt) && (signed.human_review === true || record.local_controls === true);
  const derived = humanHold && ['auto_approve', 'repair_required'].includes(result.decision) ? 'owner_decision' :
    decided(result, record.controls || Boolean(record.local_authorization));
  if (assessment.decision !== derived) throw new DecisionMismatch(assessment.decision, derived);
  // Under the setting, a held receipt (or one a maintainer has since confirmed) may find its own published ledger on the pull request.
  const ownLedger = humanReviewSigned(config) && Boolean(record.local_receipt) && (humanHold || Boolean(record.local_authorization));
  return {state, ownLedger, confirmation: findingsHold(signed), ...publication({...result, decision: assessment.decision},
    {...record.snapshot, number: assessment.number}, state)};
}

// Opt-in, protected: a signed review that requires a human is a receipt CI holds for the maintainer (local-receipt.cjs).
const humanReviewSigned = config => config.local_review?.human_review === 'signed';
// A held signed review that carries findings a human must see: only a confirmation of the exact head counts for it (policy.cjs
// confirms()), so the owner confirms the findings of the review that holds. Any other hold (protected controls or sensitive
// paths with a passing review) confirms as before.
const findingsHold = verified => verified?.human_review === true ? {findings: true} : {};

function localRecord(verified, {engine, authorization, previous, technical, author, artifact, bundle, discovery, controls = false}) {
  return {...verified, discovery, ...(engine ? {engine} : {}), ...(authorization ? {local_authorization: authorization} : {}),
    ...(controls ? {local_controls: true} : {}), previous, technical,
    local_author: author, local_artifact: artifact, local_receipt: bundle};
}

const COMPACT_KEYS = ['discovery', 'local_artifact', 'local_author', 'local_receipt_reference', 'previous', 'technical', 'version'];

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
        COMPACT_KEYS.some(key => !Object.hasOwn(record, key)) || extra.some(key => !['engine', 'local_authorization', 'local_controls'].includes(key)) ||
        (Object.hasOwn(record, 'local_controls') && (record.local_controls !== true || !humanReviewSigned(config)))) {
      throw new Error('Invalid compact local review record');
    }
    const receipts = require('./local-receipt.cjs');
    const bundle = await receipts.loadReceipt({github, repo, ref: record.local_artifact, trust: config.local_review});
    const verified = receipts.verifyReceipt(bundle, {engine, trust: config.local_review,
      repository: `${repo.owner}/${repo.repo}`, author: record.local_author, pullNumber: assessment.number, headSha: assessment.head_sha,
      baseSha: assessment.base_sha, configDigest: digest(config), policyDigest: policyDigest(), humanReview: humanReviewSigned(config)});
    return localRecord(verified.record, {engine: record.engine, authorization: record.local_authorization,
      previous: record.previous, technical: record.technical, author: record.local_author,
      artifact: record.local_artifact, bundle, discovery: record.discovery, controls: record.local_controls === true});
  }

  async function assess({github, context, fetchImpl, retryWait, report, recordPath = RECORD, receiptOnly: receiptRoute = false, ignoreReceipt = false}) {
    // Only a repository that does not make local review optional treats the receipt-only route as requiring a receipt.
    const receiptOnly = receiptRoute && config.local_review?.mode !== 'optional';
    const repo = context.repo;
    const number = numberFor(context);
    const {data: pr} = await readPull(github, repo, number);
    const identity = {version: 2, number, head_sha: pr.head.sha, base_sha: pr.base.sha, ...(engine ? {engine} : {})};
    if (pr.state !== 'open' || pr.draft || pr.base.ref !== config.base_branch) return {...identity, decision: 'not_ready', reason: 'PR is not ready for the protected base branch'};
    const technical = await legacy.technicalRun(github, repo, pr, {receipt: true});
    const technicalBlock = technical.pending ? {decision: 'pending_technical', verification: technical.state, reason: `Waiting for all tests and ${require('./coverage-changed.cjs').requirement(config).waiting}`} :
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
      // One rule: a receipt that verifies in every respect is trusted; any other is ignored and never consulted again.
      // CI then reviews the change itself (or, where a receipt is required, asks for a new one) and shows a fixed notice.
      // The hosted fallback after an unusable receipt holds the provider credential, so it never reads the receipt at all.
      const screened = ignoreReceipt ? {ref: null} : await receipts.screenReceipt({github, repo, pr, engine, trust: config.local_review,
        configDigest: digest(config), policyDigest: policyDigest(), humanReview: humanReviewSigned(config)});
      let receiptRef = screened.ref;
      const {bundle, verified} = screened;
      const mode = receiptOnly || config.local_review?.mode === 'required' ? 'required' : config.hosted_review === 'manual' ? 'manual' : 'optional';
      const ignore = (reason, detail) => {
        receiptRef = null;
        identity.receipt_notice = reason;
        identity.receipt_notice_detail = {...detail, base_branch: config.base_branch};
        if (report) report(noticeText(reason, {mode, detail: identity.receipt_notice_detail, number}));
      };
      if (screened.rejected) ignore(screened.rejected, screened.detail);
      // Why no receipt stands: the class that ignored it, else why there was nothing to read.
      const noReceipt = () => {
        const reason = identity.receipt_notice ?? (ignoreReceipt ? 'unread' : 'absent');
        const detail = {...identity.receipt_notice_detail, base_branch: config.base_branch};
        return {fields: {receipt_notice: reason, receipt_notice_detail: detail}, sentence: describe(reason, {detail}).sentence};
      };
      // A signed local quality review is reusable even when independent CI
      // cannot yet authorize acceptance. Unstamped changes retain the existing
      // technical precondition before any paid investigation.
      if (!receiptRef && technicalBlock) return {...identity, ...technicalBlock};
      const files = await github.paginate(github.rest.pulls.listFiles, {...repo, pull_number: number, per_page: 100});
      const comments = await github.paginate(github.rest.issues.listComments, {...repo, issue_number: number, per_page: 100});
      const previous = priorState(comments, `${repo.owner}/${repo.repo}`, number);
      let discovery;
      if (receiptRef) {
        let file;
        let rejected = await receipts.screenSources({github, repo, pr, snapshot: verified.record.snapshot, config, files, reviewerSha: bundle.payload.reviewer_sha,
          note: path => {file = path;}});
        if (!rejected) {
          // The pre-PR stage tolerates unresolved evidence that CI would not: a signed review
          // is reused only when hosted approval's affirmative-evidence rule also holds.
          const held = await receiptHold({github, repo, snapshot: verified.record.snapshot, reviews: verified.reviews});
          ({discovery} = held);
          if (held.hold) {
            // Name the rule that held and, for the per-file rule, the files, so the notice is actionable.
            const [rule] = held.hold.split(': ');
            rejected = {'test integrity is unresolved': 'integrity', 'review completeness is unresolved': 'completeness',
              'no supplied test imports changed production code': 'untested'}[rule];
            file = held.hold.slice(rule.length + 2);
          }
        }
        if (rejected) {
          ignore(rejected, {file});
          if (technicalBlock) return {...identity, ...technicalBlock};
        }
      }
      if (receiptRef) {
        const managed = await legacy.managedExemptions(github, repo, pr, files);
        if (report) managed.notices.forEach(report);
        const controls = legacy.scopeReason(files, pr, managed.exempt, managed.protect);
        const authorization = controls === legacy.REVIEW_CONTROL_REASON ? await legacy.purposeConfirmation(github, repo, pr, comments, findingsHold(verified)) : null;
        // A verified receipt still never grants owner confirmation. Name which rule holds the review.
        const held = (cause, message) => Object.assign(new Error(message), {code: 'RECEIPT_AUTHORITY', cause_code: cause});
        // Opt-in (protected `human_review: "signed"`): a change the fixed rules send to a human is held for the maintainer on the
        // owner-decision path instead of leaving the receipt unusable.
        const controlsHold = Boolean(controls) && !authorization && humanReviewSigned(config);
        if (controls && !authorization && !controlsHold) {
          throw held('receipt_protected_controls', 'A verified local receipt cannot authorize a change to protected review controls ' +
            '(AGENTS.md, CI workflow or configuration, the repository policy or another configured sensitive path); ' +
            'the exact-head owner confirmation is missing.');
        }
        // On the owner-decision hold (protected `human_review: "signed"`) the gate publishes this receipt's own findings before
        // the maintainer approves, so the run that approval starts finds them on the pull request. A ledger whose findings equal
        // exactly what this signed record publishes is that, not a change; any other history still voids the receipt.
        const holds = humanReviewSigned(config) && (verified.human_review === true || Boolean(controls));
        const own = holds && digest(previous.findings) === digest(reconcile({...verified.record.result, reviews: verified.reviews},
          verified.record.snapshot, verified.record.previous.findings).findings);
        // The record keeps the signed history either way, so the gate re-derives exactly the ledger it already published.
        const recorded = own ? {...previous, findings: verified.record.previous.findings} : previous;
        if (digest(previous.findings) !== digest(verified.record.previous.findings) && !own) {
          throw held('receipt_history_changed', 'The review findings recorded on the pull request changed after the local receipt was issued.');
        }
        // A maintainer-attested receipt (an enrolled maintainer reviewed another author's pull request) is named as such.
        const attested = verified.attestation;
        const kind = attested ? 'Maintainer-attested' : 'Authenticated';
        const signedBy = attested ? ` Signed by \`${attested.signer}\` for the pull request by \`${attested.author}\`.` : '';
        if (technicalBlock) {
          if (report) report(`${kind} local Clouseau quality review verified.${signedBy} Independent CI acceptance remains blocked. CI AI calls: 0.`);
          return {...identity, ...technicalBlock, review_source: attested ? 'maintainer_attested' : 'authenticated_local', provider_api_calls: 0,
            reason: `${kind} local quality review verified without an AI rerun; independent CI acceptance remains blocked: ${technicalBlock.reason}`};
        }
        const record = localRecord(verified.record, {engine, authorization, previous: recorded, technical, author: pr.user.login,
          artifact: receiptRef, bundle, discovery, controls: controlsHold});
        // The signed bundle already lives at an immutable reference. Transport
        // only the run-specific facts; the write boundary rehydrates and
        // independently re-verifies the complete record from that reference.
        const compact = {version: 2, local_receipt_reference: true, local_artifact: receiptRef,
          local_author: pr.user.login, previous: recorded, technical, discovery, ...(engine ? {engine} : {}),
          ...(authorization ? {local_authorization: authorization} : {}), ...(controlsHold ? {local_controls: true} : {})};
        fs.writeFileSync(recordPath, JSON.stringify(compact, null, 2) + '\n');
        const human = verified.human_review === true || controlsHold;
        if (report) report(`${kind} local Clouseau review verified${human ? '; it requires a human review' : ''}.${signedBy} CI AI calls: 0.`);
        return {...identity, decision: authorization || human ? 'owner_decision' : 'auto_approve', record_digest: digest(record),
          record_reference_digest: digest(compact), review_source: attested ? 'maintainer_attested' : 'authenticated_local', provider_api_calls: 0,
          reason: human ? `${kind} local review requires a human review (${verified.human_review ? 'its signed findings are listed in the review' :
            'it changes protected review controls'}); a maintainer approves this exact head with \`/approve-intent ${pr.head.sha}\`, or the author repairs and reviews again. ` +
            'Source and signature validated without an AI rerun.' : `${kind} passing local review; source, scores and CI verification validated without an AI rerun.`};
      }
      // Opt-in (protected `exact_revert`): a tree byte-identical to an earlier tree of the base history needs no fresh review.
      const exact = config.exact_revert ? await require('./exact-revert.cjs').assess({github, repo, pr, files, comments, technical, legacy,
        config, engine, identity, recordPath, report}) : null;
      if (exact) return exact;
      // Opt-in (protected top-level `hosted_review: "manual"`): with no usable receipt the CI AI review runs only on a
      // maintainer's `/hosted-review <head sha>` for this exact head. Without one the pull request is held and no provider is
      // called; with one the run continues exactly as "automatic" would (on the receipt-only route, with the existing
      // `local_receipt_unusable`, so the reference workflow's hosted fallback starts). A repository that requires receipts
      // keeps its own outcome below.
      if (config.hosted_review === 'manual' && !(receiptOnly || config.local_review?.mode === 'required') &&
          !await legacy.hostedReviewRequested(github, repo, pr, comments)) {
        const why = noReceipt();
        return {...identity, ...why.fields, decision: 'review_incomplete', cause: 'hosted_review_manual',
          reason: `No local review receipt can be used (${why.sentence}), and this repository runs the CI AI review only on request. ` +
            `A maintainer requests it for this exact head by commenting \`/hosted-review ${pr.head.sha}\`.`};
      }
      if (receiptRoute && !receiptOnly) {
        // The receipt-only route is chosen by the workflow when the PR description carries a receipt marker, and it holds no
        // provider credential. Local review is optional here, so the repository does not require a receipt; this run simply
        // cannot review the change itself.
        const why = noReceipt();
        return {...identity, ...why.fields, decision: 'review_incomplete', cause: 'local_receipt_unusable',
          reason: `The local review receipt cannot be used (${why.sentence}), and this run is the receipt-only route, which does not run the CI AI review. Local review is optional for this repository.`};
      }
      if (receiptOnly || config.local_review?.mode === 'required') {
        const why = noReceipt();
        return {...identity, ...why.fields, decision: 'review_incomplete', cause: 'local_receipt_required',
          reason: `This repository requires an authenticated local Clouseau review receipt, and none can be used (${why.sentence}).`};
      }
      const intentConfirmation = await legacy.purposeConfirmation(github, repo, pr, comments);
      // The hosted chunked review is dark: with it absent or off this is the one collection it always was. When it is on, a
      // change whose evidence does not fit one snapshot is collected again without the size cap and reviewed in bounded units.
      const chunkedActive = hostedChunked.settings(config.acceptance);
      const collect = unbounded => collectSnapshot({github, repo, pr, files, config, technical, intentConfirmation, unbounded});
      let chunking = false;
      if (chunkedActive?.force) {
        snapshot = await collect(true); chunking = true;
      } else {
        try {snapshot = await collect(false);} catch (error) {
          if (!chunkedActive || !hostedChunked.oversize(error)) throw error;
          snapshot = await collect(true); chunking = true;
        }
      }
      snapshot.prior_findings = previous.findings;
      const repair = require('./acceptance-repair.cjs');
      const reservations = repair.history(comments, snapshot.repository, number);
      snapshot.repair_history = reservations;
      refresh(snapshot, chunking ? UNBOUNDED : undefined);
      const observe = observation => {observations.push(observation); diagnostic({identity, observations});};
      let stored; let result;
      if (chunking) {
        const run = await hostedChunked.review({snapshot, active: chunkedActive, config: config.acceptance, fetchImpl, wait: retryWait, log: report,
          observe, scope: snapshot.digest, journal: wiring.fileJournal(`${recordPath}.journal`)});
        stored = {snapshot, partition: run.partition, seams: run.seams, result: run.result};
        result = {...run.result, reviews: chunkedReviews(stored, config)};
        result.decision = combine(result.reviews);
      } else {
        result = await reviewChange({github, repo, snapshot, config: config.acceptance, fetchImpl, wait: retryWait, log: report, observe});
      }
      const state = reconcile(result, snapshot, previous.findings);
      if (state.unresolved.length && ['auto_approve', 'owner_decision'].includes(result.decision)) result.decision = 'review_incomplete';
      const managed = await legacy.managedExemptions(github, repo, pr, files);
      if (report) managed.notices.forEach(report);
      const controls = legacy.scopeReason(files, pr, managed.exempt, managed.protect);
      const decision = decided(result, Boolean(controls));
      const record = {version: chunking ? 3 : 2, ...(engine ? {engine} : {}), snapshot, ...(chunking ? {partition: stored.partition, seams: stored.seams} : {}),
        result: chunking ? {...stored.result, decision: result.decision} : result, previous, controls: Boolean(controls), technical};
      // Retain the complete record. Never place the large, model-controlled
      // ledger in workflow outputs or interpolate it into shell commands.
      const text = JSON.stringify(record, null, 2) + '\n';
      if (chunking) hostedChunked.checkTransport(process.env.CLOUSEAU_RECORD_TRANSPORT, text);
      fs.writeFileSync(recordPath, text);
      publication({...result, decision}, snapshot, state);
      const assessment = {...identity, decision, record_digest: digest(record),
        reason: controls && decision === 'owner_decision' ? controls : `Evidence-bound product and technical acceptance: ${decision}.`};
      if (!chunking && !record.controls && ['repair_required', 'blocked_integrity'].includes(result.decision)) {
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
      // A cost cap or a stopped chunked review names itself; it is a hold with a stated way forward, never a size failure.
      const {cause, reason} = error.code === 'HOSTED_CHUNKED_HELD' ? {cause: error.cause_code, reason: error.message} : require('./incomplete.cjs').classify(error);
      return {...identity, decision: 'review_incomplete', cause, reason};
    }
  }

  async function assessWhenReady({wait = ms => new Promise(resolve => setTimeout(resolve, ms)), maxPolls = 260, queuedGraceSeconds = graceSeconds(config), ...options}) {
    const schedule = pollSchedule(queuedGraceSeconds);
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      let result;
      try {result = await withRateLimit(async () => branchConflict.mark(await assess(options), {github: options.github, repo: options.context.repo, baseBranch: config.base_branch, wait}), {wait, report: options.report});}
      catch (error) {
        if (!(error instanceof RateLimitHold)) throw error;
        // The shared budget is exhausted until reset: an explicit, classified hold; the next verification
        // completion (or a re-run after the stated time) reassesses the PR.
        return {version: 2, number: numberFor(options.context), head_sha: headShaOf(options.context),
          decision: 'review_incomplete', cause: 'github_rate_limit', reason: heldReason(error), retry_after: new Date(error.resetAt).toISOString()};
      }
      if (result.decision !== 'pending_technical' || result.cause === branchConflict.CAUSE) return result;
      const {stalled, delay} = schedule(result.verification);
      if (stalled) return {...result, reason: WAITING_REASON};
      await wait(delay);
    }
    throw new Error('Verification did not finish before the assessment deadline');
  }

  // `updateGithub` is the optional independent `update-token` client; only the protected `local_review.base_moved: "update"`
  // uses it, at both base-move checks below (branch-update.cjs settle). It is never handed to the legacy gate.
  async function gate({github, context, core, assessment = JSON.parse(process.env.ASSESSMENT), recordPath = RECORD, updateGithub = null, ...options}) {
    const hold = reason => legacy.gate({github, context, core, ...options,
      assessment: {...assessment, decision: 'blocked_technical', reason}});
    if (!assessment.record_digest) {
      if (assessment.decision === 'review_incomplete') await require('./incomplete.cjs').post({github, context, assessment});
      if (assessment.decision === 'pending_technical' && assessment.cause === branchConflict.CAUSE) {
        await branchConflict.surface({github, repo: context.repo, assessment, baseBranch: config.base_branch});
      } else if (assessment.decision === 'pending_technical') await require('./incomplete.cjs').postPending({github, context, assessment});
      else await require('./incomplete.cjs').resolvePending({github, context, number: assessment.number});
      return hold(`${assessment.reason} This run produced no acceptance record (decision: ${assessment.decision}), so it cannot approve or merge. ` +
        'It is reassessed automatically when PR verification completes where the workflow has the verification trigger; otherwise re-run it ' +
        'once verification has completed, or push a new head if re-running does not produce a record.');
    }
    const record = await rehydrate(JSON.parse(fs.readFileSync(recordPath, 'utf8')), assessment, {github, repo: context.repo});
    if (record.exact_revert) return require('./exact-revert.cjs').gate({github, context, core, assessment, record, config, engine, legacy, numberFor, options});
    let verifiedRecord;
    try {verifiedRecord = verifyRecord(record, assessment, config, engine);} catch (error) {
      if (error.code !== 'DECISION_MISMATCH') throw error;
      // Never an unhandled error: the PR shows both decisions (decision names only, no record content).
      const reason = `Decision mismatch between assessment and gate: the assessment reported ${error.assessed}, the stored record yields ${error.derived}.`;
      const incomplete = {...assessment, decision: 'review_incomplete', cause: 'decision_mismatch', reason};
      await require('./incomplete.cjs').post({github, context, assessment: incomplete});
      return hold(reason);
    }
    const {body, pages} = verifiedRecord;
    await require('./incomplete.cjs').resolvePending({github, context, number: assessment.number});
    if (record.snapshot.repository !== `${context.repo.owner}/${context.repo.repo}`) throw new Error('Acceptance record belongs to a different repository');
    const {data: pr} = await readPull(github, context.repo, numberFor(context));
    if (record.local_receipt && record.local_author !== pr.user.login) throw new Error('Local receipt author changed');
    const branchUpdate = require('./branch-update.cjs');
    // Only the base moved under the assessed head: hold with the notice, or, opted in, update the branch server-side. Only an
    // approved revision may be updated: a decision that approves, and, where the gate requires a maintainer's confirmation (the
    // owner_decision itself, a protected path, a bot-authored pull request), that confirmation of this head. Anything else keeps
    // today's notice, as if the setting were absent. Without the setting nothing more is read.
    const approved = async current => {
      if (!['auto_approve', 'owner_decision'].includes(assessment.decision)) return false;
      const files = await github.paginate(github.rest.pulls.listFiles, {...context.repo, pull_number: current.number, per_page: 100});
      const {required, selfAuthored} = await legacy.humanRequirement(github, context.repo, current, files, assessment);
      return !required || await legacy.maintainerConfirmed(github, context.repo, current, {...verifiedRecord.confirmation, reviewOnly: selfAuthored});
    };
    const baseMoved = async (current, approvedHere = false) => branchUpdate.settle({github, updateGithub, repo: context.repo, pr: current, assessment,
      baseBranch: config.base_branch, approved: approvedHere,
      mode: config.local_review?.base_moved === 'update' && await approved(current) ? 'update' : undefined});
    if (branchUpdate.baseOnlyMoved(pr, assessment, config.base_branch)) throw await baseMoved(pr);
    if (pr.head.sha !== assessment.head_sha || pr.base.sha !== assessment.base_sha) throw new Error('PR changed after acceptance investigation');
    const technical = await legacy.technicalRun(github, context.repo, pr, {receipt: true});
    if (digest(technical) !== digest(record.technical)) throw new Error('Verification changed after acceptance investigation');
    const comments = await github.paginate(github.rest.issues.listComments, {...context.repo, issue_number: pr.number, per_page: 100});
    if (record.snapshot.intent_confirmation && digest(record.snapshot.intent_confirmation) !==
        digest(await legacy.purposeConfirmation(github, context.repo, pr, comments))) {
      throw new Error('Accepted purpose confirmation changed; reassess the current evidence');
    }
    if (record.local_authorization && digest(record.local_authorization) !==
        digest(await legacy.purposeConfirmation(github, context.repo, pr, comments, verifiedRecord.confirmation))) {
      throw new Error('Local review owner authorization changed; confirm this exact revision again');
    }
    const current = priorState(comments, record.snapshot.repository, pr.number);
    // The ledger this held record published itself (before the maintainer approved) is not a change in history.
    const ownLedger = verifiedRecord.ownLedger && digest(current.findings) === digest(verifiedRecord.state.findings);
    if (digest(current) !== digest(record.previous) && !ownLedger) throw new Error('Acceptance history changed; reassess the current record');
    const links = [];
    for (const [index, page] of pages.entries()) {
      const marker = page.split('\n')[0];
      const existing = comments.find(item => item.user?.login === 'github-actions[bot]' && item.body.startsWith(`${marker}\n`));
      const response = existing ? await github.rest.issues.updateComment({...context.repo, comment_id: existing.id, body: page}) :
        await github.rest.issues.createComment({...context.repo, issue_number: pr.number, body: page});
      links.push(`[Evidence ${index + 1}/${pages.length}](https://github.com/${record.snapshot.repository}/pull/${pr.number}#issuecomment-${response.data.id})`);
    }
    let published = links.length ? `${body}\n\nComplete factor inputs and evidence citations: ${links.join(' · ')}` : body;
    published += noticeLine(assessment);
    const attestation = record.local_receipt?.payload.attestation;
    if (record.local_receipt) published += `\n\n${attestation ? `Maintainer-attested local review (signed by \`${attestation.signer}\` for the pull request by \`${attestation.author}\`)` : 'Authenticated local review'}: ` +
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
        // The private-owner merge boundary: the gate submitted its approval before this re-read.
        if (branchUpdate.baseOnlyMoved(currentPr, assessment, config.base_branch)) throw await baseMoved(currentPr, true);
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
        // The accepted purpose the review read confirms as it did; the owner authorization of a findings hold follows its rule.
        for (const [authorization, hold] of [[currentRecord.snapshot.intent_confirmation, {}], [currentRecord.local_authorization, latest.confirmation]]) {
          if (authorization && digest(authorization) !== digest(await legacy.purposeConfirmation(github, context.repo, currentPr, currentComments, hold))) {
            throw new Error('Exact recorded purpose authorization changed before private merge');
          }
        }
        if (digest(priorState(currentComments, currentRecord.snapshot.repository, pr.number).findings) !== digest(latest.state.findings)) {
          throw new Error('Acceptance findings changed before private merge');
        }
      },
      // The gate's own confirmation checks (maintainerConfirmed, an `/approve-intent` comment) follow the same hold rule.
      confirmation: verifiedRecord.confirmation,
      assessment: {...assessment, decision: assessment.decision === 'owner_decision' ? 'second_opinion' : 'auto_approve'}});
  }

  async function finalize({assessment = JSON.parse(process.env.ASSESSMENT), ...options}) {
    if (engine && digest(assessment.engine) !== digest(engine)) throw new Error('Merge assessment belongs to a different frozen engine');
    return legacy.finalize({...options, assessment});
  }

  return {...legacy, assess, assessWhenReady, gate, finalize, rehydrate};
}

module.exports = {RECORD, policyDigest, numberFor, decided, verifyRecord, receiptHold, discoverImporters, withDiscovery, DecisionMismatch, createAcceptancePolicy};
