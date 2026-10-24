# Native Python coverage

The shared coverage gate accepts `coverage-format: coveragepy`. Supply the
unmodified JSON format 3 emitted by coverage.py 7 with native branch measurement
enabled. The adapter is qualified against real coverage.py 7.13.0 subprocess
reports and Centinela's native 7.17.0 artifact. It requires no provider key or
additional Python runtime package to validate JSON.

For an application-only source tree:

```sh
python -m coverage run --branch --source=src -m pytest tests
python -m coverage json -o coverage/coverage.json
```

The caller owns its actual tests and source selection. `--source` lets
coverage.py report unloaded modules; every production Python file under the
declared `source-directory` must appear, including entry points, configuration,
migrations and generated application bindings. A package with no executable
statements is allowed, but an empty report or empty executable module is not
evidence of full coverage. The selected application must have nonzero line and
branch totals.

Inventory excludes concrete nonproduction conventions only: `test/` and
`tests/` directories, `test_*.py`, `*_test.py`, `tests.py`, `conftest.py`, and
dependency/cache directories `.git`, `.venv`, `venv`, `.tox`, `.nox`,
`__pycache__`, `node_modules`. These test conventions must match the
repository's actual test collection. They cannot be used to relabel application
code. Configure the native reporting command to omit only those test/dependency
files if they fall inside the measured root; unexpected entries inside the root
are rejected, matching the Istanbul source-inventory boundary. No arbitrary
application exclusion patterns are accepted by the shared adapter.

Paths can be absolute, relative to the declared source root, or relative to the
checker working directory when that resolves an existing native source. The
resolved path must match the actual inventory exactly. Duplicate aliases,
symbolic source files and traversal paths are rejected. Absolute dependency
entries outside the selected root are ignored and cannot contribute counters
or replace missing application sources. Raw duplicate JSON keys are rejected
before interpretation.

The gate uses native integer `num_statements` and `covered_lines` as the
executable-line counters, validates their balance against the exact
`missing_lines` list and the trace's `executed_lines`, and counts the union of
native `executed_branches` and `missing_branches`. Coverage.py can trace module
docstrings without counting them as executable statements; counting raw trace
lines would therefore invent a different denominator. Branch entries
are coverage.py's decision exits, not all execution arcs; negative destinations
represent native exits and are preserved. Native integer summary counts must
agree with those lists, including partial-branch counts. Percentages and their
rounded display strings do not decide approval. Each line/exit must be covered.
Missing or non-branch-aware metadata, duplicate/invalid measurements, omitted
sources and inconsistent summaries fail closed.

Source exclusion pragmas and nonempty `excluded_lines` are refused. Native
configuration that suppresses a missing branch cannot turn its absent executed
exit into a covered counter; disagreement between executed exits and the
summary is rejected. Coverage.py's structural analysis of nonbranching constant
conditions remains its native behavior. The adapter never fabricates branches
or reinterprets statement counts as branch coverage.

This gate validates evidence from the repository's real independent test job.
It does not cryptographically prove execution on a hostile workstation. Shared
review still assesses test integrity and the accepted verification recipe.

The native semantics are documented by coverage.py's
[JSON reporting](https://coverage.readthedocs.io/en/7.13.4/commands/cmd_json.html),
[branch measurement](https://coverage.readthedocs.io/en/7.13.4/branch.html), and
[source discovery](https://coverage.readthedocs.io/en/7.13.4/source.html) contracts.
