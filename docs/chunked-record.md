# Chunked review record verification

Status: dark. `src/chunked-record.cjs` is called only by `reviewDecision` in `src/local-receipt.cjs`, and only for a
record that carries a `partition`. A record without one takes exactly the previous path; its receipt digest, scores and
decision are unchanged. Nothing produces a partitioned record yet (unit runner and integration are separate changes).

## Record shape (version 3)

```
snapshot      combined snapshot, of any size (it is reviewed in bounded unit views; only the views are capped)
partition     {scheme: 'clouseau-partition/1', params: {C, S}, units: [{id, owned, context_ids, parts?, view_digest, cost}], plan_digest}
seams         controller-computed; the verifier recomputes them
result.reviews[]  {role, unit_reports: [{unit, report, drafts?}], integration: [...], drafts, grading}
result.usage[]    one entry per harness call, tagged `unit` (investigation) or by `phase` (`integration`, `grading`)
```

The merged report is derived by the injected merge function and is never stored. A review that stores `report` or
`scores` is rejected. Grades are stored once per role in `grading.decisions` (ids of the merged findings) and applied
to the derived report; the answer, its value and the set of ids must match.

## What the verifier checks, in order

1. The verifier was given protected parameters and hooks; a partitioned record is otherwise rejected.
2. Scheme `clouseau-partition/1` and the exact partition fields.
3. `partition.params` equals the protected `{C, S}` (never read from the record); any number of units.
4. The combined snapshot's digest is recomputed, whatever its size.
5. I1: every changed path is owned by exactly one unit (duplicate, unowned and foreign paths are named); a file split into
   segments (`parts: {path: {index, count}}`) is owned by one unit per segment, every index of `0..count-1` exactly once. I3: context ids
   exist. I4: each `view_digest` equals the recomputed unit view.
6. The partition recomputed from the signed snapshot and protected parameters equals the stored one, and so do the seams.
7. Per role: exactly one report per unit, each bound to its own view digest (a swapped report is refused), thin quotes
   rehydrated from the unit view, then the existing `validateInspection` against that view.
8. The merge is recomputed, grades are applied, and the existing `validateInspection` and `validateReport` run once on
   the merged report. Execution records must cover every unit, the integration pass and (with findings) grading.

The result is the same `reviews` list the non-chunked path builds. `reconcile`, `combine` and the claimed-decision
comparison then run unchanged, so there is still one decision derivation.

## Hooks and protected parameters

`options.chunked = {params: {C, S}, hooks: {partition, unitView, seams, merge}}` is accepted by
`issueReceipt`, `verifySignedRecord`, `verifyReceipt` and `reviewDecision`. Parameters come only from protected
configuration (`cap` and `max_units`, bounds of an earlier contract, are still accepted and bound nothing). The hooks are the partition and merge modules, injected so this module does not depend on them.
`acceptance-controller.cjs` does not pass the option yet, so CI rejects a partitioned record until the integrator change.

## Quote elision

`elideQuotes(report, snapshot)` drops `evidence[].quote` only when it equals the text regenerated from source and
coordinates; `rehydrateQuotes` is the exact inverse. A shorter or forged quote is kept and fails validation. About 90
percent of a report is quotes, so this is what keeps an alcantara-class record under the receipt limit.

## Multi-part receipts (no record is too large)

A record that fits one receipt (95 percent of the 3,000,000 byte receipt, 2,850,000 bytes) is signed as before. A larger
partitioned record is stored as consecutive byte slices of its own JSON (`src/receipt-parts.cjs`, 2,000,000 bytes each).
The signed payload then carries a **root** in place of the record: `{scheme: 'clouseau-receipt-parts/1', bytes, sha256,
parts: [{bytes, sha256}]}`, while `payload.record_digest` is the digest of the rebuilt record. The signature therefore covers
every byte of every part: a part that is altered, dropped, repeated, reordered or substituted fails the root, and the record
the verifier rebuilds is exactly the one that was signed. `issueReceipt` returns `{payload, signature, parts}` (parts as base64);
`publish` stores `clouseau-review.json` (the envelope) and `clouseau-review.part-0001`, `-0002`, ... as files of the one
immutable commit; `loadReceipt` reads them in the order the root lists and `verifyReceipt` joins them. Each file stays inside the
3,000,000 byte bound, and a receipt with parts is rejected unless its payload has a root (and the reverse).

The only remaining limit is the verifier's memory: it parses the rebuilt record as one JSON text, which JavaScript bounds at
about 512 MB, hundreds of megabytes of changed source. Reading the parts costs one request per 2 MB of record.

## Visible reasons

Every rejection is a `ChunkedRecordError` (`code: CHUNKED_RECORD`, `cause_code`: `chunked_record_invalid`) whose message is forwarded by `incomplete.classify` into the PR notice. Messages contain only
constant text, unit ids and bounded changed paths.
