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

**Receipt.** A receipt additionally signs `reviewer_semantics`, the digest of the engine that issued it. Receipts without
the field behave exactly as before.

**Acceptance.** `verifySignedRecord` keeps every check it has (enrolled key, author, expiry, record binding, repository,
head, base, policy and configuration digests, recomputed decision, passing result). Only when the exact engine comparison
fails, and only in central-source mode, it asks `acceptor()` whether the receipt's `reviewer_semantics` is acceptable.
`acceptor()` reads the statement from the engine checkout that is running, the checkout `identifyEngine` and
`verifyEngine` already bound to the SHA the resolver read from protected `gaulatti/clouseau` `main`. It answers yes only
if the statement parses, `current` equals the digest it computes from that checkout, and the claim is `current` or listed.
Everything else answers no.

## The decision a maintainer makes

When semantic files change, `src/review-semantics.test.cjs` fails until the statement is regenerated:

- `scripts/review-compatibility bump --compatible`: the change cannot alter what a review attests (refactor, comment,
  performance, a notice). The previous digest moves into `compatible`; receipts issued under it remain acceptable.
- `scripts/review-compatibility bump --incompatible`: the change alters rubrics, prompts, schema, scoring, validation,
  source selection, receipt format or anything else a review means. `compatible` is emptied; every earlier receipt is
  ignored and CI reviews, which is the safe default for doubt.

`scripts/review-compatibility check` reports whether the statement is current. Declarations chain: after A to B and B to C
were both declared compatible, A's receipts are accepted under C. If a series of small changes could add up to a
different review, declare the last one incompatible.

## Why the list cannot go stale silently (the enforcement argument)

The risk is a semantic change that nobody declared, so that CI accepts a receipt from a weaker or different review. The
argument has four steps.

1. The digest is a function of the bytes of the semantic files, so any semantic change changes it. Reverting restores the
   old digest, which is sound because the bytes are identical.
2. The statement is rejected unless `current` equals the digest of its own tree (`acceptor()`), and
   `review-semantics.test.cjs` asserts the same equality in the engine's required `verify` job. A change to a semantic
   file therefore cannot merge, and cannot be served by a mismatching statement, without a commit that rewrites the
   statement. That commit is visible in the diff and must say `--compatible` (old digest listed) or `--incompatible`.
3. Default-semantic classification closes the "unclassified file" gap: adding a file, renaming one or editing the neutral
   table all change the digest. Listing a file as neutral requires a reason, and the test fails if semantic code loads or
   names any neutral file (apart from `src/cli-usage.cjs`, marked presentation), so a dependency cannot be mislabelled
   neutral by accident.
4. The statement, the module, the test and every other file under `src/`, `policy/`, `scripts/`, `bin/` and `skills/` are
   protected review controls (`sensitive_paths`). A change to them already needs the owner's exact-revision confirmation.
   The enforcement is a ratchet that makes the owner's compatibility decision unavoidable and visible, not a technical lock
   against an owner who approves a wrong declaration.

If a merge race leaves main with a stale statement (two semantic PRs each regenerated against a different base), the
`push` run of the test fails and `acceptor()` refuses everything until a repair PR lands. Both are the safe direction:
receipts are ignored and CI reviews.

## Threat analysis

Attacker: the holder of an enrolled signing key, who is also the PR author, or the PR author alone.

| Attempt | Outcome |
| --- | --- |
| Receipt claims a `reviewer_semantics` that the running engine does not list | Ignored (`engine`); CI reviews |
| Receipt or PR supplies its own statement or digest | There is no input path: the statement is read only from the resolved protected engine checkout |
| PR edits `policy/review-compatibility.json` in the consumer or engine repository | The consumer's checkout is never read; in the engine repository CI runs the frozen protected main, not the PR |
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
| Statement stale after a semantic change | Engine test fails; at run time receipts are ignored |
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

Because the first two change semantic files, whichever merges second merges `main` and runs `scripts/review-compatibility
bump --compatible`; the engine test says so.

## Residual risks

- The receipt's engine claim is not independently re-derived. A signer with an enrolled key could claim a compatible
  digest while running modified code. This is the existing trust in the enrolled signer; a later hardening can fetch the
  claimed revision and recompute its semantics digest.
- Chained declarations can hide a cumulative change (see above).
- A wrong `--compatible` is a human error the system makes visible but cannot detect.
- The neutral table is conservative; moving more files into it (with a reason) reduces how often a bump is needed.
