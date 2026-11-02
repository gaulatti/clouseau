# Opt-in acceptance of an exact revert

Approving a change and then blocking its exact revert is a model inconsistency, not a defect the engine can fix
by instruction (issue 107). `exact_revert` is an **opt-in, default-off** protected-configuration field that removes the
question: a pull request whose resulting tree is byte-identical to a tree the base branch already accepted restores an
accepted state exactly, so there is nothing new to review.

## Configuration

```json
"exact_revert": {"window": 50}
```

`window` is a whole number from 2 to 200: how many of the most recent commits reachable from the base commit are examined.
Anything else (unknown keys, a smaller or larger window, a non-integer) fails configuration validation, and the field
requires protocol version two. It is read only from the protected configuration of the accepted base, so a pull request
cannot enable or widen it. Unset, no code path runs and behaviour is byte-identical (the configuration digest is unchanged
too, so existing signed receipts stay valid).

## The rule

The engine reads three facts from the base repository through the GitHub API, keyed by immutable commit ids. Nothing comes
from the PR title, body, comments, commit messages or any file the PR supplies.

1. **Head tree**: the git tree object id of the head commit. It is a hash of the complete content, so equal ids mean
   byte-identical trees.
2. **Based on the current base**: the head descends from the exact base commit (`status` ahead, merge base equal to the
   base commit). The tree the PR leaves on the base is then the head tree itself. A PR that is behind or diverged is not
   judged; update the branch.
3. **Accepted tree**: the head tree equals the tree of a commit on the **first-parent** history of the base commit within
   `window` commits, and that tree is eligible:
   - it differs from the current base tree (an empty change is not a revert);
   - it was not **rolled back**: no later commit on the chain restored the tree that preceded it. Reverting a revert would
     reinstate a state the history itself undid, so it takes an ordinary review;
   - the commit that preceded it is inside the window (otherwise rollback cannot be ruled out), or it is a root commit.

Only first-parent commits count, because those are the states the base branch itself accepted. Commits that arrived on a
merged side branch, an unmerged branch, a fork, or a force-pushed-away history are never on the chain, so their trees do not
match. The same facts are recomputed at the gate and again at the private-merge write boundary, so a later push or a
rewritten history cannot ride on an earlier verdict.

## What is not waived

- **Protected controls.** A revert that touches a protected review control (workflow, `.github/clouseau.json`, the repository
  policy, `AGENTS.md`, `sensitive_paths`) is accepted only with `/approve-intent <head sha>` from the configured owner on
  the exact head, and its decision is `owner_decision`. Without it the ordinary review runs as it does today.
- **Verification.** Tests and exact coverage must pass independently; the gate rechecks them.
- **Everything else** the native gate checks (protection, fresh approval, auto-merge arming).
- An incomplete changed-file list or any other scope problem makes the rule not apply; the ordinary review runs.

## Output

On a match the assessment keeps the existing decision (`auto_approve`, or `owner_decision` with the confirmation) and adds
`review_source: "exact_revert"` and `provider_api_calls: 0`. The report and the PR notice (marker
`<!-- clouseau-exact-revert:v1 -->`, updated in place) say:

> Exact revert accepted without an AI review: the resulting tree <id> is byte-identical to the tree of base commit <sha>,
> <n> commit(s) back on the first-parent history. CI AI calls: 0.

When enabled but not applied the job log states `Exact revert not applied: <reason>.` and the ordinary review continues.
Reasons are fixed sentences and never quote repository content.

## Limits

- The base history is trusted as accepted: a commit pushed to the base without review counts. Branch protection is the
  control for that, as it is for everything else Clouseau assumes.
- Only first-parent history is considered, and only within the window. A revert of an old change needs a larger window or
  an ordinary review.
- The local `clouseau review` path is unchanged; this applies to hosted assessment and the gate.
