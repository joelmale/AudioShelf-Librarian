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

## 0. Where we are today (baseline)

| Piece | State |
|---|---|
| Tagging | `tagger.ts` → single Haiku/Ollama call per book, 7 closed categories, ~7 tags/book. `agents/` orchestrator is a stub that duplicates API calls. |
| Vocabulary | Hardcoded sci-fi set in `tagQuality.ts` + prompt. OOV tags produce warnings nobody consumes. |
| Recommendations | `recommendations.ts` → one-shot LLM call over `buildTagSummary` (entire library serialized into a prompt), iTunes verification of external picks. |
| Retrieval | Exact-match SQL over `book_tags` (`queryBooks` filters). No semantic layer. |
| Conversation | None. MCP server at `/mcp` exposes 14 tools (incl. `query_library`) to external LLM clients. |
| Identifiers | `books.asin` and `books.isbn` synced from ABS — join keys for every external source exist already. |
| LLM infra | `LlmClient` with injectable `MessageCreator`, Anthropic + Ollama creators, `FallbackMessageCreator`, rate limiting, typed errors. |

Key structural fact: **a personal library is small** (hundreds to a few
thousand books). This drives the biggest simplification in the plan: no
vector database, no ANN index. Brute-force cosine over in-memory Float32
arrays is sub-millisecond at this scale. Everything stays in SQLite.

---

## 1. Data layer (SQLite migrations)

All migrations append to the existing `schema_migrations` sequence in
`db.ts`. Ship order matters — each is independently deployable to a live DB.

### 1.1 `book_tags.source` (Migration A — first, smallest, biggest trust win)

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

### 1.2 External metadata cache (Migration B)

```sql
CREATE TABLE external_metadata (
  book_id     TEXT NOT NULL,
  provider    TEXT NOT NULL,            -- 'openlibrary' | 'audnexus' | 'hardcover' | 'wikidata'
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

### 1.3 Grounded entities (Migration B)

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

### 1.4 Tag canonicalization + promotion queue (Migration C)

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

### 1.5 Embeddings + similarity edges (Migration D)

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

### 1.6 Feedback (Migration E, Phase 5)

```sql
CREATE TABLE rec_feedback (
  id          INTEGER PRIMARY KEY,
  book_id     TEXT,                     -- null for external recs
  external_key TEXT,                    -- 'title|author' for non-owned
  query_text  TEXT NOT NULL,
  verdict     TEXT NOT NULL,            -- 'accepted' | 'rejected' | 'finished' | 'abandoned'
  created_at  INTEGER NOT NULL
);
```

---

## 2. Enrichment clients (`core/enrichment/`)

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

### Providers, in build order

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
3. **`hardcoverProvider`** — free GraphQL (requires a token from the user's
   account; store in `secrets.json`, never settings). Community genre tags
   + ratings distribution → popularity/reception axis.
4. **`wikidataProvider`** — resolve QID via the Wikipedia pageprops trick
   (verified: "It (novel)" → Q602288), then `Special:EntityData/<QID>.json`
   for P674 (characters), P840 (narrative location), P136 (genre). Low
   recall, high precision — a confirmer, not a primary.

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

## 3. Tagging v2 — propose → canonicalize → ground → derive

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

## 4. Retrieval layer (`core/retrieval/`)

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

## 5. The librarian: query planner + agent loop

### 5.1 Architecture

Not a single-shot prompt (today's `recommendBooks` ceiling: serializing the
whole library into one context stops scaling and can't iterate). Instead an
**agentic tool loop**: the librarian LLM (cloud `COLLECTION_MODEL`,
Ollama fallback) gets tools and converses:

```
search_semantic(text, filters?, limit)        → hybrid-ranked books
filter_books(structured filters incl. excludeTags) → exact results
get_book(idOrTitle)                            → full card + tags + entities
find_similar(bookId, acrossGenre?: boolean)    → embedding neighbours
lookup_external(title, author)                 → OL/Hardcover/iTunes verify
tag_coverage(tags[])                           → how many books are tagged/untagged
                                                 for these tags (guardrail honesty)
```

These are thin wrappers over §4 — and they're **registered twice**: once
for the internal loop, once as MCP tools on the existing `/mcp` router.
That second registration means open-webui + local llama (the setup that
started this whole thread) becomes a librarian client for free, with tool
quality doing the heavy lifting rather than model quality.

Internal loop implementation: extend `LlmClient` with a `toolLoop()`
using the Anthropic messages tool-use API (creator interface grows a
`tools` field; Ollama creator maps to its tool-calling format). Max ~6
tool rounds, then forced answer. Every reply cites which books were
actually retrieved — the LLM may only recommend IDs that came back from a
tool call (schema-validated, like `tagResponseSchema`), which structurally
prevents hallucinated recommendations.

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
Planner: `get_book`/`lookup_external` resolves the anchor (owned or not —
external anchors get a card built from OL/Hardcover data on the fly).
Extract *transferable* qualities (theme:political, structure:multi-pov,
mood:witty) vs *replaced* facets (genre: hard-sci-fi → fantasy;
mood:+cozy/low-stakes). Then `find_similar(acrossGenre=true)` = cosine
neighbours with the anchor's genre **excluded** and target genre required.
Anchor vector minus nothing — the genre swap happens in SQL, the
structural similarity in embedding space. Successful transfers are written
to `book_edges(relation='comparable', source='llm')` so repeat questions
get faster and consistent.

**3) Context & cognitive load** — *"fast-paced, punchy, 45-min commute,
survivable 30-second zone-outs"*
Mostly deterministic: `pacing:fast-paced` (vocab-trusted),
`structure:linear` + `structure:single-pov` (the actual proxy for
zone-out-tolerance), `length:short|medium` preference, and — worth adding
during sync — per-book **median chapter duration** from ABS chapter data
as a `derived` metric (a 45-min commute pairs well with ~20-min chapters).
Little semantic search needed; this archetype is a structured query the
planner can express almost entirely in `filter_books`.

**4) Negative filtering & guardrails** — *"sprawling space opera, zero
chosen-one, no time travel, prefer hard magic/tech"*
Positive side: `genre:space-opera` + `length:long|epic` + semantic
"sprawling". Negative side: `excludeTags:[trope:chosen-one,
theme:time-travel]` as **hard SQL exclusion**, trusted sources only.
Then the honesty step, which is the part most engines skip: exclusion is
only as good as tagging coverage, so the planner calls
`tag_coverage(['trope:chosen-one'])` and the librarian reports it like a
librarian would: *"none of these five is tagged chosen-one; two of them
haven't been trope-audited yet, flagging that."* Books whose trope
coverage is empty get demoted, not silently included.

### 5.3 Surfaces

- **Backend**: `POST /api/curator/librarian/chat` (session in SQLite or
  in-memory ring), streaming over the existing SSE/WS plumbing
  (`api/sse.ts` pattern). Auth via existing role middleware.
- **Frontend**: new `/curate/librarian` route — the Librarian's Desk (§8);
  each recommendation renders as a book card (cover from ABS, tags, reason,
  play-in-ABS deep link) rather than prose only.
- **MCP**: the same tools at `/mcp` → open-webui, Claude Desktop, anything.

### 5.4 Trust rules (engine-wide invariants)

1. A recommendation must reference a book returned by a tool call in this
   conversation. Enforced by schema, not prompt.
2. Hard excludes ignore `llm-open` tags for *inclusion pardons* — an
   `llm-open` `trope:chosen-one` still excludes (cheap safety), but
   absence of trusted tags triggers the coverage disclosure.
3. External recommendations always pass the existing iTunes verification
   (`verifyExternal`) before display — that pipeline already works; reuse.
4. Every answer can explain itself: tags/entities/edges that produced each
   pick ride along in the response payload (the UI's "why this?" hover).

---

## 6. Feedback & personalization (Phase 5)

- Explicit: accept/reject/"more like this" buttons → `rec_feedback`.
- Implicit: ABS listening progress via the existing sync — finished fast =
  strong positive; abandoned at 10% = negative. Stored as feedback rows.
- Use: (a) a **taste centroid** — mean embedding of finished-and-liked
  books, added as a small prior term in the ranker; (b) recent feedback
  rows injected into the librarian's context ("you bounced off two
  slow-burn litfic picks last month"); (c) feedback edges in `book_edges`.
- Never let personalization override an explicit query constraint.

---

## 7. Phase map

| Phase | Ships | Touches | Exit criterion |
|---|---|---|---|
| **0. Hygiene** | Migration A (`source`), derived length/era, delete duplicate-call agents (fold into pipeline stub), trope/structure categories | `db.ts`, `types.ts`, `tagger.ts`, `agents/*`, `llmClient.ts` prompt | Re-tag run writes sourced tags; agent layer makes exactly 1 LLM call/book |
| **1. Enrichment** | Migrations B, provider interface, OL + Audnexus clients, enrichment runner + route + operation, `book_entities` | new `core/enrichment/`, `api/routes/` | IT-style fixture test: `Ben Hannigan` repaired to `Benjamin Hanscom`; `Adrian Dover` dropped |
| **2. Tagging v2** | Migration C, canonicalizer, grounding step, FAST loader script, promotion queue endpoint + UI panel | `core/tagging/` (renamed pipeline), `scripts/load-fast.ts`, frontend curate settings | Tag a sample: OOV rate reported, aliases collapse the friendship-cluster fixture, promotion round-trips |
| **3. Retrieval** | Migration D, book cards, Ollama embedder, embedding op, hybrid ranker, `find_similar` | new `core/retrieval/` | "melancholic coastal autumn" fixture returns hand-labeled expected ordering over a 30-book fixture library |
| **4. Librarian** | Tool loop in `LlmClient`, 6 tools (internal + MCP), chat route + SSE, frontend chat UI | `llmClient.ts`, `mcp/tools/`, `api/routes/librarian.ts`, frontend | All four archetype queries pass end-to-end tests with a scripted `MessageCreator`; open-webui can drive the same tools over MCP |
| **5. Feedback** | Migration E, feedback capture, taste centroid, ABS-progress signals; Hardcover + Wikidata providers; LT CK loader if dump obtained | `core/retrieval/ranker.ts`, sync, frontend | Ranker demonstrably shifts on synthetic feedback fixture |

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

## 8. UI/UX — The Librarian's Desk

Design stance: **transparency as theater, honesty as content.** The
animation and metaphors may be stylized, but every fact shown on screen is
sourced from a real event the engine emitted. We never render a fake step —
we render real steps *warmly*. This falls out of the architecture almost
for free: the tool loop (§5.1) already produces a discrete, ordered stream
of tool calls with inputs and result counts, and the backend already has
SSE/WS plumbing (`api/sse.ts`, action-log events). The UI is a renderer
over a trace that exists anyway.

### 8.1 The event contract

`POST /api/curator/librarian/chat` streams typed SSE events; this
vocabulary is a public contract that tests assert against:

```
interpretation  → the parsed query intent (chips, §8.2)
action          → one tool call: { tool, label, detail, resultSummary }
pile            → candidate-set diff: { added: [bookId], removed: [{bookId, reason}] }
answer          → final recommendations with per-book evidence
audit           → coverage/confidence disclosures (§5.4)
token           → streamed prose for the librarian's chat bubble
```

### 8.2 Query interpretation chips (the highest-value piece)

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

### 8.3 The desk feed (process theater)

A collapsible timeline beside the chat renders each `action` event as a
librarian doing librarian things. Fixed tool → verb mapping:

| Tool | Rendered as |
|---|---|
| `search_semantic` | "Browsing the stacks for *melancholic coastal autumn*… found 23" |
| `filter_books` | "Checking the card catalog — pacing: fast, structure: linear… 11 match" |
| `get_book` | "Pulling *Leviathan Wakes* off the shelf" |
| `find_similar` | "Walking the shelves near *The Expanse*… 8 neighbours" |
| `lookup_external` | "Calling another library about *The Tainted Cup*" |
| `tag_coverage` | "Double-checking my notes on chosen-one coverage… 2 books unaudited" |

`detail`/`resultSummary` are curated digests built server-side (never raw
JSON args). Each entry gets a small icon and a running count. The whole
feed collapses to a single "thinking" shimmer for users who don't care —
but it's the cool factor, so it defaults open.

### 8.4 The browsing pile

A shelf strip of small cover thumbnails that grows and shrinks as `pile`
events arrive: candidates slide in when a search adds them, and slide out
with a **reason chip** when a filter drops them — "22h — too long for a
commute", "tagged: time-travel", "you abandoned this author twice".
Representative, not exhaustive: the server caps pile events at the top ~15
covers so the animation stays legible; the count badge carries the truth
("23 candidates → 5"). Watching books get pulled and put back *is* the
algorithm, rendered honestly.

### 8.5 Recommendation cards with "Why this?"

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

### 8.6 The audit note

`audit` events render as a distinct footnote block under the answer,
styled like a librarian's margin note: *"None of these five is tagged
chosen-one. Two haven't been trope-audited yet — I've flagged them."* A
one-click "audit these now" action queues a targeted tagging run for the
flagged books. Honesty becomes a feature with a button, not a caveat.

### 8.7 Transparency beyond chat

- **Promotion queue** (Phase 2) as a "New vocabulary suggestions" panel in
  curate settings: proposed term, category, book count, sample books,
  promote/reject — the librarian visibly *learning your shelf's language*.
- **Enrichment status** per book: provider badges with fetched-at, and a
  library-level coverage bar ("64% of books have grounded entities").
- **Operation reuse**: tagging/enrichment/embedding runs surface through
  the existing operations UI (`/process/*`) — same progress components,
  new operation types.

---

## 9. Execution model — multi-role, multi-agent build

The build itself runs as an orchestrated agent team. One orchestrator
(the main Claude Code session) plans and reviews; role agents implement
under scoped work orders; the model tier is chosen per task to preserve
session quota — cheap models for pattern-following work in this
convention-heavy codebase, expensive models only where design judgment is
the bottleneck.

### 9.1 Roles

| Role | Model | Owns | Why this tier |
|---|---|---|---|
| **Orchestrator** | Fable (main session) | Work orders, sequencing, integration, merge, final review of every diff, all changes to safety-critical files (AGENTS.md list), hard debugging | Judgment-dense, low token volume |
| **Schema engineer** | Sonnet | Migrations A–E, `db.ts` accessors + tests | Fully specified in §1; follows existing migration pattern |
| **Enrichment engineer** | Sonnet | Provider clients, enricher runner, fixtures | API shapes already verified live; `fetchImpl` pattern established |
| **Pipeline engineer** | Sonnet impl / **Opus design** | Tagging v2: canonicalizer, grounding, derive; Opus designs the propose-prompt and fuzzy-match rules, Sonnet implements | Deterministic logic vs. prompt/algorithm design split |
| **Retrieval engineer** | Sonnet impl / **Opus design** | Book cards, embedder, brute-force store; Opus designs ranker weights + card composition | Same split |
| **Agent-loop engineer** | **Opus** | `LlmClient.toolLoop()`, planner, the 6 tools, librarian system prompt | Cross-cutting change to core infra; subtle failure modes |
| **Frontend engineer** | Sonnet | Desk UI (§8), chips, feed, pile, cards; SSE client | Component work against an explicit event contract |
| **Test engineer** | Sonnet (Haiku for fixture data) | 30-book fixture library, archetype regression suites, failure-path tests | Test design needs Sonnet; bulk fixture JSON is Haiku work |
| **Reviewer** | Opus | Pre-merge review pass per phase (`/code-review` style), adversarial on A4/C1/C2-class bugs | Second pair of eyes below Fable cost |

### 9.2 Model policy (quota rules)

1. **Haiku** — mechanical generation only: fixture datasets, alias seed
   lists, FAST dump parsing script boilerplate, doc updates. Never logic.
2. **Sonnet** — the default implementer. This codebase is convention-rich
   (injectable creators, operation controllers, colocated tests), and
   every work order names an exemplar file to imitate — which is exactly
   the regime where Sonnet ≈ Opus at a fraction of the cost.
3. **Opus** — reserved for design artifacts and the tool loop: places
   where a wrong early decision cascades.
4. **Fable** — orchestration only. Writes no bulk code. Reviews every
   diff, owns anything touching `organizer.ts`/`rollback.ts`/`scanner.ts`
   adjacency, secrets handling, or migrations against the live DB.

### 9.3 Work-order protocol

Every delegated task ships as a self-contained brief so the agent spends
zero quota re-exploring the repo:

- files to touch + files to imitate (e.g. "clone the operational shape of
  `tagger.ts`; inject fetch like `recommendations.ts#verifyExternal`");
- the exact contract (types/schemas copied into the brief);
- test expectations by name ("fixture test: `Ben Hannigan` →
  `Benjamin Hanscom`; `Adrian Dover` → dropped");
- done = `npm run typecheck && npm run lint && npm test` green, no new
  lint warnings (baseline must shrink, per AGENTS.md).

File-disjoint tasks run in parallel via worktree isolation; the
orchestrator merges. Anything touching a shared file (`db.ts`, `types.ts`,
`llmClient.ts`) is serialized through one agent per phase.

### 9.4 Phase → task → agent map

| Phase | Task | Agent (model) | Parallel? |
|---|---|---|---|
| 0 | Migration A + sourced accessors | Schema (Sonnet) | — |
| 0 | Derived length/era; delete stub agents; prompt trim | Pipeline (Sonnet) | after Migration A |
| 0 | Trope/structure categories + seed vocab | Pipeline (Sonnet) + Haiku for seed lists | ∥ with above |
| 1 | Migration B (cache + entities) | Schema (Sonnet) | — |
| 1 | OL provider · Audnexus provider | Enrichment (Sonnet) ×2 | ∥ worktrees |
| 1 | Enricher runner + route + operation | Enrichment (Sonnet) | after providers |
| 1 | IT-fixture grounding tests | Test (Sonnet) | ∥ |
| 2 | Migration C · canonicalizer · grounding step | Pipeline (Opus design → Sonnet impl) | — |
| 2 | FAST loader script | Haiku (parse) + Sonnet (integration) | ∥ |
| 2 | Promotion queue endpoint + panel | Frontend (Sonnet) | ∥ |
| 3 | Migration D · embedder · store | Retrieval (Sonnet) | — |
| 3 | Ranker + card composition | Retrieval (Opus design → Sonnet impl) | after store |
| 3 | 30-book fixture library + vibe regression | Test (Sonnet, Haiku fixtures) | ∥ |
| 4 | `toolLoop()` + planner + 6 tools + MCP registration | Agent-loop (Opus) | — |
| 4 | Chat route + SSE event contract | Agent-loop (Opus) → Sonnet | after loop |
| 4 | Desk UI: chips, feed, pile, cards, audit note | Frontend (Sonnet) | ∥ against event contract |
| 4 | Archetype end-to-end suites (scripted creator) | Test (Sonnet) | ∥ |
| 5 | Migration E · feedback capture · taste centroid | Retrieval (Sonnet) | — |
| 5 | Hardcover/Wikidata providers · LT CK loader | Enrichment (Sonnet) | ∥ |
| Every phase | Review pass, then merge | Reviewer (Opus) → Orchestrator (Fable) | gate |

The §8 event contract is what makes Phase 4's parallelism work: frontend
builds against the typed SSE vocabulary with a recorded-trace fixture
while the agent loop is still being written.
