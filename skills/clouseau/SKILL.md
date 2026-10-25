---
name: clouseau
description: Run the shared Clouseau change-acceptance review locally using an authenticated coding harness. Use while implementing requirements, when explicitly asked for Clouseau review, and before opening a PR. Investigate and repair blocking findings before requesting CI approval.
---

Clouseau owns the review protocol, evidence validation, semantic rubrics and score
calculation. Consume its current public source; do not copy the review rules into
the application repository or invent a passing report.

If neither the local recipe nor CI policy exists on the accepted base, use the
shared `docs/initial-installation.md` procedure instead of repeating normal
review. Initial trust requires an explicit owner/admin frozen commit-comment
grant, full local review and independent CI. Its installation-only receipt is
published before the ready PR and requires manual owner acceptance under existing
controls. It cannot authorize ordinary changes, auto-merge or deployment.

1. Run the global `clouseau` entry point, which refreshes protected Clouseau main
   before execution. Reread this skill from the refreshed installation. The
   runner freezes one Clouseau revision throughout the review.
2. Read the repository purpose and the accepted requirement. The repository's
   `.clouseau-local.json` supplies verification commands and native coverage
   configuration independently of any GitHub Actions installation. Preserve work
   outside the requirement. Commit the complete candidate before signing.
3. Store the requirement text outside the checkout and run
   `clouseau review --directory REPO --request-file FILE --harness codex`.
   Use `--harness claude` when working with that authenticated harness. No CI
   provider keys are needed. Real verification outcomes are recorded first;
   partial coverage, a failing coverage command or unavailable/invalid coverage
   never suppresses local AI review or becomes fabricated passing counts. Fresh
   examiner and challenger sessions receive the frozen evidence without the
   implementer's conversation or each other's work.
4. Read the recorded findings, factor grades, source citations and decision.
   Fix demonstrated blockers within the accepted requirement, verify the repair
   and review the new revision. Retain negative evidence; never repeat an
   unchanged review in search of approval. At most two repair cycles belong to
   one implementation attempt. Missing purpose or authority requires a concrete
   owner decision; source or verification gaps require investigation.
   This pre-PR assessment requires the accepted local recipe, safe complete
   immutable source and material behavioral evidence. Coverage percentage or
   unavailable coverage alone does not force a failing AI quality verdict;
   demonstrated defects, deceptive tests and missing material context still do.
   Report the AI decision separately from local verification/coverage status.
   CI's separate tests and exact-100% coverage gate remain mandatory before
   approval and merge; a local quality verdict cannot claim those results.
5. An enrolled runner selects its installed signing identity automatically.
   Pass `--identity FILE` when multiple enrolled identities require selection.
   A passing final AI quality review produces a signed reuse receipt
   automatically. The receipt cannot authorize technical approval or merge,
   including when local coverage is below 100%. Never read,
   print, transmit or copy the identity's private material into a repository,
   prompt, tool environment or report. The identity file belongs to the trusted
   local runner, not to project source. Developer-owned workstations and their
   privileged processes are part of that runner's declared trust boundary.
6. Before opening a PR, use `clouseau publish --directory REPO --receipt FILE`.
   Include its returned marker in the initial PR body so the first metadata
   workflow sees it. The artifact is published separately from the reviewed
   commit. Open a ready PR. Any code/base/policy change requires fresh matching
   evidence; never hand-edit the receipt or reuse a marker for another revision.

Agent installation creates no Actions workflows, CI secrets or branch rules.
Only explicitly integrated repositories can consume local receipts in CI. A
signature authenticates a registered runner's evidence; it is not proof against
a compromised runner or a malicious administrator of that computer. An
unregistered contributor cannot enroll their own key through a PR.
