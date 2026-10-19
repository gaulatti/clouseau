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

Reports and response journals stay outside source control. A completed identical
input is not automatically reviewed again. Fix blocking findings, commit the
changed implementation and reassess. A negative or incomplete review never
produces an approval receipt. This initial receipt path targets a new PR without
an unresolved existing GitHub review ledger; it rejects an existing incompatible
ledger rather than dropping its findings.

## Enrolling a trusted runner

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
    "reviewer_digest": "APPROVED_64_CHARACTER_ENGINE_SHA256",
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

Only existing protected configuration can enroll or revoke a key. A contributor
cannot authorize their own key through the proposed PR. Keys are restricted to
their enrolled native GitHub PR author. Set `revoked` or remove a key to reject
its future receipts. `optional` mode permits the separately installed CI AI
reviewer for PRs without a receipt. An invalid receipt never falls back to a paid
AI review. `required` mode needs no CI AI provider credentials.

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
requires unmodified Clouseau engine content already enrolled in accepted CI
policy. It records the exact Clouseau commit and binds the executable engine,
skill, scripts and policy by a SHA-256 content digest. Identical reviewed engine
content remains compatible across squash-merge commit identities. It verifies
the same source and installation remain unchanged before
issuing a passing receipt. Signing material is never placed in model packets,
child-process environments, project source, reports or the published artifact.
Protected review-control changes still require the separate owner-authorized
installation path; an ordinary local receipt cannot grant that authority.

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
