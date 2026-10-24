# Native Istanbul empty-map validation

The source inventory still requires an entry for every applicable JS/TS file,
including files without measured statements. An empty entry cannot hide an
unloaded function whose body requires native statement counters. Equally, a
legitimate empty file, comment-only file, empty export, uninitialized declaration,
empty class/function or type-only declaration must not need invented statements.

When an entry's statement map is empty, the Python adapter calls the bundled
`src/istanbul-source.cjs` helper using Node.js. The supported verification runtime
is Node 22, as in Clouseau CI and the local CLI. The helper parses stdin as data
using the vendored `@babel/parser` 7.29.0 bundle. It loads no application modules,
Babel configuration or external plugins, executes no application source, makes no
network requests, and needs no npm installation. Its parser supports JS/JSX,
TypeScript/TSX and CommonJS top-level returns. A missing runtime, parser failure,
timeout or invalid helper response stops validation.

The helper recognizes native Istanbul statement and branch counter sites. It
checks presence rather than asserting identical counts or source locations across
producers. An empty statement map is rejected when a statement counter site is
present. A branch-only declaration, such as a function with a default parameter,
can legitimately have no statement counters; its branch map must still be present
and its actual native hits must pass the existing checks. Files with no such
sites remain in the inventory and contribute their actual counters unchanged.
Whole-report and per-part nonempty requirements remain in force.

This is a bounded integrity check, not authentication of arbitrary reports or a
proof that a compiler instrumented every possible runtime operation. For example,
original TypeScript enums and parameter properties can acquire runtime statements
only after transpilation. Native producers have different counter granularity,
and source maps remain their responsibility. Use complete native instrumentation,
including unloaded source files, and real runtime tests. The checker neither
rewrites reports nor invents counters to compensate for producer behavior.

The dependency-free CommonJS parser bundle is unmodified. Its exact upstream
tarball, integrity and SHA-256 are recorded in
`vendor/babel-parser/provenance.json`; its MIT license is stored alongside it.
Updates must preserve that provenance and verify the real producer regression
cases. `test/fixtures/istanbul-statement-free.json` contains actual
`istanbul-lib-instrument` 6.0.3 output, including a real executed branch-only
declaration. Relative report paths are resolved from the fictional application
parent directory without modifying the emitted map entries.
