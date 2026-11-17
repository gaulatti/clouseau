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
first traverses the runtime AST subgraph: complete ambient declaration trees and
type-only metadata are omitted because the compiler erases them. This includes
literal initializers inside `declare const`, declared namespaces and declared
classes. Adjacent runtime declarations and ordinary object property names remain
in the traversal; an ambient declaration never excludes the rest of its file.
Strict TypeScript compiler fixtures and unmodified native instrumenter output
exercise those cases through both checker entry points.

The counter-site pass
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
The authenticated engine digest includes the vendored runtime tree, including
file contents and executable modes, and rejects symbolic substitutions. A parser
change therefore changes the engine identity bound to local receipts as well as
the Git revision; deleting the dependency cannot retain the expected digest.
Updates must preserve that provenance and verify the real producer regression
cases. `test/fixtures/istanbul-statement-free.json` contains actual
`istanbul-lib-instrument` 6.0.3 output, including a real executed branch-only
declaration. Relative report paths are resolved from the fictional application
parent directory without modifying the emitted map entries.

## Decorated TypeScript (#261, opt-in, dormant)

`counterSites(source, extension, {decorators: true})` also parses TypeScript's
experimental decorator syntax in `.ts`/`.tsx`: Babel's `decorators-legacy`
parser plugin, the syntax Nest uses, including parameter decorators. Babel's
standards-track `decorators` plugin is not used, because it refuses parameter
decorators. The source is still parsed as data by the vendored parser, with no
configuration, external plugin or execution. JavaScript keeps its parser
unchanged. Without the option, decorator syntax still fails to parse, so the
gate's behavior is unchanged until activation: an empty entry for a decorated
file stops validation with `Cannot inspect statement-free application source`.

A decorator is a statement site. It runs when its class is defined (TypeScript
emits `X = __decorate([...], X)`). Every native producer measured for #261 emits
statements for every decorated file, including a bare `@Module({}) export class
AppModule {}`: TypeScript compiled and then instrumented by
`istanbul-lib-instrument` 6.0.3 and remapped by `istanbul-lib-source-maps` 5.0.6
(3 to 6 statements), and `jest --coverageProvider=v8` (jest 30.4.1, ts-jest 29.4.9),
with the module loaded or never loaded. `test/fixtures/istanbul-decorated-typescript.json`
records those counters for each case. An empty statement map for a decorated file
is therefore a missing measurement, never a legitimate statement-free file. Any
decorator anywhere in the file counts, including one the parser accepts on an
ambient or abstract member that TypeScript would refuse, so the newly parsed
syntax can never make a file look counter-free. Runtime code inside decorator
arguments is walked like any other expression: a conditional, logical
expression or default parameter there is a branch site, and an arrow function's
expression body is a statement site.

**Activation** is a separate, named change: `src/coverage-istanbul.cjs`
`requireCounterSites` passes the option:

```diff
-  try {required = counterSites(fs.readFileSync(file, 'utf8'), path.extname(file));}
+  try {required = counterSites(fs.readFileSync(file, 'utf8'), path.extname(file), {decorators: true});}
```

It changes no verdict. A file without decorators is classified exactly as
before. A file with a decorator fails with or without activation when its
statement map is empty: before, as `Cannot inspect statement-free application
source`; after, as `No statements measured for application source`, which names
the real problem. No measured count changes, because the helper is consulted only
for an entry whose statement map is empty. **Rollback** is reverting that one
line; the option and its tests may stay.

