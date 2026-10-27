# Clouseau

Clouseau also provides a centrally maintained local agent skill and signed review
receipts. Agent-only installation is independent of CI: it uses authenticated
coding harnesses and creates no Actions configuration or provider secrets.
Inside Claude Code, Codex or opencode the calling agent supplies the review
sessions (`--agent`); the headless `--harness` form is for a plain terminal.
Local AI review runs regardless of coverage percentage or availability and keeps
its quality verdict separate from real verification results. Opted-in CI verifies
an enrolled runner's passing AI receipt without repeating the review, then still
requires its own tests and exact coverage before approval/merge. See
[local review, installation and trust boundaries](docs/local-review.md).
Consumers without accepted recipe/enrollment/workflows use the separate
[initial owner-authorized trust installation](docs/initial-installation.md).
Its signed evidence cannot approve ordinary changes or automatically merge.
Clouseau's own accepted-policy bootstrap and native coverage diagnostics are
documented in [self-review](docs/self-review.md).

Shared coverage gates and evidence-led AI pull request approval for GitHub Actions.
Clouseau owns the PR intent review process: check whether a change is needed,
compare it with repository contracts and precedent, request the owner's second
opinion when necessary, and approve and arm auto-merge only after every technical
requirement passes. The initial implementation was extracted from Colombo.

Version 2 implements the [change acceptance protocol](docs/change-acceptance.md):
product fit, need and proportionality; nine-factor technical findings; independent
source investigations; a persistent evidence ledger; bounded repairs; and native
protected auto-merge. Humans decide genuine purpose and authority questions.
Technical uncertainty goes to automated investigation and cannot be waived by
an intent comment. Version 1 remains explicit compatibility for existing pins.

## Ownership

Clouseau contains the coverage checker, regression tests, PR intent review rules,
DeepSeek integration, approval controller, and reusable composite action.
Each consuming repository keeps its build/test commands, a configuration file,
and its own purpose, contracts, acceptance criteria, and manual-review owner.
There is no application-specific deployment infrastructure in Clouseau.

## Operations

Automatic CI integrations pin the small `gaulatti/clouseau/scripts/resolve`
bootstrap once at a reviewed full commit. It selects protected Clouseau main,
freezes its SHA and computes its digest. Every engine job checks out that SHA
and invokes the local action with the same trusted outputs. Normal central
releases need no consumer pin or digest update. See [automatic CI upgrades](docs/automatic-ci-upgrades.md)
for source authorization, failure behavior and exact local-receipt compatibility.
Legacy fixed installations may still use `gaulatti/clouseau@FULL_REVIEWED_COMMIT_SHA`;
upgrading those installations requires a reviewed PR. See `examples/colombo.json`
for the version 2 policy configuration.

| Operation | Inputs | Result |
| --- | --- | --- |
| `verify-engine` | Trusted run SHA/digest in `CLOUSEAU_ENGINE_SHA` and `CLOUSEAU_ENGINE_DIGEST` | Verify the frozen source and record its exact identity |
| `test` | none | Run Clouseau's Node regression suite |
| `coverage` | Accepted-base v2 `coverage-config`, or legacy `coverage-report` + `source-directory` with optional `coverage-format` | Require exact, nonempty 100% native application line and branch coverage; the two input forms are mutually exclusive |
| `assess` | `config`, optional `pull-request`, `provider-key` | Authenticate local quality evidence independently of technical status, or wait for verification before CI AI assessment |
| `verify-local` | `config`, eligible published signed receipt | Validate local evidence and independent CI with zero AI calls; missing or invalid evidence holds |
| `gate` | `config`, `assessment`, optional `pull-request` | Validate protection, arm auto-merge, request owner review, or approve a verified revision |
| `repair` | v2 `config`, `assessment`, this run's record artifacts, independent `repair-token` | Validate and reserve one bounded correction, then push a new internal PR revision requiring fresh CI/review |
| `evaluate-acceptance` | `provider-key`, `typesafe-key` | Execute six fixed qualification fixtures, investigate with real models, compare DeepSeek and Jev grading plus whole-review cost; retain evidence without GitHub writes |
| `evaluate-review` | `provider-key` | Evaluate the real model on fixed maintenance, product-drift, and test-fakery cases; no GitHub writes |
| `check-provider` | `provider-key` | Verify DeepSeek authentication and JSON output without touching a PR |
| `request-reassessment` | `config`, optional `pull-request` | Validate the maintainer trigger and rerun the exact trusted PR metadata workflow; never rebuild contributor code |
| `plan-wiki` | `provider-key`, `wiki-config`, wiki/source checkouts | Generate and validate a coordinated multi-page draft after deployment; `wiki-draft: true` permits read-only validation |
| `evaluate-wiki` | `provider-key` | Read-only live factual checks on supported and deliberately false documentation |
| `publish-wiki` | `wiki-config`, validated `wiki-plan-path`, wiki/source checkouts | Revalidate deployment and publish every page in one non-force wiki commit; no provider key |
| `finalize` | `config`, `assessment` | Wait for GitHub auto-merge after the required native gate finishes, then preserve the existing CD handoff |

For example, a caller's coverage step supplies:

```yaml
with:
  operation: coverage
  coverage-report: coverage.json
  source-directory: src
```

The report must contain every compiled application path, including uncovered
code. Vendor/dependency coverage cannot mask application gaps. Counts must match
exactly; rounded percentages, missing data, or a zero branch total fail. The
caller owns instrumentation and test execution. Colombo uses Rust nightly branch
instrumentation with normal application cfgs, followed by docs and Docker tests.

For JavaScript/TypeScript, select `coverage-format: istanbul` and pass the native
`coverage-final.json` produced by c8/Istanbul. Set `source-directory` to the
original application source tree, not compiled output. Every `.ts`, `.tsx`,
`.js`, `.jsx`, `.cjs`, and `.mjs` source must appear, including unloaded modules.
Declaration-only `.d.ts` files, concrete test conventions and dependency
directories are not application sources; generated application code remains
included. The fixed inventory conventions and multi-artifact configuration are
documented in [local coverage plans](docs/local-review.md#multiple-native-coverage-artifacts).
The checker rejects omitted,
duplicate, mismatched, skipped or malformed measurements and coverage-ignore
directives. It derives exact line and branch totals from native hit counters,
never from rounded summary percentages. Configure c8 `--all` over all compiled
JavaScript with source maps to measure unloaded TypeScript sources. Run real
runtime tests as well as unit tests; this format support does not replace them.

For Python, select `coverage-format: coveragepy` and supply the unmodified JSON
format 3 report from `coverage.py` with branch measurement enabled. See the
[native Python coverage contract](docs/python-coverage.md) for source inventory,
report generation, path binding and exact native counter validation. This reads
coverage.py's executable lines and branch decision exits, not statement
percentages or every traced transition. Empty global totals, omitted application
modules, exclusions, partial coverage and inconsistent counters fail closed.

Monorepos may use the accepted-base version 2 local recipe with separate native
Istanbul and coverage.py parts. `operation: coverage` accepts that recipe through
`coverage-config` and uses the shared per-part and aggregate measurement rules.
The CI gate requires each part to be complete and exact; local AI can assess
honest partial or unavailable measurements. There is no consumer-side report
merging. Legacy single-report inputs remain supported.

## Trust and permissions

Keep test execution and privileged review in separate jobs. Contributor code runs
on disposable read-only PR runners with no secrets. Assessment and gating must
check out only the protected base branch; configuration, README, and repository
contract files are read from that trusted checkout. PR patches, source, commit
messages, and tickets are untrusted evidence and never executed by the reviewer.

The `assess` job needs actions/contents/pull-requests/issues read permissions and
the repository's `DEEPSEEK_API_KEY`. `gate` needs contents/pull-requests/issues/
actions write permissions and must receive no provider key. Pass the
assessment output between jobs. The action cannot elevate the caller's token.
Version 1's shared model is `deepseek-flash`; changes are sent to it only after
technical verification succeeds. It assesses repository fit and supported intent,
including large test improvements. There is no file-count or line-count approval
cutoff. New product decisions and unclear scope require the owner’s judgment.
A missing or token-truncated provider completion is retried within the same
read-only assessment, using the identical evidence, at most three attempts total.
Retries wait one then two seconds. The output budget starts at 4,096 tokens and
doubles only after a token-limit truncation, capped at 16,384 tokens per request.
Every request retains its 90-second timeout. Fixed attempt/outcome/token-budget
categories are logged without model text, reasoning, patches, or credentials.
A complete verdict stops retries immediately, including second opinions,
integrity rejections, and invalid or wrong-revision evidence. HTTP failures,
network/decoding errors, unknown terminal finish reasons, and exhausted retries
fail closed and require a second opinion. The provider health probe is unchanged. AI must also support test integrity with evidence about assertions
and failure cases. Detected test fakery blocks approval, including after an intent
confirmation. Coverage percentages alone cannot satisfy that assessment. No numerical confidence score grants approval.

`sensitive_paths` lists additional paths the consumer explicitly protects with
owner confirmation. The example leaves it empty; ordinary test, dependency,
and infrastructure paths are assessed by AI rather than rejected by filename.
The configured verification workflow, review controls, and repository-purpose
contract remain protected. Their changes still receive an AI integrity assessment
and require explicit owner confirmation.

The native protected merge path requires active effective base-branch rules: strict required
checks for the configured verification job and native `approve-and-merge` job
from GitHub Actions, a fresh approving review, no deletion, and no force pushes. The installing
administrator must also verify no bypass actors. Repository auto-merge and Actions
approving reviews must be enabled for automatic merge. Runtime tokens do not get administration access.

Protocol v2 also supports explicit `"merge_mode": "manual"` in accepted base
configuration. Repository auto-merge must be disabled in this mode, including
for owner-authored PRs. Tests, exact coverage, review, source binding and
current-head code-owner approval for external contributors when CODEOWNERS is configured remain mandatory.
Available branch protection is still enforced. Only GitHub's specific HTTP 403
private-plan upgrade response, together with verified private visibility and an
unprotected branch, permits approval without host-enforced protection. Generic
permission failures, unavailable APIs, public unprotected repositories and
incomplete available rules fail closed. The summary states when GitHub cannot
enforce the checks; trusted maintainers must honor them before manually merging.
The controller never merges or dispatches deployment in manual mode.

This repository explicitly selects `"merge_mode": "automatic"` for strict owner-only automation:
CODEOWNERS must exist on the accepted base and the author must own every affected
path. The normal protected native flow is unchanged. On the exact unavailable
private-plan condition above, native repository auto-merge stays disabled while
the validated acceptance controller can atomically fast-forward the exact base
to the reviewed head, with paired source/base compare-and-swap and no force.
This supports same-repository branches with an up-to-date head only; other
contributions remain manual. Missing/stale reviews, failed full verification or
coverage, changed revisions and API errors cannot authorize that write. This is
controller-enforced delivery, not unavailable native branch protection. See
[the complete private-plan contract](docs/change-acceptance.md#controller-enforced-owner-merge-on-an-unavailable-private-plan),
including deployment-trigger limitations. Omitting `merge_mode` preserves the
existing native flow and optional CODEOWNERS behavior.

Manual decisions assign the PR to `manual_reviewer` and request that person's
review. Owner-authored PRs use assignment without an invalid self-review request.
The owner can comment `/approve-intent FULL_HEAD_SHA`; this confirms intent only.
An owner confirmation can carry the actual accepted requirement, rather than
leaving investigators to infer it from a revision alone:

```text
/approve-intent FULL_HEAD_SHA

Accepted purpose:
Describe the accepted outcome and its boundaries.
```

Clouseau authenticates the configured owner and current permission, binds the
literal requirement to that revision and revalidates it before writing. Ordinary
PR prose remains untrusted; every mechanism still earns its own justification.
An agent delegated to install an accepted scope may record these confirmations
on the owner's behalf through its repairs without repeated approval prompts.
All tests and exact coverage remain mandatory. Changes invalidate the decision.
The Actions bot cannot approve its own PR; it needs an independent human review.
First-time fork workflow authorization remains GitHub's responsibility.

The PR report starts with a plain-language decision, one conservative scorecard,
and one entry per causal technical finding. Each entry shows its consequence,
blocking score, affected area, evidence and required outcome. Reviewer
disagreements, product rework, missing evidence and owner decisions stay visible.
The lowest product scores across all material changes and both reviewers are
shown; unrelated good scores never compensate for a failing change. Optional
findings show expected benefit and optional priority without creating a blocker.

Expand **Scoring and evidence** for the unchanged formulas, every individual
grade and explanation, both independent reviews, persistent finding history and
immutable source excerpts. Large audits retain lossless evidence pages. Summary
formatting uses the already validated record and makes no model requests. A
review decision never claims that merge, deployment or live verification finished.

The display regression includes the actual public Palazzo #27 review, linked to
its immutable signed evidence. Its original comment contains 36,564 characters;
5,388 remain visible with evidence sections closed. The new overview contains
948 visible characters, over five times shorter, with the same approved
verdict, both reviewers' 100/100 product scores and no technical findings. This
is an offline display fixture, never a substitute for fresh review or CI evidence.

Version 2 additionally uploads `work/clouseau-acceptance*.json` as a run/attempt
bound artifact and downloads it into `work/` in the separate approval and repair
jobs. Select examiner, challenger and grader explicitly in `acceptance`; see
[the self-hosting configuration](.github/clouseau.json). `typesafe-key` is needed
only when the explicit Jev/DeepSeek grading route is selected. Failure never
silently changes that choice. A separate repair job receives an independent
author token through `repair-token`; Colombo reuses its existing deployment
token. Neither the approval job nor AI inspection receives that author token. The repair
job requires a trusted GitHub head repository matching the base repository before
loading the author credential; the writer independently rechecks that identity.
Only purpose/authority decisions can use owner confirmation in version 2.

The consumer must retain PR, metadata-only target, comment, and manual workflow
entry points and PR-level concurrency. The controller validates the exact latest
PR-event run, revision, verification job, and named steps from configuration.
The read-only `assess` job waits for the PR verification run to finish before
calling AI. Allow 70 minutes for this job when verification can take 60 minutes.
The separate native job named `approve-and-merge` calls `gate`; it must run on
`pull_request_target` and fail if assessment fails, intent is missing, integrity
is rejected, or technical evidence is incomplete. Use `always()` with `needs`
so a failed assessment cannot silently skip the required gate. In other event
contexts, use a different job name to avoid a skipped duplicate required check.
The `native-gate` and `wait-for-verification` action inputs default to `true`.

The native job summary preserves detailed reasons; no additional API check is
created in native mode. A `GITHUB_TOKEN` API check can attach to another run's
suite and is insufficient as the required approval result for this flow. Comment/manual handlers call
`request-reassessment` with actions write and contents/pull-requests read access;
they rerun the current revision's existing `pull_request_target` run. Its test job
is skipped, so confirming intent does not rebuild the container. The handler
validates maintainer permission and exact comment SHA before requesting a rerun.

Run `finalize` in a separate job after the native gate succeeds, with actions
write and contents/pull-requests read access and no provider key. Auto-merge must
wait for the required gate job to finish, so deployment handoff cannot run inside
that gate. A provider diagnostic remains read-only and never approves a PR.

`deployment` is either `null` or an explicit workflow and path list. For a bot
merge touching those paths, Clouseau dispatches that existing workflow because
`GITHUB_TOKEN` merges suppress push-triggered workflows. It verifies main still
points at the merged revision. Deployment health, staged rollout, smoke tests,
bake windows, and ticket closure remain separate delivery work.

## Development

```sh
node --test src/*.test.cjs
```

Clouseau's own CI also requires exactly 100% line and branch coverage across
all production JavaScript modules. New source files are included
even when no test imports them. Test code is outside the production scope;
there are no exclusions for production failure paths or rounded thresholds.

To run the same gate locally with Node 22:

```sh
./scripts/verify-coverage
```

Clouseau needs only Node. One integration test runs a fixture Python application
under real coverage.py to prove the `coveragepy` adapter against live output, so
install `requirements-test.txt` (coverage.py 7.13.0) to run the whole suite. The
coverage gate itself is `bin/coverage-gate.cjs`
(`check REPORT SOURCE_DIRECTORY [llvm|istanbul|coveragepy]` or
`plan ACCEPTED_CONFIG [DIRECTORY]`), so reviewing a Python application requires
Python only for that application's own tests.

Successful native Node runs print compact outcomes and retain complete same-run
traces with per-run hashes; see [native verification traces](docs/native-verification.md).

CI also exercises the packaged composite action and verifies both passing and
failing coverage reports. No provider credential is needed for regression tests.
The new repository's wiki is not initialized; operational documentation lives
here until a wiki is available.

## Live model evaluations

The `evaluate-review` operation calls the real provider with three committed
synthetic review contexts. Maintenance must qualify, unrelated product scope
must request an owner decision, and test-specific validation bypasses must block
approval. A wrong or unavailable decision fails the evaluation. The GitHub and
technical-readiness inputs are fixtures; these evaluations validate model judgment,
not actual test execution or an end-to-end PR merge. The maintenance case injects
one synthetic truncated completion before calling the real provider to verify
automatic recovery within the same assessment. Logs identify that injection
explicitly; it is not evidence of a naturally occurring provider outage. Controller regression tests
use simulated provider decisions separately. Run live evaluations only in a
read-only diagnostic job with the provider key and no repository write token.

## Wiki maintenance after deployment

The [shared wiki policy](policy/wiki-maintenance.md) grounds documentation in the
exact deployment source revision and current wiki. A read-only job plans the
complete page set, generates each page against that common plan, validates links
and navigation, and independently fact-checks every proposed page, including
retained claims. Existing wiki prose can be stale; production control flow takes
precedence. The full bundle must pass before it becomes a publishable artifact.

Planning and writing use DeepSeek Flash; the independent factual checker uses
DeepSeek V4 Pro with low reasoning effort; Flash uses non-thinking mode at
temperature zero. DeepSeek's
[beta strict function-return format](https://api-docs.deepseek.com/guides/tool_calls/)
provides separate schemas for planning, the exact requested page, and factual
review. The sole return name is `wiki_result`. Its arguments are parsed as data;
no model-selected function is executed. Plain-text answers, unknown return names,
multiple returns, and incomplete results fail closed. The factual checker uses
automatic tool choice because the provider forbids forced choices in thinking
mode; a plain answer still fails validation. Token truncation retries
use identical evidence and schemas, at most three attempts with 4,096/8,192/16,384
output tokens and 90-second deadlines. PR review keeps its existing API and
reasoning policy.

Each page receives a dedicated factual audit with the complete source map and
the other proposed pages for consistency. The combined factual report is a fixed
checklist keyed by the planned pages. Each page
has one source reference, a findings string limited to 2,000 characters, and a
supported verdict emitted last. Every page must be supported with no unresolved
findings; contradictory verdicts are rejected. This avoids unbounded evidence
arrays while retaining an independent judgment for every updated page.

Source references select controller-assigned `path:Lnumber` IDs. The native
response schema restricts paths to actual source filenames; shortened basenames
are not accepted. The source map preserves exact lines, including blanks.
Local validation rejects invented IDs, blank citations, and missing page checks.
The model cannot substitute quotation text.
This is an AI quality gate rather than a proof of semantic correctness;
documentation still needs correction when new evidence reveals an error.

A rejected factual draft may receive up to three correction passes from actionable findings.
Only pages with findings are regenerated; other page bytes are preserved. The
complete corrected batch must differ, pass structural/link validation again,
and receive a fresh supporting factual verdict. No previously rejected text is
resubmitted, including cycles between drafts. Missing findings or an exhausted
correction budget stops publication. The
read-only `evaluate-wiki` operation disables correction and calls the real model
on supported authentication and shared-refresh documents plus deliberate
denial/unavailability and FTP-only-refresh falsehoods. Provider, schema, or citation failures cannot count as a successful
negative result.

Live evaluation case diagnostics are saved at `wiki-plan.json.evaluation.json`,
including when a positive or negative control fails. Structured generation
diagnostics are saved beside the plan at
`wiki-plan.json.diagnostic.json`. Rejected planning values are retained before
any generation. Factual diagnostics contain each reviewed draft, findings, and
its immutable source-line map. Consumers should upload diagnostics even when
planning fails. No provider credentials or raw transport bodies are stored.

A separate publisher receives no model key or deployment credentials. It downloads
only its own workflow run's artifact and independently verifies the repository,
source SHA, wiki base SHA, run ID, and the expected main workflow's completed
successful deployment job. Draft generation can skip deployment verification;
publication never can. Generation needs `actions: read` and `contents: read`.
Only publication needs `contents: write` and a Git-authenticated wiki checkout.

Consumer `.github/clouseau-wiki.json` specifies every field explicitly:

```json
{
  "version": 1,
  "source_paths": ["README.md", "src/", "migrations/", "Dockerfile", "compose.yaml", "Makefile", "scripts/", ".env.example", ".github/workflows/"],
  "deployment_workflow": "backend-deploy.yml",
  "deployment_job": "deploy",
  "wiki_branch": "master"
}
```

Only committed text in those paths is read. Real `.env` files and agent-rule paths
are refused; wiki agent instructions are excluded from model context. The wiki
must be a clean, initialized Git checkout. Pages are flat Markdown filenames,
including Home, `_Sidebar`, and `_Footer`; the model cannot change configuration,
edit `AGENTS.md`, or delete pages. Local limits are twenty pages, 128,000 bytes per
page, 512,000 bytes per bundle, 300 source files, and 1,000,000 bytes per complete
request. Nothing is silently truncated. Unsafe paths, duplicate/ambiguous names,
broken internal links, orphaned new pages, unsupported link syntax, and unclosed
code fences fail validation.

Publication uses a private temporary Git index, never model-directed filesystem
writes. All pages and the `.clouseau-deployment.json` source/run receipt form one
commit. A changed remote wiki base or rejected non-force push publishes nothing;
concurrent human edits are never rebased or overwritten. A repeated source SHA
is idempotent. A new revision with no Markdown changes records a truthful audit
receipt. Serialize deployment and documentation together to prevent a later
release from overtaking documentation. Documentation failure leaves the completed
deployment intact and makes the workflow fail visibly; it does not roll back or
claim external service health, running image bytes, or terminal upload delivery.


### Review reliability and provider qualification

Reviews retain fixed/dismissed findings across pushes and explicitly inventory
inspected, excluded and missing evidence. Missing material context prevents
approval. When protected-base CODEOWNERS exists, protocol v2 enables automatic merge only for code-owner-authored PRs;
other contributions require current-head code-owner approval and manual merge.
Confirmed absence leaves that ownership gate inactive; existing invalid files or
unavailable ownership evidence still block. Other acceptance gates are unchanged.
See [the review contract](docs/change-acceptance.md#review-convergence-and-completeness).

The frozen qualification corpus in `test/acceptance-cases.cjs` includes clean
maintenance, a real executable zero-body regression, product drift, unnecessary
machinery, deceptive tests, a dismissed false allegation and unavailable material
context. Each case has an expected disposition and an evidence-based rationale.
A blocking verdict on an unrelated issue does not qualify the known-defect case.

`node test/evaluate-acceptance.cjs` performs live judgment qualification using the
existing provider credentials and routes. `CLOUSEAU_EVALUATION_GRADERS` selects
`deepseek`, `typesafe` or `routed` (comma-separated for comparisons). Optional
`CLOUSEAU_EVALUATION_CASES` selects named diagnostic cases; such a partial run does
not qualify a replacement. Output records the corpus and protocol fingerprints,
selected cases, route, literal evidence, responses and bounded request usage.
At most 64 provider requests, including historical replay usage, are permitted.
Completed negative decisions are retained, never retried to seek approval.

Recorded-response tests exercise transport parsing, validation, history and
scoring without calling a model. They are deterministic software evidence,
not evidence of a replacement model's review quality. Provider changes require
a complete live corpus qualification against the same frozen inputs and expected
outcomes; no provider is switched automatically by these tests. Replay is allowed
only for unchanged source/policy/routing inputs and is labeled separately from
new live calls. Qualification fixtures do not establish a genuine PR merge.
