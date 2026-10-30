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
the ordinary CI AI reviewer. Invalid, expired, revoked or engine-mismatched
receipts block approval without an unexpected paid fallback. Refresh the public
local installation, review the current committed source again, publish a fresh
receipt, and start a fresh CI run. A central advance during that interval may
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
characters, as enforced by the existing collector. Incomplete local reviews
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

Consumer workflow template (names are the consumer's own):

```yaml
on:
  workflow_run:
    workflows: ["Palazzo CI"]      # this workflow's name
    types: [completed]
jobs:
  assess-intent:
    steps:
      # checkout main, then the frozen engine into .clouseau-ci, as for assess
      - id: wait
        uses: ./.clouseau-ci
        with:
          operation: await-verification
          pull-request: ${{ steps.install.outputs.number }}
      - if: steps.wait.outputs.verified == 'true'
        uses: ./.clouseau-ci
        with:
          operation: assess   # or verify-local
  request-reassessment:
    if: >-
      github.event_name == 'workflow_run' && github.event.workflow_run.event == 'pull_request'
    needs: resolve-clouseau
    permissions: {contents: read, pull-requests: read, actions: write}
    # checkout main and the frozen engine, then operation: request-reassessment
```

The `workflow_run` event is a trusted run of the same workflow, so it needs no
maintainer comment; the engine accepts only a `pull_request` run of the
configured workflow whose head is still the ready PR's head. The shared contract
tests `assertBoundedVerificationWait` (no inline `technicalRun` polling; later
steps gated on `verified`) and `assertReassessmentOnVerification` (the trigger
and job exist) encode this template. Where verification starts promptly the
review never ends pending and the trigger finds the run already succeeded.

A review run that produced no acceptance record (pending or failed
verification, incomplete review, not ready) cannot approve or merge. Attempt-
scoped record artifacts are never reused across reruns.

## Approved PRs after a sibling merge moves the base

Approval, the assessment and any local receipt are bound to the head **and** the
base. When one approved PR merges, every other approved PR is left behind
(GitHub auto-merge just waits) and no gate re-runs, so the
`clouseau-needs-branch-update` notice from the gate can never appear. A push to
the base branch is the only event that moves the base, so the engine
reconciles on it with the `reconcile-base` operation:

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

Consumer workflow template (names are the consumer's own):

```yaml
on:
  push:
    branches: [main]
jobs:
  reconcile-base:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: resolve-clouseau
    permissions: {contents: read, pull-requests: read, issues: write}
    concurrency: {group: clouseau-reconcile-base, cancel-in-progress: false}
    # checkout main and the frozen engine, then:
    #   operation: reconcile-base
    #   update-token: ${{ secrets.BRANCH_UPDATE_TOKEN }}   # optional
```

The shared contract test `assertBaseReconciliation` encodes the trigger, the
push-only condition, issues write without contents or actions write, and
queued (never cancelled) runs.

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
