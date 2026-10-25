# Complete large-source review

New local and central collection selects the immutable source-bank protocol when
a source exceeds 300,000 UTF-8 bytes, serialized evidence exceeds 500,000
characters, or a changed source contains only whitespace or is empty. Small
ordinary snapshots retain their existing review route. Revalidation never adds
the source-bank flag to an older signed snapshot or changes its digest.

The bank retains complete source, patch and change-context text. Its inventory
binds each source ID, path, revision, authority, kind, byte count, SHA-256 and line
count. Patches and context have their own entries. UTF-8 pages preserve every
byte, including a BOM, empty files and lines longer than a page. GitHub source
that exceeds the Contents inline limit is read from its exact native Git blob;
metadata size, object hash and complete bytes must agree. Invalid UTF-8, binary
data, truncation and substituted blobs fail collection.

Each independent examiner and challenger receives the inventory and asks for
bounded pages through parsed responses. It receives no other role's findings.
Entry numbers and page indices are zero-based: an entry with `page_count: 1`
has only `page: 0`. Every prompt includes an exact valid selector example.
Each role also receives its controller-recorded delivered selectors and current
literal pages so a fresh continuation can identify unread material.
The controller lists the remaining required selectors and restricts the response
schema to sources whose full bytes are available, including the current literal
pages. It withholds satisfied completeness until all required pages are available.
Current pages enter the acknowledged journal only after the invocation completes.
Honest missing-source and unresolved reports remain possible.

The factual source inventory has one required object slot for every exact
`source_index`, including verification, requirement and excluded material. Each
slot contains its disposition, reason and proof IDs. The controller rejects an
omitted, invented or substituted slot; it never fills missing judgments itself.
The controller accepts only selectors for the frozen bank and acknowledges a
delivery only after a completed authenticated invocation. A citation spanning
pages requires all its literal bytes. An empty source also requires its actual
empty-page delivery. A manifest alone is not inspection.

Factual file accounting likewise has one required object slot per exact changed
path, containing its submitted unit IDs, reason and direct source proof IDs.
The controller restores only the path selected by that key; omitted, invented or
extra path fields fail rather than receiving a generated judgment. Ordinary
small-snapshot reports keep their existing array representation.

Each continuation places all retained own history before its current proof
catalog, unread selectors and literal pages. The final `pages` field is the
current invocation's actual source, not a request that must be repeated before
it can be read. Earlier observations remain hypotheses to check against those
bytes; neither their repetition nor a repeated page delivery establishes
semantic completeness. Reinspection retains the existing delivery budget.

Inventory entry numbers select pages; source-proof IDs select actual source
intervals. Patch and context entries have no source-proof IDs of their own.
Provisional concerns select only source proofs supplied in the current frame;
a frame containing only patches/context requires an empty concern array.
Questions suggested by a patch remain in the raw observations while the role
requests the corresponding base/head source pages. Earlier causal concerns stay
in that role's immutable history and need not be repeated on every frame.

Final report citations select from an explicit bounded `citable_proofs` catalog:
the first available proof of each read source, proofs in current literal pages,
every earlier structured citation, and exact known proof IDs bookmarked in that
role's observations. Text bookmarks select existing controller IDs only; they
never create an alias, supply missing bytes or grant authority to an observation.
Every selected proof's complete byte span
must be available to that role, including any current pending pages. The schema
offers those exact IDs, so patch entry numbers cannot become source citations.
If a later cross-file question needs another line range, re-request its source
page; the bank still retains every original byte and all earlier observations.
The catalog is limited to 100,000 UTF-8 bytes and fails intact on exhaustion.

Before claiming complete review, the role must have received every changed
base/head source, patch, change-context entry and trusted contract/verification
entry. Inspected optional sources and dependencies require complete delivery too.
Exclusions still need cited justification. Independent semantic grading compares
the material-source inventory with the trusted inspection requirements; delivery
history is supporting evidence, not proof of understanding.

Every role retains its raw structured responses, provisional concerns, completed
reports, source-bank epochs and delivery provenance. Adding immutable source
invalidates the bank and requires fresh inspection of required material. Earlier
concerns must retain their causal identity or receive explicit current-source
counterevidence. Receipt and protected-write validation replay this history,
bind it to the owning role and actual invocations, and reject altered facts,
missing deliveries, borrowed role history or erased concerns. Grading can set
numeric bounds and apply the existing authority/completeness constraints; it
cannot rewrite factual observations or make missing evidence complete.

Grading uses reversible metadata tables with explicit columns and catalogs for
source indexes, full revisions, kinds and dispositions. Paths, reasons and proof
IDs are retained verbatim. Current delivery state is joined by source index;
historical epochs carry their validated bank/exposure digests in that grading
view. Full native banks, historical journals and model responses remain in the
signed record and undergo the original replay. This avoids repeating opaque IDs
and entire journals inside one atomic question while retaining literal cited
evidence, complete trusted contracts and the independent completeness rubric.

Repeated schema objects and choices share exact definitions without dropping
constraints or source slots. Native harness schemas use `$defs`; central strict
function schemas use the provider's documented
[`$def` and `$ref` form](https://api-docs.deepseek.com/guides/tool_calls/#ref-and-def).
Central function transport shares only complete object modules and leaves scalar
enum constraints inline at their fields. A real completed report returned IDs
outside a referenced scalar proof enum; keeping those choices inline avoids that
native reference boundary without changing the expanded schema. Local harness
schema compaction retains its existing shared scalar choices. Provider output
still undergoes independent controller validation; a native strict-schema claim
cannot authenticate an invented citation.

| Bound | Limit |
| --- | ---: |
| One native source | 2,000,000 bytes |
| One patch or context entry | 4,000,000 bytes |
| Complete serialized source bank | 16,000,000 bytes |
| Entries, including patches and context | 1,024 |
| One literal page | 32,000 UTF-8 bytes |
| Pages per response | 4 |
| Serialized page view / inventory | 300,000 / 200,000 bytes |
| Investigation prompt / local grading prompt | 900,000 bytes |
| Page deliveries per role inspection cycle | 128 |
| Additional-source batches per cycle | 8, each at most 8 paths |
| Complete inspection cycles | 2, only after new immutable evidence |

Growing the bank does not replenish page or source-request allowances. A
transition from an ordinary investigation retains its remaining source-request
allowance. Oversized grading batches split without dropping or grading a question
twice. An individual atomic question that still exceeds its transport bound is
rejected intact. Existing Jev packet limits and rubric/scoring rules remain.
Central strict function transport uses separate report, page-request and
source-request branches; inactive null/empty envelope fields are restored by the
controller without changing submitted facts. The validated native function name
is the sole discriminator; typed request arguments contain observations and that
function's payload fields directly. A page function receives `bank_digest`
and `pages`; a source function receives `request_sources`; an acceptance function
receives only the factual report fields, including its full summary. It needs
no separate progress observations after completing that report. The controller supplies the internal
report/page wrapper without changing any submitted field. It derives the constant internal
`kind` from the function name rather than requesting a second duplicate selector.
New provisional concern events use explicit `page_request_with_concerns` or
`source_request_with_concerns` variants with a required concern array. Plain
requests have no new concern event and cannot submit that field. Those variants
are unavailable on frames with no citable source proofs. Final acceptance uses
its complete factual findings/resolutions. Every earlier concern still requires
retention or explicit current-source resolution, regardless of the next function.
Local prompts describe their full response envelope; central prompts describe
only the selected typed function's active fields. A rejected typed response
retains its original function, complete raw/canonical arguments, usage and
request digest for diagnosis. It is not normalized into a passing response or
retried. Qualification failures also retain any native harness diagnostic.

The complete signed receipt remains limited to **3,000,000 UTF-8 bytes**. Paging
does not remove source or history from the signed record, raise that limit or
change signature, source/base/policy/configuration/engine/author/expiry/revocation
bindings. CI duplication and large-record transport are tracked separately in
[#66](https://github.com/gaulatti/clouseau/issues/66). An oversized receipt or CI
record must hold approval rather than omit evidence or fall back to paid AI.

Deterministic controller and native-collection tests establish protocol behavior,
not model comprehension. Delivered-source attack fixtures verify that contributor
instructions cannot promote immutable source authority or submit controller-owned
numeric grades. Real authenticated Codex/Claude and selected central
provider qualification against the frozen large consumers is required by
[#65](https://github.com/gaulatti/clouseau/issues/65); this implementation checkpoint
has not completed that qualification. It is not a shipped acceptance claim.

The existing owner-authorized replacement route freezes the guarded candidate's
SHA/digest in both assessment and write jobs. Generated `work/` acceptance
artifacts are ignored as runtime data, so downloading the native record does not
make that engine's Git checkout dirty. The unchanged engine hash and clean-source
checks still reject substituted, modified or unrelated untracked code; artifact
authentication and all technical/approval gates remain mandatory.

The read-only central qualification is an explicit `workflow_dispatch` input,
`qualify_large_sources`, available only to the repository owner in this repository.
It first requires native verification and then checks out the execution's exact
SHA. It uses the existing DeepSeek examiner/challenger and routed DeepSeek/Jev
grading with the normal production controller. No consumer PR runs this corpus.
The fixed public Alcantara revisions in `test/evaluate-large-sources.cjs` contain
85 changed paths, 107 base/head source entries and 2,308,455 raw source bytes.
Collection rejects changed counts or bytes, preserves native object identities,
and supplies the exact head file inventory as untrusted context for dependency
requests. Missing paths still fail closed; no substitute source is invented.

The dedicated run allows at most 256 actual provider requests and 45 minutes;
these bounds do not change the ordinary 64-request fixed-case qualification or
the review controller's page/source limits. It retains complete public snapshots,
responses, request metadata and failures in its run artifact. Provider headers
and credentials are never recorded. Its temporary Git clone is removed on both
success and failure. Local `node test/evaluate-large-sources.cjs collect`, `codex`
and `claude` use the same fixed public cohort from a clean committed checkout and
retain results under ignored `.clouseau-work/large-qualification-MODE/`.

Protocol completion requires both independent reports, every required literal
page, the complete source inventory, validated delivery history and completed
independent grading. It does not require or manufacture a positive verdict.
Consumer execution is explicitly unavailable; these diagnostic runs never sign
a consumer receipt, approve a consumer, merge or deploy it. Material semantic
completeness remains a separate, honestly recorded assessment.
