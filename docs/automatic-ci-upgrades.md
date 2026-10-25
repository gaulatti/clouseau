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
and contracts are still complete; source size and investigation limits stay
unchanged. Incomplete local reviews retain the delivered snapshot and journal,
and the error identifies their private local evidence directory.
The final allowed local source batch is delivered before the report turn; it is
not read and discarded at the investigation limit. Three batches of up to eight
paths remain the maximum. Another source request still fails closed.

Local-only installations still need only the public Clouseau source and an
authenticated coding harness. CI configuration and provider credentials are not
installed by bastille startup. The signature authenticates an enrolled
workstation's evidence; it does not defend against a compromised workstation.

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

