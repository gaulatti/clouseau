# Changed-line coverage (opt-in)

The default coverage gate is exact 100% line and branch coverage of the whole
application. A repository whose existing coverage is far below that can opt in to
a different gate instead of being blocked by it:

> Every line and branch the pull request **adds or modifies** must be covered,
> and the repository-wide line and branch coverage must not fall below the base
> revision's.

Nothing changes for a repository that does not opt in: with the setting unset
(or `exact`) the gate, its output and the assessment and approval wording are
the same as before.

## Enabling it

The mode lives only in the protected repository configuration
(`.github/clouseau.json`), which is a control path: changing it needs the
exact-revision owner confirmation like any other policy change.

```json
{ "version": 2, "...": "...", "coverage": { "mode": "changed_lines" } }
```

`coverage.mode` is `"exact"` (the default) or `"changed_lines"`; no other key is
accepted. The required verification step name stays
`Enforce 100% line and branch coverage`, because installed workflows already
require that name.

## Workflow wiring

`operation: coverage` switches mode only when **both** the protected `config`
says `changed_lines` **and** the workflow passes `coverage-base-ref`. Anything
else runs the exact gate, which is the stricter direction.

| Input | Meaning |
| --- | --- |
| `config` | The protected configuration. Pass the **base** revision's file (for example `git show "$BASE_SHA:.github/clouseau.json"`), never the contributor's. |
| `coverage-base-ref` | Base revision to diff against, for example the PR base SHA. The checkout needs its history (`fetch-depth: 0`). |
| `coverage-baseline` | **Path to a file** of JSON totals measured on the base revision (`baseline.json` below): `{"lines":[total,covered],"branches":[total,covered]}`. Inline JSON is rejected as an unreadable baseline. |

Produce the baseline by running the same tests on the base checkout and then:

```sh
node "$CLOUSEAU_ROOT/bin/coverage-gate.cjs" totals REPORT SOURCE_DIRECTORY FORMAT > baseline.json
node "$CLOUSEAU_ROOT/bin/coverage-gate.cjs" totals-plan ACCEPTED_CONFIG [DIRECTORY] > baseline.json
```

`totals` measures without gating, so a repository below 100% can run it. The
baseline must come from the protected base revision, never from the pull request.

The gate itself is `changed-check REPORT SOURCE_DIRECTORY FORMAT BASE_REF BASELINE`
(single artifact) or `changed-plan ACCEPTED_CONFIG DIRECTORY BASE_REF BASELINE`
(version 2 recipe with several native parts). Both print
`changed lines: covered/total` and `changed branches: covered/total` and fail with
the first uncovered `file:line` entries.

## What counts as changed

The diff is `git diff --unified=0 BASE_REF...HEAD` (changes since the merge base,
no rename detection). A measured line is *changed* when it is added or modified.
A measured branch outcome is *changed* when its decision line is changed.
Deleted lines, files outside the measured source directory, and unmeasured
lines are ignored. A change with no measured lines or branches passes the
changed-line half; the repository-wide half still applies. Paths git would
quote (control characters, quotes) fail closed.

| Format | Line unit | Branch unit |
| --- | --- | --- |
| `istanbul`, `lcov` | statement or `DA` line | the decision's source line (`loc`, else legacy `line`, else first outcome) |
| `coveragepy` | executed/missing line | decision exit, by its origin line |
| `go` | every line of a profile block | the block, covering its line range (Go records no finer unit) |
| `llvm` | not supported: the summary has no per-line data, so the mode fails closed |

Ignore directives, missing sources, duplicate or inconsistent reports are
rejected exactly as in the exact gate, because the same adapters measure first.

## Regression rule

For lines and for branches, `covered/total` of the pull request must be at least
`covered/total` of the baseline, compared exactly with integer arithmetic. A
baseline total of zero is accepted for a metric the repository does not have.

## Limits

* Local (`clouseau review`) verification still reports exact-100% status for the
  `.clouseau-local.json` recipe. It is advisory; CI is the authority.
* The assessment, gate and approval texts name the active requirement
  (`changed-line coverage` instead of `exact coverage`).
* Metrics: this repository is a CI engine and exposes no Prometheus backend;
  there is no metrics impact.
