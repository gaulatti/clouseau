# Reviewing against the pull request's ledger (opt-in)

By default `clouseau review` reviews against this runner's local finding history (`ledgers/<digest of repository and
branch>.json` in the state directory), and that history is what the receipt signs as its input history (`local_previous`,
bound to `snapshot.prior_findings`). CI accepts a pull request ledger only when it equals that input history, the signed record
reconciled with it, or the legacy form ([Signing a review that requires a human](local-review.md#signing-a-review-that-requires-a-human-opt-in) in docs/local-review.md).
A local history that differs from the ledger therefore cannot match it: a repair round whose review was never published, a
second machine or a cleared state directory (no history, so an empty one), or a ledger published in the legacy form.

`"review_history": "pull_request"` in `.clouseau-local.json`, read from the base like the rest of that file, makes every
`clouseau review` of that repository take its prior findings from the pull request's acceptance ledger instead. It is the
only accepted value; anything else is refused with `Invalid local-only Clouseau configuration: review_history must be
"pull_request" when set`.

**Do not set the key before this change is on main**: an engine without it refuses the recipe (`Unknown version 2 coverage
recipe field`), in every local review and in CI's coverage gate.

Without the key nothing changes: no GitHub call, no new output, the local history as before. With it, `clouseau review`:
1. finds the pull request, through gh only: `gh api repos/<origin>`, refusing a fork (its pull requests live in another
   repository, which is never guessed), then `gh api 'repos/<origin>/pulls?head=<owner>:<branch>&state=open'`. A
   maintainer attestation (`--pr N`) reads pull request N's ledger, and `clouseau refresh --pr N` passes N to its review, so
   neither looks the pull request up by branch;
2. reads the pull request's comments and takes the newest `github-actions[bot]` acceptance ledger, validated by the same
   function the gate uses (`priorState` in `src/acceptance-ledger.cjs`);
3. reviews against the ledger's findings, so the receipt's signed input history is the ledger by construction, which the gate
   accepts. The local history is still written after the review, as the ledger reconciled with this review. On the same
   head a changed ledger (a hosted review published in between) is a new review input, and an unchanged one is the same
   input, which never runs twice.

A lookup that finds no open pull request for the branch is a definite answer: the review uses the local history exactly as
without the key and says nothing. A pull request without a ledger comment has an empty ledger, so the review's prior history is
empty: that is the history the gate compares with, and a local history of an earlier pull request on a reused branch name never
leaks into the new one.

Every failure stops the review before verification runs, with one of these stable prefixes (detail follows it):

| Prefix | When |
|---|---|
| `Pull request ledger: gh is not available` | gh is not on PATH. |
| `Pull request ledger: gh is not authenticated` | gh exits 4 (it has no credentials), or GitHub answers HTTP 401. gh is checked by its first call, not by `gh auth status`, which also fails when only the network is down. |
| `Pull request ledger: the pull request lookup failed` | Reading the repository or the pull requests failed: offline, an API error or a rate limit, with GitHub's status when gh reports one. |
| `Pull request ledger: more than one open pull request for branch <branch>` | The branch heads several open pull requests. |
| `Pull request ledger: forks are not supported yet` | `gh api repos/<origin>` reports `"fork": true`. |
| `Pull request ledger: the ledger could not be read` | Reading the pull request's comments failed. |
| `Pull request ledger: the ledger failed validation` | The newest bot ledger comment fails the gate's validation. |

A finding of the local history that is blocking and unresolved (state `confirmed` or `outstanding`) and absent from the
ledger is no longer carried into the review. Each one is named on stderr, and the review continues:
`Local-only finding not on the pull request ledger: <id> "<title>" (<state>)`.

What it costs: gh, authenticated for the repository, becomes a requirement of `clouseau review` for the repository that sets
the key, and a review needs GitHub to be reachable. A hosted review that publishes between the read and the gate changes the
ledger, which is refused as before, and a new review reads the new ledger. `.clouseau-local.json` is a protected path, so the
pull request that turns the key on needs the owner's exact-head confirmation. CI never reads the key: the gate's rule is the
same with or without it, and a receipt made before the key was set is judged exactly as before. Rollback is removing the key.

## The histories it accepts

Without the key three histories stay refused, because the receipt signs the runner's local history and nothing signed links
it to the pull request's ledger:
- **a legacy-form ledger followed by a later receipt**: the later receipt's local history is the earlier review reconciled
  with its own local history, not the legacy-form ledger on the pull request;
- **an unpublished intermediate review**: a review between two published receipts (a repair round) was never published, so
  the local history the next receipt signs includes its findings and is not the ledger;
- **a second machine or a cleared state directory**: there is no local history, so the receipt signs an empty one.

With the key each of these reviews against the ledger and is accepted (`src/acceptance-controller-ledger-matrix.test.cjs`,
rows 9, 11 and 13, with and without the key; row 14, a history built before the key, is judged exactly as before). Otherwise
the exit is to remove the local-review marker from the pull request body so the CI reviewer reviews the change (under the
protected `hosted_review: "manual"`, a maintainer comments `/hosted-review <head>`), or a maintainer. A review of the same
head with the same local history signs the same history, so reviewing again without the key does not clear that hold.
