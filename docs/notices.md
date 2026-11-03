# Notices and their causes

Every refusal or hold that Clouseau shows on a pull request, in a check summary or in a workflow log carries three things:

1. a **cause class**, a fixed machine-stable name such as `receipt_engine` (the same text is used in the comment, the workflow annotation and this page);
2. one sentence that says what is wrong, with the concrete values that are safe to show: a short commit id, the engine revision, the base that moved, the rule that held, or a file of the pull request itself;
3. **numbered next steps** the customer can run, with exact commands where one exists.

A notice never contains a secret, the contents of a receipt, or a provider's response. A cause class is a key of a closed table in the source (`src/receipt-rejection.cjs`, `src/incomplete.cjs`, `src/gate-notice.cjs`, `src/merge-protection.cjs`, `src/branch-update.cjs`, `src/branch-conflict.cjs`); text from a run is never promoted to a class. `src/notice-causes.test.cjs` fails when a class is added without a sentence, a numbered step and a row on this page.

Commands in steps use `clouseau`, the global launcher of the shared agent installation (`bash scripts/install-agent`), and the GitHub CLI `gh`. `BASE_BRANCH`, `PR_NUMBER`, `REQUIREMENT_FILE` and `RECEIPT_FILE` are placeholders for values only you know.

## Local review receipt not used

A receipt named by the `clouseau-local-review:` marker in the pull request description is either verified in every respect or ignored. An ignored receipt approves nothing. What the run does next depends on the repository:

| Mode | What the notice says |
| --- | --- |
| Local review is required | Nothing is approved until you publish a valid receipt. Shown as an incomplete-review comment with cause `local_receipt_required`. |
| Receipt-only route (a marker is present, no provider key) | This run did not review the change itself. Publish a valid receipt, or remove the marker so the CI AI reviewer runs. Cause `local_receipt_unusable`. |
| Anything else | CI reviewed the change itself; no action is needed. A paragraph at the end of the review comment names the cause. |

The notice reads `Local review receipt not used (cause: \`receipt_<class>\`): <sentence>`, and the incomplete-review comment shows it as `**Cause:** \`local_receipt_required\` (\`receipt_<class>\`)`.

| Cause class | Meaning | First class-specific step |
| --- | --- | --- |
| `receipt_absent` | The pull request description carries no `clouseau-local-review:` marker. | Reissue the receipt (below). |
| `receipt_unread` | This hosted run does not read receipts: it follows a receipt-only run, and that run already rejected the receipt (its notice names the cause). | Reissue the receipt (below). |
| `receipt_malformed` | The marker or the published receipt is malformed or unsupported (for example more than one marker, an installation-only receipt, or an artifact that is not a Clouseau receipt). | Reissue the receipt (below). |
| `receipt_unavailable` | The receipt could not be read from the immutable commit the marker names. | Check that the commit named by the marker still exists in this repository and has not been deleted; if it is gone, reissue the receipt. |
| `receipt_signature` | Its signature is not from an enrolled, active key. | Sign with an enrolled identity (`clouseau public-identity` prints the one on this machine); if it is not enrolled or was revoked, ask a repository owner to change the protected `local_review` section of `.github/clouseau.json` on the base branch to enroll it. |
| `receipt_author` | Its signer is not enrolled for the author of this pull request. | Sign with an identity enrolled for the pull request author, or ask a repository owner to change the protected `local_review` section of `.github/clouseau.json` on the base branch to enroll yours for this author. |
| `receipt_attestation` | It is not a maintainer attestation that the protected configuration permits for this pull request and author. | Have the pull request author run the review, or ask a repository owner to change the protected `local_review` section of `.github/clouseau.json` on the base branch to allow `local_review.attest` for this author. |
| `receipt_expired` | It is expired or not yet valid. | Receipts are valid only for a limited time after they are issued; renew this one in the pull request checkout with `clouseau refresh --pr PR_NUMBER --agent claude\|codex\|opencode` (outside an AI harness use `--harness codex\|claude`), which reviews the unchanged head again, reusing the earlier answers, and replaces the marker without pushing the branch, or do the steps below by hand. |
| `receipt_revision_repository` | It was issued for a different repository. | Run the review in a checkout of this repository, not a fork or another project. |
| `receipt_revision_head` | It reviewed an earlier head but this pull request is now at another head. | Any push after a review needs a new review: make your last change first, then review and publish that head. |
| `receipt_revision_base` | It was issued against an earlier base but the base branch is now at a newer commit. | Update the branch with the base: `gh pr update-branch PR_NUMBER` (or `git fetch origin && git merge origin/BASE_BRANCH`; never rebase), then `git pull` if GitHub did it. |
| `receipt_changed` | The protected policy or configuration changed after the receipt was issued. | Merge the current base into the branch (`git fetch origin && git merge origin/BASE_BRANCH`; never rebase) so the review uses the current rules. |
| `receipt_source` | The reviewed sources or diff differ from the pull request. | The review reads committed files only: commit all changes, do not amend or add commits after the review, and make sure the pull request contains exactly the reviewed commits. |
| `receipt_record` | Its review record is incomplete or inconsistent with what was signed. | Do not edit a receipt by hand; discard it and run a fresh review. |
| `receipt_engine` | It was issued by an older Clouseau engine and this run uses the current protected engine, which does not list that engine as review-compatible. | Run the review again: the `clouseau` launcher refreshes to the current protected engine before it starts (pass `--engine latest` to leave a review that was started on an older engine). |
| `receipt_not_passing` | The review it records did not pass. | Open the findings of the local review, repair the blockers within the accepted requirement, and review the new head. |
| `receipt_settings` | The protected chunked review configuration is invalid, so no receipt can be checked. | This is not fixable from the pull request: ask a repository owner to change the protected `local_review` section of `.github/clouseau.json` on the base branch (the `chunked` settings), then re-run this check. |
| `receipt_untested` | No supplied test imports changed production code. | Add or extend a test that imports each named production file (or the module that wraps it), commit it, and review again. |
| `receipt_integrity` | Test integrity is unresolved. | Make the tests prove the change (real assertions on the changed behavior, no weakened or deleted checks), commit, and review again. |
| `receipt_completeness` | Review completeness is unresolved. | Supply the evidence the reviewer could not read (sources or tests it names as missing), commit, and review again. |

Unless the class is `receipt_settings` (a protected configuration the owner must correct), the steps end with the same three that issue a fresh receipt for the current head by hand (`clouseau refresh --pr PR_NUMBER` does them for you; see [Refreshing a pull request](local-review.md#refreshing-a-pull-request-after-its-base-moved)):

1. Commit everything, then review this exact head: `clouseau review --directory . --base origin/BASE_BRANCH --request-file REQUIREMENT_FILE --agent claude|codex|opencode` (outside an AI harness use `--harness codex|claude` instead of `--agent`).
2. Publish the receipt: `clouseau publish --directory . --receipt RECEIPT_FILE`.
3. Put the marker it prints in the pull request description, replacing the old `clouseau-local-review:` marker (editing the description re-runs this check).

Values shown in a sentence are re-validated when rendered: commit ids must be 40 hexadecimal characters (shown as 12), an expiry must be an ISO instant, a branch name must be a plain name, and a file name comes from the pull request's own changed files with markup removed.

## Review incomplete

`Clouseau review incomplete` means no decision could be reached. The comment shows the cause class, one reason sentence and numbered steps. `{repo}` and `{run}` in a step are filled from the workflow run link.

| Cause class | First step |
| --- | --- |
| `provider_key_missing` | Add the provider key repository secret named in the reason: `gh secret set {secret} --repo {repo}`. |
| `provider_key_invalid` | Store the bare key (no spaces, quotation marks or line break) as the repository secret: `gh secret set {secret} --repo {repo}`. |
| `provider_rejected` | The provider refused the credential (HTTP 401 or 403). Create or activate a valid key in the provider console. |
| `provider_payment_required` | The provider refused the request for payment reasons (HTTP 402); the key itself was accepted. Add credit or fix billing on the provider account that owns the key. |
| `provider_unavailable` | No change to this pull request or its secrets is needed: the provider did not answer successfully. Check the provider status page. |
| `local_receipt_required` | Run the local Clouseau review on this exact head: `clouseau review --directory . --base origin/BASE_BRANCH --request-file REQUIREMENT_FILE --agent claude\|codex\|opencode`. |
| `local_receipt_unusable` | Run the local Clouseau review on this exact head and update the receipt marker in the pull request description (`clouseau review ...`, then `clouseau publish --directory . --receipt RECEIPT_FILE`). |
| `review_output_invalid` | The reviewer model answered in an invalid form on every bounded attempt. Re-run only the failed jobs: `gh run rerun {run} --failed --repo {repo}`. |
| `provider_incomplete` | The reviewer model did not finish its answer within the bounded budget. Re-run only the failed jobs: `gh run rerun {run} --failed --repo {repo}`. |
| `evidence_budget` | Split the change so that the changed files together fit the 900 KB review evidence budget. |
| `changed_file_unreadable` | Split the file named in the reason out of this change, or make it complete text of at most 300 KB. |
| `lockfile_unsummarizable` | Regenerate the lockfile named in the reason with a supported lockfile version, or split it out of this change. |
| `changed_files_incomplete` | GitHub did not return a patch for every changed file (a very large, binary or truncated diff). Reduce the change so every file has a patch. |
| `tree_truncated` | The repository tree is too large to locate existing tests. Re-run only the failed jobs: `gh run rerun {run} --failed --repo {repo}`. |
| `investigation_exhausted` | The reviewer could not complete its bounded source investigation. Re-run only the failed jobs: `gh run rerun {run} --failed --repo {repo}`. |
| `verification_failed` | Open the failing job linked in the reason (when it names one) and fix the failing step. |
| `github_api_error` | GitHub rejected an API request this review needs; the status and endpoint are in the reason. Re-run only the failed jobs: `gh run rerun {run} --failed --repo {repo}`. |
| `github_rate_limit` | No change is needed: the repository installation token used its GitHub API budget. |
| `receipt_protected_controls` | A local receipt cannot stand in for the owner. Ask a maintainer to comment exactly `/approve-intent {head}` on this pull request. |
| `receipt_history_changed` | The findings on the pull request changed after the receipt was issued. Run the local review again on this exact head so the receipt reflects them (`clouseau review ...`). |
| `chunked_record_invalid` | The signed chunked review record is not consistent with the evidence and protected parameters named in the reason. Run the local Clouseau review again on this exact head (`clouseau review ...`). |
| `decision_mismatch` | The assessment and the stored record disagree (both decisions are in the reason). Re-run only the failed jobs: `gh run rerun {run} --failed --repo {repo}`. |
| `evidence_incomplete` | Open the log of the failed assessment job in the workflow run below for the diagnostic and repair the missing evidence. |

A provider that refuses a request is told apart by its status: 401 or 403 is `provider_rejected` (the credential), 402 is `provider_payment_required` (the account cannot pay; the key itself is valid), anything else is `provider_unavailable`. A credential that is malformed is named before any request is made (`provider_key_missing`, `provider_key_invalid`) with the secret's name and a fixed problem class, never its value.

## Review pending

`Clouseau review pending` is shown while PR verification (tests, exact coverage and package build) has not finished. Nothing is approved. The cause class records the observed state.

| Cause class | What the customer does |
| --- | --- |
| `verification_pending_absent` | No PR verification run exists for this revision. Check that the verification workflow is enabled for this repository (the Actions tab). A pull request opened before that workflow was installed has no run: update the branch so one starts: `gh pr update-branch {number}`. |
| `verification_pending_queued` | Verification is queued for a runner; nothing is needed. The review runs again automatically when verification completes. |
| `verification_pending_running` | Verification is running; nothing is needed. The review runs again automatically when verification completes. |
| `verification_pending_finalizing` | Verification just finished and its results are being recorded; nothing is needed. The review runs again automatically. |
| `verification_pending_unknown` | Verification has not reported a final state; nothing is needed. The review runs again automatically when verification completes. |

## Branch update needed

Cause class `base_moved`. The base branch moved after the revision was assessed, so the assessment, any receipt and the exact-head approval are bound to the old base. The comment names both short commit ids and numbers three steps: `gh pr update-branch PR_NUMBER` (or merge the base; never rebase), wait for the automatic re-review, and, only where a receipt is required, review and publish again on the new head.

## Merge conflict with the base

Cause class `branch_conflict`. GitHub does not start `pull_request` workflows for a pull request that has a merge conflict with its base, so PR verification (tests, exact coverage and package build) never exists for the revision and the pull request would otherwise show nothing. The `pull_request_target` run still starts; while it waits for a verification run that is absent, it reads the pull request's mergeability from GitHub. Only a definite `mergeable: false` in state `dirty` on the assessed head is a conflict: a value still being computed (`mergeable: null`) is re-read up to four times, with waits of 2, 4 and 8 seconds, and if it is still unknown nothing is posted and the ordinary wait continues. A conflict ends the wait at once instead of after the queue grace and replaces the generic pending notice with one comment, `Clouseau: merge conflict`, bound by a hidden marker to the head and the base commit: a rerun posts nothing, a base that moves again updates the same comment, and a new head gets its own. The comment names the base branch (GitHub does not expose which files conflict; the merge in step 1 lists them) and numbers three steps: merge the base and resolve (`git fetch origin && git merge origin/BASE_BRANCH`; never rebase), refresh the review evidence and push once (`clouseau refresh --pr PR_NUMBER ...`, or review, publish, update the marker and push by hand), and wait: verification starts only after the conflict is resolved and pushed.

## Merge not armed (repository settings)

Cause class `merge_protection_insufficient`. Clouseau recorded its decision and approval but did not arm the merge. The comment lists each bounded gap with the change that closes it, then asks for a re-run.

| Gap | Step |
| --- | --- |
| auto-merge disabled | Enable auto-merge: `gh repo edit {repo} --enable-auto-merge`. |
| main not protected | Protect the base branch with a ruleset or branch protection (Settings, Rules); `gh api repos/{repo}/rulesets` lists existing rulesets. |
| required checks missing | Add the Clouseau verification and policy jobs as required status checks of the base branch ruleset. |
| up-to-date missing | Turn on "Require branches to be up to date before merging" in the base branch ruleset. |
| approval freshness missing | In the ruleset require one approving review, dismiss stale approvals on push, and require approval of the most recent push. |
| force-push+deletion protection missing | Add the "Restrict deletions" and "Block force pushes" rules to the base branch ruleset. |

## Maintainer request

When a maintainer's second opinion is required, the comment and the check summary carry the `/approve-intent` command and one of these cause classes.

| Cause class | First step |
| --- | --- |
| `intent_bot_authored` | A maintainer submits an approving review of this exact revision, because the approval bot cannot approve its own pull request: `gh pr review {number} --approve --repo {repo}`. |
| `intent_protected_controls` | Review the protected-control change (the sentence above names the rule), then have a maintainer confirm it. |
| `intent_incomplete_patch` | Reduce the change so GitHub returns a patch for every file, or review the withheld files by hand. |
| `intent_owner_decision` | Read the review above; if it is correct, have a maintainer confirm the change belongs in this repository. |

## Gate stopped

When the approval gate stops, its check summary shows the gate's own sentence followed by one of these classes. An error that is not in the table is `gate_failed`.

| Cause class | First step |
| --- | --- |
| `gate_verification_failed` | Open the failing job linked above and fix the failing step. |
| `auto_merge_not_armed` | Allow auto-merge for the repository: `gh repo edit {repo} --enable-auto-merge`. |
| `auto_merge_must_be_off` | Turn auto-merge off for this pull request: `gh pr merge {number} --disable-auto --repo {repo}`. |
| `assessment_pending` | Wait for the AI assessment to finish after verification; the gate runs again with its result. |
| `intent_required` | A maintainer comments exactly `/approve-intent {head}` on this pull request. This confirms intent only; all tests and coverage remain mandatory. |
| `revision_changed` | A push or a base change happened while the gate ran, so its result belongs to an older revision. |
| `verification_not_finished` | If this pull request comes from a fork, a maintainer approves its workflow runs (Actions tab, "Approve and run"). |
| `confirmation_withdrawn` | A maintainer comments exactly `/approve-intent {head}` on this pull request. This confirms intent only; all tests and coverage remain mandatory. |
| `ownership_changed` | Code ownership changed while the gate ran. Re-run the failed job: `gh run rerun {run} --failed --repo {repo}`. |
| `code_owner_approval_required` | A code owner approves the current head of this pull request: `gh pr review {number} --approve --repo {repo}`. |
| `protection_mode_changed` | The repository protection settings changed while the gate ran. Re-run the failed job: `gh run rerun {run} --failed --repo {repo}`. |
| `gate_failed` | Open the failed job log of the workflow run for the full error. |

## Local review notices

`clouseau review` prints these to stderr and lists their cause classes under `notices` in its result.

| Cause class | Meaning | Steps |
| --- | --- | --- |
| `verification_tool_missing` | A verification command needs a program or module that is not installed (a program that cannot start, `No module named X`, or `X: not found`). The program name is shown only when it is a plain name. | Install it (for `coverage`: `python3 -m pip install -r requirements-test.txt`; for `c8`: `npm ci`; otherwise put it on PATH), then run the review again on the same commit. |
| `local_recipe_edited` | The change edits `.clouseau-local.json`, so local review verified the recipe from the base branch, not the edit (a change cannot weaken its own checks). | Land a wanted edit in its own pull request first and review this change on the new base, or revert the edit. |

## Declared coverage

The `declared` coverage mode ([declared coverage](declared-coverage.md)) fails the coverage step with one of these classes. The step prints `Declared coverage (cause: <class>): <sentence>` followed by numbered steps. For a multi-artifact plan the header names the part and its declaration file: `Declared coverage (cause: <class>) for coverage part N (<format>, source <source>, declaration <dir>/package.json): <sentence>`, and every failing part is reported under its own class; the approval gate then reports `gate_verification_failed` for the failed job.

| Cause class | Meaning | First step |
| --- | --- | --- |
| `declared_missing` | The base revision has no readable `package.json` in the part's package directory (the part's `package_directory`, else its source directory; a missing directory included), or it declares no `lines` or `branches` minimum (`jest.coverageThreshold.global`, `c8` or `nyc`). | Declare the minimum in package.json and land it in its own pull request first; the gate reads the base revision. |
| `declared_conflict` | The declaration is ambiguous: a repeated JSON key, two tools declaring different values for one metric, tools disagreeing on `per-file`, or both spellings of one `c8`/`nyc` key. | Keep exactly one value per metric. |
| `declared_unsupported` | The shape cannot be read exactly: invalid JSON, a Jest path or glob entry, a string, negative, exponent or out-of-range value, thresholds without `"check-coverage": true`, Vitest, or per-file minimums on a `go` or `llvm` report. | Use `jest.coverageThreshold.global`, or `c8`/`nyc` with `"check-coverage": true`, with plain decimals from 0 to 100. |
| `declared_below_threshold` | A measured metric is below the declared minimum. The sentence names each metric, the measured percent (floored to two decimals, with the exact counts) and the declared minimum. | Add tests; do not lower the threshold in the same pull request. |

A pull request that changes the parsed declaration in any `package.json` (the root or a part's own) is a protected-control change and is held with the existing `intent_protected_controls` cause (see Maintainer request); it carries the notice `<path>/package.json is a protected-control hold: the declared coverage thresholds changed.` with the changed file's path (`package.json` for the root). More than 20 changed `package.json` files are all held with one notice.

## Notices that already name their own cause

These four are fixed sentences that state their condition, and each is outside the cause tables for the reason given. `src/notice-causes.test.cjs` proves each sentence.

| Notice | Why it needs no cause class |
| --- | --- |
| managed AGENTS.md hold | One stable sentence per decided change (`AGENTS.md stays a protected-control hold: <reason>.`, with reasons such as the managed block not being an enrolled central snapshot). It is not a refusal by itself: it feeds the protected-control request, which carries the cause classes `intent_protected_controls` and its numbered steps. |
| exact-revert hold | A report line (`Exact revert not applied: <reason>.`), never a hold: the ordinary review continues. Every verdict carries a fixed reason, and a stale base says `update the branch`. |
| installation settings notice | States the condition (an unprotected private base branch or an unreadable auto-merge setting) and the way out (a maintainer merges manually or protects the base branch). Trust is verified; only automatic merge is withheld. |
| repair-reservation comment | Not a refusal. It records that bounded repair attempt N of 2 was reserved for a named revision and that all checks and both AI reviews run again. |
