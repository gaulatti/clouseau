# Hosted chunked review

Status: dark. With `acceptance.chunked_hosted` absent (or `enabled: false`) in the protected base-branch configuration, the
hosted CI review behaves byte for byte as before, including its `evidence_budget` hold for a change above 900 KB. This
page describes what happens when a maintainer turns it on.

The tenet: Clouseau never fails a pull request because of its size. The hosted review scales by partitioning the change
into bounded units (the planner, unit views and seams of the local chunked review: `docs/chunked-runner.md`,
`docs/chunked-seams.md`), reviewing each unit with the examiner and the challenger, and integrating the seams. A cost cap
never skips evidence: when the change would exceed it, the pull request is **held** with a notice that names the cap and
how to raise it.

## Protected configuration

```json
"acceptance": {
  "examiner": "deepseek-flash", "challenger": "deepseek-v4-pro", "grader": "deepseek", "grading_model": "deepseek-flash",
  "repair_attempts": 2,
  "chunked_hosted": {"enabled": true, "max_units": 32, "max_input_tokens": 6000000}
}
```

* `enabled` (required boolean): the feature is off unless it is `true`. An invalid object is a configuration error, never
  a silent "off".
* `max_units` (default 32) and `max_input_tokens` (default 6,000,000, estimated as prompt characters divided by 4) are the
  **cost cap**. They are positive integers and may be raised as well as lowered: raising one is how a maintainer accepts the
  cost of a very large change. They live only in protected configuration read from the base branch; nothing in the pull
  request, its description or the workflow can change them.
* `force` (boolean), `params` (`{C, S}`), `concurrency`, `unit_deadline_ms`, `integration_cap`, `integration_call_seams`
  and `integration_max_seams` mean what they mean for `local_review.chunked` (`docs/local-review.md`) and may only be
  tightened below the same defaults. `force: true` reviews a change that fits one snapshot in units too (qualification).
* Enabling it requires `grader: "deepseek"`: the chunked path grades the merged findings with the `grading_model`.

The configuration digest covers this object, so turning the feature on or off changes the digest. A record assessed under
one setting is stale under the other and is never verified by the wrong reader.

## Flow

1. `assess` collects the snapshot exactly as before. Only when that fails with the 900 KB evidence budget, or with a changed
   file above 300 KB, and the feature is on, the snapshot is collected again without the size cap (a changed file may be
   as large as the GitHub contents API returns, 1,000,000 bytes; a larger one is split into segments by the planner). Any
   other failure is a failure, not a chunked review.
2. The planner partitions the combined snapshot; the seams are computed by the controller. Before any provider call the
   unit count and the estimated input (twice the sum of the unit costs, over 4) are checked against the cap.
3. Every unit is reviewed by the examiner and the challenger on that unit's view only (`concurrency` at a time), with the
   same prompts as the local review whose signed output CI already accepts. A unit cannot request more source. A reply that
   fails its own validation is asked again with the same prompt, twice at most, as in the single-snapshot review.
4. One blind integration pass per role dispositions every seam (`checked`, `finding`, `missing`). Seams beyond
   `integration_max_seams` are recorded as `missing`; none is skipped.
5. The unit reports are merged by the existing merge rules (any blocking finding blocks), the merged findings are graded
   once per role, and the decision is derived by the same code the gate runs.
6. A role that left any seam not `checked` holds approval (`review_incomplete`, "integration left seams open"). Missing or
   overflow evidence never approves.

## Record (version 3)

`work/clouseau-acceptance.json` for a chunked assessment has the shape of the local chunked record (`docs/chunked-record.md`):

```
version 3, snapshot (any size), partition, seams, result.reviews[] {role, unit_reports[], integration[], drafts, grading},
result.usage[] (one entry per provider call, tagged by unit or phase), previous, controls, technical
```

The merged report is derived, never stored. A record without `partition` is read exactly as before (new shape if present,
else current). The record is not signed; it is bound to the assessment by `record_digest`, as every hosted record is. The gate
and the atomic write boundary (`verifyAcceptance`) call the same `verifyRecord`, which for a partitioned record:

* requires the feature to be enabled in the protected configuration (otherwise the record is refused);
* recomputes the snapshot digest, the partition from the snapshot and the protected `{C, S}`, every unit view digest and the
  seams (a forged or tampered partition, a missing or foreign unit report, a report replayed for another unit, a dropped
  integration entry or an altered snapshot are refused);
* validates each unit report against its own view, recomputes the merge and the grades, and runs the usual approval hold.

The record travels as a workflow artifact, which has no 3 MB limit, so the signed multi-part receipt logic
(`docs/receipt-compatibility.md`) is not needed. The `job-output` record transport (`docs/record-transport.md`) carries at
most 2 MiB expanded and 300,000 bytes gzipped. When the workflow selects `job-output` and a chunked record exceeds either
limit, `assess` does not write the record: the pull request is held (`review_incomplete`, cause `chunked_record_transport`)
with a notice saying to set `record-transport` to `artifact` (the default) and re-run. It is never a size failure. A chunked record produces no automatic repair proposal.

## Notices

A held review names its cause (all are `review_incomplete`, never an approval or a merge):

| cause | meaning | next step |
| --- | --- | --- |
| `chunked_unit_cap` | the change needs more units than `max_units` | raise `max_units` in the protected configuration, or accept the hold |
| `chunked_token_cap` | the estimated input (before the run) or the running total exceeds `max_input_tokens` | raise `max_input_tokens` |
| `chunked_<code>` | the chunked runner refused (`unit_deadline`, `prompt_too_large`, `unit_source_request`, `integration_input_too_large`, ...) | the reason carries the runner's message |

Raising a cap changes the configuration digest, so the next run reviews the change afresh under the new configuration.
Finished provider calls are remembered in `<record>.journal/` keyed by (snapshot, role, phase, request); a re-run under
the **same** configuration (after a provider outage or a rate limit, with the work directory restored) never asks a
finished call again.

## Cost

Measured from the recorded usage of the end-to-end fake runs (`src/hosted-chunked-flow.test.cjs`), priced with the published
tariffs in `src/review-cost.cjs` (as of 2026-10-18; USD per million tokens: `deepseek-flash` miss 0.15 and output 0.60,
`deepseek-v4-pro` miss 0.66 and output 1.98), examiner on flash, challenger on v4-pro, no cache hits assumed, 4,000 output
tokens per investigation call and 500 for the others. `review-cost` reports a lower and an upper estimate (the upper is twice
the lower):

| change (added source) | units | estimated input | estimated cost |
| --- | --- | --- | --- |
| 1.2 MB (40 modules and tests) | 6 | 1.5 M tokens | $0.66 to $1.33 |
| 4 MB (134 modules and tests) | 20 | 5.0 M tokens | $2.30 to $4.60 |

So about $0.55 per MB of changed source (upper $1.10). Prompt characters are about 4.9 times the changed source (each unit prompt
carries its source, patch, proofs and the policy, and both roles review it). Cost is linear in the units.

The default caps (`max_units` 32, `max_input_tokens` 6,000,000) are sized from this: a 4 MB change (20 units, 5.0 M tokens)
and a 1.2 MB change pass without a hold; the worst case under the cap, every token priced as a v4-pro miss with the upper
estimate, is 6 M x $0.66 x 2, about $7.9, below $8. A test asserts both ceilings ($2 and $8) against the upper estimate. Scale
the figures to your own models and raise the caps in protected configuration to accept a larger change.

## Limits

* GitHub omits the patch of a very large diff. A changed file without a patch is still "Changed-file evidence is incomplete"
  (`changed_files_incomplete`); that is a GitHub limit, not a size policy of Clouseau.
* The unit prompts and the DeepSeek tool schemas are exercised with fakes only. Qualify the route with
  `evaluate-acceptance` against the real provider before enabling it for a repository.
* Recorded grading provenance names the local grading seam (`local-harness`); the model is in the usage entries.
