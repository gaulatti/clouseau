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

`llvm` is also supported. The shared parser requires complete, nonempty exact
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
    "max_age_seconds": 3600,
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
inventory to GitHub's immutable PR sources, and recalculates the AI scores.
A valid local assessment can be authenticated and reused with zero CI AI calls
even while independent CI is pending or failed. That result remains
`pending_technical` or `blocked_technical`, with no approval-usable record digest
or approval/merge write. Unstamped PRs retain the CI provider route after
technical verification.

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
reviewer digest. An engine mismatch blocks without a paid fallback: refresh,
review again and start a fresh workflow. The selected commit and digest are in
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
harness exits retain the final 2,000 characters of stdout and stderr, complete
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
