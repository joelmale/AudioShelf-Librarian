# Curator data flow

How a book moves from the AudiobookShelf library to a recommendation, and
what each stage may and may not assume about the data it receives.

This describes the system as built (Phases 0–3). For decisions and their
rationale see [`decisions.md`](./decisions.md); for the forward plan see
[`../librarian-engine-plan.md`](../librarian-engine-plan.md).

---

## The pipeline at a glance

```
AudiobookShelf
    │  sync.ts
    ▼
books ────────────────────────────────────────────────┐
    │                                                 │
    │  enricher.ts          POST /enrichment/run      │
    ▼                                                 │
external_metadata ──► book_entities                   │
    │                       (grounded allowlist)      │
    │                          │                      │
    │  tagger.ts               │  POST /tags/run      │
    ▼                          ▼                      │
  LLM propose ──► canonicalize ──► ground ──► derive  │
                       │                              │
                       ▼                              │
                   book_tags  (every row carries a `source`)
                       │                              │
                       │  bookCard.ts                 │
                       ▼                              │
                   card text ──► card_hash            │
                       │                              │
                       │  embedder.ts   POST /embeddings/run
                       ▼                              │
                book_embeddings ◄─────────────────────┘
                       │
                       │  queryBooks (hard filters) ──► ranker.ts (order)
                       ▼
                 recommendations
```

Five stages, each with a different trust posture. The through-line: **every
downstream stage can tell where its inputs came from**, because provenance is
carried in the data rather than assumed.

---

## 1. Sync — `core/sync.ts`

Mirrors the AudiobookShelf library into the local SQLite `books` table.
Carries `asin` and `isbn` through, which matters more than it looks: those
two columns are the join keys into every external dataset used downstream.

`sync_status` marks rows `active` or `deleted` rather than removing them, so
a book vanishing from ABS does not cascade-delete its tags and entities.

**Assumes:** nothing. **Guarantees:** every other stage can identify a book
by a stable ABS id, and usually by ISBN or ASIN as well.

---

## 2. Enrichment — `core/enrichment/`

`POST /enrichment/run` (`dryRun` / `sample` / `sampleSize` / `bookIds`).

Providers implement one interface (`enrichment/types.ts`) and are pure
fetch-and-parse — no database access, `fetchImpl` injected so tests never
touch the network:

| Provider | Keyed by | Yields |
|---|---|---|
| `openLibrary` | ISBN, else title+author with match verification | `person` / `place` / `time` facets, `subject` terms |
| `audnexus` | ASIN | Audible genre + tag names |

Results land in `external_metadata` as **whole `EnrichmentPayload` objects**,
not bare provider responses, so entity extraction can be re-run later without
re-fetching. Status is `ok` / `not-found` / `error`, and `not-found` is a
cached answer too — Open Library does not get hammered for books it has never
heard of.

`enricher.ts` then rebuilds each book's `book_entities` row set as a
case-insensitive union across **all** cached `ok` payloads, merging the
provider names into `sources`. Rebuilding from the cache rather than from
this run's results keeps the allowlist correct when only one of several
providers was due today.

**The critical output is `book_entities`** — the per-book allowlist of real
people, places, and times. Everything the tagger does with character and
setting tags depends on it.

**Assumes:** books exist. **Guarantees:** nothing about coverage. Open
Library resolves roughly half of a typical library and its `person` facet is
a *mention index*, not a curated cast list — it contains every proper noun in
the book's index, typos included. Treat it as an allowlist to validate
against, never as a tag source.

---

## 3. Tagging — `core/tagging/`, orchestrated by `core/tagger.ts`

`POST /tags/run`. One LLM call per book, then three deterministic stages.
Both the bulk runner and the MCP `retag_book` tool go through
`composeBookTags` so they cannot drift apart.

### 3a. Propose (LLM, generous)

`buildTagPrompt` asks for 15–30 tags across `genre`, `mood`, `theme`,
`pacing`, `audience`, `trope`, `structure`, `character`, `setting`. The
prompt shows the current vocabulary as *preference*, not constraint —
precision comes from the next two stages, so the model is allowed to be
imprecise here. It is **not** asked for `length` or `era`; those are
arithmetic (see 3c).

Trope tagging is prompted symmetrically — "tag notable tropes that ARE
present" — because negative filtering can only exclude what got tagged.

### 3b. Canonicalize — `tagging/canonicalize.ts`

Non-entity tags only. Per tag: normalize the surface form (camelCase split,
kebab-case), then in order —

1. exact vocabulary hit → `source: 'vocab'`
2. alias hit (`tag_aliases`) → `source: 'vocab'`, canonical form
3. stopword fold, retry 1–2 (`the-power-of-friendship` → `friendship`)
4. single-token uniqueness: if exactly **one** token of a multi-token tag is
   a vocabulary term, use it — two matches means ambiguity, and ambiguity
   never guesses
5. otherwise → `source: 'llm-open'`, normalized form kept

Unmapped tags increment `vocab_terms` proposed counts, which is what feeds
the promotion queue (`GET /vocab/proposed`).

### 3c. Ground — `tagging/ground.ts`

`character` and `setting` tags only, matched against `book_entities` via
`enrichment/entityMatcher.ts`:

- **hit** → canonical entity form, `source: 'external:<providers>'`
- **miss, allowlist has people** → **dropped.** This is the hallucination
  filter.
- **miss, no allowlist at all** → kept as `llm-open` only if the name appears
  in the book's description; else dropped
- **settings** never drop on a miss — `coastal-town` is a legitimate tag with
  no entity behind it

The matcher repairs before it rejects, but only on a *unique* hit:
`Ben Hannigan` → `Benjamin Hanscom`, while `Adrian Dover` is dropped rather
than guessed into `Adrian Mellon`.

### 3d. Derive — `core/derivedTags.ts`

`length` from `durationSeconds`, `era` from `publishedYear`. Confidence 1,
`source: 'derived'`, and they **win** their category over any LLM tag.

**Guarantees:** every `book_tags` row carries a `source`. Downstream code can
distinguish a vocabulary-canonical tag, a computed one, an externally
confirmed entity, and an unverified guess — which is the entire basis of the
trust rules in retrieval.

---

## 4. Card composition and embedding — `core/retrieval/`

`POST /embeddings/run`.

`bookCard.ts` composes one text blob per book: title, author, series,
canonical tags grouped by category, grounded entities, and a description
excerpt. **The tags are in the text on purpose** — a card that literally
reads `mood: melancholic, cozy` and `setting: coastal-town` is what lets an
embedding answer an abstract vibe query that no vocabulary anticipated.

`cardHash(text)` is stored alongside the vector. `db.getStaleEmbeddings()`
compares stored hash against freshly composed hash and returns books that
differ **or have no embedding at all** — one case, one selector. That is why
a vocabulary promotion (which rewrites many books' tags, and therefore their
cards) needs no event hooks: the next embedding run notices and self-corrects.

`embeddings.ts` holds `EmbeddingCreator` (injectable, mirroring
`llmClient.ts`'s `MessageCreator`, so tests use deterministic stub vectors),
an Ollama implementation, and `EmbeddingStore` — vectors loaded into one
Float32Array matrix, brute-force cosine, no index. At personal-library scale
that is sub-millisecond and adds no infrastructure.

**Assumes:** tags and entities are settled for a book. **Guarantees:** a
vector matching the current card, or none.

---

## 5. Retrieval — `db.queryBooks` → `retrieval/ranker.ts` → `findSimilar.ts`

Two engines with a strict division of labour:

**Structured filtering** (`queryBooks`) does all rejection. Multi-tag AND/OR,
entity filters, duration/series/year, and `excludeTags`. Hard filters run
*before* any scoring.

**Ranking** (`rankBooks`) does all ordering and never drops a candidate.
Score is a weighted sum of semantic cosine (0.55), confidence-weighted tag
overlap (0.35, with `llm-open` tags counted at half a trusted tag), and a
reception prior (0.10, neutral at 0.5 when unknown so unrated books are not
penalised). Soft-excludes demote rather than remove — that is how "not a
full-on thriller" works.

**`findSimilar`** returns embedding neighbours. Its `acrossGenre` mode drops
every candidate sharing a genre tag with the anchor as a set operation, so
cosine ranks the survivors on transferred structure — this is the mechanism
behind "the politics of The Expanse, but fantasy". `sharedTags` omits genre
so the caller can explain the match.

### Two invariants that must survive Phase 4

1. **`excludeTags` ignores `trustedOnly`.** Exclusions consider every tag
   regardless of provenance. Unverified evidence is weak grounds *for* a book
   and sufficient grounds *against* one. See `decisions.md` #6.
2. **Exclusion is only as good as tag coverage.** A book that was never
   trope-audited cannot be excluded by trope. The librarian is required to
   disclose this rather than imply certainty (plan §5.4, §8.6).

---

## Operations

Tagging, enrichment, and embedding are all the same operational shape —
`tagger.ts` is the reference, `enricher.ts` and `embedder.ts` clone it:

- a `p-limit` worker pool at configured concurrency
- an `OperationController` checkpoint before each item, so runs pause/cancel
- `dryRun` to report a plan without spending anything
- `sample` mode — `max(20, 5%)`, evenly spread — to QC quality before
  committing to a full library run
- per-item failure isolation: one book failing records an error and the run
  continues; successful work is never rolled back
- action-log events and a `sync_log` row

Anything long-running added later should clone the same shape rather than
invent a new one.
