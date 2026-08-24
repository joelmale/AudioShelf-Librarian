# Curator architecture decisions

Decisions that outlive the build plan, with the reasoning that produced them
and the conditions under which they should be revisited.

These were extracted from `docs/librarian-engine-plan.md`, which is a build
artifact — it describes work to be done and goes stale as that work lands.
These do not. When a decision here conflicts with the plan, this file wins.

Related: [`data-flow.md`](./data-flow.md) for how the system actually fits
together.

---

## 1. Tag provenance is stored, not inferred

**Decision.** Every `book_tags` row carries `source`: `vocab` | `derived` |
`llm-open` | `abs` | `external:<provider>`.

**Why.** An LLM asked for 35 tags produces a mix of genuine facets,
unnormalized synonyms, and confident fabrications, and it reports the same
confidence for all three. Without provenance they are indistinguishable in
SQL, so no downstream feature can decide what to trust. Provenance is the
column that makes every other trust rule in this document expressible.

**Revisit if:** a source category stops meaning one thing — e.g. if
`external:*` ever spans providers with very different reliability, it needs
splitting rather than overloading.

---

## 2. Entity tags are grounded against an allowlist, or dropped

**Decision.** `character` tags are matched against `book_entities` (built
from Open Library, Audnexus, and later Wikidata). A miss is **dropped** when
the book has any person entities; ambiguous fuzzy matches are dropped rather
than resolved.

**Why.** The motivating example: a local model asked for tags on Stephen
King's *IT* returned `BenHannigan` (the character is Ben **Hanscom**) and
`AdrianDover` (a fusion of Adrian Mellon and Dorsey Corcoran). Open Library's
`person` facet contains both real names and neither invented one, so a
membership check catches both — and a unique fuzzy match *repairs* the first
rather than discarding it.

The uniqueness rule matters as much as the match: if two allowlist entries
could plausibly match a proposal, guessing produces a canonical-looking wrong
answer, which is worse than no tag at all.

**Cost accepted.** Open Library resolves roughly half of a typical library.
When there is no allowlist, grounding degrades to a description substring
check rather than to blind trust.

**Revisit if:** entity coverage rises enough (LibraryThing Common Knowledge
dump, Wikidata expansion) that a miss becomes strong evidence of a
fabrication even for obscure titles.

---

## 3. Computed facts are never asked of the model

**Decision.** `length` comes from `durationSeconds`, `era` from
`publishedYear`, both `source: 'derived'`, and both win their category over
any LLM tag. They were removed from the tagging prompt entirely.

**Why.** The original prompt asked the model to bucket a duration it was
already given. That is arithmetic delegated to a system that approximates —
it costs output tokens and introduces errors in exchange for nothing.

**Generalizes to:** anything derivable from data already in hand. If a future
facet can be computed, compute it.

---

## 4. Vocabulary grows from the library, not from a guess

**Decision.** The LLM proposes freely; a deterministic canonicalizer maps
proposals onto controlled terms; unmapped terms accumulate counts in
`vocab_terms` and surface in a promotion queue for human approval. Promotion
retroactively re-sources matching `llm-open` rows via `tag_aliases`.

**Why.** A hand-written vocabulary encodes whoever wrote it's assumptions
about the collection — the original was sci-fi-shaped because the plan author
assumed a sci-fi library. Letting terms earn their way in by appearing on N
books makes the vocabulary reflect the actual shelf. It also means the
expensive part (re-tagging) is usually unnecessary: promotion is an alias
remap, not a re-run.

**Corollary.** OCLC FAST alt-labels are imported as aliases **only for terms
already in the vocabulary** (`scripts/load-fast.ts`). Importing the whole
1.7M-term dump would swamp a personal library's vocabulary with headings
nothing uses.

---

## 5. No vector database

**Decision.** Embeddings are `Float32Array` BLOBs in SQLite, loaded into one
in-memory matrix, scored by brute-force cosine. No ANN index, no external
service.

**Why.** A personal audiobook library is hundreds to low thousands of books.
Brute-force cosine at that scale is sub-millisecond, while a vector database
adds an operational dependency, a schema to keep in sync, and a failure mode,
in exchange for solving a problem this system does not have.

**Revisit if:** the library exceeds roughly 50k books, or embeddings start
being computed per-chapter rather than per-book.

**Related.** Embeddings come from Ollama on the user's own hardware, behind
an injectable `EmbeddingCreator` interface (mirroring `MessageCreator`), so
tests are deterministic and offline.

---

## 6. Exclusions consider every tag; `trustedOnly` narrows inclusions only

**Decision.** `db.queryBooks`'s `trustedOnly` flag restricts `tag`,
`allTags`, and `anyTags` to non-`llm-open` provenance. **`excludeTags`
ignores it entirely** and always considers every tag.

**Why.** The two error directions are not symmetric. Over-excluding costs the
reader one candidate they might have enjoyed. Under-excluding returns a book
carrying the exact trope they said to avoid — violating a constraint they
stated outright. Unverified evidence is weak grounds *for* a book and
sufficient grounds *against* one.

**History, because this was contested.** The plan originally said both things
in different sections: §5.2 specified "trusted sources only" for exclusions,
§5.4 said an `llm-open` tag should still exclude. An implementation faithfully
followed §5.2 and shipped with 24 passing tests locking the unsafe behaviour
in, and a stale contract in `fixtures/library.ts`'s header propagated it to
three more agents. When corrected, a subsequent agent reverted it with a
reasoned argument: a SQL accessor should supply *mechanism* and the
librarian's trust rules should supply *policy*, since hard-coding a stance
into a data accessor makes it un-overridable.

That argument was overruled deliberately. `queryBooks` is the boundary
between a stated user constraint and a recommendation that reaches them, so
it fails safe rather than fails configurable. A documented footgun is still a
footgun, and the consumer above it is agent-written.

**If a caller genuinely needs trusted-only exclusions** (pruning a slate where
a low-confidence guess should not bury a good candidate), add an explicit
opt-in field. Do not re-widen `trustedOnly` — the unsafe combination should
be unreachable by accident.

**Cost accepted.** A low-confidence `llm-open` tag can suppress a book that
does not really carry that trope. This is why exclusions are paired with the
coverage disclosure rather than presented as certainty (see #7).

---

## 7. Exclusion honesty is a feature, not a caveat

**Decision.** An exclusion is only as good as tag coverage. The librarian
must report how many candidate books were actually audited for the excluded
facet, rather than implying a clean guarantee.

**Why.** "No chosen-one tropes" over a library where half the books were
never trope-tagged is not a filter, it is a coin flip presented as a filter.
Surfacing the gap is both more honest and more useful — it tells the reader
what to do next (audit those books).

**Implication for Phase 4.** The `tag_coverage` tool exists for this. It must
be called on exclusion queries, not treated as optional.

---

## 8. Rejection is SQL; attraction is embeddings

**Decision.** Negative constraints are hard SQL predicates. They are never
expressed as vector arithmetic — no subtracting an unwanted concept's
embedding, no negative weighting in the similarity computation.
`findSimilar`'s `acrossGenre` likewise excludes by set operation, then ranks
the survivors by cosine.

**Why.** Embedding arithmetic does not cleanly encode "not time travel". The
result is a direction in vector space that correlates with the concept and
also with unrelated things, producing quiet, unfalsifiable errors. A SQL
predicate either matched or did not, and can be tested.

---

## 9. Staleness is queryable, not event-driven

**Decision.** `getStaleEmbeddings()` compares stored `card_hash` against the
freshly composed card and returns books that differ *or were never embedded*
— one selector, one case. No hooks fire into the embedder from the vocabulary
routes, the enricher, or the tagger.

**Why.** Three existing operations mutate the data a card is built from, and
more will be added. Wiring callbacks from each would couple four modules to
the embedder and still miss whatever gets added next. A comparison catches
drift regardless of cause and self-heals on the next run.

**Cost accepted.** Semantic search can be stale between runs. Scheduling the
embedding operation after tag-mutating work is an orchestration concern,
deliberately kept out of the data layer.

---

## 10. Long-running work has one shape

**Decision.** Tagging, enrichment, and embedding share an operational
pattern: `p-limit` pool, `OperationController` checkpoints, `dryRun`,
`sample` mode, per-item failure isolation, action log, `sync_log`.
`core/tagger.ts` is the reference implementation.

**Why.** Beyond consistency for its own sake, this is what makes delegation
cheap: a work order that says "clone the operational shape of `tagger.ts`"
transfers a large amount of hard-won behaviour — partial-failure semantics,
cancellation, cost preview — in one sentence. Divergent implementations would
each need that reasoning re-derived and re-reviewed.

**Corollary.** `sample` mode is not a nicety. It is how a run's quality gets
checked against real data before the full cost is spent.
