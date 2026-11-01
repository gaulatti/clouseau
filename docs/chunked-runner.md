# Chunked review unit runner

Status: dark. `src/chunked-review.cjs` is called by nothing; `local_review.chunked` wiring is a later change.
`src/local-review.cjs` now exposes `investigate` and `gradeReview`, extracted unchanged from `localReview`
(an ordinary review asks the same prompts in the same order).

`chunkedReview({snapshot, plan, seams, ask, chunked, journal, scope})` runs every unit of a `clouseau-partition/1`
plan through the unchanged examiner and challenger on that unit's `unitView`, then one blind integration pass per
role, `mergeUnitReports`, and one grading round per role over the merged findings. It returns
`{result, partition, seams, reviews}`: `result` and `partition` have the record v3 shape the chunked verifier
accepts (no merged report or scores stored); `reviews` carry the merged reports for `combine` and `reconcile`.

* Limits come only from the protected `local_review.chunked` object (`params`, `concurrency` default 2, maximum 8,
  `unit_deadline_ms` default 300000, `integration_cap` default 250000). Unknown fields are refused.
* Size never refuses a review: any number of units runs in waves of `concurrency` sessions, each session bounded by
  the deadline. A missed deadline refuses with `unit_deadline` and `retry_ceiling` (half of `C`) so the caller can
  re-plan smaller units; finished sessions replay from the journal.
* The journal remembers every finished call by (scope, role, phase, request digest). A resumed review never samples
  a finished call again, a negative result included; a response that fails its own check is not remembered.
* A unit is reviewed only on its own evidence: a source request from a unit refuses (`unit_source_request`).
* Integration: each seam gets one disposition (`checked`, `finding`, `missing`); anything but `checked` leaves
  `review_completeness` unresolved (an integration finding cannot yet be a scored finding). Seams shard under
  `integration_cap`. `mergeWithIntegration` is the pure merge a verifier hook recomputes.
* A file too large for one unit is split into segments by the planner (`docs/local-review.md`); the runner carries each
  unit's `parts` and gives `unitView` the segment limit derived from the protected `C` and `S`. A record above one
  receipt is signed in parts (`docs/chunked-record.md`), so neither is a refusal any more.
* Typed gaps for the integrator: `integration_input_too_large`, `seam_too_large` and `prompt_too_large`.
  Integrity refusals: `chunk_config_invalid`, `plan_invalid`, `seams_invalid`, `integration_invalid`, `partition_invalid`.
* Not supported while concurrent: the agent-session exchange numbers sessions by call order, so wiring must key
  agent sessions by `task.unit`, `task.role` and `task.phase`.
