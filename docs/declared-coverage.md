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

A single-artifact gate reads the repository-root `package.json`; a multi-artifact
plan reads each part's own `package.json` ([below](#monorepos-one-declaration-per-part)).
Either is parsed strictly, from the base revision
(`git cat-file blob BASE_REF:<directory>/package.json`).

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
  counts, so it is available for `istanbul`, `lcov`, `coveragepy` and `gooutcomes` reports only.
* Jest path and glob entries are not read; they fail closed.
* The same value declared by two tools is fine; different values conflict.
* Vitest cannot declare thresholds in `package.json`; a project that uses it and
  has no other declaration fails closed.

## Monorepos: one declaration per part

Clients that keep the declaration next to each package (for example
`backend/package.json`) use the accepted-base v2 `coverage-config` recipe, and each
part names the directory whose `package.json` declares its minimums:

```json
"coverage": [
  {"format": "istanbul", "report": "backend/coverage/coverage-final.json",
   "source_directory": "backend/src", "package_directory": "backend"},
  {"format": "istanbul", "report": "frontend/coverage/coverage-final.json",
   "source_directory": "frontend/app", "package_directory": "frontend"}
]
```

* `package_directory` is optional and must be `.` (the repository root) or an
  explicit repository-relative directory that **contains** the part's
  `source_directory` (or equals it). Without it, the part's own
  `source_directory` is the package directory; nothing is inferred from a parent
  directory and nothing falls back to the root. A part at the repository root
  (`source_directory: "."`) reads the root `package.json`.
* Each part's measured lines and branches are enforced against **its own**
  declaration at the base revision; the totals of the parts are not pooled and
  one part's declaration never applies to another. Several parts may share a
  package directory.
* A part whose package directory has no `package.json` at the base revision
  (including a directory or file that is a symbolic link there), or whose file
  declares nothing, fails closed as `declared_missing` naming the part, for
  example `Declared coverage (cause: declared_missing) for coverage part 1
  (istanbul, source backend/src, declaration backend/package.json): ...`. It
  never uses the root's declaration or 100%.
* Every failing part is reported with its own class. `per-file` applies to the
  files of its own part only.
* A pull request that adds a weaker `package.json` to a part directory, moves the
  directory, or edits the declaration changes nothing for that run: the base
  revision decides, and a changed declaration in any `package.json` needs the
  exact-head `/approve-intent` ([approval rule](#approval-rule)). `..`, absolute,
  backslash and `.git` paths, a `package_directory` that does not contain the
  source, duplicate reports and overlapping source directories are rejected, and
  a source directory that is a link leaving the checkout fails as for every mode.

Adding `package_directory` to a recipe is a change to the accepted recipe, so it
lands in its own pull request first. Plans written for the root `package.json`
with a nested `source_directory` (for example `src`) now need
`"package_directory": "."`.

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

A pull request whose **parsed declaration** differs between base and head, in the
root `package.json` or in any other `package.json` (a monorepo part's own), is a
protected-control change and needs the exact-head `/approve-intent`, like a change
to `.github/clouseau.json`. The comparison is of the parsed objects, so unrelated
edits to `package.json` files (dependencies, scripts, version) never trigger the hold;
lowering, raising, removing, adding a second declaration or making the file
unreadable does. A renamed or deleted `package.json` counts as a change, and so does a new one
that declares thresholds. The comparison covers every changed `package.json`, not
only the recipe's part directories, so a declaration change in an unrelated
package is also held (more than 20 changed `package.json` files are all held). The
hold applies only when `coverage.mode` is `declared`. `clouseau review` prints the
same warning locally.

## Limits

* Local verification (`clouseau review`) still reports exact-100% `coverage` status
  for the `.clouseau-local.json` recipe. It is advisory; CI is the authority.
* Only `package.json` files; `.nycrc`, `.c8rc.json`, `jest.config.*` and Vitest
  configuration files are not read.
* Metrics: this repository is a CI engine and exposes no Prometheus backend;
  there is no metrics impact.
