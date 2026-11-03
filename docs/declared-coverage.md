# Declared coverage (opt-in)

The default coverage gate is exact 100% line and branch coverage. A repository
that already states its own minimum in `package.json` can ask Clouseau to
enforce **that** instead:

> The measured line and branch coverage must reach the minimums declared by the
> client repository's `package.json` **at the accepted base revision**.

Clouseau still measures coverage itself through its native adapters (`istanbul`,
`lcov`, `coveragepy`, `go`, `llvm`); only the pass line comes from the declaration.
Nothing changes for a repository that does not opt in: with `coverage.mode`
unset (or `exact`) the gate, its output and the assessment and approval wording
are the same as before.

## Enabling it

```json
{ "version": 2, "...": "...", "coverage": { "mode": "declared" } }
```

in the protected `.github/clouseau.json`, like the other modes (see
[changed-line coverage](changed-line-coverage.md#enabling-it)). The workflow
passes the protected base config as `config` and the PR base revision as
`coverage-base-ref` (checkout with `fetch-depth: 0`). No `coverage-baseline` is
used. Without `coverage-base-ref` the step runs the stricter exact gate.

## What is read

Only the repository-root `package.json`, parsed strictly, from the base revision
(`git cat-file blob BASE_REF:package.json`).

| Declaration | Read as |
| --- | --- |
| `jest.coverageThreshold.global` | `lines`, `branches`, `functions`, `statements` |
| `c8` | the same four keys; `check-coverage` must be `true`; `per-file` |
| `nyc` | the same; `checkCoverage` / `perFile` are accepted spellings |

* A metric that is declared is enforced; an undeclared metric is not.
* Clouseau measures **lines and branches**. A declared `functions` or `statements`
  minimum is read and protected against change but reported as `declared but not
  enforced` (Clouseau has no such counters). A declaration with *only* those is
  `declared_missing`.
* Comparison is exact integer arithmetic: `covered * 100 * d >= n * total` for a
  threshold `n/d` written as a decimal (`87.5` is `875/10`). A metric with a zero
  total (no branches) passes. The shown percent is floored to two decimals.
* `per-file: true` checks every file against the minimum. It needs per-file
  counts, so it is available for `istanbul`, `lcov` and `coveragepy` reports only.
* Jest path and glob entries are not read; they fail closed.
* The same value declared by two tools is fine; different values conflict.
* Vitest cannot declare thresholds in `package.json`; a project that uses it and
  has no other declaration fails closed.

## Fail closed, never fall back

Each failure names a stable cause class, the measured percent against the
declared minimum where relevant, and numbered steps. It never falls back to 100%
or to zero. Classes: `declared_missing`, `declared_conflict`, `declared_unsupported`,
`declared_below_threshold` (see [notices](notices.md#declared-coverage)).

## Why the base revision

Reading the declaration from the pull request head would let a PR lower its own
bar. The mode comes only from the protected base config and the declaration only
from the base revision's `package.json`; a threshold edit in a PR applies from the
next base, not to the run that contains it.

## Approval rule

A pull request whose **parsed declaration** differs between base and head is a
protected-control change and needs the exact-head `/approve-intent`, like a change
to `.github/clouseau.json`. The comparison is of the parsed objects, so unrelated
edits to `package.json` (dependencies, scripts, version) never trigger the hold;
lowering, raising, removing, adding a second declaration or making the file
unreadable does. A renamed or deleted `package.json` counts as a change. The
hold applies only when `coverage.mode` is `declared`. `clouseau review` prints the
same warning locally.

## Limits

* Local verification (`clouseau review`) still reports exact-100% `coverage` status
  for the `.clouseau-local.json` recipe. It is advisory; CI is the authority.
* Only the root `package.json`; `.nycrc`, `.c8rc.json`, `jest.config.*` and Vitest
  configuration files are not read.
* Metrics: this repository is a CI engine and exposes no Prometheus backend;
  there is no metrics impact.
