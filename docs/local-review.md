# Local review and CI receipt reuse

The canonical `skills/clouseau` skill runs Clouseau with a locally authenticated
coding harness. Installation refreshes protected public Clouseau main into one
shared user cache and registers the skill globally. Application repositories
contain their purpose and verification recipe, not copies of the review engine.

## Separate installations

Run `bash scripts/install-agent` from Clouseau, or use bastille's managed startup
bootstrap. The installer creates only a shared source cache, user-wide skill
links and the `clouseau` launcher. It creates no Actions files, provider secrets,
CI dependencies, signing credentials or branch rules. Explicit installer
`--prefix` and `--cache-root` paths support separate user profiles and isolated
installation checks without changing a home directory.

The launcher checks source freshness before every invocation. It loads an
immutable checkout for that run and preserves modified caches or unrelated
installed skills with an explicit error. An unavailable update does not silently
activate stale code. Codex and Claude Code use their existing authenticated
account stores; Clouseau makes no direct DeepSeek/Jev requests in local mode.

## Local-only repository configuration

Commit `.clouseau-local.json` on the accepted base. It is independent of GitHub
Actions and contains no provider settings:

```json
{
  "version": 1,
  "base_branch": "main",
  "readme": "README.md",
  "repository_policy": "AGENTS.md",
  "verification": [["npm", "run", "test:coverage"], ["npm", "run", "typecheck"]],
  "coverage": {
    "format": "istanbul",
    "report": "coverage/coverage-final.json",
    "source_directory": "src"
  }
}
```

`llvm` and `lcov` (production sources only; `DA` lines and `BRDA` branches) are also supported. The shared parser requires complete, nonempty exact
line/branch counters. Commands run as argument arrays, without shell expansion.
The accepted base supplies the recipe; a change cannot weaken its own checks.
The source checkout must be committed and clean before review. Verification
artifacts should use the repository's established ignored output locations.

### Multiple native coverage artifacts

Version 2 keeps separate native reports for applications with multiple source
roots. Its `coverage` field is a nonempty array with at most 32 explicit parts:

```json
{
  "version": 2,
  "base_branch": "main",
  "readme": "README.md",
  "repository_policy": "AGENTS.md",
  "verification": [
    ["python3", "-m", "coverage", "run", "--branch", "--source", "backend", "-m", "unittest", "discover", "-s", "backend/tests"],
    ["python3", "-m", "coverage", "json", "-o", "coverage/backend.json"],
    ["npm", "--prefix", "frontend", "run", "test:coverage"]
  ],
  "coverage": [
    {"format": "coveragepy", "report": "coverage/backend.json", "source_directory": "backend"},
    {"format": "istanbul", "report": "frontend/coverage/coverage-final.json", "source_directory": "frontend/app"}
  ]
}
```

Only the six documented top-level fields are accepted in version 2: `version`,
`base_branch`, `readme`, `repository_policy`, `verification`, and `coverage`.
Misspelled or additional policy fields fail before local command execution and
at the CI data entrypoint. Each coverage part likewise accepts only its three
documented fields. Version 1 keeps its existing compatibility behavior.

Adapt commands to the repository's real test suite. The runner passes argument
arrays directly, runs every command, and checks each untouched native report.
It does not generate a combined artifact or reinterpret counters. Native
measurement requires a complete application inventory and nonempty measured
lines. Local AI review records valid partial counts and unavailable, invalid or
unverified coverage honestly, then runs regardless of the percentage. It does
not label an old artifact as this run's verified coverage. CI's separate exact
coverage gate still requires 100% lines and branches for every part. A genuinely
branchless part may have zero branches when another part supplies measured
branches; an entirely branchless plan fails that CI gate. One part cannot
compensate for another part's missing or uncovered data.

Report and source paths must be repository-relative. Resolved source roots must
exist and must not overlap, and report paths must be unique, including aliases.
Both recipe versions accept `source_directory: "."` for the complete repository
root, including executable root configuration and nested application sources.
A version 2 root part cannot appear alongside another part because their source
roots overlap. The canonical `.` spelling is allowed only for a source directory;
report and other paths keep their existing restrictions. A root recipe still
rejects missing native source measurements and uncovered counters.
Paths that escape the checkout fail. There is no arbitrary exclusion option.
Generated application code, executable configuration and entry points remain
in scope. Native JS/TS inventory excludes declaration-only `.d.ts` files,
`*.test.*`/`*.spec.*` files and the fixed `test`, `tests`, `__tests__`, `.git`,
`node_modules` and `vendor` directories. Native coverage.py uses its documented
Python test/dependency conventions. Those non-application entries may appear in
a native report but cannot contribute passing counters.

Version 2 supports native measurement through the complete-inventory `istanbul`,
`coveragepy` and `go` adapters. Version 1's single-report interface, including LLVM,
remains supported. Unsupported native formats are reported as unavailable local
coverage; they do not suppress AI review or acquire invented counters. CI still
rejects unsupported formats. LLVM multi-root plans require a complete
compiled-source inventory capability and are not measured by version 2.
Go is measured only through the `go` adapter, whose lines are statements and
branches are basic blocks ([native Go coverage](go-coverage.md)).

The accepted base supplies the complete recipe in normal local review. Local
evidence records actual command outcomes and output, native counters when valid,
artifact digests and freshness, unavailable-coverage diagnostics, and the accepted
configuration digest. A nonzero command is not assumed to have failed only
because of coverage. One frozen engine checks every part throughout the review.

CI invokes the same shared verifier through `operation: coverage` with
`coverage-config`. Supply the recipe from the exact accepted base, separately
from the candidate checkout. For example, in an unprivileged PR verification
job with no provider credentials:

```yaml
- uses: actions/checkout@v4
  with:
    ref: ${{ github.event.pull_request.head.sha }}
    fetch-depth: 0
- name: Read accepted coverage recipe
  env:
    BASE_SHA: ${{ github.event.pull_request.base.sha }}
  run: git show "$BASE_SHA:.clouseau-local.json" > "$RUNNER_TEMP/accepted-coverage.json"
# Run the repository's actual tests and native instrumentation here.
- uses: gaulatti/clouseau@FULL_REVIEWED_COMMIT_SHA
  with:
    operation: coverage
    coverage-config: ${{ runner.temp }}/accepted-coverage.json
```

The coverage action reads that JSON as data and never executes its verification
commands. Do not supply proposed PR policy as the accepted recipe. Configuration
selection belongs to trusted workflow wiring; source execution, credentialed
assessment and the write-capable controller remain separate. `coverage-config`
cannot be combined with legacy `coverage-report` or `source-directory` inputs.
The legacy single-report inputs are unchanged.

Store the requirement outside the checkout, then run:

```bash
clouseau review --directory /path/to/repository --base origin/main \
  --request-file /path/to/requirement.txt --harness codex
```

Verification subprocesses and the native coverage parser receive the same
credential-filtered environment as initial installation: inherited variable names
matching `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` are removed.
Nonsecret runtime and tooling variables remain available. Repository verification
commands supply their own nonproduction fixture configuration. PEM private-key
output is rejected before it can enter AI evidence.

### Agent-driven review inside an AI harness

The headless `--harness codex|claude` form launches a separate child process per
model session. It is for a person at a plain terminal. Inside Claude Code, Codex
or opencode the calling agent supplies those sessions itself:

```bash
clouseau review --directory /path/to/repository --base origin/main \
  --request-file /path/to/requirement.txt --agent opencode
```

`--agent` accepts `claude`, `codex` or `opencode` and excludes `--harness`.
The controller still owns real verification, immutable sources, citations, grading
formulas, the finding ledger and the decision. When it needs a model session it
writes `request-NNNN.json`, the full `prompt-NNNN.txt` and `schema-NNNN.json` under
the review cache's `agent/` directory (outside the checkout), prints
`status: awaiting_agent` and exits with code 3. The agent starts a fresh subagent
or session that sees only those files, has it write a JSON answer to the request's
`answer_file`, and registers it:

```bash
clouseau respond --agent-request REQUEST_FILE --answer ANSWER_FILE --session SESSION_ID
```

`respond` validates the answer against the request schema (the supported subset
fails closed on unknown keywords), refuses a session identifier already used for
another request in the exchange, and allows three attempts per request. Repeating
the identical `review` command then resumes: it reuses the one recorded
verification, requires the same frozen evidence digest, replays accepted answers
and stops at the next pending session. A request whose stored digest no longer
matches stops the review rather than guessing. If protected Clouseau main advances
between commands the cache identity changes and the review restarts.

Usage records for these sessions carry `harness` (`claude`, `codex` or `opencode`),
`execution: agent_session`, the supplied session identifier and digests of the
request, answer and stored response file. Receipt validation accepts them alongside
headless records and still requires distinct sessions for the examiner and
challenger investigation and grading phases. The controller cannot itself prove
that a subagent was isolated from the implementer, so this independence rests on
the runner's trust boundary and on the enrolled engine revision: CI accepts a
receipt only from a Clouseau revision the protected configuration enrolls, which is
where an owner decides whether to trust agent-driven receipts. The signed handoff,
`independent_ci_required` and `merge_authority: false` are unchanged.

Outside an AI harness, use `--harness claude` to run Claude Code headlessly. The controller runs real verification,
records its actual outcomes, captures immutable base/head sources and accepted
purpose, and starts separate examiner and challenger sessions. Coverage below
100%, a failing coverage command, or unavailable, malformed or unsupported
coverage does not prevent those local AI sessions. Additional source requests are bounded. Fresh
semantic grading sessions supply descriptive factor levels; the same Clouseau
code owns citations, formulas, thresholds and final decisions. No investigator
gets the implementer's conversation or the other investigator's conclusions.

The controller identifies this as a pre-PR assessment in both investigation and
grading. It requires the accepted local recipe, safe complete immutable source
and meaningful evidence for the changed behavior. Coverage percentage or
unavailable coverage alone does not force a failing AI quality verdict; actual
behavioral defects, deceptive tests and missing material evidence still do. The
review never rewrites failed or unavailable verification into a test pass.

New and cached CLI results identify `decision_scope: review_reuse_only`,
`independent_ci_required: true` and `merge_authority: false`, with local
verification and coverage status separate from the AI decision. A local
`auto_approve` verdict means passing AI quality evidence eligible for signed
reuse, not technical approval. CI audit, workflow and container execution remains
independent; a local receipt does not claim those results or authorize GitHub
approval. CI must pass every mandatory technical gate before approval or merge.

A source-line reference can be normalized only to an existing immutable catalog
block containing that line. The controller preserves the observation and reads
the literal source bytes; this correction needs no additional model request.
Unknown sources, out-of-range lines and unsupplied blocks still stop review.

Reports and response journals stay outside source control. A completed identical
input is not automatically reviewed again. Fix blocking findings, commit the
changed implementation and reassess. A negative or incomplete review never
produces an approval receipt. This initial receipt path targets a new PR without
an unresolved existing GitHub review ledger; it rejects an existing incompatible
ledger rather than dropping its findings.

## Evidence size

Serialized local evidence is capped at 900,000 characters. To keep large changes inside the cap
without dropping anything a reviewer judges, the local collector stores a file added whole once:
its snapshot entry keeps the patch header and `patch_body: "head_source"`, the body being exactly
the head source with every line prefixed `+` (consumers restore the identical patch). The pinned
engine seed for workflow changes is optional context: seed files that would use the last 150,000
characters are listed in `omitted_sources` with a reason, and reviewers can still request them.
Changed files, their base and head sources and contracts are never omitted; a change that exceeds
the cap with only that evidence is reviewed in bounded units (see "Chunked local review") unless the protected configuration disabled chunked review, in which case it fails closed.

## Enrolling a trusted runner

Consumers with neither accepted recipe nor CI policy use the separate
[explicit initial trust installation](initial-installation.md). Its frozen
owner/admin commit-comment grant and installation-only evidence cannot replace
ordinary approval or authorize automatic merge.

`clouseau init-identity` creates an Ed25519 identity outside the repository with
private file permissions. Its output contains only the public enrollment entry
and local identity-file path. Identity creation is explicit and is never part of
agent installation. The existing authenticated GitHub account supplies the
identity's `github_actor`.

An owner must install the public enrollment entry in protected CI configuration:

```json
{
  "local_review": {
    "mode": "required",
    "central_source": {"repository": "gaulatti/clouseau", "ref": "refs/heads/main"},
    "max_age_seconds": 172800,
    "keys": [{
      "id": "PUBLIC_KEY_IDENTIFIER",
      "issuer": "ENROLLED_RUNNER_IDENTIFIER",
      "github_actor": "ENROLLED_GITHUB_LOGIN",
      "public_key": "ED25519_PUBLIC_PEM",
      "revoked": false
    }]
  }
}
```

This source authorization requires the [automatic CI resolver wiring](automatic-ci-upgrades.md)
and its frozen SHA/digest; configuration alone cannot select an engine. Legacy
fixed installations instead enroll `reviewer_digest` and omit `central_source`.
The modes are exclusive, and only the central-source integration avoids recurring
release enrollment PRs.

Receipt lifetime: `issueReceipt` defaults to 48 hours (172800 seconds), and the
trust validator rejects `max_age_seconds` above 172800. Each consumer sets its
own `max_age_seconds` in its protected `.github/clouseau.json`; consumers that
still say 3600 keep one-hour receipts until raised separately. The first
[initial-installation](initial-installation.md) authorization deliberately stays
at one hour, and installation receipts are capped by it. A receipt remains bound
to the exact head SHA, signed review history and reviewer digest, so a changed
head invalidates it regardless of age.

Only existing protected configuration can enroll or revoke a key. A contributor
cannot authorize their own key through the proposed PR. Keys are restricted to
their enrolled native GitHub PR author. Set `revoked` or remove a key to reject
its future receipts. `optional` mode permits the separately installed CI AI
reviewer for PRs without a receipt. An invalid receipt never falls back to a paid
AI review. `required` mode needs no CI AI provider credentials.

Malformed, unknown-version, duplicate or mixed receipt marker claims block
before any provider call; only genuinely unstamped optional-mode PRs can enter
the ordinary CI AI route. Do not normalize or discard an invalid stamp.

The initial trust boundary is an enrolled maintainer workstation, including its
operator and privileged processes. The identity is not remote or hardware
attestation. A private key held by that operating-system account cannot protect
against malicious processes with equivalent account access. Such a compromise
can forge the runner's claims. Signatures protect receipt integrity and identify
the enrolled issuer; they do not mathematically prove that an LLM executed or
that its conclusions are correct. Stronger hostile-runner protection requires
an independently isolated execution/signing service and is not claimed here.

## Signed handoff

An enrolled runner selects its matching installed identity automatically. Use
`--identity /path/to/identity.json` to select explicitly when needed. The runner
requires an unmodified public Clouseau engine and the enrolled signer. CI
authorizes the exact engine separately from the signature. Legacy CI without a
trusted frozen-source selection still requires its configured digest. It records the exact Clouseau commit and binds the executable engine,
skill, scripts and policy by a SHA-256 content digest. Legacy fixed-digest installations permit identical engine content across squash
identities. [Automatic CI upgrades](automatic-ci-upgrades.md) require both the
exact selected central commit and its computed digest; no cross-version
compatibility is inferred. It verifies
the same source and installation remain unchanged before
issuing a passing receipt. Signing material is never placed in model packets,
child-process environments, project source, reports or the published artifact.
Protected review-control changes still require the separate owner-authorized
installation path; a local receipt cannot grant that authority. A current-head owner confirmation
is independently recorded and revalidated by CI when a signed review accompanies
a review-control change.

The receipt signs a domain-separated SHA-256 payload with Ed25519. It includes
the complete review record, exact repository/head/base, Clouseau and policy/config
identities, issuer/key, issuance/expiry, and a 256-bit random nonce. Publish it
before opening the PR:

```bash
clouseau publish --directory /path/to/repository --receipt /path/to/receipt.json
```

This creates a separate artifact commit and unique `clouseau-review/<nonce>` tag;
it does not change the reviewed source commit or checkout. Include the returned
`clouseau-local-review:v1` marker in the initial ready PR body. The complete
artifact follows the repository's visibility and contains reviewed source and
the requirement text; those inputs must be appropriate for publication there.

## CI consumes evidence without repeating AI

An opted-in protected workflow loads configuration and Clouseau from trusted
source. It loads a referenced receipt as data, validates its
signature/issuer/author/time/revisions/policy, compares the complete signed source
inventory to GitHub's immutable PR sources (dependency lockfile summaries are
recomputed from the repository's lockfile bytes and must match exactly), and
recalculates the AI scores.
A valid local assessment can be authenticated and reused with zero CI AI calls
even while independent CI is pending or failed. That result remains
`pending_technical` or `blocked_technical`, with no approval-usable record digest
or approval/merge write. Unstamped PRs retain the CI provider route after
technical verification.

### Reviewed diff verification

CI also verifies the diff text the reviewers saw. It reuses the changed-file list
already fetched for the assessment (the pull request files endpoint, paginated;
no extra request per file) and compares each file's repository-supplied `patch`
with the signed `snapshot.files[].patch`. The local collector stores `git diff`
output, so the comparison reduces it to GitHub's form: the git extended header
(`diff --git`, mode, similarity, rename, `index`, `---`, `+++` lines) is removed
and the final newline dropped; every remaining byte of the hunks must equal what
GitHub reports. A header line that is not one of those git lines, or a rename
that is not the pull request's rename, is a mismatch. Whitespace-only differences
are mismatches. The file list and each file's status must match exactly: no extra
file, none missing.

Any disagreement stops reuse with the incomplete reason `receipt_patch_mismatch`,
which names the file (never diff content) and tells the author to review again on
the exact head. GitHub supplies no `patch` for very large or binary changes. The
hosted collector already refuses those (`changed_files_incomplete`), and receipts
for such changes are refused the same way rather than verified with a weaker rule.

Only after actual CI tests and exact coverage pass may the controller emit an
approval assessment. It revalidates the receipt at the write gate and uses the
existing native approval, merge-authority and protection checks. Missing, stale,
revoked, altered, non-passing or unauthorized receipts cannot approve and never
silently become a paid fallback.

Tests, exact 100% coverage and the applicable shared protection/owner-merge
rules remain mandatory before approval or merge. Review-control changes retain
their existing exact-revision owner installation requirements.
Post-deployment wiki generation and factual review remain separate operations.

Local caches include the exact installed central SHA, even when a newer commit
has identical engine bytes. Refreshing and reviewing again creates evidence for
that new SHA and preserves the old receipt. An exact matching cached receipt
still avoids another local review. Negative evidence and causal findings remain
retained; a different SHA with identical engine bytes cannot resample an unchanged
negative judgment.

When a resolver workflow changes, the runner supplies at most 32 observed shared
source/test dependencies, its actual pinned bootstrap and the legacy action
boundary as additional untrusted context. Wiki source is included only when the
changed workflow invokes it.
Historical source requests use `.clouseau-ci/PATH@FULL_COMMIT_SHA`; they read
immutable public bytes without switching the frozen review engine or granting
contract authority. CI checks the same bytes before receipt reuse. The ordinary
serialized evidence size remains capped at 900,000 characters. Each local
investigation can read eight batches of
up to eight paths, then submit its report using the final batch. A ninth source
batch still stops the review; missing evidence cannot produce a passing report.
Failed investigations retain `snapshot.json`
and `observations.jsonl`; their error gives the evidence directory. These files
contain review evidence, never the signing identity.

Automatic central-source installations retain signer enrollment in protected base
configuration and authorize protected Clouseau main instead of a recurring
reviewer digest. A receipt that is valid in every respect except that it
was produced by an older engine revision than the protected main CI resolved is
ignored, never accepted as evidence: CI treats it as absent, reviews the change
itself through the ordinary hosted path and shows the one-line notice that the
receipt predates the current engine. Signature, trust, issuer, author, expiry,
head and base, policy, configuration and record failures stay hard failures.
(A repository in `required` mode still has no receipt, so it reports
`local_receipt_required`.) Refresh and review again to reuse the local review. The selected commit and digest are in
the run summary and engine artifact.

Reviewers may request `.clouseau-ci/` paths to inspect their own frozen public
engine. The collector records that engine revision as untrusted source evidence
without requiring a consumer CI checkout. CI verifies the exact signed excerpt
against its accepted engine; engine source cannot become a repository contract.


The local reuse assessment does not grant protected-control owner confirmation.
That exact-head confirmation remains mandatory in CI before approval. Its pending
execution alone cannot block the pre-PR reuse assessment when the implementation
preserves the gate. Actual unsupported scope or authority still blocks.

For explicit additional behavioral checks, pass `--additional-checks FILE`, where
FILE is an operator-supplied JSON array of at most eight argv arrays, for example
`[["npm", "test", "--prefix", ".github/tests"]]`. Keep this file outside the source
checkout. This only adds checks: additional commands run after the accepted-base
recipe and native measurement, even when coverage is partial or unavailable.
They must leave the observed coverage artifacts unchanged; rewriting an artifact
is an integrity failure, not a route to better counters. Every actual command
result and the additional plan are bound to the review and cache identity. This can record consumer workflow-test execution without
changing application scripts or triggering deployment. It requires no CI keys
and creates no CI installation. Independent hosted checks remain mandatory.

Local harness presentation preserves every source byte and prior observation.
It sends verbatim source with indexed proof coordinates and replaces a duplicate
draft quote only when the identical bytes remain in the referenced immutable
source. Differing or unavailable earlier literals remain explicit. No source,
concern, disposition or score is truncated to fit transport. Oversized Codex
input fails before invocation. Native stdout/stderr are decoded across UTF-8
stream boundaries, preserving characters split between process writes. Failed
harness exits retain the final 2,000 UTF-16 code units (never starting inside a surrogate pair, so a tail may be one unit shorter) of stdout and stderr, complete
stdout character/UTF-8 byte counts and digest, elapsed time, exit status/signal,
configured bounds and controller timeout/output-limit kill reasons in private
`failure.json` beside the snapshot and journal. The stdout tail is explicitly
partial diagnostic data, never a completed review or replacement source evidence.
Public errors show only the diagnostic digest and evidence path, never the
private output or environment. Existing invocation limits remain unchanged.

CI accepts complete receipt artifacts up to 3,000,000 UTF-8 bytes. This bounded
allowance accommodates complete source and converged independent reviews without
discarding draft evidence; the prior 2 MB allowance rejected a passing 2.1 MB
consumer record. Signature envelopes use the same byte limit.
When the [GitHub Contents API](https://docs.github.com/en/rest/repos/contents#get-repository-content)
omits inline content above 1 MB, CI reads the Git blob named by that immutable
artifact's metadata. It checks the exact blob identity, byte count and Git object
hash before the normal signature, source, policy and engine verification.
Unavailable, oversized or substituted content holds approval without AI fallback;
this transport does not grant trust or change receipt compatibility.
A partitioned review record too large for one receipt is stored as a signed multi-part receipt
(`clouseau-review.part-NNNN` files beside the envelope, see `docs/chunked-record.md`); each file keeps this bound.

## Chunked local review

`clouseau review` (and `respond`/`publish`, which continue and publish the same review) never refuses a change for its size.
It collects the change as before; when the complete evidence does not fit one 900,000-character snapshot (or a changed file is
over 300,000 bytes) it re-collects without a cap and takes the chunked path end to end: partition (`clouseau-partition/1`), bounded unit views
(a file too large for one unit is split into segments), both roles on every unit through the unchanged reviewer, controller-computed
seams, one blind integration pass per role, merge, one grading round per role, one chunked record (`version 3`, multi-part
when it exceeds one receipt) and ONE signed receipt. A change that fits is reviewed and signed exactly as before (record `version 2`,
byte-identical). CI verifies a chunked receipt through the same single derivation, recomputing the partition, views and seams.

It is on by default. The protected `local_review.chunked` object (in `.github/clouseau.json` on the base branch, so CI reads the same
values) can only **tighten** it:

| field | meaning | bound |
|---|---|---|
| `enabled: false` | turn chunked review off; an oversized change fails as it did before | |
| `force: true` | chunk even a change that fits one snapshot | |
| `params: {C, S}` | unit ceiling and shared context | at most 450000 and 100000 |
| `concurrency` | harness sessions at once (an `--agent` review answers one at a time) | at most 2 |
| `unit_deadline_ms` | deadline of one session | at most 300000 |
| `integration_cap` | integration pass input | at most 250000 |

No argument or environment variable changes them. A unit that misses the deadline stops the review with `unit_deadline` and the
ceiling to use; lower `params.C` in the protected configuration and review again. A crashed headless review resumes from its journal
(`<cache>/chunked/journal`) without sampling a finished call again. Rollback is unsetting `force` or setting `enabled: false`.

## Review partition

`src/review-partition.cjs` implements scheme `clouseau-partition/1`, the first stage of reviewing a change
whose complete evidence exceeds the 900,000-character snapshot budget in bounded units. It is deterministic
and model-free; `clouseau review` uses it for a change that does not fit one snapshot.

Changed files are sorted by new path (UTF-8 bytes) and grouped into atoms: a file stays with its `.test`,
`.spec` and `.stories` siblings, and a rename is one entry keyed by its new path. A file costs
`ceil(1.03 * (base bytes + head bytes + patch characters))`, where the patch size is the stored one (a file added whole keeps only its patch header, its body lives once in the head source). Atoms are packed next-fit, in path order, into
units of at most `unit_ceiling` (C = 450,000); an atom above C becomes its own unit. The plan digest covers the
scheme, parameters, unit membership and costs, so it is the same for any input order. Every changed path is
owned by exactly one unit (checked by `checkOwnership`).

A change is never refused for its size, and never truncated. The plan refuses only what is not a size: an
`unpartitionable_path`, an `unpartitionable_binary` (binary changes still fail closed), a duplicate path, or an
inconsistent ownership. A file with a `derived_size` (a lockfile replaced by a summary CI can recompute) costs that summary
instead of its sources. Every entry also costs `file_overhead` (512 characters, its accounting entry and manifest row), so a
thousand tiny files fill units as a few large ones do.

The number of units is unbounded (the runner executes them in waves). A stem group (a file and its tests) costing more than
`budget - shared - reserve` (900,000 - 100,000 - 240,000 = 560,000) falls apart into its files; a file costing more than that
is split into **segments** of at most C (`src/file-segments.cjs`). Every unit view stays inside the 900,000 budget.

A segment owns a contiguous run of the file's patch rows, so every changed line belongs to exactly one segment, and one
unit per segment (two segments of one file never share a unit). Its view shows that segment's patch (with sub-hunk headers
that count exactly its rows) and, as ordinary sources, the windows of the base and head text the rows touch plus 12 lines of
margin (a file added whole is stored compactly, its body once, in the head window). Windows keep the file's line structure:
the first line of a window is line `segment.start_line` of the whole source. A single line larger than a fragment (a minified
bundle) is cut into consecutive pieces owned by consecutive segments. The merge lifts every citation of a window to the same
lines of the whole source, which holds because a quote is a piece of the lines it cites, so the merged report is validated by
the unchanged validators against the complete combined snapshot. A unit's spec names its segment as
`parts: {path: {index, count}}`; `checkOwnership` and the record verifier want every index of `0..count-1` exactly once.
Inconsistent evidence (a patch that names a line outside its source) is an integrity error (`segment_inconsistent`), never a guess.

The change manifest every unit receives lists every changed path while it fits 60,000 characters. Beyond that the deepest
directories are summarized first (`{dir, files, additions, deletions, size, units}`, `unit_count` when more than 16 units), then
shallower ones, down to one row for the whole change; the files a unit owns are listed in full in its own files. Optional shared
context beyond the shared cap (another unit's lockfile summary, an engine file) is dropped and listed in `shared_omitted`;
only the contracts, the verification record and the request are mandatory, and those must fit the shared cap. That limit is a
property of the repository's contract documents, not of the size of a change.

`src/change-table.cjs` reads the planner's table from the stored snapshot, costing text by its JSON-escaped length, and adds
the segment costs of a file too large for a unit, so the plan, CI's recomputation and the views agree.

Print a plan for a table of changed files (`{files: [{path, previous?, base_size, head_size, patch_chars,
derived_size?}]}`; `test/fixtures/alcantara-02618a9.json` is the measured table of alcantara commit 02618a9,
which gives 4 units at C = 450,000 with stored sizes, 5 when every added file also counts its full patch). A table has only
sizes, so a file too large for a unit is split into equal parts:

```
scripts/partition-plan test/fixtures/alcantara-02618a9.json [--ceiling 300000]
```

The parameters come from the protected `local_review.chunked` configuration (defaults C = 450,000, S = 100,000). The earlier `max_units` and `file_ceiling` parameters, and the protected `cap` and `max_units`, bound
nothing any more (the protected configuration still accepts `cap` and `max_units` and ignores them).

### Unbounded collection

`collectLocal({..., unbounded: true})` is the collector of a chunked review: a changed file, a patch or the combined
snapshot of any size is read whole (binary evidence still fails closed), and the optional engine seed is never omitted for
size. Without the option nothing changes: one snapshot of at most 900,000 characters. The combined snapshot is reviewed in
bounded views and stored as a multi-part receipt (`docs/chunked-record.md`).

### Alcantara-shaped measurement

`scripts/measure-chunked [TABLE.json] [--ceiling N] [--shared N]` builds a synthetic
change from a table (fictional filler content of exactly the measured sizes, a real derived lockfile summary, compact
added files), partitions it, builds every unit view, merges fake finding-free unit reports, builds the thin chunked
record, signs it with an ephemeral key and verifies it through the one derivation. It prints the unit count,
per-unit sizes (view, owned, shared, manifest, foreign hunks, estimated prompt), the record size against the single-receipt
limit and the signed receipt (one file, or a multi-part receipt) size. No AI, network or secret is used. For `02618a9`
it gives 4 units, a 1.55M combined snapshot, a 1.70M record (59.5% of the single-receipt limit) and a largest estimated prompt of about 570K characters.
`src/chunked-measure.test.cjs` asserts these bounds and that every size which used to be refused (170 files, more than 8 units,
a record over the signing limit, roughly 500 paths, a file over 300,000 bytes, a unit over the unit budget, a file of
millions of characters, a single line of a million) is partitioned, reviewed, merged, signed and verified.
