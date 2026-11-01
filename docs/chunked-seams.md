# Cross-unit seams (chunked review)

Status: dark. `src/review-seams.cjs` is called by nothing yet; the unit runner and the integrator (separate changes) use it.

A defect can sit between review units: a caller in one unit of a function whose contract changed in another. The controller
computes those seams from the signed snapshot and the partition plan, never a model, so CI can recompute them with the
`seams({snapshot, plan})` hook of `src/chunked-record.cjs` (`seamsOf`).

## Seam kinds

Each seam is `{id, kind, a: {path, unit}, b: {path, unit}, exports?, excerpts}`. `a` is the file whose unit must look at
`b`; `excerpts` are the changed hunks of both ends (each capped at `excerptCap`, with `truncated` set when cut). Only edges
between DIFFERENT units are seams.

| kind | meaning |
|---|---|
| `import` | `a` imports the changed file `b` |
| `export_consumer` | as `import`, and `a` mentions an export that `b`'s patch added or removed (`exports` lists them) |
| `removed_import` | `a` still imports a path that `b` removed or renamed away |
| `test_subject` | `a` is a test that was deleted or lost lines, `b` is its subject (same stem, or imported) changed in another unit |

Edge detection reuses `specifiersOf` and `resolveSpecifier`. Semantic coupling with no import (config keys, event names)
is not detected; that limit is accepted in the design.

## Integration pass

`integrationInputs` builds one input per shard for one role: the change manifest, that role's unit summaries (`unitSummary`
forwards only titles, finding text, gate states and accounting, each bounded, labelled untrusted) and a share of the seams.
Manifest rows, summaries and seams are packed next-fit into as many shards as `integrationCap` (250,000 characters) needs.
A larger change gets more shards: size never causes a refusal and nothing is cut (an item that alone exceeds the cap gets a
shard of its own). Refusals are for integrity failures only.

`dispositionSeams` validates the pass's answers (`checked`, `finding` naming a raised finding, `missing`); a seam with no
answer is `missing`. `holdMissingSeams` records each missing seam as a `missing` coverage dependency and sets
`review_completeness` to `unresolved`, which the existing `approvalHold` turns into a hold. A report without a coverage
register cannot carry that record and is refused (`seam_hold_unrepresentable`) rather than silently approved.

Refusal codes: `limit_invalid`, `unowned_path`, `seam_answer_invalid`, `seam_unknown`,
`seam_duplicate`, `seam_finding_unknown`, `seam_hold_unrepresentable`.
