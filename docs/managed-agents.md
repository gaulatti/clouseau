# Opt-in exemption for the managed-standard `AGENTS.md` update

`AGENTS.md` is a protected review control, so the agent-standard updater commit
(`chore(agents): sync managed rules and skills to <sha>`) is held for the owner's
exact-head `/approve-intent` confirmation. Unattended repositories stall on every
central bump. `managed_agents` is an **opt-in, default-off** protected-configuration
field that lets a change to `AGENTS.md` skip that hold when, and only when, the
change is verifiably the central managed block and nothing else.

## What the engine can and cannot verify

The updater records no snapshot identity in the repository: `.agents/skills/.bastille-managed`
lists skill names, and the central commit appears only in the updater's commit
message, which is contributor-controlled text. The central standard repository is
private, and the engine has no verified access to it. There is therefore no central
source the engine can read; the only input it can verify is a digest that the owner
enrolled in the protected configuration on the base branch.

## Configuration

```json
"managed_agents": {"digests": ["<sha256 hex of the managed block>"]}
```

One to 64 distinct lowercase SHA-256 hex digests, valid in protocol versions 1 and 2.
Anything else (unknown keys, empty list, duplicates, uppercase, wrong length) fails
configuration validation. Unset, no code path runs and behaviour is byte-identical.

The digested bytes are the managed block exactly as the updater writes it: the line
`<!-- BEGIN BASTILLE MANAGED RULES -->` through the line
`<!-- END BASTILLE MANAGED RULES -->` inclusive, each line ending in `\n`:

```sh
awk '$0==b{i=1} i{print} $0==e{i=0}' b='<!-- BEGIN BASTILLE MANAGED RULES -->' \
  e='<!-- END BASTILLE MANAGED RULES -->' AGENTS.md | shasum -a 256
```

Enrolling a digest is a change to `.github/clouseau.json`, itself a protected control,
so the owner confirms it once, before or with the first bump that uses it. Each later
central snapshot needs its digest enrolled before its sync PR can skip the hold; until
then that PR is held exactly as today.

## The rule

A PR's `AGENTS.md` change is not a protected-control hold only if the base and head
files, read at the PR's immutable base and head SHAs (the head from the head
repository), satisfy all of:

1. the status is `modified`, with no rename (added, removed and renamed files hold);
2. each file contains exactly one `BEGIN` line and one `END` line, in that order,
   each matching the marker byte for byte as a whole LF-terminated line;
3. the head block's SHA-256 is an enrolled digest;
4. every byte before the head `BEGIN` line and after the head `END` line equals the
   same region of the base file.

Everything else holds as before: edits to local rules or any other byte outside the
block, partial or whitespace edits of the block, CRLF, padded or lowercase markers,
duplicate, nested, reordered or wrapped markers, an unenrolled snapshot, an
unreadable or oversized file. Every other protected path in the same PR (workflow,
`.github/clouseau.json`, the policy file, `sensitive_paths`) still holds. The
decision is recomputed from the file bytes at every assessment and again at the
gate, so a later push cannot ride on an earlier verdict. A transport failure is an
error, never a verdict.

## Where it applies

- Hosted assessment and the native gate (protocol versions 1 and 2), including the
  authenticated-receipt route: a verified receipt over an exempt update no longer needs
  `/approve-intent`.
- `clouseau review` and `clouseau publish`: the local protected-control warning is
  not printed for an `AGENTS.md` change that passes the same rule on the local base
  and head commits.

## Notices

When `managed_agents` is set and `AGENTS.md` changed, the job log (and the local
controller report) states either `AGENTS.md is not a protected-control hold: ... (sha256 <digest>)`
or `AGENTS.md stays a protected-control hold: <reason>`. Neither names file content.

## Out of scope

Reading the digest from the central repository, signed snapshots, exempting any other
protected path, and any change to receipt semantics.
