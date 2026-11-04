# Native Go coverage

The shared coverage gate accepts `coverage-format: go`. Supply the unmodified text
profile written by `go test -coverprofile`. The adapter is a Node module; validating
a profile needs no provider key and no Go runtime. It is qualified against committed
real Go 1.27.3 profiles (`test/fixtures/go`: set, count and atomic modes, an unloaded
package, repeated per-package rows) and a test that runs real `go test` when Go is
installed.

```sh
go test -covermode=atomic -coverpkg=./... -coverprofile=coverage.out ./...
```

`-coverpkg=./...` is required: it makes Go emit zero-count rows for packages that no
test loads. Without it those files are absent and the gate fails.

## What the gate measures

Go's cover profile records basic blocks (`file:line.col,line.col statements count`).
It does not record branch outcomes, so the gate does not claim branch coverage. It
defines the two required integer totals exactly as follows:

- `lines` is **statements**: the sum of every block's statement count. A statement is
  covered when its block count is above zero. This is not an executable-line count;
  a block mapped to line numbers could invent execution (for example after a
  recovered panic), so lines are never derived.
- `branches` is **basic blocks**: each profile block is one required entry. An `if`
  body, `case` clause, loop body, function entry and the code after a conditional
  are each a block.

Both totals must be nonempty and exactly covered, with no rounding. Not measured, and
therefore not proven by a passing gate: the implicit false/no-match exit of an `if` or
`switch` (no block exists for it), separate short-circuit operands (`a && b` is one
statement), and `select`/`range` zero-entry exits. This is a weaker guarantee than the
LLVM, Istanbul and coverage.py branch metrics; the check command prints a note saying
so. Write tests for those outcomes explicitly. A true outcome-level Go branch route is
tracked separately (gaulatti/clouseau#67).

## Aggregation and inventory

Go writes one row per block per package test binary, so a profile may repeat a block.
Repeated rows are merged as a union of runs: the block is covered if any run entered
it, and rows for one block that disagree on statement count are rejected. Blocks in a
file must not overlap, which rejects a profile that does not match the source.

The module is bound from the nearest `go.mod` at or above `source-directory`; a row
counts when its import path starts with that module path and resolves inside the
source directory. Rows for other modules or paths outside the directory are not
application coverage. Every production `.go` file under the directory is inventoried.
Excluded are `*_test.go`, directories `vendor`, `testdata`, `node_modules`, names
starting with `.` or `_`, and nested modules (directories with their own `go.mod`).
Generated application code is included. Symbolic `.go` files or directories fail.

A file must appear in the profile when its code (comments and literals removed)
contains the `func` keyword. A file without it has no statements and may be absent.
A file that Go did not build (build constraint, `_linux.go` style suffix, unloaded
package) therefore fails with an explicit error rather than being treated as
branchless. A file containing only function *types*, with no bodies, also fails
closed; that is a documented limitation. Go has no coverage-ignore directives.

## Failures

Unknown mode line, malformed rows, non-integer or oversized numbers, a block that ends
before it starts or lies beyond its source file, rows for files outside the inventory,
conflicting or overlapping blocks, a missing `go.mod` module path, invalid UTF-8 or
unterminated literals, and missing application files all fail with a specific message.
