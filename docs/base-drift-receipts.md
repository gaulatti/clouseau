# Base-drift tolerant receipts (design, superseded)

Status: superseded, not implemented. The owner chose to bind a receipt to its diff instead of proving a base move harmless:
see [binding a receipt to its diff](local-review.md#binding-a-receipt-to-its-diff-opt-in) (protected `local_review.binding: "diff"`).
This document is kept as the record of the alternative that was considered.
`clouseau refresh` ([local review](local-review.md#refreshing-a-pull-request-after-its-base-moved)) already removes most of the
author's cost without touching trust; this document asks whether CI could also keep accepting a receipt after the base moved,
and recommends **go for a shadow stage and a narrow first stage, no-go for unconditional acceptance** (section 8).

## 1. Problem

A signed local receipt binds `snapshot.base_sha` and `snapshot.head_sha` (`verifySignedRecord`: `snapshot.base_sha === baseSha`).
When any other pull request merges, the base moves, every open pull request's receipt, assessment and approval is bound to
the old base, and `base-reconcile.cjs` posts `branch update needed`. The author's remedy is mechanical: merge the base,
review again, publish, edit the marker, push. A review costs several minutes and, in CI, about $6 (see
[receipt compatibility](receipt-compatibility.md)); the human cost is the same for every open pull request after every merge.

The question: when the move of the base cannot have changed anything the review attested, can CI say so itself,
deterministically, without a model?

## 2. What a receipt binds to the base today

| Bound input | Where it enters | Drift behavior today |
|---|---|---|
| base commit id | `snapshot.base_sha`, `verifySignedRecord` | any move rejects |
| changed-file patches | `snapshot.files[].patch`, compared with GitHub's per-file `patch` (reviewed diff verification) | a patch that differs rejects |
| base-side sources | `snapshot.sources` with `ref: base_sha` (every changed file's base text, the contracts `readme` and `repository_policy`, `.clouseau-local.json`) | content is part of the signed snapshot |
| head-side sources | `snapshot.sources` with `ref: head_sha` | bound to the head |
| per-file history | `snapshot.history` (`git log -3` of the base for each changed path) | commit ids of the base |
| protected configuration | `config_digest` (`.github/clouseau.json` on the base) | read at the live base, so config drift already rejects |
| policy | `policy_digest`, engine revision and review semantics | independent of the base |
| lockfile summaries | derived from the base and head bytes, recomputed by CI | a lockfile moved on the base rejects |
| verification record | `technical` for the head | independent CI verification is separate and mandatory |
| owner confirmation | `/approve-intent` bound to the exact head | not carried by a receipt |

Almost every row is already content-addressed. What is really bound to the *commit id* of the base is a convenience, not
evidence; the evidence is the bytes the reviewers read.

## 3. The safe condition

Let `B0`/`H0` be the signed base and head, `B1` the live base tip and `H1` the live pull request head. CI may accept the
receipt of `(B0, H0)` for `(B1, H1)` if and only if **all** of the following hold, each recomputed by CI from immutable
commit ids and never read from the receipt:

1. **Lineage.** `B0` is an ancestor of `B1`, and `B1` is an ancestor of (or equal to) the live base branch tip. The pull
   request is the signed one (same number, author, repository, branch).
2. **Head is exactly the merge.** Either `H1 = H0` (the pull request is not updated and GitHub will merge `H0` onto `B1`), or
   `H1` is a two-parent commit whose first parent is `H0` and whose second parent is `B1`, **and its tree id equals the tree
   `git merge-tree --write-tree H0 B1` computes**. A hand-edited merge (an extra change smuggled into the update) has another
   tree and is rejected. With `H1 = H0`, the same merge-tree result stands for the tree GitHub will create.
3. **Same patches.** Let `M` be that merged tree. The set of paths that differ between `B1` and `M` equals the signed
   `snapshot.paths`, and for every path the extended-header-stripped patch, mode and rename status computed by the same
   `git diff --no-ext-diff --no-textconv --find-renames` are byte-identical to the signed `files[].patch`.
4. **Same reads.** Let `D` be the set of paths that differ between `B0` and `B1` (the base's own movement). Every base-side
   source of the signed snapshot has the same blob id at `B0` and `B1`; every head-side source has the same blob id in `H0`
   and `M`; `history` recomputed at `B1` is byte-identical to the signed one; `config_digest`, `policy_digest` and
   `local_config_digest` recomputed at `B1` equal the signed ones. In particular no changed file, linked or requested
   source, contract, policy file, local or protected configuration is in `D`.
5. **Nothing the reviewers could not see depends on `D`.** No file in `D` is a dependency manifest or lockfile, a workflow,
   a `sensitive_paths` file or a path the protected configuration lists, and no changed file of the pull request imports,
   includes or otherwise statically resolves to a path in `D` (section 5, row 1), and no file in `D` does so to a changed path.
   Languages without an implemented resolver count as unresolvable: `D` may then contain only paths of the protected
   allow-list (section 7).
6. **Everything else is unchanged.** The receipt's own expiry and engine rules apply as today; protected-control changes
   still need the exact-head owner confirmation; a maintainer attestation keeps its own conditions; independent
   `verify` (tests, exact coverage, audits) runs on the live `H1` as always.

The comparison is always `(B0, H0)` against `(B1, H1)`, never a chain of acceptances, so errors cannot accumulate across
successive base moves. If any element cannot be computed (a missing object, a truncated listing, a limit on the number of
paths), the answer is "not tolerant" and today's behavior applies.

## 4. What CI must recompute deterministically

All of it is pure Git and file arithmetic; no model is asked.

- ancestry of `B0`, `B1` and the base tip (`merge-base --is-ancestor`, or the compare API on immutable ids);
- the merge tree of `H0` and `B1` (`git merge-tree --write-tree`), and equality of `tree(H1)` with it;
- the per-file patches, modes and renames between `B1` and `M`, normalized as the reviewed-diff verification already does;
- `D = diff(B0, B1)` and its intersection with the read set derived from the signed `snapshot.sources` (path, side, blob id);
- `history`, `config_digest`, `policy_digest`, `local_config_digest` and lockfile summaries at `B1`;
- the static dependency relation between changed paths and `D` for the languages that have a resolver (`specifiersOf` and
  `resolveSpecifier` in `acceptance.cjs` today cover JavaScript and TypeScript);
- hard limits (paths, blob sizes, resolver time) whose breach means "not tolerant".

The hosted verifier works from the GitHub API, not a clone, so the first implementation needs a bounded way to read trees at
two commits (the git trees API) or a cached bare clone of the repository in the workflow. That choice is an
implementation risk, not a design change.

## 5. Attacks and what stops them

| # | Attack or accident | Why a clean merge is not enough | Defence |
|---|---|---|---|
| 1 | **Semantic conflict through an unreviewed dependent.** The base gains a caller of a function the pull request changed (or removes an export the pull request's new code imports). Text merges cleanly; behavior breaks. | The reviewers read the changed files and requested sources, not every dependent; the read set cannot show absence. | Condition 5: no changed path resolves to a path in `D` and the reverse, for resolvable languages; otherwise only allow-listed delta. Independent `verify` runs on `H1` and catches what static checks cannot. **This is the residual risk**: it is the same exposure as merging any green pull request onto a moved base, without a re-review. |
| 2 | **Configuration or policy drift.** The base changes the contract, policy, `sensitive_paths`, CODEOWNERS or coverage config. | The review judged the change against the old contract. | Read-set equality of contracts and `.clouseau-local.json`; `config_digest` and `policy_digest` recomputed at `B1`; any `.github/**` or workflow path in `D` rejects. |
| 3 | **Lockfiles and manifests.** The base bumps or swaps a dependency; the pull request's lockfile summary is computed against the old base. | A supply-chain change can arrive through the base, and a lockfile merge can be clean. | The lockfile summary is recomputed at `B1` and must equal the signed one; any manifest or lockfile in `D` rejects. |
| 4 | **Renamed files.** The base renames a file the pull request edits (git carries the edit to the new path), or the pull request renames a file the base edited. | Rename detection is heuristic; the merged patch lands on a path the reviewers never saw. | Condition 3 (the path set and rename status must equal the signed ones) and condition 4 (the base-side source of the old path must be unchanged); rename thresholds are fixed. |
| 5 | **Forged or edited update commit.** `H1` carries an extra change presented as "just a merge". | The receipt was issued for `H0`. | Condition 2: `tree(H1)` must equal the recomputed merge tree; the first parent must be the signed head. |
| 6 | **Rewritten base.** A force-pushed or unrelated `B1`. | `B0..B1` would not describe the base's real movement. | Condition 1: `B0` is an ancestor of `B1` and `B1` of the live tip. |
| 7 | **Mode, symlink, submodule or binary changes** that the header-stripped patch hides. | The stripped comparison drops mode lines. | Modes and entry types compared from the raw tree diff; binary and submodule changes fail closed as in the partition planner. |
| 8 | **Stale approval.** The base moves again after acceptance. | The approval is bound to an older base. | `strict_required_status_checks_policy` and the existing reconciler re-evaluate every move; each evaluation is cheap and model-free, so a second move costs nothing. |
| 9 | **Replay on another pull request.** A receipt reused for a copied branch. | Same bytes, another pull request. | Author, number and repository checks as today, plus the signed head being the first parent of the live head. |
| 10 | **Verifier resource exhaustion.** A huge `D` or a pathological tree. | Computing the relation could be expensive. | Hard limits; exceeding any is "not tolerant", never "tolerant". |

Not defended and therefore the reason for a staged approach: an interaction through a file the repository's static analysis
cannot relate (configuration read at run time, generated code, a different language, a convention such as a registry file),
which only the independent tests can catch.

## 6. Why the receipt itself does not change

No new receipt field is needed: the read set is the signed `snapshot.sources`, the patches are `files[].patch`, the digests are
already signed. Keeping the receipt unchanged means no review-compatibility break, no re-issuing, and an immediate rollback:
the verifier simply stops applying the tolerance.

## 7. Staged rollout behind protected configuration

The knob lives only in the protected base configuration (`.github/clouseau.json`, `local_review.base_drift`), as the
`chunked` and `attest` settings do, so a pull request cannot enable it for itself. It is part of the configuration digest,
so flipping a stage invalidates outstanding receipts once (the same cost as any protected-configuration change) and a rollback
is un-flipping a flag.

| Stage | Setting | Behavior | Exit criterion |
|---|---|---|---|
| 0 | `{"mode": "observe"}` | CI computes the verdict and each condition's result, writes them in the job summary and a counter, and **accepts nothing new**. The existing branch-update notice is unchanged. | A representative period; for every pull request that was later refreshed and re-reviewed, the observed verdict never said "tolerant" when the re-review found a defect or the refreshed patches differed; the false-reject rate and the share of base movements that are tolerant are measured. |
| 1 | `{"mode": "accept", "allowed_delta": ["docs/**", "*.md"]}` | A receipt is accepted when conditions 1 to 4 and 6 hold and `D` lies wholly inside the allow-list (no resolver needed). | No incident; owner review of every acceptance for the first weeks. |
| 2 | add `"resolvers": ["js"]` | `D` may include code paths when the resolver proves no relation in either direction. | Same, plus resolver accuracy on the repository's own history. |
| 3 | drop the allow-list for resolvable languages only | Unresolvable languages still require the allow-list. | Decided from stage 2 data; not planned. |

Each stage is its own change to the protected configuration, with the stage 0 data attached to the proposal for the next.
Nothing activates on merge of the verifier code: it lands dark behind `mode` being unset.

## 8. Recommendation

**Go** for stage 0 (observe only) and stage 1 (documentation-only movement of the base), because the conditions are
deterministic, add no trust to the receipt, have an immediate rollback, and stage 0 produces the number that decides whether
the rest is worth building: how often a base movement is actually disjoint from a pull request. **No-go** for accepting a
receipt unconditionally across any base movement, and for stage 3, until stage 0 and 1 data exist: the semantic-conflict
class in row 1 cannot be excluded by the receipt or by any rule short of running the tests, and the independent `verify`
gate is the only control for it.

The local `clouseau refresh` command is the reason the wait is cheap: it already turns each stale pull request into one
command, and reuses every reviewer answer whose evidence is byte-identical, so the cost the hosted tolerance would save is
now mostly the author's attention rather than model time.

## 9. Open questions

- Which API gives `git merge-tree` semantics without a clone? (A bounded cached clone in the protected workflow is the
  fallback; both are model-free.)
- Whether `base_drift` should be excluded from the configuration digest to avoid one re-issue per stage (recommended: no, keep
  the simple fail-closed rule).
- Whether `history` should stop being review evidence (it changes with every base movement that touches a changed path and
  rarely informs a verdict); that would be a review-semantics change and is out of scope here.
