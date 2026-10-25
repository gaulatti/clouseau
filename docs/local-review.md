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
It does not generate a combined artifact or reinterpret counters. Every part
requires a complete application inventory, nonempty measured lines, and exact
100% lines and branches. A genuinely branchless part may have zero branches
when another part supplies measured branches; an entirely branchless plan fails.
Uncovered or missing data in one part cannot be compensated by another part.

Report and source paths must be repository-relative. Resolved source roots must
exist and must not overlap, and report paths must be unique, including aliases.
Paths that escape the checkout fail. There is no arbitrary exclusion option.
Generated application code, executable configuration and entry points remain
in scope. Native JS/TS inventory excludes declaration-only `.d.ts` files,
`*.test.*`/`*.spec.*` files and the fixed `test`, `tests`, `__tests__`, `.git`,
`node_modules` and `vendor` directories. Native coverage.py uses its documented
Python test/dependency conventions. Those non-application entries may appear in
a native report but cannot contribute passing counters.

Version 2 supports the complete-inventory `istanbul` and `coveragepy` adapters.
Version 1's single-report interface, including LLVM, remains supported. LLVM
multi-root plans require a complete compiled-source inventory capability and
are not accepted by version 2; Go statement reports do not become line/branch
coverage through this interface.

The accepted base supplies the complete recipe in normal local review. Local
evidence records exact counters and a content digest for every native artifact,
aggregate counters, and the accepted configuration digest. One frozen engine
checks every part throughout the review.

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

Use `--harness claude` for Claude Code. The controller runs real verification,
captures immutable base/head sources and accepted purpose, and starts separate
examiner and challenger sessions. Additional source requests are bounded. Fresh
semantic grading sessions supply descriptive factor levels; the same Clouseau
code owns citations, formulas, thresholds and final decisions. No investigator
gets the implementer's conversation or the other investigator's conclusions.

The controller identifies this as a pre-PR assessment in both investigation and
grading. It requires the accepted local recipe and meaningful evidence for the
changed behavior. CI audit, workflow and container execution remains pending
until the independent protected workflow runs; a local receipt does not claim
those results or authorize GitHub approval. Missing local evidence, deceptive
tests and unresolved code concerns still prevent a passing receipt. CI must
pass every mandatory technical gate before consuming the review for approval.

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
source. It waits for actual CI tests and exact coverage, loads the referenced
receipt as data, validates its signature/issuer/author/time/revisions/policy, and
compares its complete signed source inventory to GitHub's immutable PR sources.
It recalculates the review scores and revalidates the receipt at the write gate.
It then uses the existing native bot approval, auto-merge and protection checks.
The local path makes zero CI AI calls. Missing, stale, revoked, altered,
non-passing or unauthorized receipts cannot approve.

Tests, exact 100% coverage and branch protection remain mandatory. Review-control
changes retain their existing exact-revision owner installation requirements.
Post-deployment wiki generation and factual review remain separate operations.

Local caches include the exact installed central SHA, even when a newer commit
has identical engine bytes. Refreshing and reviewing again creates evidence for
that new SHA and preserves the old receipt. An exact matching cached receipt
still avoids another local review. Negative evidence and causal findings remain
retained; a different SHA with identical engine bytes cannot resample an unchanged
negative judgment.

When a resolver workflow changes, the runner supplies its immediate shared
dependencies and its actual pinned bootstrap as additional untrusted context.
Historical source requests use `.clouseau-ci/PATH@FULL_COMMIT_SHA`; they read
immutable public bytes without switching the frozen review engine or granting
contract authority. CI checks the same bytes before receipt reuse. The ordinary
source budgets remain unchanged: each investigation can read three batches of
up to eight paths, then submit its report using the final batch. A fourth source
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
