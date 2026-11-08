# Ticket refinement, execution and closeout: pilot design

Status: design only. This document implements nothing and changes no protocol.
It answers the first acceptance step of issues
[#60](https://github.com/gaulatti/clouseau/issues/60) (refinement),
[#61](https://github.com/gaulatti/clouseau/issues/61) (execution) and
[#62](https://github.com/gaulatti/clouseau/issues/62) (closeout): inspect the
current protocol, define the smallest pilot, and split the work. The three issues
are Backlog design issues; none of them moves to Todo until the owner has settled
the [Owner decisions](#owner-decisions) below. Their dependency
[#59](https://github.com/gaulatti/clouseau/issues/59) is closed; the consumer
installs it left blocked (colombo#22, palazzo#31) are not dependencies of this
pilot, which runs in this repository.

## What already exists (and is not rebuilt)

| Capability | Where | Fact the pilot relies on |
| --- | --- | --- |
| Requirement-bound local review | `docs/local-review.md` (agent-driven review), `src/local-review.cjs`, `src/local-agent.cjs` | `clouseau review --request-file FILE --agent claude` binds the requirement text into the signed record; at most two repair cycles per attempt (`skills/clouseau/SKILL.md`). |
| Signed handoff | `docs/local-review.md` "Signed handoff", `src/local-receipt.cjs` | `clouseau publish` creates the `clouseau-review/<nonce>` tag and a `clouseau-local-review:v1` marker for the ready PR body. |
| Linked tickets as evidence | `src/acceptance-sources.cjs` (`closingIssuesReferences`), `docs/change-acceptance.md` | Linked issue text enters the proof catalog as `ticket:N:ref`, as untrusted data; authorship grants no contract, execution or merge authority. Only closing references are loaded. |
| Authority | `docs/change-acceptance.md` "Owner decisions", `src/acceptance-controller.cjs` | Contract authority is the owner's exact-head `/approve-intent`; `CODEOWNERS` decides who may merge. |
| Protected merge | `docs/change-acceptance.md` "Code-owner merge authority", `src/merge-protection.cjs`, `src/private-owner-merge.cjs` | A merge is not delivery, deployment or ticket completion. |
| Post-merge handoff | `action.yml` operations `finalize`, `plan-wiki`, `publish-wiki`; `README.md` | The README states that ticket closure "remains separate delivery work". Documentation publication is keyed on deployment evidence, not on tickets. |
| Notices and causes | `docs/notices.md`, `src/incomplete.cjs` | A fixed-cause, retained-diagnostic vocabulary that ticket failures reuse instead of inventing prose. |
| Unattended triggers | `.github/workflows/clouseau-reconcile.yml` | Precedent for a schedule/`workflow_run` job that checks out only trusted main and never PR code. The pilot does not add one. |

Missing, in the issues' own terms: nothing reads a ticket against a readiness
contract (#60), nothing turns an authorized Todo ticket into a claimed, isolated,
reviewed PR (#61), and nothing compares acceptance criteria with merged evidence
(#62). The project's own status (Backlog/Todo) is read nowhere in this repository.

## Pinned contracts (the shared interface)

Every PR below is coded against these names and shapes, never against another
PR's diff. Changing one is a change to this document first.

1. **Ticket contract v1** (an issue body). H2 sections, exact titles:
   `Outcome`, `Acceptance`, `Dependencies`, `Authority`, `Out of scope`.
   `Acceptance` is a Markdown checklist; every item ends with exactly one
   evidence tag `{evidence: KIND}` where KIND is `file:PATH`, `test:PATH`,
   `check:NAME` (a GitHub check-run name on the merged revision) or `external`
   (deployment, runtime, a person; never satisfiable from repository evidence).
   `Dependencies` lists `OWNER/REPO#N` references or the single word `none`.
   `Authority` names who accepted scope and which unresolved decisions remain
   (`none` or a list). Claims in the body that are model inference rather than
   repository evidence are prefixed `Inference:`; unprefixed claims carry a path
   or link. Legacy tickets without tags are `unverifiable`, never guessed.
2. **Ready digest.** `sha256` of the issue body with line endings normalized to
   LF and trailing whitespace trimmed per line, lowercase hex. A ticket is ready
   for execution only while its current digest equals the digest recorded in the
   owner-posted marker `<!-- clouseau-ticket:ready:v1 digest=HEX -->`. Editing the
   body after readiness invalidates it.
3. **Project state.** Only `Backlog` and `Todo` are pinned. `Todo` is the only
   ready state. No other status is assumed to exist.
4. **Claim ref.** `refs/heads/ticket/N` (N the issue number, same repository).
   Creating it is the atomic claim: the GitHub ref-create call fails if it exists.
5. **Evidence report** `clouseau-ticket-evidence:v1`, a JSON file written outside
   the checkout (review cache `ticket/` directory): ticket number and digest,
   merged PR, merge SHA, per-criterion `{index, kind, verdict, proofs[]}` where
   verdict is `met`, `unmet` or `unverifiable`, plus an overall `closeable`
   boolean that is true only when every criterion is `met`.
6. **Markers.** `<!-- clouseau-ticket:ready:v1 digest=HEX -->` and
   `<!-- clouseau-ticket:closeout:v1 sha=FULLSHA -->` identify the only comments
   these protocols read or write.
7. **CLI names.** `clouseau ticket check N`, `clouseau ticket claim N`,
   `clouseau ticket request N`, `clouseau ticket verify N --pr M`. All default to
   read-only or draft output; nothing outbound happens without `--post` (or, for
   `claim`, the ref creation itself), and `--post` is a flag the caller must
   pass, not configuration.
8. **Pull request linkage.** Ticket PRs say `Refs #N`, never a closing keyword
   (see D7), and carry the ordinary `clouseau-local-review:v1` marker.

## #60 Refinement

**Problem (issue's terms).** Turn an idea plus repository evidence into an
implementation-ready issue: accepted scope and precedent found, humans asked only
about unresolved product or authority choices, observable acceptance criteria,
dependencies and verification stated, evidence kept distinct from inference.
Project state is authoritative and only Todo means ready. A genuinely ambiguous
idea must stay in Backlog until the ambiguity is settled. No implementation.

**Smallest pilot.** One agent-run procedure plus one deterministic check, no
service.

- Input: an idea (text or an existing Backlog issue number) and read access to
  this repository, its issues, PRs and docs.
- Procedure (`skills/clouseau/ticket.md`, a runbook installed with the existing
  skill directory, which `scripts/install-agent` links as a whole): research the
  code and history, write a draft body in ticket contract v1 to a local file,
  list the open questions with options and a recommendation, stop. The operator
  relays the questions; the agent revises after answers.
- `clouseau ticket check N|FILE` (read-only) validates a body against contract v1
  and prints `ready` or `not_ready` with fixed causes: `section_missing`,
  `criterion_untagged`, `criterion_not_observable` (empty or tag only),
  `dependency_malformed`, `dependency_open` (a listed dependency is still open),
  `decision_open` (Authority lists an unresolved decision),
  `claim_without_source` (unprefixed claim with no path/link). It also prints the
  ready digest. The check never judges quality; it decides only the mechanical
  readiness above.
- Output: a draft body file and, once the owner approves, an owner-posted
  edit plus ready marker. Moving Backlog to Todo is the owner's act in the
  Project (D2); the pilot only reports whether the check passes.
- Touchpoints: a new `src/ticket-contract.cjs` (pure parser/validator, no I/O),
  `src/cli-usage.cjs` (command listing, integrator PR only), `docs/notices.md`
  (cause names, with the validator PR). No change to `src/acceptance-*.cjs`:
  review semantics, scoring and the receipt compatibility fold
  (`policy/review-compatibility.json`) stay untouched.

**Out of scope.** Moving issue state automatically; any model-graded "is this
ticket good"; scheduling or a daemon; creating issues in other repositories;
editing the owner's issues without a go; Project fields other than Backlog/Todo;
implementation or deployment.

**Acceptance checks.**

- [ ] `ticket check` accepts a conforming fixture and rejects each of the seven
      causes with its fixed cause, in tests at the CLI boundary.
- [ ] The digest is stable across line-ending and trailing-space changes and
      changes on any content edit.
- [ ] A genuinely ambiguous real idea is run through the procedure: the draft
      lists an open decision, `check` says `not_ready` (`decision_open`), the
      issue stays in Backlog; after the owner settles the decision, `check` says
      `ready` and the owner moves it to Todo. Both states are retained as
      evidence (draft files, check output, issue and Project links).
- [ ] Exact 100% line and branch coverage and the existing CI checks pass; no
      review-compatibility declaration is needed because no review semantics move.

**Risks and mitigations.**

- Models invent confidence: the validator requires a source on every unprefixed
  claim and an `Inference:` prefix otherwise; the procedure forbids unprefixed
  claims without a link.
- Contract drift with real tickets: pin v1 here; later versions add a version
  line, never reinterpret v1.
- Edits after readiness: the ready digest invalidates a stale marker.
- Over-building into a planner: the validator is pure and small, the procedure is
  a document; no new orchestration.

**Proposed split** (independent, uncalled, any merge order).

- A1 `feat(ticket): add the ticket contract validator`: `src/ticket-contract.cjs`
  and tests; callable by nothing yet. Contract v1 and the cause names are the
  only shared surface.
- A2 `docs(ticket): add the refinement runbook`: `skills/clouseau/ticket.md`,
  refinement section. Names `ticket check` per the pinned CLI; runnable by hand
  before the command exists, since it only reads files.
- A3 integrator (wiring only): `clouseau ticket check` in the CLI table and usage;
  `skills/clouseau/SKILL.md` link to the runbook. No logic; any logic found goes
  to a new independent PR.
- A-closer: the pilot run on a real ambiguous idea, with evidence. Gated on
  production state (A1 and A3 on main), never on approvals.

## #61 Execution

**Problem (issue's terms).** Implement an authorized Todo issue from its own
requirements without a second prompt: claim atomically, isolate, honour
dependency blockers, run local Clouseau, fix findings, publish a genuine signed
receipt, then open a ready PR that merges through the unchanged protected path.
Failures leave actionable status and retained evidence, not duplicate agents,
repeated paid review or unchecked pushes. Deployment stays separately authorized.

**Smallest pilot.** Operator-invoked, one ticket, one attempt, inside an agent
harness. There is no scheduler, queue or daemon; "without a second prompt" means
the single instruction "run ticket N" is enough, not that an unattended trigger
exists (D1 and D4 cover widening).

Flow, each step with its failure behavior:

1. `clouseau ticket claim N` reads the issue and refuses (no side effect) unless:
   Project status is `Todo`; `ticket check` is `ready` and the current digest
   equals the owner-posted ready marker; every listed dependency is closed; the
   author of the ready marker is a repository owner (CODEOWNERS entry). Each
   refusal prints a fixed cause (`not_todo`, `not_ready`, `digest_stale`,
   `dependency_open`, `marker_untrusted`).
2. It creates `refs/heads/ticket/N` at the current base SHA. A ref that already
   exists is the answer "claimed by another run": print `already_claimed` with the
   ref's commit, exit non-zero, start nothing. No second agent is ever started.
3. `clouseau ticket request N` writes the requirement file from the issue body at
   the claimed digest (outside the checkout) so the review binds exactly what was
   authorized. Issue text is data; it cannot widen scope, authority or checks.
4. The agent implements in a fresh worktree on `ticket/N`, runs the repository's
   verification, then `clouseau review --agent ...` (existing flow, at most two
   repair cycles), `clouseau publish`, and opens a ready PR with the marker and
   `Refs #N`. Existing CI is unchanged: tests, exact coverage, receipt validation;
   paid hosted review runs only for an unstamped change, as today.
5. On any stop (refusal, failed verification, negative or incomplete review after
   the repair bound, receipt not verifying) the run writes a `blocked` draft
   comment naming the fixed cause and the retained evidence paths, and ends.
   Re-running needs the owner to release the claim (delete the ref), so a failed
   ticket cannot loop into repeated paid or full reviews.

Touchpoints: new `src/ticket-claim.cjs` (GitHub ref create plus precondition
reads, injected client) and `src/ticket-request.cjs` (pure body to request text
and digest); `docs/local-review.md` (one cross-link in the integrator PR);
`skills/clouseau/ticket.md` (execution section); `docs/notices.md` (causes).
The receipt, gate, owner-merge and finalize paths are consumed unchanged.

**Out of scope.** A trigger service or schedule; parallel multi-ticket dispatch;
dependency graph solving beyond "all listed dependencies are closed"; automatic
retry; changing review scoring, receipt format, signing trust or branch
protection; deployment, wiki publication, Project writes (the pilot leaves status
at Todo; it does not move it to a state this document has not pinned);
cross-repository tickets.

**Acceptance checks.**

- [ ] Each of the five refusal causes is produced from fixtures and creates no ref.
- [ ] Two concurrent claims of one ticket: exactly one creates the ref, the other
      prints `already_claimed` and starts nothing (tested with the injected client
      returning the real 422 shape).
- [ ] The request file's digest equals the ready marker's digest; editing the body
      between claim and request is refused.
- [ ] One real ticket goes from Todo to a merged PR through the unchanged
      protected path with a genuine signed receipt, with no second implementation
      prompt and no `/approve-intent` for an ordinary (non-protected) change.
      Evidence: ticket, claim ref, receipt tag, PR, CI run and merge links.
- [ ] A forced failure (a ticket whose change fails verification) ends with a
      `blocked` draft, retained evidence, no PR, and a second invocation refused as
      `already_claimed`.
- [ ] No paid hosted review is requested on the success path; exact coverage and
      existing checks pass; a merge alone is not reported as deployment.

**Risks and mitigations.**

- Issue text as injection: it is data; the review's scope gate and the ordinary
  protected-path rules apply; protected review controls still need `/approve-intent`
  and the ticket cannot grant it.
- Duplicate agents: the ref create is the single serialization point.
- Runaway cost: free local harness only; the existing two-repair-cycle bound and
  three-attempt answer bound apply; one claim per ticket until the owner releases.
- A ticket whose change touches protected controls cannot complete unattended:
  `claim` does not predict this; the existing `receipt_protected_controls` stop
  surfaces it and the run ends `blocked` (documented, not worked around).
- Stale base: the existing `clouseau refresh` flow handles it; not reimplemented.

**Proposed split** (all this repository, uncalled until the integrator).

- B1 `feat(ticket): add the ticket request builder`: pure `src/ticket-request.cjs`
  and tests (body to request text, digest).
- B2 `feat(ticket): add the claim precondition and ref creation`:
  `src/ticket-claim.cjs`, injected client, tests including the concurrent-claim
  422 shape. Codes against the pinned digest, marker and ref names; imports
  nothing from A1 (it receives a ready verdict as input).
- B3 `docs(ticket): add the execution runbook`: execution section of
  `skills/clouseau/ticket.md`, including the blocked-draft template.
- B4 integrator: `clouseau ticket claim|request` in CLI and usage; SKILL.md link.
- B-closer: one real ticket run, gated on B4 and A3 being on main.

## #62 Closeout

**Problem (issue's terms).** Keep documentation publication separate from ticket
completion. Compare every acceptance criterion with immutable implementation,
test, CI and (only where authorized and required) deployment evidence. Leave the
ticket open when any criterion or external boundary is unverified. Close only with
links proving the outcomes; a green build, a merge or a generated wiki is not
enough. Prove positive and negative cases without waiving scope, security or
exact coverage.

**Smallest pilot.** A deterministic, read-only evidence report, then a draft
closeout comment. No model is involved: contract v1 gives every criterion a
machine-checkable evidence tag, so the verdict is computed, not judged.

`clouseau ticket verify N --pr M` reads the issue, the merged PR and its merge SHA
and, per criterion by tag:

- `file:PATH` met when PATH exists in the merge SHA's tree (permalink recorded);
- `test:PATH` met when PATH exists at the merge SHA and the repository's
  verification passed there: a successful `verify` check run on the merge SHA, or
  the receipt-attested verification (`docs/local-review.md` "Receipt-attested
  verification") that CI accepted for the exact head;
- `check:NAME` met when a check run of that name concluded `success` on the merge
  SHA, and no later check run of that name on the same SHA failed;
- `external` always `unverifiable` unless D6 supplies an authorized source.

The overall verdict is `closeable` only when the PR is merged, the PR head equals
the head the gate approved, the issue digest equals the digest at claim, and every
criterion is `met`. Otherwise it lists the unmet or unverifiable criteria and the
ticket stays open. The report and a draft comment (the `closeout:v1` marker, each
criterion with its proof link) are written locally. Closing is not performed by
the pilot (D5).

Touchpoints: new `src/ticket-evidence.cjs` (pure, takes fetched issue/PR/check
data; a thin fetch wrapper reuses `src/pull-read.cjs` patterns), `docs/notices.md`
causes (`criterion_unmet`, `criterion_external`, `head_mismatch`,
`issue_edited`, `pr_not_merged`), `skills/clouseau/ticket.md` closeout section.
`finalize`, `plan-wiki` and `publish-wiki` in `action.yml` are not touched; the
report never reads wiki output as evidence.

**Out of scope.** Closing issues; deployment or runtime verification, beta/gamma
or production traffic progression (issue says theoretical); model-graded
criteria; reopening; waiving, lowering or reinterpreting any gate; wiki content as
evidence; multiple PRs per ticket (one PR in the pilot).

**Acceptance checks.**

- [ ] Positive: a fixture ticket whose every criterion is `met` yields
      `closeable: true` with a proof link per criterion.
- [ ] Negative, each its own test at the report boundary: a green merge with one
      criterion unmet; a `check:` that concluded `failure`; a `test:` file absent
      at the merge SHA; an `external` criterion; PR head differing from the gated
      head; issue edited after claim; PR not merged. Each yields not closeable
      with its fixed cause.
- [ ] A real merged ticket from #61's closer produces a report and draft; the
      owner reviews it; the ticket's open or closed state afterwards matches the
      report.
- [ ] Output never contains secrets, receipt keys or private source beyond links.
- [ ] Exact 100% line and branch coverage and existing checks pass.

**Risks and mitigations.**

- Mistaking a green build for acceptance: `check:` and `test:` verdicts require
  the named artifact, not an overall green status.
- Retroactive tag edits: the digest at claim is compared; the merge SHA tree is
  immutable.
- Late or flaky checks: the report states which check runs it read and at what
  time and never infers success from absence.
- Premature closure by a human reading a draft as final: the draft states
  "not closed by Clouseau" and carries the marker only.

**Proposed split.**

- C1 `feat(ticket): add the ticket evidence report`: `src/ticket-evidence.cjs`,
  fixtures and tests for the positive and every negative case. Codes against
  contract v1 and the report schema above only.
- C2 `docs(ticket): add the closeout runbook and draft template`.
- C3 integrator: `clouseau ticket verify` in CLI and usage; SKILL.md link.
- C-closer: closeout of the real #61 pilot ticket, gated on production state.

## Ship order and cross-repository work

One task is one repository. Everything above is `gaulatti/clouseau`. A1, A2, B1,
B2, B3, C1 and C2 are mutually independent and may merge in any order; each lands
uncalled. A3, B4 and C3 are the per-lane integrators (wiring and usage only). The
closers are gated on main state. Nothing activates on merge: no workflow, schedule,
action input or configuration changes, and no existing command's behavior changes.

Separate tasks in other repositories, each its own ticket with this order:

1. After A1 is on main: a consumer adds an issue template that matches contract v1.
   This is a production no-op (a template file) and the first consumer task.
2. After A3, B4 and C3: a consumer pilot run. Colombo or palazzo according to D1.
3. Optionally, bastille: a managed-rule sentence pointing agents at the runbook.
   Private access must never block consumer agents; this is last and not required.

## Owner decisions

These are policy; this document does not decide them.

- **D1 Pilot venue.** (a) This repository's own tracker; (b) colombo; (c) palazzo.
  Recommend (a): no cross-repo dependency, one task one repo, and consumers
  follow after the commands exist.
- **D2 Who authorizes execution.** (a) Todo alone; (b) Todo plus an owner-posted
  ready marker on the exact digest; (c) Todo plus issue authored by a CODEOWNERS
  owner. Recommend (b): Todo is a mutable Project field, the digest ties
  authorization to the text that was read.
- **D3 Claim mechanism.** (a) A remote ref `ticket/N`; (b) a local lock file
  (single machine only); (c) assignee/label (not atomic). Recommend (a): the
  branch must exist remotely for the PR anyway and creation is atomic.
- **D4 Cost and attempt policy.** (a) Local harness only, existing two repair
  cycles, one claim per ticket until released; (b) allow one automatic re-claim;
  (c) allow paid hosted review on failure. Recommend (a); (c) is excluded because
  the issue forbids repeated paid review.
- **D5 Who may close issues.** (a) The pilot never closes; the owner or the
  coordinator closes after reading the report and draft; (b) the operator
  closes with `--post` after an owner go; (c) automatic when `closeable`.
  Recommend (a) for the pilot, (b) after the first clean positive and negative
  runs; (c) is not recommended before several real runs.
- **D6 Deployment and runtime criteria.** (a) Always `unverifiable`, ticket stays
  open; (b) accept an owner-named workflow run plus health check as evidence.
  Recommend (a): no deployment source is authorized by these issues.
- **D7 Closing keywords.** (a) Ticket PRs use `Refs #N` and closing is separate;
  (b) allow `Fixes #N` so GitHub closes at merge. Recommend (a): (b) defeats
  #62 (a merge would close the ticket). Consequence: the PR does not enter the
  linked-requirement catalog (`closingIssuesReferences`), so the ticket text
  reaches review through the receipt's requirement file; an unstamped fallback
  for ticket PRs would need a follow-up change to review evidence loading
  (and a review-compatibility fold) and is deliberately not in the pilot.
- **D8 Outbound writes by the tool.** (a) Draft-only: comments, ready markers
  and `blocked` notices are written locally and posted by the owner or the
  coordinator after a go; (b) `--post` per action after an owner go. Recommend (a)
  for the pilot (consistent with the standing rule that nothing leaves the
  machine unreviewed); (b) later.
- **D9 Contract strictness for legacy tickets.** (a) v1 applies forward only;
  older tickets are `unverifiable` at closeout; (b) retro-tag existing open
  tickets. Recommend (a).

## Readiness of the three issues

After the owner answers D1 to D9, each issue's own checklist can be completed by
recording the answers (trigger: explicit operator command; authority: D2; failure
behavior: the fixed causes above; cost and retry: D4; acceptance: the checklists
above; dependencies: #59 closed, A1 before the first closer) and linking the PRs
above. Until then they stay in Backlog.
