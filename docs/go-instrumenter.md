# Go instrumenter and the `gooutcomes` coverage format

`coverage-format: go` (docs/go-coverage.md) reads Go's own cover profile, which records statements and basic
blocks and cannot record branch outcomes. `gooutcomes` is the outcome-level route required by gaulatti/clouseau#67:
a Clouseau-owned Go program, `tools/goinstr`, measures every executable line and every outcome of every decision,
and the shared adapter `src/coverage-gooutcomes.cjs` validates its report. Nothing is inferred: each count is
written by the program being tested at the moment the line runs or the outcome is taken.

## Design decision (recorded for #67)

Clouseau owns a new instrumenter, runtime and native schema. No inspected upstream producer qualified (gobco emits
no select/range counters; the standard profile cannot represent implicit false, no-match or zero-entry, and counts a
recovered panic's block as run). The program uses only the Go standard library (`go/parser`, `go/ast`, `go list`
and `go test -overlay`); it has no third-party dependency and needs Go 1.18 or newer in the measured module's `go.mod`
(the counters use generics so they accept named boolean types).

## Measurement contract

**Lines.** A line is executable when a statement starts on it. Each statement gets a marker that runs immediately
before it. A line is covered only when every statement that starts on it ran; `if ok { return }` on one line is
covered only when the return ran. A statement after an early return, `os.Exit`, a panic or a recovered panic is
unhit. The adapter's `lines` total is the number of distinct executable lines.

**Branches.** Every outcome below is a required entry, recorded in place with evaluation order and short-circuit
effects unchanged (a decision is wrapped by a function that returns its value after recording it):

| Construct | Required outcomes |
| --- | --- |
| `if` / `else if` | `true`, `false` (an `if` with no `else` still has an explicit, separately required `false`) |
| `&&` / `||` | each operand separately, `true` and `false`; an operand not evaluated records nothing |
| `for cond`, `for init; cond; post` | `true` (iteration entered), `false` (condition ended the loop), `zero-entry` |
| `for range` | `enter`, `zero-entry` |
| `switch`, type switch | one outcome per clause, `default` when written, and `no-match` when there is no `default` |
| `select` | one outcome per clause (a `select` has no no-match) |

`break`, `continue`, `goto`, `return`, `panic` and `os.Exit` are statements: when one is taken, the statements after it
on that path stay unhit. A loop's `break` exit is therefore visible as the unhit statements after it, not as a
separate outcome. A statement reached only by `goto` records nothing at its label, which can only under-report.

**Counting.** A hit is a boolean: first execution, written at once (`pwrite`) to `hits/<package>.hit`, so it survives
`os.Exit`, a crash and a recovered panic, and several test binaries (one per package) share a file.

**Unsupported constructs fail, they are not excluded.** cgo packages, a `&&` / `||` outside a function body or inside a
`const`, a module declaring Go older than 1.18, a package that does not load, and a generated file name collision all
stop `instrument` with a message. A construct that compiles but is mis-typed by the rewrite (for example mixing a
named boolean type with an untyped constant under `&&`) fails the build, not the measurement.

## Source and build identity

The inventory is every production `.go` file under the module, with the same exclusions as the `go` adapter
(`*_test.go`, `vendor`, `testdata`, `node_modules`, names starting with `.` or `_`, nested modules; generated
application code is included; symbolic sources fail). `go list` decides which files a build loads for the declared
`GOOS`, `GOARCH` and `-tags`.

- A file the build loads is instrumented and reported `measured`. A package no test imports is still instrumented:
  its lines and outcomes are present with zero hits, so it fails the gate.
- A file the declared builds exclude (constraint, `_windows.go` suffix) or that no package loads is reported
  `inactive` with the reason, and the adapter fails naming it. Declare another build that includes it (below); the
  file is then measured from that build.
- Each file carries the SHA-256 of its bytes and its line count. The adapter rejects a report whose bytes differ
  from the checkout (stale or wrong source), a missing or unknown or duplicate file, an unknown field, a
  non-integer or negative count, a line outside the file, and a duplicate outcome. The report names the Go version,
  module and every declared build.

## Recipe

```sh
# once per job: build the program from a Clouseau checkout
(cd /path/to/clouseau/tools/goinstr && go build -o "$OLDPWD/.clouseau-work/goinstr" .)

# one instrumented run per declared build (repeat -goos/-goarch/-tags for each)
.clouseau-work/goinstr instrument -module . -work .clouseau-work/go-host
.clouseau-work/goinstr instrument -module . -work .clouseau-work/go-windows -goos windows -goarch amd64

# execute: -count=1 so the test cache cannot skip the instrumented code
go test -count=1 -overlay="$PWD/.clouseau-work/go-host/overlay.json" ./...
# a build that cannot run on the runner is still instrumented and compiled; it only supplies identity
GOOS=windows GOARCH=amd64 go build -overlay="$PWD/.clouseau-work/go-windows/overlay.json" ./...

# merge builds and shards (hits are unioned) into the native report
.clouseau-work/goinstr report -out coverage/go-outcomes.json -run .clouseau-work/go-host -run .clouseau-work/go-windows
```

Then configure `{"format": "gooutcomes", "report": "coverage/go-outcomes.json", "source_directory": "."}` in a
version-2 coverage plan. Run the overlay from the same directory path that you pass to `-module`; the overlay is
keyed by absolute path (both the resolved and the shell path are written, so a symlinked checkout works). Shards are
separate `-work` directories (or one directory reused by several `go test` invocations) merged with repeated `-run`.
If the overlay is not applied, no counter is written and the gate fails rather than passing.

The program refuses a non-empty `-work` directory unless its manifest carries the goinstr schema and it holds only goinstr files; it removes its own directory on failure.

## Verification

- `tools/goinstr/main_test.go` instruments a copy of `test/fixtures/go-outcomes/app` and runs selected tests against the
  overlay to prove each outcome class: the implicit false and `else if`, short-circuit operands (a false first operand
  records nothing for the second), switch and type-switch no-match and `default`, select clauses and default,
  range and conditional-loop zero-entry, an early return, a recovered panic (the standard `go test -coverprofile` marks
  the block with the statement that never ran as covered; goinstr leaves it unhit), an unloaded package, a build-
  constrained file, a second build, shard union, and the unsupported-input errors.
- `src/coverage-gooutcomes.test.cjs` reads the committed real reports (`full.json`, `partial.json`, `host-only.json`)
  without Go and covers every adapter branch. `src/go-instrumenter.test.cjs` rebuilds the report with real Go and
  compares it with `full.json` (skipped when Go is not installed; the committed reports still gate the adapter).

## Not yet claimed

This route is the producer and the shared adapter. It does not by itself close gaulatti/clouseau#67: the original
16 and four additional external counterexample fixtures are not vendored here (this fixture covers the same outcome
classes), no consumer (Pompeii) is qualified, and the route is not released on protected main.
