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
The controller accepts only selectors for the frozen bank and acknowledges a
delivery only after a completed authenticated invocation. A citation spanning
pages requires all its literal bytes. An empty source also requires its actual
empty-page delivery. A manifest alone is not inspection.

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
controller without changing submitted facts.

The complete signed receipt remains limited to **3,000,000 UTF-8 bytes**. Paging
does not remove source or history from the signed record, raise that limit or
change signature, source/base/policy/configuration/engine/author/expiry/revocation
bindings. CI duplication and large-record transport are tracked separately in
[#66](https://github.com/gaulatti/clouseau/issues/66). An oversized receipt or CI
record must hold approval rather than omit evidence or fall back to paid AI.

Deterministic controller and native-collection tests establish protocol behavior,
not model comprehension. Real authenticated Codex/Claude and selected central
provider qualification against the frozen large consumers is required by
[#65](https://github.com/gaulatti/clouseau/issues/65); this implementation checkpoint
has not completed that qualification. It is not a shipped acceptance claim.
