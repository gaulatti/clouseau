# Quickstart: a new repository to its first auto-merged PR

This is the shortest verified path for a repository with no Clouseau files. It
links to the reference documents instead of repeating them. Every step below was
run in a fresh repository. Decide first which mode you want:

| Mode | You need | Result |
| --- | --- | --- |
| Local receipt (`local_review.mode: optional` or `required`) | An authenticated `codex` or `claude` on your workstation | The PR carries a signed local review; CI only verifies it. No provider key |
| CI review (PRs without a receipt, `optional` mode) | `DEEPSEEK_API_KEY` secret (and `TYPESAFE_API_KEY` when `acceptance.grader` is `routed` or `typesafe`) | CI performs the AI review itself |

Without the CI secrets, a PR that has no valid receipt ends with the comment
`Clouseau review incomplete ... DEEPSEEK_API_KEY is not configured`; add the
secret and re-run the failed jobs.

## 1. Repository settings (before the first PR)

- Settings > Actions > General > Workflow permissions: enable **Allow GitHub
  Actions to create and approve pull requests** (API:
  `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -F can_approve_pull_request_reviews=true -f default_workflow_permissions=read`).
  The automatic approval depends on it (see the README's protected-merge
  requirements).
- Settings > General > Pull Requests: enable **Allow auto-merge** and squash
  merging. Private repositories on a plan without branch protection cannot enable
  it; see [the private-plan path](change-acceptance.md#controller-enforced-owner-merge-on-an-unavailable-private-plan)
  (`merge_mode` must then be `automatic` or `manual`, and the initial trust check
  expects repository auto-merge to read as disabled).
- Add `.github/CODEOWNERS` naming the owner when `merge_mode` is `automatic`.
- Runners: the reference workflow uses `ubuntu-latest`. Self-hosted pools must
  have a runner registered for the repository before the first PR; a pool with
  one slot is covered by [waiting for verification](automatic-ci-upgrades.md#waiting-for-verification).
- Pushing files under `.github/workflows/` needs a credential with the
  `workflow` scope (an SSH remote works; a `repo`-only `gh` token is refused).

## 2. Install the CLI and prepare the candidate

```sh
git clone https://github.com/gaulatti/clouseau.git && bash clouseau/scripts/install-agent
clouseau init-identity          # once per workstation; skip if one exists
clouseau installation-engine    # prints reviewer_sha: the pin used below
clouseau public-identity        # the public enrollment for clouseau.json
```

Keep `main` free of `.clouseau-local.json` and `.github/clouseau.json`. On a new
branch (for example `install/clouseau`) add:

- `.clouseau-local.json` as **version 2** (CI's `coverage-config` accepts only
  version 2; see [local review](local-review.md#multiple-native-coverage-artifacts)),
- `.github/clouseau.json` from [`examples/consumer-clouseau.json`](../examples/consumer-clouseau.json)
  with your public enrollment, owner and verification step names,
- `.github/clouseau.md` (the purpose contract) and `.github/CODEOWNERS`,
- `.github/workflows/ci.yml` from [`examples/consumer-ci.yml`](../examples/consumer-ci.yml)
  and the `initial-trust` workflow from [initial installation](initial-installation.md#independent-ci-and-initial-owner-acceptance),
  both pinned to the `reviewer_sha`.

## 3. Initial trust PR

Follow [initial installation](initial-installation.md): `installation-prepare`,
`installation-authorize`, `installation-review --harness claude|codex`,
`installation-publish`, then open the PR from the install branch with the
returned marker in its body. Wait for `verify` and `initial-trust`, then merge it
yourself: initial trust never auto-merges.

## 4. Protect main

After the trust PR is merged, create the ruleset the native path requires (public
repositories and paid private plans). `approve-and-merge` and `verify` must come
from GitHub Actions (integration id 15368), with no bypass actors:

```sh
gh api -X POST repos/OWNER/REPO/rulesets --input - <<'EOF'
{"name":"main protection","target":"branch","enforcement":"active","bypass_actors":[],
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},
  {"type":"pull_request","parameters":{"required_approving_review_count":1,
    "dismiss_stale_reviews_on_push":true,"require_code_owner_review":false,
    "require_last_push_approval":true,"required_review_thread_resolution":false}},
  {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,
    "required_status_checks":[{"context":"verify","integration_id":15368},
                             {"context":"approve-and-merge","integration_id":15368}]}}]}
EOF
```

## 5. Ordinary PRs

```sh
clouseau review --directory . --base origin/main --request-file req.txt --harness claude
clouseau publish --directory . --receipt PATH_FROM_THE_REVIEW_OUTPUT
```

Put the returned `clouseau-local-review:v1` marker in the PR body. When `verify`
and the review pass, the bot approves, arms auto-merge and the PR merges. If the
receipt is unusable (older engine, expired, stale head, different patch), the same
workflow run reviews the change in CI through the separate `assess-hosted` job, which
needs the provider secret and never reads the receipt; you do not have to remove the
marker. Workflows installed before this job existed carry a copy and must be upgraded
(see [automatic CI upgrades](automatic-ci-upgrades.md#receipt-route-fallback-upgrade)).

Changes to review controls (`.github/clouseau.*`, workflows, `.clouseau-local.json`,
`sensitive_paths`) cannot be approved by a receipt alone. The PR then shows
`Local receipt cannot replace changed review history or protected-control
authorization` in the job log. The owner posts a comment on the PR (the owner
must have write access):

```text
/approve-intent FULL_HEAD_SHA

Accepted purpose:
State the accepted outcome and its boundaries.
```

and the review is reassessed automatically. See
[owner decisions](change-acceptance.md#owner-decisions-and-protected-merge).
