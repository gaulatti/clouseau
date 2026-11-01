# Automatic CI upgrades

Clouseau's protected review workflow uses the shared protocol below. Palazzo
and Colombo enable it through their own protected workflow installation PRs;
the shared release alone does not install consumer CI.
“Latest” means the commit returned for `gaulatti/clouseau`'s protected `main`
when the workflow's isolated `resolve-clouseau` job starts. It does not mean a
release tag, a contributor branch, or an unmerged candidate. Protection and the
central review process authorize that source; signatures retain their existing
workstation trust boundary.

The small `scripts/resolve` bootstrap is pinned once in trusted consumer workflow
configuration. It has no source-selection inputs. It checks the public GitHub
branch response, requires protected main and a full lowercase commit SHA, checks
out that SHA without persisted credentials, and computes the engine content
digest from that actual source. Unavailable, malformed and unprotected results
fail the workflow. There is no previous-version fallback or private dependency.

Every engine job directly needs that resolver and checks out its SHA. Jobs pass
`CLOUSEAU_ENGINE_SHA` and `CLOUSEAU_ENGINE_DIGEST` from those job outputs; the
local action verifies the actual content and, when available, checkout commit.
Bootstrap identification checks the clean revision both before and after hashing.
These are trusted workflow values, never PR text or uploaded evidence. Git-free
action bundles verify their content digest against the same immutable selection.
Missing resolver output selects an invalid all-zero commit at checkout, so it
cannot silently select a default branch. The required approval job also fails
when resolution prevents assessment.
Tests of Clouseau itself still exercise proposed code; ordinary protected review
uses central main. The existing explicit owner-authorized installation path is
separate from automatic source selection. Explicit controller-installation pushes
skip the automatic resolver and use only their guarded, frozen candidate. They
do not publish an unused protected-main selection as their engine evidence.

GitHub action `uses` references cannot select a revision from runtime outputs.
Use a literal local action path after `actions/checkout` with an expression in
`with.ref`. Do not resolve main independently in each job. See GitHub's
[workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsuses)
and [context availability](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability).

Assessment outputs and acceptance artifacts bind the frozen SHA and computed
digest. Approval, score recalculation, repairs and finalization verify the same
identity. Advancing central main cannot change an already selected run; the next
run selects the new approved commit. Rerunning the resolver job makes a new
selection, so rerun the whole workflow after a release rather than combining
old successful jobs with a new selection.

## Consumer verify jobs need no provider secret

A consumer's `.github/tests/provider-recovery.test.mjs` (a consumer-owned file)
imports `src/provider.cjs` from the frozen `.clouseau-ci` checkout and calls
`requestReview` with an injected `fetchImpl`. Because the checkout is the
resolved engine revision, an engine fix reaches every installed consumer with no
consumer change; consumers do not carry a copy of the provider.

`requestReview` therefore does not validate `DEEPSEEK_API_KEY` itself. The
named, secret-free notice for a missing or malformed key comes from
`policy.assess` (and `requestJSON` / `requestWiki` / `checkProvider` for their own
paths), which run before any request in a real review. A `verify` job, a fork PR
or a fresh installation with no provider secret must pass. Engine revisions
`d0d773b` through `bc88519` regressed this; fixed revisions need no consumer
edit. If a consumer ever pins an affected revision, the minimal workaround is
`process.env.DEEPSEEK_API_KEY ??= 'fictional-test-key';` at the top of the test,
and the upgrade path is to advance to the fixed `main`.

## Repository-local receipt authorization

Keep signer enrollment, author binding, maximum age and revocation in protected
base configuration. Replace the recurring `local_review.reviewer_digest` field
with:

```json
"central_source": {"repository": "gaulatti/clouseau", "ref": "refs/heads/main"}
```

The two configuration modes are exclusive. During the owner-confirmed
installation transition, a frozen central identity supplied by trusted workflow
configuration can authorize the engine while protected signer configuration
still contains its legacy digest. Without that trusted run identity, the legacy
digest remains mandatory. A receipt never supplies that authorization. Proposed PR configuration cannot
enroll a source or signer. CI checks the receipt's exact engine SHA and digest
against its frozen, checked-out source. A receipt cannot supply its own accepted
digest. No version-label or implicit cross-version compatibility is supported.

A matching eligible signature reuses the independent local review with zero CI
AI calls. Independent tests, exact 100% line and branch coverage, current source,
base, policy and configuration checks remain mandatory. Review-control changes require a separate, current-head owner purpose
confirmation. The receipt supplies the scored review only; CI records and
revalidates that separate authorization before approval. Missing receipts in optional mode use
the ordinary CI AI reviewer. So does any receipt that does not verify in every
respect (malformed, unknown or revoked key, bad signature, wrong author, expired,
wrong head or base, changed policy, configuration or record, different engine
revision, changed sources or diff, or a review that did not pass): it is ignored,
never accepted as evidence, CI performs every check itself and the PR shows one
fixed notice naming a bounded reason class. An ignored receipt cannot approve
anything. In `required` mode there is no hosted review, so the outcome is
`local_receipt_required` with the same notice. Refresh the public
local installation, review the current committed source again, publish a fresh
receipt, and start a fresh CI run to reuse the local review. A central advance during that interval may
require another fresh review; previous evidence must remain available.

Local investigators can inspect `.clouseau-ci/` source requests through their
own frozen public engine. This alias requires no consumer CI checkout and
adds no authority to the source. Signed engine excerpts carry the exact engine
revision; CI compares their bytes to its accepted frozen source before reuse.
The pinned bootstrap can be inspected separately as
`.clouseau-ci/scripts/resolve/action.yml@FULL_COMMIT_SHA`. Historical source is
read-only untrusted evidence from the fixed public Clouseau repository; it never
selects or executes a different review engine. CI verifies its exact immutable
bytes. Changed resolver workflows receive at most 32 observed shared source/test
dependencies up front, including their actual pinned bootstrap and the legacy
action/configuration/policy/receipt files read during migration. Wiki dependencies
are included only when the changed workflow invokes them. Changed project files
and contracts are still complete. Serialized evidence remains capped at 900,000
characters, as enforced by the existing collector. Changed dependency lockfiles
count as a bounded derived summary, not as raw text (see
`docs/change-acceptance.md`). Incomplete local reviews
retain the delivered snapshot and journal,
and the error identifies their private local evidence directory.
The final allowed local source batch is delivered before the report turn; it is
not read and discarded at the investigation limit. Eight local batches of up to
eight
paths are the maximum. The larger bounded allowance addresses the actual
multi-repository installation investigation, which needed more than three
batches within the existing source-size ceiling. Another source request still
fails closed.

Local-only installations still need only the public Clouseau source and an
authenticated coding harness. CI configuration and provider credentials are not
installed by bastille startup. The signature authenticates an enrolled
workstation's evidence; it does not defend against a compromised workstation.

## Waiting for verification

The `pull_request_target` review run and the `pull_request` verification run are
different workflow runs, so `needs:` cannot order them. A review job that polls
for verification therefore holds a runner while it waits. On a runner pool with
one slot the queued `Verify PR` job can never start behind it, and the review
used to sit until its deadline (about 30 minutes) and fail without a decision.

The review no longer holds a runner indefinitely, and no manual rerun is needed:

1. Use the `await-verification` operation instead of an inline polling script
   (`assess` with the default `wait-for-verification` applies the same rule).
   While the exact-head verification run is `in_progress` the job keeps polling.
   If no run exists or it is still queued longer than the **queue grace**, the
   step ends cleanly with output `verified=false`, makes no decision and
   creates no acceptance record. Later assessment steps are skipped with
   `if: steps.<id>.outputs.verified == 'true'`. A failed or changed verification
   still fails the step.
2. `approve-and-merge` stays red (fail closed): a record-less run cannot approve
   or merge, and its message is the run's own reason ("Waiting for
   verification..."), never a missing protocol-two record.
3. When the PR verification run completes, a `workflow_run` trigger starts the
   `request-reassessment` operation, which reruns the exact-head
   `pull_request_target` run (waiting for it to finish if it is still ending)
   unless that run already succeeded. The rerun finds verification complete and
   produces the record. Contributor tests are not rerun.

Configure the grace in `.github/clouseau.json` (whole seconds, 0 to 3600,
default 900):

```json
"verification_queue_grace_seconds": 900
```

The default is conservative so a slow runner pool is not mistaken for a
deadlock. A single-slot pool never needs the whole grace; lower it (for example
60) to release the slot sooner. With a larger pool nothing changes while
verification is running or starting within the grace.

Consumer workflow template (names are the consumer's own). The reassessment trigger lives in a
**separate workflow file** that watches the verification workflow: GitHub does not start a workflow from
its own completion, so a `workflow_run` trigger that names the workflow containing it never fires.

```yaml
# .github/workflows/ci.yml (the verification workflow, named "Palazzo CI")
on:
  pull_request:
  pull_request_target:
jobs:
  assess-intent:
    outputs:
      # the wait step publishes a precise incomplete assessment if verification truly failed, so the
      # write-capable job can post the visible notice
      assessment: ${{ steps.assess.outputs.assessment || steps.wait.outputs.assessment }}
    steps:
      # checkout main, then the frozen engine into .clouseau-ci, as for assess
      - id: wait
        uses: ./.clouseau-ci
        with:
          operation: await-verification
      - id: assess
        if: steps.wait.outputs.verified == 'true'
        uses: ./.clouseau-ci
        with:
          operation: assess   # or verify-local
```

```yaml
# .github/workflows/clouseau-reassess.yml (a different file)
on:
  workflow_run:
    workflows: ["Palazzo CI"]      # the verification workflow's name, never this workflow's own
    types: [completed]
jobs:
  request-reassessment:
    if: >-
      github.event_name == 'workflow_run' && github.event.workflow_run.event == 'pull_request'
    permissions: {contents: read, pull-requests: read, actions: write}
    # checkout main and the frozen engine, then operation: request-reassessment
```

The `workflow_run` event is a trusted run of the watched workflow, so it needs no
maintainer comment; the engine accepts only a `pull_request` run of the
configured workflow whose head is still the ready PR's head. The shared contract
tests `assertBoundedVerificationWait` (no inline `technicalRun` polling; later
steps gated on `verified`) and `assertReassessmentOnVerification` (the trigger
and job exist, and the trigger watches a different workflow than the one
containing it) encode this template. Where verification starts promptly the
review never ends pending and the trigger finds the run already succeeded.

The verification wait decides only from the final state of the latest attempt of the
exact-head `pull_request` run. A completed run whose job or step list is still being
finalized (jobs in progress, steps without a conclusion, an empty list, a job list from a newer
attempt than the run record) is re-read a bounded number of times and otherwise stays pending;
it is never converted into a failure. A final failure names the run, job or step
(`Required verification step "..." concluded skipped`) in an incomplete assessment that
`await-verification` publishes through the composite action's `assessment` output (it
maps `steps.assess` or, for this operation, `steps.await`). The wait step then ends
cleanly with `verified=false`: it does not fail, so the `assess-intent` job succeeds, hands
the assessment to `approve-and-merge` through the job output
`steps.assess.outputs.assessment || steps.wait.outputs.assessment`, and the gate posts the
visible `clouseau-review-incomplete` comment naming the failed step and then holds (it
cannot approve or merge). A consumer that does not list the wait step's output in the job
output gets no notice; `assertBoundedVerificationWait` rejects that.

Every other way the wait can end without a green verification is also visible. `await-verification`
publishes the same kind of assessment, so the gate posts a comment and holds: a verification still
queued or running when the queue grace (default 900 s, measured in waited time, not polls) or the
wait budget ends is `pending_technical`, shown as one short, idempotent `clouseau-review-pending`
comment ("waiting for PR verification; the review runs again automatically when it completes",
replaced by a resolution line once a decision exists); an exhausted GitHub API budget is
`review_incomplete` with cause `github_rate_limit` and the retry time. The wait does not end early:
a review that ended after about two minutes with no comment had been stopped by a rate-limit hold
(the budget is shared by every open PR), not by the grace. The reassessment trigger uses the same
bounded backoff; if the budget is still exhausted it fails with `Reassessment held: ... Re-run this
job after that time`, never an unhandled HttpError.

Any other HTTP error from GitHub during the wait also ends visibly: the wait publishes a
`review_incomplete` assessment with cause `github_api_error` and the reason
`GitHub API request failed: HTTP <status> <method> <owner>/<repo>/<path> (<message>)` (no host, query
or credential), which the gate posts as the `clouseau-review-incomplete` comment. A PR read that GitHub
refuses with "too many files changed" (a small PR on a branch far behind a busy base: GitHub cannot
compute the diff statistics for `GET /pulls/{n}`) is served from the pull-request list instead, and the
PR's own changed-file count comes from the paginated files endpoint; no base-versus-head comparison is used.

A review run that produced no acceptance record (pending or failed
verification, incomplete review, not ready) cannot approve or merge. Attempt-
scoped record artifacts are never reused across reruns.

## Approved PRs after a sibling merge moves the base

Approval, the assessment and any local receipt are bound to the head **and** the
base. When one approved PR merges, every other approved PR is left behind
(GitHub auto-merge just waits) and no gate re-runs, so the
`clouseau-needs-branch-update` notice from the gate can never appear. The base
moves on a merge, so the engine reconciles with the `reconcile-base` operation.
A `push` to the base branch fires only for **human** merges: a merge made by
the bot with `GITHUB_TOKEN` (the whole unattended path) creates no push event,
because GitHub starts no workflow from events caused by `GITHUB_TOKEN`. The
unattended path therefore reconciles from a trigger that does fire: a
`workflow_run` of the review workflow completing, in a **separate workflow
file** (a workflow is never started by its own completion; it must not name
itself). The operation reconciles when that completed `pull_request_target` run
belongs to a PR that is now merged into the base, and unconditionally on a
`schedule` or manual `workflow_dispatch`, which also covers an auto-merge that
completes after the review run ended. It is idempotent and cheap when nothing
is behind:

1. For every open, ready PR that has a current-head GitHub Actions bot approval
   or armed auto-merge, compare its head with the base. A PR that is not
   behind is left alone.
2. Optional `update-token` (an independent credential such as a fine-grained
   PAT or App token, like `repair-token`): the lowest-numbered stale
   same-repository PR is brought up to date with `update-branch`
   (`expected_head_sha`, no force). That push, unlike a `GITHUB_TOKEN` push,
   starts normal verification, a fresh independent review and, where required,
   a fresh local receipt. Only one PR is updated per push so the next sibling
   merge does not invalidate several in-flight re-reviews; the merge of the
   updated PR is itself a push that updates the next one.
3. Every other stale PR (all of them without `update-token`, forks, deleted head
   repositories, conflicts or a refused update) gets one visible
   `clouseau-needs-branch-update` comment, updated in place on later pushes.

Nothing is approved, merged or re-armed by this operation, and a push made with
`GITHUB_TOKEN` is never used because it would leave the new head without
tests, coverage or review evidence. Evidence is never reused across heads.
Limitation: a PR that is still being reviewed when the base moves is not
touched here; its own gate raises the notice when it finishes.

Consumer workflow template (names are the consumer's own). The human-merge trigger stays in the
verification workflow; the unattended trigger is in a separate file, normally the same file as the
verification-completed reassessment above:

```yaml
# .github/workflows/ci.yml (human merges)
on:
  push:
    branches: [main]
jobs:
  reconcile-base:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: resolve-clouseau
    permissions: {contents: read, pull-requests: write, issues: write}
    concurrency: {group: clouseau-reconcile-base, cancel-in-progress: false}
    # checkout main and the frozen engine, then:
    #   operation: reconcile-base
    #   update-token: ${{ secrets.BRANCH_UPDATE_TOKEN }}   # optional
```

```yaml
# .github/workflows/clouseau-reassess.yml (bot merges; a different file than the workflow it watches)
# Commenting on a pull request needs BOTH issues: write and pull-requests: write
# (GitHub reports x-accepted-github-permissions: issues=write; pull_requests=write).
on:
  workflow_run:
    workflows: ["Palazzo CI"]
    types: [completed]
  schedule: [{cron: '11,41 * * * *'}]    # optional, off the hour so schedules do not align: auto-merges that finish after the review run
jobs:
  reconcile-base:
    if: >-
      github.event_name == 'schedule' ||
      (github.event_name == 'workflow_run' && github.event.workflow_run.event == 'pull_request_target')
    permissions: {contents: read, pull-requests: write, issues: write}
    concurrency: {group: clouseau-reconcile-base, cancel-in-progress: false}
    # checkout main and the frozen engine, then operation: reconcile-base (same inputs as above)
```

This repository ships exactly this separate file for itself as `.github/workflows/clouseau-reconcile.yml` (watching `Clouseau CI`, no update token), so its own approved PRs also receive the notice after a bot merge.

The reconciler decides its scope from the trigger. A push, a schedule, a dispatch, or the completed review run
of a **merged** PR re-checks every open PR. The completed review run of an **open** PR re-checks only that PR:
in a batch the first merge usually happens while the others are still under review, and the later approvals
have no merge event after them, so without this their notice would never be posted. Notices are idempotent
(one comment per PR and head, edited in place when the base moves again). Every run states what it did, or why
it did nothing, in its log and run summary (`Base reconciliation skipped: ...`, `Base reconciliation (...)`),
and the template's `explain` job writes a summary line even when the `reconcile-base` job is skipped by its
`if:` (the completed run was a `pull_request` run, not a `pull_request_target` review run).

The shared contract test `assertBaseReconciliation` encodes both forms: a push trigger on
the base branch, or a `workflow_run` trigger that watches a different workflow; the push-only or
review-run-only job condition; issues write without contents or actions write; and queued (never
cancelled) runs. A condition that also admits `schedule` is accepted because it still contains the
`workflow_run` clause.

## Operations and boundaries

In artifact mode, find `clouseau-engine-<run id>-<attempt>` for the full central
SHA, source and digest. In summary mode, use the resolver's workflow summary;
every engine step also records its identity there. Acceptance records carry the same
engine identity. Keep review, receipt reuse, hosted tests, approval, merge and
deployment as distinct evidence. When CODEOWNERS exists on the protected base,
automatic merge remains restricted to authors
who own every affected path under protected-base CODEOWNERS; other contributors
need code-owner involvement and manual merge. Write access alone grants no
ownership.
Confirmed absence leaves the optional ownership gate inactive; unavailable or
invalid ownership evidence does not. All other acceptance gates remain mandatory.

The resolver's `provenance` input defaults to `artifact`. Repositories without
Actions artifact storage can explicitly select `summary`; this skips only the
additional provenance artifact upload. Resolution, protected-source validation,
immutable checkout, digest computation, SHA/digest outputs, the full workflow
summary and the run-bound engine identity in review records remain mandatory.
Unknown modes fail before resolution. This does not change review-record
transport: use its separately supported `job-output` mode when needed. Neither
mode turns a failed resolution, verification or review into success.

Normal central releases reach the next consumer run without consumer pin or
digest PRs. The stable bootstrap pin changes only when its selection protocol
needs maintenance, through an ordinary reviewed installation change.

Palazzo source CI and its separate wiki workflow each freeze their own version;
they do not share a run identity. Colombo's source CI uses this mechanism. Its
older documentation action pins are inside `backend-deploy.yml`, whose changes
trigger production deployment; those remain outside this installation. Deployment
commands, triggers and documentation publication boundaries are unchanged.

## Review evidence transport

Review source inventories use controller-assigned numeric indices over the model
transport. The controller restores each full immutable source ID before the
existing completeness validation. Unknown, duplicated or substituted sources
remain errors; malformed evidence cannot authorize approval.
The report schema permits an inspected dependency only when its current-head
source is supplied. Call-site evidence cannot establish dependency inspection;
missing material source must be requested or explicitly reported missing.



Local qualification can add explicit operator checks with
`--additional-checks FILE`; these run after accepted-base verification and exact
coverage, cannot change its coverage artifacts, and never replace CI checks.
This records the actual consumer workflow tests without application changes or
deployment. Local evidence uses lossless transport presentation, retaining all
source and prior observations while avoiding duplicate literal text. A transport
limit still fails closed with private diagnostics, never a partial approval.
The workflow contract checks every engine checkout and rejects a later checkout
that could overwrite the frozen source before tests or coverage.
