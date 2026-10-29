# Review record transport

Protocol v2 assessment and privileged approval remain separate jobs. The default
`record-transport: artifact` keeps the existing behavior: callers upload the
read-only assessment's `work/clouseau-acceptance.json` and optional repair and
diagnostic files, then download that same run's artifact before gate or repair.
No upload, download, retention, or approval behavior changes in artifact mode.

When a caller explicitly chooses `record-transport: job-output`, assessment
returns an additional opaque `review-record` output. Pass it unchanged to the
separate gate or repair action, also selecting `job-output`. This is useful when
an approved runner pool can execute the jobs but Actions artifact storage quota
prevents their normal data handoff. It does not change the runner, credentials,
provider selection, qualification requirements, protected-base checkout, or
independent writer permissions.

For example, the relevant parts of an existing protected workflow become:

```yaml
jobs:
  assess:
    # Keep the existing approved runner, read-only permissions and base checkout.
    outputs:
      assessment: ${{ steps.review.outputs.assessment }}
      review-record: ${{ steps.review.outputs.review-record }}
    steps:
      # Existing protected-base checkout and setup precede this step.
      - uses: gaulatti/clouseau@FULL_REVIEWED_COMMIT_SHA
        id: review
        with:
          operation: assess
          record-transport: job-output
          config: .github/clouseau.json
          # Existing qualified provider inputs remain in this read-only job.
  approve:
    needs: assess
    # Require successful assessment; retain the existing failed-assessment guard.
    # Keep the separate writer permissions and protected-base checkout.
    steps:
      - uses: gaulatti/clouseau@FULL_REVIEWED_COMMIT_SHA
        with:
          operation: gate
          record-transport: job-output
          config: .github/clouseau.json
          assessment: ${{ needs.assess.outputs.assessment }}
          review-record: ${{ needs.assess.outputs.review-record }}
```

The same pair of outputs also supports `verify-local` and `repair`. A repair
still requires its separately supplied independent author token. It receives the
complete repair bundle only if the assessment binds its `repair_digest`. An
unexpected, missing or altered repair bundle fails before the writer runs.
An incomplete assessment may carry no record; this cannot create passing review
evidence. Every caller must retain its failed-assessment job guard.

## Authenticated local review records

When a signed local review is reused, the assessment does not copy the signed
snapshot, result and receipt into the transported record a second time. The
record carries only the run facts (`previous`, `technical`, the author, optional
engine and owner authorization) and the immutable receipt reference. The
assessment binds it with `record_reference_digest`, and `record_digest` still
names the complete record. Each write boundary (the gate and the private-plan
atomic merge check) independently loads the receipt from its immutable Git blob,
re-verifies signature, author, base, head, config, policy and engine, rebuilds
the complete record and requires its digest to equal `record_digest` before any
write. A missing, substituted or unavailable receipt fails closed with no AI
fallback. Complete records produced by earlier engines remain accepted; they are
distinguished by the absence of `record_reference_digest`.

## Data format and limits

`review-record` is a compact canonical JSON array of exactly four strings. They
contain consecutive base64url chunks of one gzip-compressed JSON envelope. Each
chunk is at most 100,000 ASCII characters; empty trailing chunks are explicit.
Consumers treat the entire output as opaque data and pass it through unchanged.
Missing, extra, nonstring, differently segmented, or noncanonical chunks fail.
The composite action evaluates the array as data and supplies four bounded
environment variables to its static JavaScript. It never inserts the payload
into executable JavaScript, shell commands, heredocs, or an evaluator. Splitting
the environment values also avoids Linux's per-string `execve` limit.

The base64url data is capped at 400,000 ASCII characters (300,000 compressed
bytes); the array adds 13 ASCII punctuation characters. The complete inflated
envelope is capped at 2 MiB, including the complete review and optional repair
bundle. Decompression enforces this limit while inflating. There is no
truncation, automatic artifact fallback, or alternate paid review route.

[GitHub limits job outputs to approximately 1 MiB per job, measured as UTF-16](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idoutputs).
The opaque record uses about 800,026 bytes of that allowance, leaving room for
the compact assessment and ordinary small outputs. Callers remain responsible
for their aggregate job-output budget. A platform-omitted or truncated output
cannot pass decoding. Diagnostics go to bounded log chunks rather than a second
large output.

Envelope version 1 contains the full record and optional repair bundle, plus an
exact binding to repository, workflow run ID, run attempt, head SHA, base SHA,
the existing canonical `assessment.record_digest`, and optional repair digest.
Gate and repair compare these values against their current context and supplied
assessment before materializing JSON in the existing fixed work paths. A
foreign repository, previous run or previous attempt fails even when the source
revision is unchanged. This binding supplies data integrity and run isolation;
it is not a replacement signature or a new source of review authority.

The unchanged verifier then checks source/configuration/policy identity,
authenticated receipts when present, independent roles, scores, findings,
decision, and history. The existing gate still rechecks live PR head/base,
current CI, owner authority and branch protection before approval. Existing
repair validation and reservation rules remain mandatory. A compressed record
never selects an operation or grants permissions, and no provider credential
enters the separate approval action.

## Failed and incomplete diagnostics

In job-output mode, the assessment preserves its existing diagnostic JSON even
when review is incomplete or the assessor throws. Under the same 2 MiB expanded
and 400,000-character encoded limits, it logs the exact file bytes losslessly as
numbered gzip/base64url chunks between
`CLOUSEAU_DIAGNOSTIC_GZIP_BASE64URL_BEGIN` and
`CLOUSEAU_DIAGNOSTIC_GZIP_BASE64URL_END`. The beginning includes byte length,
encoded length and SHA-256. Recover chunks in numerical order, concatenate their
base64url values, decode and gunzip under the same expanded cap, and compare the
recovered bytes' length and SHA-256 with the header. These are data-only log
lines; raw provider headers and private signing identity files are never read.

If a diagnostic exceeds either cap, the action retains the exact original file
and copies it outside the checkout to a unique system temporary directory named
with the current run ID and attempt. The directory is private (0700), and the
file is private (0600). It streams a SHA-256 digest and logs the retained absolute
path and hash, then fails before emitting an approval-eligible record. The
system temporary directory must be outside the checkout. No oversized file is
truncated or deleted, and no automatic retention infrastructure is installed.
This oversized copy is **worker-local evidence, not a GitHub artifact**. Its
availability follows the explicitly accepted persistent runner's lifecycle and
requires operator retrieval before that worker is discarded. Artifact-mode
diagnostic retention remains the caller's existing responsibility.
