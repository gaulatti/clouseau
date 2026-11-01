# Initial consumer trust installation

Ordinary review reads its recipe and public signing enrollment from accepted
base configuration. A consumer with neither file needs a separate initial
trust decision. Never pretend proposed configuration is accepted, repeatedly
invoke a normal review that cannot bootstrap, or substitute an unsigned report
for an approval receipt.

These explicit installation commands are independent of agent startup. They use
the existing authenticated Codex or Claude Code harness and Ed25519 identity,
not CI model keys or a new credential service.

## Freeze and explicitly authorize initial trust

1. Read the accepted requirement and repository purpose. Preserve existing
   controls and ownership. Prepare real complete verification before trust.
2. Obtain the shared engine identity and the runner's public enrollment:

   ```sh
   clouseau installation-engine
   clouseau public-identity
   ```

   Select `--identity /outside/project/identity.json` when necessary. If none
   exists, explicitly run `clouseau init-identity` first. Public export returns
   only the enrollment and local identity-file path. Never copy private material
   into source, prompts, logs or artifacts.
3. Prepare the supported local recipe, version-two CI policy, purpose,
   ownership and thin workflows. The proposed CI policy must enroll that one
   public identity for its native GitHub actor, authorize the fixed public
   `central_source` from the [released upgrade protocol](automatic-ci-upgrades.md)
   or name the reported legacy engine digest, and select that actor as manual
   reviewer. The initial manifest and receipt always bind one exact engine SHA
   and digest, including in central-source mode. Commit and push the complete
   candidate. Store the literal accepted requirement outside the checkout.
   Keep the accepted base branch (`main`) free of `.clouseau-local.json` and
   `.github/clouseau.json`: push the candidate on its own branch (for example
   `install/clouseau`) and open the PR from it. The full commit SHA to pin in
   the workflows (`gaulatti/clouseau/scripts/resolve@SHA`, and
   `FULL_REVIEWED_RELEASE_SHA` below) is the `reviewer_sha` printed by
   `clouseau installation-engine`.
4. Prepare a new manifest outside the checkout:

   ```sh
   clouseau installation-prepare --directory /path/to/project \
     --request-file /outside/project/requirement.txt \
     --output /outside/project/installation-manifest.json
   ```

   It binds repository/base/head, engine SHA/digest, policy, requirement,
   recipe/CI configuration, public enrollment and all relevant workflow,
   purpose, instruction and ownership files. It is pending authorization, not
   a passing review. Existing accepted recipe or CI policy disables this
   initial-only path; use ordinary review/repair for installed controls.
5. Explicitly authorize the frozen manifest as the native repository
   administrator:

   ```sh
   clouseau installation-authorize \
     --manifest /outside/project/installation-manifest.json
   ```

   This creates a distinct `/authorize-clouseau-installation v1` comment on
   the pushed source commit, before a PR exists. Its canonical body contains
   public enrollment, requirement and immutable identities. The native comment
   author must match the enrolled runner and retain current administrator
   permission. A normal `/approve-intent` cannot enroll a key. An agent with
   delegated installation authority may record this explicit decision without
   repeatedly asking the owner for routine revisions.

The engine must be immutable accepted history of protected public
`gaulatti/clouseau` main. An unmerged central branch cannot qualify as a release.
The grant lasts at most one hour. Head/base/configuration changes, expiry,
comment removal/alteration or revoked administrator permission invalidate it.
Signatures authenticate the enrolled runner; they do not attest against a
malicious or compromised same-account workstation.

## Review, repair and publish before the ready PR

Use the returned native comment identifier:

```sh
clouseau installation-review --directory /path/to/project \
  --manifest /outside/project/installation-manifest.json \
  --grant-comment NATIVE_COMMENT_ID --harness codex
```

`--harness` is `codex` or `claude`; this command does not accept the `--agent`
form of `clouseau review` (it launches the harness itself, also from inside an
AI session). Use a correct harness name: a mistyped one still records an
attempt, after which the unchanged head is refused with `this unchanged
revision already has a negative review; repair it before reassessment`. Commit
a change, then prepare and authorize a new manifest. A branch has at most three
attempts.

This runs actual verification and native measurement, records their real
outcomes, then performs immutable source collection, independent
examiner/challenger review and deterministic scoring. Partial coverage, a failing
coverage command or unavailable coverage does not suppress local AI review or
become invented passing counts. A passing local AI-quality verdict may produce
installation-only signed evidence; it does not establish successful technical
verification or initial trust. The independent CI gate still requires all tests
and exact coverage, and the owner must accept the installation manually. Every
changed mechanism still earns its scope and integrity results. Setup subprocesses do not inherit provider/write-token environment
variables; the existing workstation trust boundary remains unchanged.

Incomplete transports and negative findings persist outside source. Renewing
timestamps/comments cannot resample an unchanged failed revision. Preserve the
diagnostics, repair demonstrated blockers, commit the complete revision and
obtain fresh frozen authorization. One attempt permits at most two repair
cycles. Existing report files are not overwritten. Only a passing review can
produce an installation-only signed receipt.

```sh
clouseau installation-publish --directory /path/to/project \
  --receipt /outside/project/returned-receipt.json
```

Publication uses the existing separate immutable Git artifact/tag route.
Include the returned `clouseau-installation-review:v1` marker in the initial
ready PR body (if the PR already exists, edit its body, then re-run the
`initial-trust` job). The PR must be internal, authored by the authorized native actor
and have automatic merge disabled. Ordinary receipt verification rejects this
receipt and marker, which is the ordinary rule for any receipt that does not verify: it is ignored and
the normal hosted review checks run (see [local review](local-review.md#a-receipt-that-does-not-verify-is-ignored)).

## Independent CI and initial owner acceptance

Contributor-code tests and native exact coverage run separately without
provider or write secrets. Keep all mandatory existing checks. A read-only
metadata job runs only the frozen released shared engine, reads the signed
artifact as data, checks current native authority, compares immutable source,
recomputes scores, and requires the exact successful PR-event verification run
and named steps. It never executes the contributor application.

A separate initial metadata workflow can invoke the shared CLI:

```yaml
name: Initial Clouseau trust verification
on: pull_request
permissions:
  actions: read
  contents: read
  pull-requests: read
  issues: read
jobs:
  initial-trust:
    runs-on: ubuntu-latest
    timeout-minutes: 70
    steps:
      - uses: actions/checkout@v4
        with:
          repository: gaulatti/clouseau
          ref: FULL_REVIEWED_RELEASE_SHA
          path: shared-clouseau
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Verify initial trust and independent CI
        env:
          GH_TOKEN: ${{ github.token }}
        run: >-
          node shared-clouseau/bin/clouseau.cjs installation-check
          --repository "${{ github.repository }}"
          --pull-request "${{ github.event.pull_request.number }}"
```

Use the same frozen engine as the grant. Guard the job with
`if: contains(github.event.pull_request.body, 'clouseau-installation-review:v1')`
under `initial-trust:`; unguarded, it runs on every later PR and fails with
`Invalid initial installation: one installation-only receipt marker is
required`. Run this job in a **different workflow**
from configured verification: it waits for that complete verification run and
must not wait on itself. It makes zero model requests, receives no provider key
or write permission, and cannot discard an existing review ledger. Unprotected
private repositories must explicitly select `manual` or strict owner-only
`automatic` merge mode and disable repository native auto-merge. Selecting the
eventual ordinary automatic policy does not grant this installation any merge
authority: the frozen grant binds that configuration, the initial receipt still
requires manual owner acceptance, and ordinary changes later use accepted-base
policy and enrollment. See the private-plan controller path in
[change acceptance](change-acceptance.md#controller-enforced-owner-merge-on-an-unavailable-private-plan).

Success explicitly returns `installation_verified`,
`manual_owner_acceptance_required`, `ordinary_pr_approval: false` and
`auto_merge_authorized: false`. It does not post approval, merge, weaken
controls, deploy, or claim the future base-branch controller already executed.

The owner accepts the initial trust PR under **all existing** requirements.
Any existing fresh code-owner approval remains necessary; never bypass or
remove it to escape bootstrap. Deployment authorization is separate. Once main
contains accepted recipe, enrollment and workflows, configure/read back the
supported effective rules and verify the ordinary path with a useful proof PR.
Initial owner trust acceptance is not that unattended proof.
