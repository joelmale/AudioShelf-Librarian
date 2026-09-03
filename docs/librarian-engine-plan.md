# The Librarian Engine — Integration Plan

Goal: turn the curator module into a **knowledgeable librarian friend** — a
conversational recommendation engine over the user's real audiobook library
that can answer vibe queries, "if you like X" queries, situational queries,
and boundary-driven queries with grounded, trustworthy results.

This plan integrates the externally-validated findings (Open Library
person/place/time facets, OCLC FAST, LibraryThing Common Knowledge,
Wikidata narrative properties, Audnexus/AudiobookDB, Hardcover, UCSD Book
Graph) into the existing curator architecture.

---

## Status key

Section headings carry a marker. Sub-steps inside a ✅ section are struck
through when they shipped as written, and annotated instead when the
implementation deliberately diverged from the plan.

| | |
|---|---|
| ✅ | Shipped, tested, and on `main` |
| 🟡 | Partly shipped — the heading says which half |
| ⬜ | Not started |
| ⏸ | Parked by decision, not by dependency |
| ~~struck~~ | An individual sub-step that is done |

**Where the build actually is (2026-08-28):** Phases 0–3, 3.5, and the Phase 6
code milestone are done.
The Phase 4 library-only loop and supported follow-ons are implemented
and independently reviewed in the current worktree: the snapshot-only §10.C
acceptance harness, the retrieval-first Scout recommender with independently
verified iTunes lookup for external picks, and registry-backed MCP exposure of
the five librarian tools, plus restart-safe conversation threads, history,
follow-up turns, their bounded Desk consumer, honest audit disclosures, an
additive bounded candidate pile, and a collapsible action-only research trail.
They are not yet shipped on `main`. Phase 4 is not
accepted: Joel approved the ten human-readable query expectations on 2026-08-28,
but the harness has not been run on a real snapshot, stable expected IDs still
need to be encoded, and the real Key West ranking needs his judgment.
Unsupported richer Desk ideas are explicitly deferred until
their data contracts exist. Phase 5 has not started because the Phase 4 human
gate remains open. Phase 6 is implemented and independently reviewed against
synthetic temporary-library fixtures; no live realignment was run. Transcripts
remain parked pending the cheaper-source measurements.
See §7.

---

## 0. Where we are today (baseline) ⬜ *historical — describes the pre-Phase-0 state*

| Piece | State |
|---|---|
| Tagging | `tagger.ts` → single Haiku/Ollama call per book, 7 closed categories, ~7 tags/book. `agents/` orchestrator is a stub that duplicates API calls. |
| Vocabulary | Hardcoded sci-fi set in `tagQuality.ts` + prompt. OOV tags produce warnings nobody consumes. |
| Recommendations | `recommendations.ts` → one-shot LLM call over `buildTagSummary` (entire library serialized into a prompt), iTunes verification of external picks. This remained live on Scout & Acquire until the retrieval-first §10.L implementation in the current worktree. |
| Retrieval | Exact-match SQL over `book_tags` (`queryBooks` filters). No semantic layer. |
| Conversation | None. MCP server at `/mcp` exposes 14 tools (incl. `query_library`) to external LLM clients. |
| Identifiers | `books.asin` and `books.isbn` synced from ABS — join keys for every external source exist already. |
| LLM infra | `LlmClient` with injectable `MessageCreator`, Anthropic + Ollama creators, `FallbackMessageCreator`, rate limiting, typed errors. |

Key structural fact: **a personal library is small** (hundreds to a few
thousand books). This drives the biggest simplification in the plan: no
vector database, no ANN index. Brute-force cosine over in-memory Float32
arrays is sub-millisecond at this scale. Everything stays in SQLite.

---

## 1. Data layer (SQLite migrations) ✅ *A–D shipped; E is Phase 5*

Two tables arrived after this section was written and are not described
below: `tag_runs` (§10.A — what a tagging run *attempted*, so coverage can
say `unaudited` rather than a confident `absent`) and
`conversations`/`conversation_events` (§10.F). Both are additive.

All migrations append to the existing `schema_migrations` sequence in
`db.ts`. Ship order matters — each is independently deployable to a live DB.

### 1.1 `book_tags.source` (Migration A) ✅

```sql
ALTER TABLE book_tags ADD COLUMN source TEXT NOT NULL DEFAULT 'llm-open';
-- values: 'vocab' | 'derived' | 'llm-open' | 'abs' | 'external:<provider>'
```

- `vocab` — LLM tag that canonicalized onto a controlled term.
- `derived` — computed deterministically (length from `durationSeconds`,
  era from `publishedYear`). Never LLM output.
- `llm-open` — LLM tag with no external confirmation. Allowed in fuzzy
  discovery, **excluded from hard filters and negative guarantees**.
- `abs` — mirrored from AudiobookShelf genres.
- `external:openlibrary` etc. — confirmed by an enrichment source.

### 1.2 External metadata cache (Migration B) ✅

```sql
CREATE TABLE external_metadata (
  book_id     TEXT NOT NULL,
  provider    TEXT NOT NULL,            -- 'openlibrary' | 'audnexus' | 'googlebooks' | 'wikidata' | 'hardcover'
  payload     TEXT NOT NULL,            -- raw JSON, provider-shaped
  fetched_at  INTEGER NOT NULL,
  status      TEXT NOT NULL,            -- 'ok' | 'not-found' | 'error'
  PRIMARY KEY (book_id, provider)
);
```

Raw payloads are cached so enrichment is **re-processable without
re-fetching** — when the entity extractor improves, re-run it against the
cache. `not-found` is a cached answer too (don't hammer OL for books it
doesn't know).

### 1.3 Grounded entities (Migration B) ✅

```sql
CREATE TABLE book_entities (
  book_id    TEXT NOT NULL,
  entity     TEXT NOT NULL,             -- canonical form: 'Benjamin Hanscom'
  kind       TEXT NOT NULL,             -- 'person' | 'place' | 'time'
  sources    TEXT NOT NULL,             -- JSON array: ["openlibrary","wikidata"]
  PRIMARY KEY (book_id, entity, kind)
);
```

This is the **validation allowlist** for entity tags and a query surface of
its own ("what do I have set in Maine?"). Populated by enrichment, never by
the tagger directly.

### 1.4 Tag canonicalization + promotion queue (Migration C) ✅

```sql
CREATE TABLE tag_aliases (
  alias      TEXT PRIMARY KEY,          -- normalized raw form: 'the-power-of-friendship'
  canonical  TEXT NOT NULL,             -- 'friendship'
  category   TEXT NOT NULL
);

CREATE TABLE vocab_terms (
  term       TEXT NOT NULL,
  category   TEXT NOT NULL,
  status     TEXT NOT NULL,             -- 'seed' | 'proposed' | 'promoted' | 'rejected'
  book_count INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (term, category)
);
```

`vocab_terms` replaces the hardcoded `VOCABULARY` in `tagQuality.ts` (the
current set becomes `status='seed'` rows). The `outOfVocabulary` report
already computed by `validateTagQuality` becomes the **feed** for this
queue instead of a dead-end warning.

### 1.5 Embeddings + similarity edges (Migration D) ✅

```sql
CREATE TABLE book_embeddings (
  book_id    TEXT PRIMARY KEY,
  model      TEXT NOT NULL,             -- 'nomic-embed-text:v1.5' etc.
  card_hash  TEXT NOT NULL,             -- hash of the embedded card text → cheap invalidation
  vector     BLOB NOT NULL              -- Float32Array bytes
);

CREATE TABLE book_edges (
  from_book  TEXT NOT NULL,
  to_book    TEXT NOT NULL,             -- may reference a non-owned work (external key)
  relation   TEXT NOT NULL,             -- 'similar' | 'comparable' (readalike)
  score      REAL,
  source     TEXT NOT NULL,             -- 'embedding' | 'llm' | 'feedback'
  PRIMARY KEY (from_book, to_book, relation)
);
```

### 1.6 Feedback (Migration E) ✅ *shipped 2026-08-28*

```sql
CREATE TABLE rec_feedback (
  id          INTEGER PRIMARY KEY,
  book_id     TEXT,                     -- null for external recs
  external_key TEXT,                    -- 'title|author' for non-owned
  query_text  TEXT NOT NULL,
  verdict     TEXT NOT NULL,            -- 'accepted' | 'rejected' | 'finished' | 'abandoned'
  source      TEXT NOT NULL DEFAULT 'explicit',  -- 'explicit' | 'implicit'
  weight      REAL NOT NULL DEFAULT 1,  -- graded: see below
  created_at  INTEGER NOT NULL
);
```

Two columns arrived beyond the original sketch, and three more tables:

- **`source`** separates a deliberate thumbs-down from a listening-derived
  one. Implicit rows are a *restatement of current state*, so a re-sync
  replaces them (`db.upsertImplicitFeedback`); appending instead would let a
  book's weight in the taste profile grow with how often sync ran. Explicit
  rows are never touched by that path.
- **`weight`** makes an implicit verdict graded. Abandoning at 8% is a
  rejection; abandoning at 80% is very nearly a completion and should barely
  count against the book. The abandon point is the ONLY true negative this
  system will ever observe about an owned book — a personal library is a
  positive-only dataset.

```sql
CREATE TABLE rec_impressions (   -- what was SHOWN, with rank positions
  id INTEGER PRIMARY KEY, slate_id TEXT NOT NULL, query_text TEXT NOT NULL,
  book_id TEXT, external_key TEXT, rank INTEGER NOT NULL, score REAL,
  shown_at INTEGER NOT NULL
);
CREATE TABLE listening_progress ( -- snapshot per book, overwritten
  book_id TEXT PRIMARY KEY, progress REAL NOT NULL, is_finished INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER, time_listening INTEGER NOT NULL,
  last_played_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE listening_sessions ( -- append-only, keyed by ABS session id
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL, started_at INTEGER NOT NULL,
  duration INTEGER NOT NULL, playback_speed REAL, device TEXT
);
```

`rec_impressions` is the one a reader is most likely to think is optional.
Verdicts say what was accepted; they never say what it was accepted *over*.
Recording the slate with its rank positions is what turns "did the ranker put
the winner at rank 1?" into an offline NDCG/MRR measurement over real history
— the difference between tuning weights against a metric and needing a fresh
human judgment for every change (§10.C).

`listening_progress` deliberately has **no foreign key** to `books`: ABS can
report progress for an item this mirror has not synced yet, and losing the
strongest signal in the system to a constraint would be the wrong trade.
`listeningSync.ts` filters unknown book ids at ingest and reports the count.

---

## 2. Enrichment clients (`core/enrichment/`) ✅

One shared interface; each provider is independently testable with fixtures
(AGENTS.md rule: no network in tests — reuse the `MessageCreator`-style
injection with a `fetchImpl` parameter, same as `recommendations.ts`).

```ts
interface EnrichmentProvider {
  readonly name: string;                       // → external_metadata.provider
  lookup(book: Book, fetchImpl: typeof fetch): Promise<EnrichmentPayload | null>;
}
interface EnrichmentPayload {
  raw: unknown;                                // cached verbatim
  entities: { entity: string; kind: 'person' | 'place' | 'time' }[];
  subjects: string[];                          // candidate facet terms
}
```

### Providers and current state

1. **`openLibraryProvider`** — keyless, verified live.
   `GET https://openlibrary.org/search.json?q=...&fields=key,person,place,time,subject&limit=1`.
   Prefer ISBN lookup, fall back to normalized title+author (reuse
   `normalized()` from `recommendations.ts`). Caveat baked into the design:
   OL `person` is a *mention index* (IT's list includes Batman and Def
   Leppard) — it is an **allowlist for validation**, never a tag source.
   Coverage measured at ~40–50% (Dune and Blindsight have nothing), so
   absence of data is always a soft signal.
2. **`audnexusProvider`** — audiobook-native, keyed by `books.asin` (already
   synced). Genres, narrator, series. Check whether AudiobookDB has
   superseded it at build time; the interface isolates the choice.
3. **`googleBooksProvider`** — shipped as an optional, API-keyed provider.
   It contributes descriptions and BISAC subjects, not grounded entities, and
   handles the service's daily quota and transient failures explicitly. On the
   measured library it raised external-metadata coverage from 72% to 81% but
   grounded-entity coverage only from 297 to 298 books.
4. **`wikidataProvider`** — shipped. It resolves and verifies work entities,
   then reads P674 (characters), P840 (narrative location), and P136 (genre).
   It remains a low-recall, high-precision confirmer rather than a primary.
5. **`hardcoverProvider`** — still planned for Phase 5. It requires a token
   stored in `secrets.json`, never settings, and would contribute community
   genre tags and ratings for the popularity/reception axis.

### Offline datasets (loaded once, not fetched per book)

- **OCLC FAST** (`scripts/load-fast.ts`): download the N-triples dump
  (ODC-By license), extract the topical + form facets into `tag_aliases` /
  `vocab_terms` as the canonicalization backbone. FAST's 8 facets map onto
  our category split; its variant labels become alias rows for free.
- **LibraryThing CK** (optional): bulk XML feeds (CC-BY-SA, attribution
  required in the UI). Curated characters/places, keyed by LT workcode —
  needs an ISBN→workcode step via their API. Full feeds aren't at public
  URLs (404 verified); park behind a "have the dump locally" flag.
- **UCSD Book Graph**: academic-use-only, no redistribution — fine for a
  personal instance. Use offline to *seed* `vocab_terms` with shelf-name
  frequencies (which folksonomy terms real readers converge on), not at
  runtime.

### Enrichment runner (`core/enrichment/enricher.ts`)

Clone the `tagger.ts` operational pattern exactly: `p-limit` pool,
`OperationController` checkpoints (pause/cancel), `dryRun`, per-book
failure isolation (A4), action log events, sync_log entry. Providers run
per-book in sequence (they're fast; the pool parallelizes across books).
Respect `external_metadata` cache with a TTL (e.g. 90 days; `not-found`
retries after 30).

Output per book: upsert `external_metadata`, rebuild `book_entities` union
(canonical form + sources), stash provider `subjects` for the
canonicalizer.

---

## 3. Tagging v2 — propose → canonicalize → ground → derive ✅

Rewrite `agents/` into a real pipeline (and fix the current bug where
GenreAgent/MoodAgent/ArbitrationAgent each burn a full duplicate
`tagBook()` call):

1. **Propose** (LLM, generous): one call, open vocabulary, target 25–40
   tags across categories `genre, mood, theme, trope, structure, setting,
   audience` + entity *candidates* (characters/places). The prompt shows
   the current promoted vocabulary as *preference*, not constraint. Local
   Ollama model is fine here — this is the llama-generous pass; precision
   comes from the next two deterministic steps, so the cheap model's
   weaknesses are contained.
2. **Canonicalize** (deterministic, no LLM): normalize to kebab-case →
   `tag_aliases` lookup → FAST variant-label match → fuzzy fold (strip
   stopwords: `the-power-of-friendship` → `friendship`). Mapped tags get
   `source='vocab'`. Unmapped tags stay `llm-open` and increment
   `vocab_terms(status='proposed').book_count`.
3. **Ground entities** (deterministic): candidate character/place tags are
   matched against `book_entities` (exact, then token-overlap fuzzy —
   `Ben Hannigan` → token `Ben` → repair to `Benjamin Hanscom`). Matched →
   stored as the **canonical** entity with `source='external:<provider>'`.
   Unmatched, when the book *has* an entity allowlist → **dropped** (this
   is the hallucination filter). Unmatched with no allowlist → kept as
   `llm-open`, substring-checked against the description as a weak gate.
4. **Derive** (no LLM): `length` from `durationSeconds`, `era` from
   `publishedYear`, both `source='derived'`. Removed from the LLM prompt
   entirely — fewer output tokens, zero arithmetic errors.
5. **Arbitrate** (LLM, rare): only when the proposal is pathological
   (< N tags, or required categories empty after canonicalization) —
   escalate that one book to the cloud `COLLECTION_MODEL`. This is what
   `ArbitrationAgent` was meant to be.

New categories to add to `TAG_CATEGORIES`: **`trope`** (chosen-one,
love-triangle, time-travel, found-family, unreliable-narrator, hard-magic,
soft-magic, first-person, …) and **`structure`** (linear, nonlinear,
multi-pov, single-pov, epistolary, frame-story). Trope tagging must be
prompted *explicitly and symmetrically* ("tag notable tropes that ARE
present — exclusion queries depend on presence") because negative filtering
(§5.4) can only exclude what got tagged.

Promotion loop: a `proposed` term reaching `book_count >= 5` surfaces in a
review endpoint/UI (extends the existing tag-quality report). Promoting it
flips matching `llm-open` rows to `vocab` retroactively via the alias map.

---

## 4. Retrieval layer (`core/retrieval/`) ✅ *this is Phase 3, not Phase 4*

Two engines, one façade.

### 4.1 Structured search (exists, extend)

`db.queryBooks` grows: multi-tag AND/OR, **`excludeTags`** (with a
`trustedOnly` flag → `source != 'llm-open'`), entity filters
(`book_entities`), min/max duration, series membership. Pure SQL, already
indexed.

### 4.2 Semantic search (new: `core/retrieval/embeddings.ts`)

- **Book cards**: a composed text per book — title, author, series,
  canonical tags grouped by category, entities, and the first ~800 chars of
  description. Tags in the card are what make vibe-matching work: the card
  says "mood: melancholic, cozy; setting: coastal-town, small-town" in
  plain text where the embedding model can see it.
- **Embedder**: `EmbeddingCreator` interface mirroring `MessageCreator`
  (injectable, testable). Default impl: Ollama `/api/embed`
  (`nomic-embed-text` or `bge-m3`) — the `ollamaUrl` config and homelab
  instance already exist. Optional cloud fallback later.
- **Store**: `book_embeddings` BLOB; `card_hash` invalidates when tags
  change. Load all vectors into a Float32Array matrix at startup /
  on-change; brute-force cosine. No index, no dependency.
- **Ops**: embedding runs as an operation like tagging (pool, progress,
  resume); re-embed only books whose `card_hash` changed.

### 4.3 Hybrid ranker (`core/retrieval/ranker.ts`)

```
score(book) = w_sem · cosine(queryVec, bookVec)
            + w_tag · tagOverlap(preferredTags, bookTags, confidence-weighted)
            + w_pop · reception prior (Hardcover ratings, when present)
hard filters applied BEFORE scoring; exclusions are filters, not weights.
```

Deliberate deviation from the prompt's "negative vector weighting" idea:
subtracting embeddings is unreliable (vector arithmetic doesn't cleanly
encode "no time travel"). Exclusions are **hard SQL predicates on tags**,
with honest confidence reporting (§5.4). Embeddings handle attraction;
SQL handles rejection.

---

## 5. The librarian: query planner + agent loop 🟡 *library-only v1 shipped; acceptance and follow-ons remain*

**What exists** (`core/librarian/`, all tested with an injected driver — no
LLM, no network):

- ~~the round-based tool loop~~ — `runConversation`, capped by BOTH a round
  budget (6) and a token budget (120k). The token budget charges tool
  results, not just driver usage, because that is where the context
  actually goes (§10.I).
- ~~the tool layer~~ — `core/librarian/tools.ts`, with an import-graph test
  proving it has no path to `buildTagSummary` (§10.I's forbidden pattern).
- ~~the event contract~~ — §8.1's vocabulary plus `error` and terminal
  `done`, emitted from a `finally` so exactly one terminal event ends every
  stream (§10.E).
- ~~conversation persistence~~ — SQLite, with a startup reconcile that
  resolves a run nobody saw end to `interrupted` rather than leaving it
  `running` forever (§10.F).

Also shipped in the Phase 4 library-only slice:

- ~~`search_semantic`~~ — query-time embeddings over the full hard-filtered
  candidate set, then hybrid ranking.
- ~~prompt-backed `TurnDriver`~~ — one schema-constrained decision per round
  using the existing cloud/Ollama `MessageCreator`; `llmClient.ts` and its
  adapter contract did not need to change.
- ~~`POST /api/librarian/chat`~~ — the real loop fanned out to SSE and SQLite,
  with an end-to-end HTTP test asserting the same terminal feed on both.
- ~~minimal Desk UI~~ — question/answer bubbles plus the live `action` feed.
  A provisional `answer` event is buffered until `done`; `exhausted` is never
  rendered as a successful answer.

**What remains:**

- The reviewed snapshot-only acceptance harness exists, with a blank six-slot
  machine fixture plus a ten-query human proposal, but it has not run against a
  real snapshot. §10.C steps 6–7 still require real embeddings, Joel's approved
  expected results/IDs, and ranking judgment.
- ~~Restart-safe conversation threads, bounded history/list/detail APIs, and
  follow-up turns whose prior context cannot substitute for fresh evidence.~~
- ~~The bounded Desk consumer for conversation history, persisted replay,
  restart/reopen, and follow-up turns.~~
- Chat remains library-only. Scout's external recommendations now use the
  separately verified iTunes lookup; that path is not a chat tool.
- ~~Supported Desk trace surfaces: live/replayed audit disclosures, a globally
  bounded additive candidate pile, and a collapsible, counted action trail.~~
- Richer concepts that lack honest contracts are deferred, not Phase 4 exit
  blockers: editable interpretation chips, pile removal causes, rich evidence
  cards, feedback controls, and a write-triggering audit action (§8.2–§8.7).

### 5.1 Architecture 🟡 *internal loop and MCP wrapper built; acceptance and Desk follow-ons remain*

Not a single-shot prompt (today's `recommendBooks` ceiling: serializing the
whole library into one context stops scaling and can't iterate). Instead an
**agentic tool loop**: the librarian LLM (cloud `COLLECTION_MODEL`,
Ollama fallback) gets tools and converses:

```
search_library(structured filters)             → exact books + tags
search_semantic(query, hard + soft filters)     → hybrid-ranked books
get_book(id)                                   → full owned card + tags
find_similar(bookId, acrossGenre?: boolean)     → embedding neighbours
tag_coverage(tags[], bookIds?)                  → present / confirmed absent /
                                                  unaudited (guardrail honesty)
```

These are thin wrappers over §4 and share one internal registry. The reviewed
MCP adapter registers that same registry at `/mcp`; `query_library` remains a
deprecated compatibility alias that delegates to `search_library`, not a
second implementation.

Internal implementation deliberately diverged from the original native
tool-use proposal. `createPromptTurnDriver` serializes the question and prior
tool transcript into the existing single-shot `MessageCreator.create()` and
forces one JSON decision with `responseSchema`. This works for Anthropic and
Ollama without changing `llmClient.ts`. Max ~6 tool rounds, then a separately
schema-forced answer. Before an answer crosses the boundary, the driver
rejects every book id absent from actual prior tool results and hydrates
title/author from those results, not from model prose.

### 5.2 The four archetypes → resolution strategies

**1) Vibe & atmosphere** — *"autumn in an old coastal town, melancholic,
cozy, a bit of mystery, not a full thriller"*
Planner emits: semantic query = the user's own words (embeddings love
prose); soft preferred tags `mood:melancholic, mood:cozy, theme:mystery,
setting:coastal-town, setting:small-town`; soft-exclude `genre:thriller`
(demote, don't ban — "not a full-on thriller" is a preference).
`search_semantic` does the blend; ranker weights `w_sem` high, `w_tag`
medium. Grain-of-salt note honored: it's not tag-blending *instead of*
genre filters, it's embeddings-first with tags as a re-rank boost — pure
tag blending fails exactly on abstract vibes that no vocabulary
anticipated.

**2) Cross-domain / if-you-like** — *"world-building + political intrigue
of The Expanse, but low-stakes fantasy with smart dialogue"*
Planner: v1 uses `get_book` to resolve an owned anchor. External anchors are
deferred with external recommendations rather than accepted without a
verification path.
Extract *transferable* qualities (theme:political, structure:multi-pov,
mood:witty) vs *replaced* facets (genre: hard-sci-fi → fantasy;
mood:+cozy/low-stakes). Then `find_similar(acrossGenre=true)` = cosine
neighbours with the anchor's genre **excluded** and target genre required.
Anchor vector minus nothing — the genre swap happens in SQL, the
structural similarity in embedding space. Persisting successful transfers as
`book_edges(relation='comparable', source='llm')` remains Phase 5 feedback
work.

**3) Context & cognitive load** — *"fast-paced, punchy, 45-min commute,
survivable 30-second zone-outs"*
Fully deterministic: `pacing:fast-paced` (vocab-trusted),
`structure:linear` + `structure:single-pov` (the actual proxy for
zone-out-tolerance), and a `length:short|medium` preference. Little
semantic search needed; v1 expresses hard constraints through
`search_semantic`'s pre-ranking filters (or `search_library` where one exact
tag is sufficient).

This archetype **deliberately does not use chapter duration.** An earlier
revision leaned on per-book *median chapter duration* ("a 45-min commute
pairs well with ~20-min chapters"); that claim was struck on 2026-08-23
after checking the data source rather than assuming it — see §10.G for the
evidence. Chapter boundaries are not in the payload sync actually reads,
and `pacing` + `structure` + `length` carry this archetype on their own.
Half-supporting it was the option we refused.

**4) Negative filtering & guardrails** — *"sprawling space opera, zero
chosen-one, no time travel, prefer hard magic/tech"*
Positive side: `genre:space-opera` + `length:long|epic` + semantic
"sprawling". Negative side: `excludeTags:[trope:chosen-one,
theme:time-travel]` as **hard SQL exclusion across every tag source,
including `llm-open`** — exclusions deliberately ignore `trustedOnly`,
which narrows inclusion filters only. Unverified evidence is weak
grounds *for* a book and sufficient grounds *against* one; see §5.4
rule 2, which this sentence previously contradicted.
Then the honesty step, which is the part most engines skip: exclusion is
only as good as tagging coverage, so the planner calls
`tag_coverage(['trope:chosen-one'])` and the librarian reports it like a
librarian would: *"none of these five is tagged chosen-one; two of them
haven't been trope-audited yet, flagging that."* Books whose trope
coverage is empty get demoted, not silently included.

### 5.3 Surfaces

- **Backend**: `POST /api/librarian/chat`, persisted in SQLite and streamed
  through `api/sse.ts`. The existing `/librarian` authorization rule applies.
- **Frontend**: the existing `/desk` now carries the minimal chat and action
  feed. Full recommendation cards remain §8.5 follow-on work.
- **MCP**: the same five-entry internal registry is exposed at `/mcp`; names,
  schemas, descriptions, authorization, and execution remain registry-backed.

### 5.4 Trust rules (engine-wide invariants)

1. A recommendation must reference a book returned by a tool call in this
   conversation. Enforced by schema, not prompt.
2. Hard excludes ignore `llm-open` tags for *inclusion pardons* — an
   `llm-open` `trope:chosen-one` still excludes (cheap safety), but
   absence of trusted tags triggers the coverage disclosure.
3. The chat loop emits no external recommendations. Scout's acquire results
   pass the independent iTunes verifier before display and fail closed when a
   hard constraint cannot be proven from the verified metadata.
4. V1 preserves the model's reason sentence and retrieved book identity. The
   richer tags/entities/edges evidence payload is deferred with §8.5.

---

## 6. Feedback & personalization ⬜ *Phase 5*

- Explicit: accept/reject/"more like this" buttons → `rec_feedback`.
- Implicit: ABS listening progress via the existing sync — finished fast =
  strong positive; abandoned at 10% = negative. Stored as feedback rows.
- Use: (a) a **taste centroid** — mean embedding of finished-and-liked
  books, added as a small prior term in the ranker; (b) recent feedback
  rows injected into the librarian's context ("you bounced off two
  slow-burn litfic picks last month"); (c) feedback edges in `book_edges`.
- Never let personalization override an explicit query constraint.

**Amended 2026-08-28** — see `docs/recommendation-data-model.md` for the
reasoning behind each change:

- **Several centroids, not one.** A single mean over a library holding
  sci-fi, cozy mystery and history lands in empty embedding space and
  attracts things mildly like everything and strongly like nothing. Cluster
  the finished-and-fast books into 3–6 taste modes and treat each as its own
  prior. This also gives §10.J's cold-start gate a natural shape: a mode with
  too few members simply does not participate.
- **Log impressions, not just verdicts.** `rec_feedback` as specified in §1.6
  records what was accepted; it does not record what was *shown*. Logging the
  whole slate with rank positions turns "did the ranker put the winner at
  rank 1?" into NDCG/MRR over real history — an offline metric to iterate
  against between the human judgments §10.C otherwise needs for every weight
  change.
- **The abandon point is the only true negative this system will ever have.**
  A personal library is a positive-only dataset: every book in it was chosen.
  Dropped-at-8% versus dropped-at-80% is the single richest signal available,
  and it is free — Audiobookshelf already tracks it and nothing ingests it.

---

## 7. Phase map

### Status (last updated 2026-08-28)

| Phase | State | Evidence |
|---|---|---|
| **0. Hygiene** | ✅ done | `5eb90ed` — `book_tags.source`, derived length/era, trope/structure categories, prompt trim |
| **1. Enrichment** | ✅ done | `7540f92` migration B · `530b123` Open Library · `a7d828f` Audnexus · `36c033b` entity matcher · `ebbf435` runner + routes · `926d0ee`/follow-ups Google Books · `1b4e9d4`/follow-ups Wikidata. Exit criterion met: `Ben Hannigan` → `Benjamin Hanscom`, `Adrian Dover` dropped |
| **2. Tagging v2** | ✅ done | `d728a35` migration C · `5940b0e` canonicalize + ground wired into the pipeline · `2233e49` promotion queue + panel · `a2a97cb` enrichment sample QC · `6c26047` FAST alias loader |
| **3. Retrieval** | ✅ done | `de83980` migration D + fixture library · `d070501` book cards, embedder, `queryBooks` extension · `9292fbd` exclusion-safety invariant · `8bc8ea2` embedding operation + route + ranker · `212e1bd` `find_similar` + vibe regression. Exit criterion met: the fixture query returns `fx-01 > fx-02 > fx-03` as a hand-labelled **ordering**, not merely the right set |
| **3.5 Validation** | ✅ done; embedding blocker **closed 2026-09-03** | Ran against the real 955-book library: 692/955 Open Library resolved (72%), 297 with grounded entities (31%), 958 tagged at $2.10, vocabulary consolidated (1,560 rows). Its own doc was retired once answered; the three questions that outlived it moved to `phase-4-readiness.md`. **2026-08-28 re-measurement on the live DB (965 books): only 396 embedded — 41%.** See §10.M. **2026-09-03: live `/api/readiness` reports 961/961 embedded (100%, 0 stale)** — grounded-entity coverage is unchanged at 33% (314/961), which is a separate, still-open gap (§ enrichment-sources-review.md F1) |
| **4-pre. Readiness (§10)** | ✅ done | A, B, D, E, G, H, I, F all closed — see `docs/phase-4-readiness.md`. Includes the librarian conversation spine: round + token budgets, `error`/`done` terminal events, SQLite conversation persistence |
| **4. Librarian** | 🟡 code complete; human acceptance pending | Five internal tools, prompt driver, persisted SSE route, four scripted fixture archetypes, snapshot-only acceptance harness, retrieval-first Scout flow with verified external lookup, registry-backed MCP wrapper, restart-safe conversation history/follow-ups, bounded Desk history, honest audits, additive candidate pile, and collapsible action trail are implemented and independently reviewed. The ten query expectations are approved. **§10.M closed 2026-09-03 — embeddings are no longer the blocker.** Q1 was re-run live and passed (rank 1: `Relative Humidity`, exactly as expected; see §10.M's resolution note). Still open: the constraint-parsing caveat noted there, encoding stable IDs/vectors and running §10.C steps 6–7 on a distinct snapshot for the other nine queries, settling `relaxableTags` (query-time canonicalization from `e4d1f31`/`73984bd` stays; the tool-owned retry loop should go), and re-tagging the broken per-book rows §10.M's second finding found (`Tropical Depression`, `Tropical Swap`, `Album`) |
| **5. Feedback** | 🟡 code complete; unverified against live data | Migration E (`rec_feedback`, `rec_impressions`, `listening_progress`, `listening_sessions`), explicit accept/reject capture with Desk buttons, ABS listening ingest → graded implicit verdicts, multi-centroid taste profile with the §10.J cold-start gate, a `taste` ranker term defaulting to 0, slate impression logging on every Scout answer, and a Hardcover provider feeding §4.3's until-now-empty reception prior. All fixture-tested. **Not verified against live data: no ABS listening sync has been run, and the Hardcover request shape has never touched the real API.** Google Books and Wikidata are Phase 1 enrichment (`926d0ee`, `1b4e9d4`), not Phase 5, despite where `docs/current-status.md` mentions them. Design rationale: `docs/recommendation-data-model.md` |
| **6. Library hygiene** | ✅ code complete; live mutation remains a human gate — see §10.K | Per-library confirmed folder conventions, safe renderer/detector, honest 75%-coverage structure metric, server-authored ID-only plans, canonical containment/overlap/freshness checks, atomic recovery journals, authorized rollback roots, and reviewed frontend contract. Synthetic rich non-default fixtures pass with zero proposed moves when consistent; no live library was touched |
| **T. Audio transcripts** | ⏸ parked — `docs/audio-transcript-pipeline-plan.md` | Deliberately deferred until after Phase 6. Raises entity coverage on the ~663 books no catalogue describes, by sampling audio (not full transcription). Its own §7 requires three cheaper sources be measured first — the description extractor may make it unnecessary |

Also shipped outside the original plan: enrichment **sample mode + quality
report** (`a2a97cb`) — `POST /enrichment/run` with `sample: true` runs the
real pipeline over an evenly-spread `max(20, 5%)` subset and returns
per-provider hit rates, entity coverage, and example books, so a run can be
QC'd before committing to the full library. This is the mechanism §10.C
depends on. Embedding runs get the same treatment via `getStaleEmbeddings`
as their single candidate selector: "never embedded" and "card changed" are
one case, so a re-run after a vocabulary promotion is cheap and
self-correcting rather than requiring event hooks into four modules.

**One invariant worth re-reading before Phase 4** (`9292fbd`): `excludeTags`
deliberately ignores `trustedOnly`. Exclusions consider every tag regardless
of provenance, because unverified evidence is weak grounds *for* a book and
sufficient grounds *against* one. §5.2 archetype 4 previously said the
opposite and was corrected; a faithful implementation of the wrong half had
already shipped with 24 passing tests locking it in. The librarian tool layer
must not re-widen it — pair exclusions with the §8.6 coverage disclosure
instead.

| Phase | Ships | Touches | Exit criterion |
|---|---|---|---|
| **0. Hygiene** | Migration A (`source`), derived length/era, delete duplicate-call agents (fold into pipeline stub), trope/structure categories | `db.ts`, `types.ts`, `tagger.ts`, `agents/*`, `llmClient.ts` prompt | Re-tag run writes sourced tags; agent layer makes exactly 1 LLM call/book |
| **1. Enrichment** | Migrations B, provider interface, OL + Audnexus clients, enrichment runner + route + operation, `book_entities` | new `core/enrichment/`, `api/routes/` | IT-style fixture test: `Ben Hannigan` repaired to `Benjamin Hanscom`; `Adrian Dover` dropped |
| **2. Tagging v2** | Migration C, canonicalizer, grounding step, FAST loader script, promotion queue endpoint + UI panel | `core/tagging/` (renamed pipeline), `scripts/load-fast.ts`, frontend curate settings | Tag a sample: OOV rate reported, aliases collapse the friendship-cluster fixture, promotion round-trips |
| **3. Retrieval** | Migration D, book cards, Ollama embedder, embedding op, hybrid ranker, `find_similar` | new `core/retrieval/` | "melancholic coastal autumn" fixture returns hand-labeled expected ordering over a 30-book fixture library |
| **4. Librarian** | Prompt-backed loop, 5 internal tools, persisted SSE route; reviewed acceptance harness, Scout re-point, verified external lookup, MCP adapter, restart-safe conversation history/follow-ups, and supported Desk history/trace UI in the current worktree | `core/librarian/`, `core/retrieval/acceptance*.ts`, `core/recommendations.ts`, `mcp/tools/librarian.ts`, API routes, frontend | Scripted archetypes and focused backend/frontend regressions pass; implementation review is closed. Acceptance still requires approved expectations, §10.C steps 6–7, and the real Key West judgment |
| **5. Feedback** | ✅ Migration E, explicit + implicit capture, multi-centroid taste profile, ABS-progress signals, impression logging, Hardcover provider and reception prior. LT CK loader remains out — no dump obtained | `core/feedback/`, `core/retrieval/ranker.ts`, `core/librarian/tools.ts`, `api/routes/feedback.ts`, `core/absClient.ts`, frontend | Met on fixtures: the taste profile separates two distinct appetites into their own modes and a candidate resembling a rejected book is demoted. Live verification (a real ABS sync, a real Hardcover response) is still outstanding |
| **6. Library hygiene** | ✅ Per-library folder patterns and explicit confirmation, finite detection, honest structure health, server-authored plans, contained/fresh/serialized execution, durable rollback journals, typed Realign/settings/health UI | `models.ts`, `folderPattern.ts`, `organizer.ts`, `realign.ts`, `rollback.ts`, history/settings, routes, frontend | Met on synthetic temp libraries: a rich non-default convention reports a real score and proposes zero changes when already consistent. Live mutation remains separately gated |

Dependencies: 0 → 1 → 2 → 3 → 4 → 5 strictly; 1's providers beyond OL can
land any time after 1.

### Testing discipline (per AGENTS.md)

- Every provider: fixture-based, `fetchImpl` injected, failure paths
  (timeout, 404, garbage JSON) tested — the `MessageCreator` pattern.
- The four archetypes become **named regression fixtures** — a 30-book
  synthetic library with known tags/entities/embeddings (embedder stubbed
  with deterministic vectors) and expected result orderings.
- Grounding tests assert both directions: repair (fuzzy match to
  canonical) and rejection (no allowlist match → dropped).
- No test touches the network or a real library path.

### Cost & model placement

| Work | Model | Volume | Notes |
|---|---|---|---|
| Propose pass | Ollama local (or Haiku) | 1 call/book, once + on promote-rerun | generous, cheap |
| Canonicalize / ground / derive | none | — | deterministic |
| Arbitration | claude-sonnet-5 | rare | pathological books only |
| Embeddings | Ollama local | 1/book + on card change | free at homelab |
| Librarian chat | claude-sonnet-5 (Ollama fallback) | interactive | the only recurring cloud spend |

### Risks / open questions

- **OL coverage (~50%)** — mitigated by provider union + soft-absence
  semantics; entity grounding degrades to description-substring, never to
  blind trust.
- **Hardcover token** — user-supplied; engine must run fully without it.
- **Ollama tool-calling quality** — small models fumble tool loops; the
  fallback librarian may need a constrained "one-shot plan → execute →
  one-shot answer" mode instead of free iteration. Design the planner so
  both modes share the tool layer.
- **LT CK full feeds** — not publicly URL-addressable; requires asking
  LibraryThing. Optional path, CC-BY-SA attribution required if used.
- **Re-tagging cost** on vocabulary promotion — alias remap is retroactive
  and free; only *new* categories (trope/structure) need one paid re-run
  over the library.

---

## 8. UI/UX — The Librarian's Desk 🟡 *event contract + minimal chat/action feed shipped; pile backend partial*

Design stance: **transparency as theater, honesty as content.** The
animation and metaphors may be stylized, but every fact shown on screen is
sourced from a real event the engine emitted. We never render a fake step —
we render real steps *warmly*. This falls out of the architecture almost
for free: the tool loop (§5.1) already produces a discrete, ordered stream
of tool calls with inputs and result counts, and the backend already has
SSE/WS plumbing (`api/sse.ts`, action-log events). The UI is a renderer
over a trace that exists anyway.

### 8.1 The event contract ✅ *implemented in `core/librarian/events.ts`*

`POST /api/librarian/chat` streams typed SSE events; this
vocabulary is a public contract that tests assert against:

```
interpretation  → the parsed query intent (chips, §8.2)
action          → one tool call: { tool, label, detail, resultSummary }
pile            → candidate-set diff: { added: [bookId], removed: [{bookId, reason}] }
answer          → final recommendations with per-book evidence
audit           → coverage/confidence disclosures (§5.4)
token           → streamed prose for the librarian's chat bubble
error           → { stage: 'tool' | 'driver', message, recoverable }
done            → TERMINAL: { status: 'answered' | 'exhausted' | 'failed', rounds, tokensUsed }
```

`error` and `done` (readiness item E) close the gap the original six left
open: if a tool threw or the round budget ran out, the feed simply stopped —
indistinguishable from "still thinking." Every conversation now emits
**exactly one `done`, and it is always the last event on the stream**,
whichever way the conversation ends — the round-loop spine
(`core/librarian/conversation.ts`) guarantees this with a `try`/`finally`
around the whole loop, so an unanticipated throw still produces a terminal
event rather than a silently-dead connection.

`error.stage` distinguishes the two failure sources, because they have
different consequences: `'tool'` means one tool call threw and is always
`recoverable: true` — the loop continues, the driver can try another call or
another round, and the conversation can still end `answered`. `'driver'`
means the turn driver itself threw (on a normal round or on the final forced
round) and is always `recoverable: false` — nothing can save this
conversation, and it ends `done{status:'failed'}`.

`done.status` is one of three. **`'exhausted'` is not the same as
`'answered'`, even though an `answer` event may have been emitted on both
paths:**

- `'answered'` — the driver produced an answer within the normal round
  budget (`maxRounds`, default ~6 per §5.1).
- `'exhausted'` — the round budget ran out before the driver answered, so the
  loop made one final forced call (`TurnContext.forceAnswer: true`) rather
  than let the feed die silently. That forced call may itself produce an
  answer, but the Desk buffers it until the terminal event and does not
  render it as a successful recommendation list. The status stays
  `'exhausted'`, never `'answered'`. This is invariant 5 (docs/
  phase-4-readiness.md — "a check that cannot succeed must report Unknown,
  never a confident number") applied to the round loop: an answer produced
  under duress, after the budget the driver was supposed to work within is
  already spent, is not the answer the loop would have reached given more
  rounds. Reporting it as `'answered'` would be the exact same lie as a
  confident 0%.
- `'failed'` — the driver (or the forced call) threw and no answer exists at
  all.

### 8.2 Query interpretation chips ⏸ *deferred until a planner/override contract exists*

Before anything runs, the planner's parse of the user's prose renders as
editable chips:

> `mood: melancholic` `mood: cozy` `setting: coastal-town`
> `soft-avoid: thriller` `EXCLUDE: chosen-one` `prefer: hard-magic`

Soft preferences and hard exclusions are visually distinct (tint vs.
struck-through red). Chips are removable and editable, and editing re-runs
the search. This closes the loop most engines leave open: the user sees
*how they were understood* and corrects the interpretation instead of
rephrasing blindly. It also doubles as the debugging surface for prompt
quality.

The current driver does not emit a structured interpretation and there is no
typed override/re-run contract. Shipping editable chips now would invent state
the librarian did not actually use, so this is not a Phase 4 exit blocker.

### 8.3 The desk feed ✅ *supported action trace shipped*

A collapsible timeline beside the chat renders each `action` event as a
librarian doing librarian things. Fixed tool → verb mapping:

| Tool | Rendered as |
|---|---|
| `search_semantic` | "Browsing the stacks for *melancholic coastal autumn*… found 23" |
| `search_library` | "Checking the card catalog — pacing: fast… 11 match" |
| `get_book` | "Pulling *Leviathan Wakes* off the shelf" |
| `find_similar` | "Walking the shelves near *The Expanse*… 8 neighbours" |
| `tag_coverage` | "Double-checking my notes on chosen-one coverage… 2 books unaudited" |

`detail`/`resultSummary` are curated digests built server-side (never raw
JSON args). Each entry gets a small icon and a running count. The whole
feed collapses to a single "thinking" shimmer for users who don't care —
but it's the cool factor, so it defaults open.

The shipped feed renders every real `action` with a stable friendly verb and
the server's curated `detail`/`resultSummary`, counts actions only, keeps token
prose outside the trail, and supports collapse/reopen for live and replayed
turns.

### 8.4 The browsing pile ✅ *bounded additive trace shipped; removals deferred*

The conversation spine now emits and persists `pile` events when retrieval
adds previously unseen book ids. It deliberately leaves `removed` empty: the
generic tool dispatcher cannot honestly infer why ranking or a filter removed a
candidate. The Desk renders the first 15 unique stable library IDs across the
conversation without inventing titles or covers.

A shelf strip of small cover thumbnails that grows and shrinks as `pile`
events arrive: candidates slide in when a search adds them, and slide out
with a **reason chip** when a filter drops them — "22h — too long for a
commute", "tagged: time-travel", "you abandoned this author twice".
Representative, not exhaustive: the server caps pile events at the top ~15
covers so the animation stays legible; the count badge carries the truth
("23 candidates → 5"). Watching books get pulled and put back *is* the
algorithm, rendered honestly.

Removal animations and reason chips remain deferred until a retrieval result
can report real removal causes. They are not a Phase 4 exit blocker.

### 8.5 Recommendation cards with "Why this?" 🟡 *safe owned answer UI complete; rich evidence deferred*

The minimal Desk currently renders the retrieved title/author and reason in an
answer bubble only after terminal status is `answered`. The cards below remain
the intended richer surface.

Final picks render as cards (cover, title, narrator, duration, play-in-ABS
deep link, accept/reject buttons feeding `rec_feedback`). Each card
expands to an evidence panel:

- matched tags, **colored by trust**: green = `vocab`/grounded-entity,
  blue = `derived`, amber = `llm-open` (hover explains the tiers);
- a similarity bar when an anchor book was involved, with the shared
  structural tags listed ("multi-pov · political · witty-dialogue");
- shared entities where relevant ("also set in: Maine");
- the reason sentence the librarian gave, verbatim.

The same trust colors appear on the book-detail page everywhere else in
the app, so the language is learned once. Enrichment provenance shows
there too: "characters confirmed by Open Library + Wikidata".

The answer contract currently carries owned library IDs, title, author, and the
librarian's reason—not narrator, cover, deep link, or structured evidence.
Those richer cards wait for that contract; accept/reject controls belong to
Phase 5 feedback and do not block Phase 4.

### 8.6 The audit note ✅ *honest disclosure presentation shipped*

`audit` events render as a distinct footnote block under the answer,
styled like a librarian's margin note: *"None of these five is tagged
chosen-one. Two haven't been trope-audited yet — I've flagged them."* A
one-click "audit these now" action queues a targeted tagging run for the
flagged books. Honesty becomes a feature with a button, not a caveat.

The Desk now renders an `audit` note only after a successful `tag_coverage`
result, using the exact reported count and actual unaudited sample IDs, live and
on replay. The write-triggering "audit these now" action is deferred because it
would queue a cost-bearing mutation and has no authorized Phase 4 contract.

### 8.7 Transparency beyond chat ✅ *supported readiness, promotion, and operations surfaces shipped*

- **Promotion queue** (Phase 2) as a "New vocabulary suggestions" panel in
  curate settings: proposed term, category, book count, sample books,
  promote/reject — the librarian visibly *learning your shelf's language*.
- **Enrichment status** per book: provider badges with fetched-at, and a
  library-level coverage bar ("64% of books have grounded entities").
- **Operation reuse**: tagging/enrichment/embedding runs surface through
  the existing operations UI (`/process/*`) — same progress components,
  new operation types.

Per-provider fetched-at badges remain future enrichment UX; they are not part
of the Librarian acceptance boundary.

---

## 9. Execution model — multi-role, multi-agent build

The build runs as an orchestrated Codex team. The main task remains the
orchestrator; project-scoped role agents plan, investigate, implement, and
review under bounded work orders. The repository-wide protocol now lives in
[`agent-operating-model.md`](./agent-operating-model.md), the restart checkpoint
in [`current-status.md`](./current-status.md), and the reusable workflow in
`.agents/skills/audioshelf-work-order/`.

### 9.1 Roles

Standing definitions live in `.codex/agents/` and are selected by their `name`
fields.

| Role | Owns |
|---|---|
| **Orchestrator** (main task) | User intent, phase hand-offs, sequencing, worktree hygiene, integration, human gates, and final acceptance |
| **tech_lead** | One milestone end-to-end: reconciles the plan with code, slices work, coordinates ICs, resolves interfaces, and reports integration readiness |
| **explorer** | Read-only code and contract mapping before work is assigned |
| **ic_implementer** | One scoped migration, provider, module, UI slice, or test slice plus its focused verification |
| **ic_reviewer** | Adversarial pre-integration review; read-only and never edits |

Specialist slices a tech-lead should recognize when cutting a phase:
schema (migrations + `db.ts` accessors), enrichment (providers, runner,
fixtures), pipeline (canonicalize/ground/derive), retrieval (cards,
embedder, ranker), agent-loop (`toolLoop`, tools, planner — a high-judgment
tech-lead slice), frontend (Desk UI against the §8 event contract),
and test (fixture library, archetype regressions).

### 9.2 Model and reasoning policy

Role definitions inherit the parent task's model unless a run explicitly
chooses another one. The role files set reasoning effort where the work needs
it: higher for technical leadership and adversarial review, balanced for
bounded exploration and implementation. Keep model choice outside this product
plan so the operating model does not become stale when available models change.

Spend depth on ambiguous architecture, safety-critical filesystem behavior,
live-database migrations, authentication/secrets, hard debugging, and final
review. Use faster execution for well-bounded pattern-following work only when
the contract and exemplar are explicit.

### 9.3 Work-order protocol

Every delegated task ships as a self-contained brief, using the
`audioshelf-work-order` skill, so the agent does not re-derive settled context:

- files to touch + files to imitate (e.g. "clone the operational shape of
  `tagger.ts`; inject fetch like `recommendations.ts#verifyExternal`");
- the exact contract (types/schemas copied into the brief);
- test expectations by name ("fixture test: `Ben Hannigan` →
  `Benjamin Hanscom`; `Adrian Dover` → dropped");
- done = `npm run typecheck && npm run lint && npm test` green, no new
  lint warnings (baseline must shrink, per AGENTS.md).

File-disjoint tasks may run in parallel only with worktree isolation; the
orchestrator integrates. Anything touching a shared file (`db.ts`, `types.ts`,
`llmClient.ts`), a migration, or a public contract is serialized through one
agent per milestone. Every implementation is gated through `ic_reviewer`, and
material findings return to the original implementer before re-review.

### 9.4 Remaining scope → role map

| Scope | Primary owner | Parallel policy |
|---|---|---|
| Phase 4 real-library acceptance (§10.C steps 6–7) | tech_lead + orchestrator; user supplies quality judgment | Harness implementation/review is complete; the real-snapshot run and decision remain a human gate |
| Phase 4 MCP wrapper and Scout external lookup | explorer → ic_implementer | Implemented and independently reviewed in the current worktree; MCP shares the registry and Scout verifies external picks |
| Phase 4 Desk layers | ic_implementer | May parallelize against the existing typed event contract in isolated worktrees |
| Phase 5 migration, feedback capture, and ranker integration | tech_lead → ic_implementer | Migration and ranker integration are serialized |
| Phase 5 independent providers/loaders | ic_implementer per provider | May parallelize in isolated worktrees |
| Phase 6 folder pattern, structure metric, and realign safety | tech_lead → ic_implementer | Safety-critical; serialize and stop before live mutation |
| Every implementation | ic_reviewer | Required gate after implementation and after material corrections |
| Every milestone | Orchestrator | Integrates, verifies, records status, and accepts |

The §8 event contract remains the boundary that makes Phase 4 follow-on work
parallelizable. Frontend work builds against that typed SSE vocabulary and its
recorded-trace fixtures; agents extend the contract deliberately rather than
creating a second event path.

---

## 10. Review of remaining work (2026-08-22) 🟡 *readiness fixes closed; M resolved 2026-09-03 — C's real-cosine acceptance steps are unblocked*

Each entry below states the problem **as it was found**; the heading says
how it ended. `docs/phase-4-readiness.md` carries the plan, the exit
criteria, the decisions taken inside each fix, and the nine invariants this
work established.

Two items were not "fixed" in the ordinary sense and are worth noting:
**G** was closed by *striking* a claim the data could not support rather
than building toward it, and **C** is half-closed by design — its remaining
steps need Joel's judgement about what a good answer looks like, which is
not something an implementer can supply.

A pass over the unbuilt phases against what Phases 0–3 actually produced.
Ordered by severity. Each finding names the phase that should absorb it.

**L was added after the original pass**, from a live failure rather than a
document review. It is kept here rather than in a new section because it is
the same kind of finding: a gap between what the plan assumed had been
superseded and what is actually still serving users.

**M was added on 2026-08-28**, from running L's own prescribed diagnostic
against the live database. It outranked C and L while open: both of those
ask for judgment about ranking quality, and ranking quality is not
measurable while most of the library has no vector. **M closed 2026-09-03** —
see its entry below. C's real-cosine acceptance steps (6–7) and the
`relaxableTags` question it raised are the live work that inherits M's slot.

### A. ✅ CLOSED — `tag_coverage` cannot distinguish "absent" from "never audited"

**Severity: high. This undermines the headline differentiator.**

§5.2 archetype 4 and §5.4 promise the librarian can say *"none of these
five is tagged chosen-one; two haven't been trope-audited yet."* Nothing
in the schema supports that sentence. `book_tags` records what a book
HAS; "tagged" is defined as `id NOT IN (SELECT book_id FROM book_tags)`,
so a book carrying zero trope tags is indistinguishable from a book that
was tagged before `trope` existed as a category.

This is not hypothetical — it is guaranteed by our own migration path.
`trope`/`structure` were added in Phase 0 and `character`/`setting` in
Phase 2, so **every book tagged before those commits sits in exactly this
ambiguous state**, and re-tagging the whole library is the only thing that
would clear it.

*Fix:* record, per book, which categories a tagging run actually
attempted — either `books.tagged_categories` (JSON) + a schema-version
integer, or a small `tag_runs(book_id, categories, schema_version,
tagged_at)` table. Then `tag_coverage` returns three states per tag —
`absent` (audited, not present), `unaudited` (category never attempted),
`present` — and the audit note in §8.6 renders honestly. Schema change
belongs in **Phase 3.5**; the tool change in **Phase 4**.

### B. ✅ CLOSED — Nothing re-embeds a book when its tags change

**Severity: high — silent staleness.**

`card_hash` is specified as the invalidation key, and the embedding
operation re-embeds only changed cards. But cards contain tags, and three
existing operations mutate tags: vocabulary promotion and aliasing
(Phase 2, which retroactively flips `llm-open` → `vocab` across many
books at once), enrichment (which rewrites grounded entities), and
re-tagging. None of them trigger re-embedding, so semantic search silently
answers from stale cards after every promotion.

*Fix:* make staleness queryable rather than event-driven — a
`getStaleEmbeddings()` that compares stored `card_hash` against the
freshly composed card — and run the embedding operation at the end of any
tag-mutating operation. Cheap, because unchanged cards are skipped. Add
to **Phase 3** if the tech-lead can still absorb it, otherwise Phase 3.5.

### C. 🟡 harness implemented and reviewed; real run and Joel's judgment remain

**Severity: high — the whole engine is unvalidated against reality.**

Phase 3 tunes `w_sem`/`w_tag`/`w_pop` against a 30-book synthetic fixture
with stub vectors, and Phase 4 builds the entire Desk UI on top. Nothing
in the plan says "point this at Joel's actual library and look at the
output" before the UI is committed to.

*Fix:* insert **Phase 3.5 — Validation**, between 3 and 4:
1. `POST /enrichment/run {dryRun:true}` → sanity-check the plan size.
2. `{sample:true}` → read the quality report: per-provider hit rates,
   entity coverage. Expect Open Library ~40–50%; if it is far lower, the
   title/author fallback matching needs work before a full run.
3. Full enrichment run.
4. Tagging `{sample:true}` → inspect canonicalization and grounding on
   real books. Check the promotion queue for terms the real library
   converged on that the seed vocabulary missed.
5. Full tagging run, then embed.
6. **Re-tune ranker weights against real cosine distributions** — stub
   vectors say nothing about how `nomic-embed-text` actually spaces this
   library.
7. Hand-write 5–10 real queries in Joel's own words and record expected
   results as the honest regression suite Phase 4 develops against.

The current worktree now contains the reviewed snapshot-only harness at
`core/retrieval/acceptance.ts`, its read-only loader and CLI, the
`acceptance:retrieval` command, the blank six-slot
`scripts/fixtures/retrieval-acceptance-queries.v1.json` machine template, and
the ten-query human proposal in `docs/phase-4-retrieval-query-proposal.md`. It rejects
live/default database paths and opens a distinct snapshot read-only. It has not
been run on a real snapshot: the embedding model, query vectors, stable result
IDs, and exact expectations remain intentionally blank until Joel supplies or
approves them.
No synthetic expected result is a substitute for steps 6–7.

### D. ✅ CLOSED — No library-readiness signal

**Severity: medium — trust, not correctness.**

Early on, coverage is partial by construction (OL misses ~half the
library; tagging is new). A librarian that answers confidently from 30%
coverage looks broken rather than under-informed.

*Fix:* a library-readiness summary (% enriched, % tagged at current
schema version, % embedded) surfaced in the Desk header, and a rule that
the librarian mentions materially low coverage in its answer — the same
honesty posture as §8.6, applied at library level rather than per query.

### E. ✅ CLOSED — The §8.1 SSE contract has no failure or terminal event

**Severity: medium — the UI cannot render a broken run.**

The vocabulary is `interpretation | action | pile | answer | audit |
token`. If a tool throws mid-loop, or the model exhausts its rounds
without answering, the Desk feed just stops — indistinguishable from
"still thinking".

*Fix:* add `error` (`{stage, message, recoverable}`) and an explicit
terminal `done` (`{status:'answered'|'exhausted'|'failed', rounds,
tokensUsed}`). Add to the contract in **Phase 4** before the frontend
work starts, since the frontend builds against this contract in parallel.

### F. ✅ CLOSED — Conversation persistence is still undecided

§5.3 says "session in SQLite or in-memory ring". Decide **SQLite**: every
other piece of state in this app survives restart, the Desk should be
able to reload a conversation, and last night's mid-run reboot is the
argument. In-memory means a machine update erases the conversation the
user was mid-way through.

### G. ✅ CLOSED (by striking the claim) — Archetype 3 promises a metric with no data source

§5.2's commute archetype leans on *median chapter duration* ("a 45-min
commute pairs well with ~20-min chapters"). Nothing in the curator reads
ABS chapter data — `chapterCount` exists only in the encoder's local file
scan, not on `books` and not from `absClient`.

*Fix:* either add chapter duration to sync (a `books.median_chapter_sec`
column populated from the ABS item payload, derived-source) in **Phase
3.5**, or strike the claim from §5.2 and resolve that archetype on
`pacing` + `structure` + `length` alone. Do not ship the archetype
half-supported.

**RESOLVED 2026-08-23 — the claim is struck.** The payload was checked
before committing, per §10.K's lesson. Findings:

1. `sync.ts:114` sources every book from `absClient.getLibraryItems()` →
   `GET /api/libraries/{id}/items`, which returns **minified** media.
2. That is not a guess. We have already been bitten by it and written it
   down twice: `modules/librarian/index.ts:1008` ("ABS returns MINIFIED
   media on `/libraries/{id}/items` — no `audioFiles` array unless
   `expanded=1`") is why the M4B metric now reports `Unknown`, and
   `curator/core/encoder/scanner.ts:28` says the same and works around it.
3. Chapter boundaries live in the same expanded-only region of the payload
   as `audioFiles`. Reading them means one `GET /api/items/{id}` per book
   — ~955 extra round-trips per sync, which is precisely the cost the
   encoder scanner already has to bound behind `pLimit(5)`. That is not
   "cheaply carried by the item payload".
4. The minified shape's chapter-adjacent field is a *count*, not a list of
   boundaries. Even where present, `duration / numChapters` is a **mean**,
   not the median §5.2 asked for. A median cannot be derived from a count
   at all.

So the honest options were a per-book expanded fetch on every sync, or a
mean dressed up as a median. Both were refused: the second is exactly the
class of bug in invariant 5 and §10.K — a check that cannot succeed
reporting a confident number. §5.2 archetype 3 now resolves on `pacing` +
`structure` + `length`, and says so explicitly so this does not get
re-litigated from memory.

If chapter data is ever genuinely wanted, the honest shape is a separate
opt-in operation over `/api/items/{id}` with its own cost budget and its
own `Unknown` state for books it has not fetched — not a field quietly
populated during sync.

### H. ✅ CLOSED — `book_edges.to_book` has no key convention for non-owned works

The schema comment allows `to_book` to reference a work the user does not
own (the "comparable" relation from archetype 2 points at external
anchors), but no key format is defined, so those edges are unjoinable and
will collide across differently-spelled titles.

*Fix:* define one explicit convention — `ext:<normalized-title>|<normalized-author>`
using the existing `normalized()` idiom — and a helper that mints it, so
external anchors are stable across conversations. **Phase 4.**

### I. ✅ CLOSED — No token ceiling on the librarian loop, and one pattern to forbid

Max ~6 tool rounds is specified, but nothing bounds tokens, and cost is
never surfaced. More concretely: `buildTagSummary` serializes the *entire
library* into a prompt, and it is the existing in-repo pattern an
implementer would reasonably copy. The whole point of the tool loop is to
retrieve incrementally instead.

*Fix:* state explicitly in **Phase 4** that the tool layer must never
call `buildTagSummary`; add a per-conversation token budget that forces
the answer when exceeded; return `tokensUsed` on the `done` event so the
Desk can show cost.

### J. ✅ CLOSED — Taste centroid has a cold-start problem

**Phase 5.** With fewer than ~5 finished-and-liked books the centroid is
noise, and applying it as a ranking prior actively degrades results while
looking principled. Gate the prior behind a minimum-N and surface it
("learning your taste — 3 of 5 signals") rather than applying it silently.

*Closed 2026-08-28 by three gates, not one.* `buildTasteProfile` returns
`null` below `MIN_PROFILE_BOOKS` (5) and drops any individual mode below
`MIN_MODE_MEMBERS` (2). When it returns null, `search_semantic` leaves the
taste term out of the blend entirely rather than scoring every book at a
constant — and `DEFAULT_WEIGHTS.taste` is **0**, so an install with no
feedback ranks bit-identically to how it did before Phase 5 existed. That
last property is what keeps §10.C's acceptance harness measuring retrieval
rather than whatever the user happened to finish last week; the harness pins
`taste: 0` explicitly at its own call site. `GET /taste` reports
`available: false` with a reason, which is the honest surface this item asked
for — never empty modes, which read as "we know you like nothing".

### K. ✅ Phase 6 code complete — structure follows a confirmed per-library convention

**Phase 6 (library hygiene) — not a Phase 4 blocker.** `RealignService.
scanLibrary()` generates a target path from a fixed
`{libraryDir}/{Author}/{Series}/{Title}` convention and flags any book whose
path differs by strict string equality. On the real library that flagged
**811 of 950 books**, which measured nothing: the library is already organised,
just to a richer convention —

```
/audiobooks/Larry Correia/The Adventures of Tom Stranger, Interdimensional Insurance Agent/
  2019 - #1 in Customer Service- The Complete Adventures of Tom Stranger - {Adam Baldwin, Larry Correia}
```

— carrying a year and narrator the scheme has no slot for, so essentially
every folder mismatches. The number reported "you do not use our naming
scheme", not "your library is disordered", while costing a quarter of
`overallScore`.

Two dangers beyond the bad number. `POST /realign/execute` acting on this
would rename 811 correctly-organised folders into a **poorer** convention,
discarding year and narrator. And `/health/library` called `scanLibrary()`
inline on every request, so the health panel depended on an operation that has
been observed returning 502 at the reverse proxy.

The interim fix reported structure as `Unknown`, scored neutrally, and stopped
calling the old scan from health.

The completed fix makes the folder pattern configurable — a template describing the
convention actually in use (`{author}/{series}/{year} - {title} - {{{narrator}}}`)
— and have "structure" measure *consistency against the library's own
convention* rather than conformance to one the user never chose. Detecting the
dominant pattern is finite, read-only, and never auto-confirms a choice.
Structure remains `Unknown` unless all populated libraries are configured and
at least 75% of observed books are eligible. Realignment uses expiring
server-authored plans and accepts only stable book IDs; it re-fetches metadata,
recomputes canonical paths, preflights the whole batch, persists an atomic
recovery journal before mutation, and serializes execution. The UI preserves
detected provenance until explicit confirmation and fails closed on low
coverage or stale scans.

The exit criterion is proven on synthetic temporary libraries, including the
documented Larry Correia-style convention. No live library scan or mutation was
used for verification; that remains a human authorization gate.

Same class of bug as the M4B metric: a check that cannot succeed reporting a
confident number instead of admitting it did not measure anything.

### L. 🟡 Phase 4 — retrieval-first Scout implementation reviewed; real ranking acceptance pending

**Severity: high — the most prominent surface in the app is served by the
engine every other phase was built to replace.**

Item I forbade the whole-library-summary pattern *inside the librarian tool
layer*, and `tools.importGuard.test.ts` now enforces it as an import-graph
assertion. It deliberately said nothing about the surface that had already
shipped using that pattern, because the plan treated that surface as
superseded baseline (§0). It is not superseded. It is what the Recommendation
librarian panel on Scout & Acquire calls today:

```
RecommendationFinder.tsx → POST /recommendations → core/recommendations.ts
  → llmClient.generateRecommendations(buildTagSummary(db), ...)   ← one call, ~950 books
```

It never touches `book_embeddings`, `book_entities`, `book_edges`, the
ranker, or any of the five retrieval tools. So the app currently ships **two
recommendation engines, and the weaker one owns the better UI.**

Found by running *"I'm in the mood for a murder mystery at the beach"* against
the real library on 2026-08-26. It returned the eleven alphabetically-last
books in the library (`World War Z` … `[The Expanse 2.5]`), each with an
invented justification, and described its own input back as the
interpretation. Four distinct defects stacked, and separating them matters
because only one is about ranking quality:

1. **Silent prompt truncation** — the Ollama creator sent `num_predict`
   without `num_ctx`, so the whole-library prompt was cut to whatever fit
   Ollama's 4k default: the tail. The user's request, which sits above the
   library JSON, was cut away entirely. *Fixed in `837bb85`* — an explicit
   `num_ctx` plus a warning when a prompt exceeds the ceiling. This is why
   the pattern is dangerous in a way a cloud-model test would never reveal:
   the reply came back schema-valid and confident.
2. **`scope: 'discover'` discards shelf results structurally** —
   `recommendations.ts` returns `[]` for `onShelf` under that scope and the
   UI hides the section. `discover` is the default, so the common case cannot
   recommend an owned book at all.
3. **The summary cannot express the query.** `SUMMARY_CATEGORIES` is
   `genre, mood, theme, era, pacing` — it drops `setting`, `character`,
   `trope`, and `structure`, and carries no description. "At the beach" has
   nothing to match against. Phase 3 solved exactly this: `bookCard.ts`
   composes `setting:` and `Places:` lines *specifically* so abstract vibe
   queries work, and those cards are already embedded.
4. **`verifyExternal` treats unknown duration as over-limit** — a candidate
   whose iTunes result has no `trackTimeMillis` is dropped whenever any
   `maxDurationHours` is set (`recommendations.ts:66`), including a
   hallucinated one. Small, separable, and worth fixing wherever this code
   lands.

*Fix: re-point the surface, do not patch it.* Defects 2 and 3 are properties
of the one-shot design, not bugs in it — patching them means re-deriving
retrieval inside `recommendations.ts`. The work is:

- Serve the panel from the retrieval layer: embed the query, `search_semantic`
  for the top ~20 candidates, rank, and send **only those** to the model for
  reason-writing. This is the §5.1 tool loop applied to a non-chat surface.
- Keep the acquire half behind `verifyExternal` per §5.4 rule 3. Note this
  is the first surface to need external recommendations, so it forces the
  "external lookup" item already listed against Phase 4.
- Delete `generateRecommendations` and its prompt builder once nothing calls
  them, and extend the item-I import guard to cover the new route — the
  prohibition should hold by construction here too, not by intention.
- `generateCollection` / `generateAutoCollections` keep the whole-library
  prompt for now. That is deliberate and consistent with the item-I guard's
  own carve-out: collection *authoring* is a different feature with a
  different one-shot design. Worth revisiting, not in scope here.

**Exit criterion:** the query above returns the Key West Capers from the real
library, ahead of any hard-sci-fi title, and the answer survives being asked
with `scope` unset. That query joins the §10.C step 7 regression set rather
than being checked once by hand. The current worktree's reviewed implementation
routes Scout through the registered `search_semantic` tool, bounds the model's
evidence to the top 20 retrieved candidates, defaults omitted scope to `both`,
and independently verifies external picks through iTunes. Synthetic tests put
the beach mystery ahead of hard sci-fi and prove the bounded evidence path, but
they do not prove the real Key West ranking. The acceptance template's six
query slots remain empty by design; filling the first needs Joel's query,
expected book ids, and a real query vector from the configured embedder.

If it still fails *after* re-pointing, the cause is downstream of this item and
should be diagnosed as such rather than by reopening L: check that those books
carry embeddings and a `setting`/`Places` line on their card at all. Phase 3.5
measured 31% grounded-entity coverage library-wide, so a book the catalogues do
not describe well can be correctly wired and still not retrievable by place —
which is a §10.C weight-tuning or coverage question, and ultimately the
argument the parked transcript plan (§7 row T) exists to answer.

**That diagnostic was finally run on 2026-08-28, and it came back positive:
the Key West books are not embedded.** L is therefore correctly closed as a
re-pointing item — Scout does now serve from the retrieval layer — and the
residual failure is downstream exactly as predicted. It is written up as
**§10.M**, which supersedes any further debugging of this item. Note for
future readers: two agents spent ~1200 lines on retrieval-side fixes for Q1
*before* anyone ran the one-command check this paragraph specifies. Run the
diagnostic first.

### M. ✅ CLOSED 2026-09-03 — 59% of the library had no embedding, and Q1's expected answer was in that 59%

**Severity: blocking. Phase 4 acceptance cannot be judged until this is
fixed, and no ranker weight tuned before it means anything.**

Found 2026-08-28 by running §10.L's own diagnostic against the live homelab
database (container `audioshelf-librarian`, `/app/data/curator.db`).

**The measurement.** 396 of 965 books are embedded — **41%**. Of the 17
Laurence Shames books, 12 have no embedding, including four of the five
titles named as Q1's expected result in
`docs/phase-4-retrieval-query-proposal.md`:

| Expected rank | Title | Embedded |
|---|---|---|
| 1 | Key West Normal | **NO** |
| 2 | Relative Humidity | **NO** |
| 3 | Key West Luck | **NO** |
| 4 | Scavenger Reef | yes |
| 5 | Sunburn | **NO** |

`rankBooks` scores `w_sem · cosine(queryVec, bookVec)`. A book with no vector
scores zero on that component: it is still *returned* and can still place on
tag overlap, but it cannot compete on vibe. **The intended rank-1 answer to
an explicitly atmospheric query is structurally unable to win it.** This is
also why `search_semantic` reports `semanticScored` — on this library that
number is currently well below `results.length` for most queries, and the
tool description already requires the librarian to say so.

*Fix:* run the embedding backfill. This is an existing operation, not new
code — `getStaleEmbeddings` treats "never embedded" and "card changed" as one
case, so the run is cheap and self-correcting. Worth establishing why it
stalled: whether the last run never completed, or whether the 2026-08-23
vocabulary consolidation invalidated `card_hash` for a large slice and no
re-run followed.

**Second finding: tag quality is materially worse than the coverage
percentages suggest.** From the same query, all real:

- `Tropical Depression` — `setting: derry-maine` (Stephen King's Derry) while
  its `book_entities` correctly holds `place:Key West (Fla.)`. `groundSetting`
  never *replaces* a wrong setting tag, it only declines to drop it, so
  grounding had the right answer and the card still says Maine.
- `Tropical Swap` — `setting: locations-and-place-vibes`, a prompt category
  label echoed back as a tag.
- `Album` — `genre: fre-ac-converter, free-software`; almost certainly not a
  book row at all.
- `The Paradise Gig` — `genre: space-opera, historical-fiction`;
  `Mangrove Squeeze` and `Scavenger Reef` both carry `fantasy`;
  `Nacho Unleashed` carries `light-sci-fi`. All Key West capers.

With 59% of the library unembedded, tag overlap is carrying most of the
ranking weight, so a wrong tag does double damage right now. Re-tagging the
visibly broken rows belongs with the backfill, and `Album`/`Tropical Swap`
are worth checking for a wider title-parse problem.

**Third finding: the vocabulary premise behind the 2026-08-28 retrieval work
was mostly wrong.** Actual genre spread: `mystery(65)`, `cozy-mystery(8)`,
then singletons — `humorous-mystery(1)`, `comedy-mystery(1)`,
`beach-town-mystery(1)`, `dark-mystery(1)`, `horror-mystery(1)`,
`getaway-bay-mystery(1)`, `southern-vampire-mystery(2)`. So of the work in
`e4d1f31`/`73984bd`:

- **Query-time canonicalization earns its place.** `murder mystery` was not a
  strict filter matching nothing — no stored tag contains a space, so it was
  unsatisfiable for any library. Resolving it to `mystery` reaches 65 books.
  This is a bug fix inside the hard-filter invariant, not a softening of it.
- **Automatic subtype expansion is a general mechanism for a long tail of
  singletons** — it buys `comedy-mystery(1)` and `humorous-mystery(1)`.
  Low stakes either way.
- **`relaxableTags` and the tool-owned retry should be removed.** They give
  `search_semantic` a two-pass control loop that reclassifies the caller's
  own constraints. §5.1 calls these tools "thin wrappers over §4", §4.3
  specifies one pass, and §5.2 assigns the hard-vs-soft decision to the
  planner per archetype. The mechanism was built to fix a failure whose
  actual cause was 569 missing embeddings.

*Order:* backfill embeddings → re-tag the broken rows → re-run Q1 → then
settle the `relaxableTags` question → then §10.C steps 6–7.

> **Resolved 2026-09-03.** Verified live against the homelab container
> (`audioshelf-librarian`, `/app/data/curator.db`), not inferred from the
> operation having been triggered:
>
> - `GET /api/readiness` reports **961/961 books embedded (100%), 0 stale**.
>   (965 → 961 is ordinary library drift between 08-28 and now, not a data
>   loss.) Something — the operation run directly, or the volume of card
>   changes from Wave A's R1–R3 (§ enrichment-sources-review.md) — completed
>   the backfill; the exact trigger wasn't captured in the action log at the
>   time of this check and isn't worth chasing further now that the state
>   itself is confirmed.
> - The Q1 diagnostic (`docs/phase-4-retrieval-query-proposal.md`) was
>   re-run for real against `POST /api/recommendations`, `scope: 'shelf'`,
>   using the approved wording verbatim: *"I'm in the mood for a murder
>   mystery at the beach — sunny, coastal, and more mystery than
>   thriller."* **Rank 1: `Relative Humidity: Key West Capers, Book 17`** —
>   exactly the expected title, and one of the four books this section
>   found with zero embedding on 08-28. `Virgin Heat` and `Key West Luck`
>   (also previously unembedded) place at #6 and #7. No hard-SF or
>   space-opera title appears above the Key West result — the stated pass
>   condition. Full response saved this session; ranked list transcribed
>   above.
> - Getting a clean run required two unrelated live-environment fixes,
>   neither a code change: the container's `ANTHROPIC_API_KEY` had gone
>   invalid and needed rotating (`recommendBooks` calls the LLM interpreter
>   before retrieval ever runs, so this masqueraded as a retrieval failure
>   at first), and the homelab's `ollama` container was down (exit 127,
>   traced to an Nvidia socket issue, resolved by a host reboot) — Ollama
>   serves `nomic-embed-text`, the query embedder `search_semantic` depends
>   on. Neither is a defect in this codebase; noted here only because both
>   read as "ranking is broken" from the API response before the real cause
>   surfaced.
>
> **Caveat carried forward, not closed by this test.** The interpreter's
> parsed `constraints` for this run came back thin (`genres: ["murder
> mystery"]`, `moods: ["sunny"]` — no explicit setting/coastal constraint),
> yet ranking still landed correctly. That means this pass leaned on the
> semantic/tag blend more than on tight constraint parsing, which is a
> reasonable way for Q1 to pass but is not proof every archetype's
> constraint parsing is solid. Q1 alone is not full acceptance — see the
> reopened §10.C steps 6–7 below.
>
> Second and third findings in this section (broken per-book tags;
> `relaxableTags` should be removed) are **still open** — this resolution
> covers only the embedding-coverage blocker itself. They remain live work,
> now unblocked rather than moot.

### Verified as still sound

- **Exclusions as hard SQL predicates, not vector arithmetic** — holds;
  nothing found in Phase 3 that argues for negative vector weighting.
- **Brute-force cosine, no vector DB** — holds at personal-library scale.
- **Grounding via external allowlists** — the Phase 1 exit test
  (`Ben Hannigan` repaired, `Adrian Dover` dropped) proves the mechanism;
  the ~40–50% Open Library coverage is handled by soft-absence semantics
  rather than blind trust.
