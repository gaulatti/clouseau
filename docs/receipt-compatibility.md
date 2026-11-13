# Receipt compatibility across engine revisions

A signed local review receipt names the engine revision that produced it (`reviewer_sha`, `reviewer_digest`). Today CI
accepts it only when that is exactly the protected `main` it resolved. `main` moves many times a day, so a receipt
rots within hours and CI repeats a review (about $6 and several minutes) even when the engine change cannot affect what
the review attests. This design lets CI accept a receipt issued under revision X while running revision Y, if and only if
Y itself declares X's review semantics compatible. If CI cannot establish that, it behaves as it does today: the receipt is
ignored and CI reviews.

## Design

**Review-semantics digest.** `src/review-semantics.cjs` hashes every engine file under the same roots as the exact engine
digest (`action.yml`, `src`, `policy`, `bin`, `skills`, `scripts`; tests excluded) *except* the files listed in its
`NEUTRAL` table. Each neutral file has a written reason. A file is semantic by default: a new or renamed file is part of
the meaning until a person lists it as neutral. The table lives in `review-semantics.cjs`, which is itself semantic, so
moving a file into it changes the digest and forces the same decision as editing the file would.

**Compatibility statement.** `policy/review-compatibility.json` is in-tree on protected main:

```json
{"version": 1, "current": "<digest of this tree>", "compatible": ["<older digest>", "..."]}
```

`current` must equal the digest of the tree that contains it. `compatible` lists earlier semantics whose receipts this
tree accepts (at most 64, newest first, never including `current`). The statement is the only source of compatibility.

Two further files exist only to keep the statement in step with the tree, and `acceptor()` never reads them:

- `compat/manifest.json` lists the semantic files (path, executable bits, content hash) the statement was last folded for.
  Its digest must equal `current`. It lets a tool say which semantic files changed since the fold by comparing two file
  lists, with no Git history.
- `compat/declarations/<digest>.json`, one file per pull request, state that a set of semantic files changed (by content
  hash, or deleted) and whether the change is `compatible` or `incompatible`. A declaration is inert until it is folded.

**Receipt.** A receipt additionally signs `reviewer_semantics`, the digest of the engine that issued it. Receipts without
the field behave exactly as before.

**Acceptance.** `verifySignedRecord` keeps every check it has (enrolled key, author, expiry, record binding, repository,
head, base, policy and configuration digests, recomputed decision, passing result). Only when the exact engine comparison
fails, and only in central-source mode, it asks `acceptor()` whether the receipt's `reviewer_semantics` is acceptable.
`acceptor()` reads the statement from the engine checkout that is running, the checkout `identifyEngine` and
`verifyEngine` already bound to the SHA the resolver read from protected `gaulatti/clouseau` `main`. It answers yes only
if the statement parses, `current` equals the digest it computes from that checkout, and the claim is `current` or listed.
Everything else answers no.

## Declare, then fold

A pull request never rewrites the statement. Two pull requests that each change semantic files therefore never touch the
same line, and merge in either order without a manual re-bump.

**In the pull request.** When semantic files change, `src/review-semantics.test.cjs` (the required `verify` job) fails with
"Undeclared review-semantics change" until the author records the decision, which adds one new file:

- `scripts/review-compatibility declare --compatible`: the change cannot alter what a review attests (refactor, comment,
  performance, a notice). Earlier receipts stay acceptable.
- `scripts/review-compatibility declare --incompatible`: the change alters rubrics, prompts, schema, scoring, validation,
  source selection, receipt format or anything else a review means. Every earlier receipt is ignored and CI reviews, which
  is the safe default for doubt.

The declaration names each changed semantic file with its content hash (a deleted file as `sha256: null`). The file is named
by the digest of its own content. `verify` passes only when every changed semantic file is covered by exactly one
declaration whose hash equals the file in the tree, and every declaration covers a file that really changed. An undeclared
change, a declaration for a file that did not change, a file changed again after it was declared, two declarations for one
file, an unknown file in `compat/declarations/` and a manifest that does not match the statement all fail `verify`.

**On protected main.** `scripts/review-compatibility fold` turns the declarations into the new statement and manifest and
deletes them. It runs only in `.github/workflows/compat-fold.yml`, which checks out `main` alone, and the command itself
refuses unless `GITHUB_REPOSITORY` is `gaulatti/clouseau` and `GITHUB_REF` is `refs/heads/main`. It validates exactly as
`verify` does and changes nothing on any inconsistency. If every declaration is `compatible`, the previous `current` moves
into `compatible`; if any is `incompatible`, `compatible` is emptied. It is deterministic (same tree, same bytes),
idempotent (a second run finds nothing to fold) and its result passes `scripts/review-compatibility check`. The workflow
then runs `check` and the engine tests again before pushing one plain, fast-forward commit; if `main` moved it folds again
from the new `main`.

`scripts/review-compatibility check` succeeds only on a folded tree. `verify` also succeeds on a tree that carries
valid, not yet folded declarations. `scripts/review-compatibility bump --compatible|--incompatible` remains as the manual
equivalent of a fold for a maintainer repairing a tree by hand: it applies the decision to everything that changed, rewrites
statement and manifest together and consumes the declarations. A pull request that still edits the statement by hand fails
`verify` unless it also keeps manifest and declarations consistent, and costs the conflicts this design removes, so use
`declare`.

Declarations chain: after A to B and B to C were both declared compatible, A's receipts are accepted under C. When two pull
requests are folded together, their combined step is compatible only if both declared `compatible`. If a series of small
changes could add up to a different review, declare the last one incompatible. After about 50 further `compatible` folds the
64-entry cap drops the oldest digests and receipts issued under them are ignored again.

Two pull requests that edit the **same** semantic file are the one case that still needs a second declaration: Git may merge
the text, but the merged content then matches neither declaration, so `verify` fails until one author deletes their
declaration and declares again. That is the safe direction. Where the protected `local_review.binding: "diff"` applies, the
second declaration does not void the pull request's diff-bound receipt as long as it keeps the same verdict over the same
files: CI compares declarations by what they declare, not by the digests they pin (see
[binding a receipt to its diff](local-review.md#binding-a-receipt-to-its-diff-opt-in)). `clouseau refresh` makes that second declaration
itself when it merges the base with no review (`updated`) and that is the only repair the merged tree needs; otherwise it
refuses to push.

## Why the list cannot go stale silently (the enforcement argument)

The risk is a semantic change that nobody declared, so that CI accepts a receipt from a weaker or different review. The
argument has four steps.

1. The digest is a function of the bytes of the semantic files, so any semantic change changes it. Reverting restores the
   old digest, which is sound because the bytes are identical.
2. The statement is rejected unless `current` equals the digest of its own tree (`acceptor()`; unchanged by the declare
   and fold flow). The engine's required `verify` job asserts that every semantic file that differs from the manifest is
   covered by exactly one valid declaration, so a change to a semantic file cannot merge without a visible
   `--compatible` or `--incompatible` decision bound to that file's content. Between the merge and the fold, `current`
   no longer equals the digest of the tree, so `acceptor()` answers no to everything: receipts are ignored and CI reviews.
   Only the fold turns a decision into a statement, and it applies the same checks as `verify`.
3. Default-semantic classification closes the "unclassified file" gap: adding a file, renaming one or editing the neutral
   table all change the digest. Listing a file as neutral requires a reason, and the test fails if semantic code loads or
   names any neutral file (apart from `src/cli-usage.cjs`, marked presentation), so a dependency cannot be mislabelled
   neutral by accident.
4. The statement, the manifest, the declarations, the module, the test and every other file under `src/`, `policy/`,
   `compat/`, `scripts/`, `bin/` and `skills/` are protected review controls (`sensitive_paths`). A change to them already needs the owner's exact-revision confirmation.
   The enforcement is a ratchet that makes the owner's compatibility decision unavoidable and visible, not a technical lock
   against an owner who approves a wrong declaration.

There is deliberately a window between a merge and its fold in which main's statement is stale. It is safe because
`acceptor()` refuses everything then (receipts are ignored and CI reviews), and it is short: the fold follows the merge's
review workflow, any push that touches `compat/declarations/`, and a half-hourly schedule. If a fold cannot run or fails,
the window stays open and CI keeps reviewing; nothing is ever accepted on the strength of an unfolded declaration.

## Threat analysis

Attacker: the holder of an enrolled signing key, who is also the PR author, or the PR author alone.

| Attempt | Outcome |
| --- | --- |
| Receipt claims a `reviewer_semantics` that the running engine does not list | Ignored (`engine`); CI reviews |
| Receipt or PR supplies its own statement or digest | There is no input path: the statement is read only from the resolved protected engine checkout |
| PR edits `policy/review-compatibility.json` in the consumer or engine repository | The consumer's checkout is never read; in the engine repository CI runs the frozen protected main, not the PR |
| PR adds a declaration, or edits the manifest, to hide or reclassify a semantic change | Declarations are inert to `acceptor()`. `verify` binds each to the content hash of the files it names, and a manifest that does not hash to `current` fails; both are protected paths |
| PR changes a semantic file and no declaration covers it | `verify` fails; the PR cannot merge |
| A declaration is run through the fold from a pull request or a fork | The fold runs only on `gaulatti/clouseau` `refs/heads/main`, from a main-only checkout, and refuses elsewhere |
| Weak engine fork signs a receipt naming a real compatible digest | Same trust as today: an enrolled key already vouches for `reviewer_sha`/`reviewer_digest`, which CI cannot re-derive from the receipt. Not widened; see residual risks |
| Receipt from an unlisted or retired semantics, or from a fixed-digest (non central-source) trust | Ignored; fixed-digest trust never uses this path |
| Tampering with `reviewer_semantics` after signing | Breaks the signature |
| Replaying a compatible receipt on another head, base, repository, author, policy or configuration | All existing bindings still apply |
| Statement unreadable, malformed, stale, or the digest cannot be computed (symlink, missing file) | `acceptor()` answers no; receipt ignored |

## Failure modes

| Condition | Result |
| --- | --- |
| Receipt has no `reviewer_semantics` | Today's behaviour: exact engine match or ignored |
| Old CI engine meets a receipt with the new field | Unknown field: `malformed`, ignored (fail closed) |
| Statement stale after a semantic change | Undeclared: engine test fails. Declared and merged but not yet folded: receipts are ignored until the fold |
| Declarations inconsistent with the tree, or fold cannot push | Fold changes nothing and fails; receipts stay ignored |
| Semantics digest unknown to the statement | Ignored |
| More than 64 digests listed | Statement malformed, receipts ignored |
| Receipt older than 48 hours | Expired by the existing rule, whatever the statement lists |

## Rollout

Consumers change nothing: their workflows already resolve protected main, and the receipt format only gains an optional
signed field. The work lands as independent pull requests that change no behaviour until the last one:

1. Semantics digest, statement, maintainer tool and enforcement test (this document). Nothing calls them.
2. Receipt format: an optional signed `reviewer_semantics`, accepted by the verifier and issued when a caller supplies it,
   and an optional acceptance hook consulted only after an exact engine mismatch. No caller passes either.
3. Integrator: local review supplies the digest when it issues a receipt, and the verifier's hook defaults to
   `acceptor()`. Receipts issued from that point carry the field; receipts of the preceding revisions are not retrofitted
   and stay governed by exact match. To roll back, make the hook default `null` again; no receipt or statement needs to
   change.

Each pull request that changes semantic files declares the change (`declare`); none of them edits the statement.

## Residual risks

- The receipt's engine claim is not independently re-derived. A signer with an enrolled key could claim a compatible
  digest while running modified code. This is the existing trust in the enrolled signer; a later hardening can fetch the
  claimed revision and recompute its semantics digest.
- Chained declarations can hide a cumulative change (see above).
- A wrong `--compatible` is a human error the system makes visible but cannot detect.
- The neutral table is conservative; moving more files into it (with a reason) reduces how often a declaration is needed.
- The fold and the maintainer tool (`src/review-compatibility-cli.cjs`, `scripts/review-compatibility`) are receipt-neutral, as `bump`
  always was, so editing them does not change the digest. The rules they apply to declarations (`inspect`, `declare`) live in
  `src/compat-declarations.cjs`, which is semantic, because `clouseau refresh` also applies them before an `updated` push; they are protected review controls and `src/review-compatibility-cli.test.cjs`
  pins their behaviour. `.github/workflows/compat-fold.yml` is pinned by `.github/tests/compat-fold.test.mjs` (permissions, refs, no
  secret, plain push to main).
