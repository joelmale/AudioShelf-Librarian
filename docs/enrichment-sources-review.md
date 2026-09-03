# Enrichment sources — review and expansion recommendations

Reviewed 2026-09-01 against `HEAD` plus the current working tree, by reading
`core/enrichment/` end to end (five providers, the runner, `rebuild.ts`,
`rederive.ts`, `entityNotability.ts`), every consumer of `external_metadata`,
and `retrieval/bookCard.ts`.

This is a findings-and-recommendations document, not a third project plan.
Everything here is a proposal against `docs/librarian-engine-plan.md` §2 and
§10.M. Reconcile it against the plan before acting on it.

**Status as of 2026-09-02: R1, R2 and R3 are shipped and on `main`** (Wave A,
14 commits, `1add593..48fdabd`). F2, F3 and F4 are resolved; each is annotated
below with what actually landed and where it deviated from the recommendation
as written. R4–R8 are untouched and still sit behind §10.M's embedding
backfill — see §5 and §7.

## Status key

Reuses the plan's markers.

| | |
|---|---|
| ✅ | Shipped, tested, and on `main` |
| ⬜ | Not started |
| ⏸ | Parked by decision, not by dependency |

---

## 1. What the sources contribute today

Five providers are registered in `api/routes/enrichment.ts`; two of them are
conditional on a configured credential.

Updated 2026-09-02: the "never read" column is what Wave A closed.

| Provider | Auth | Writes `entities` | Writes `subjects` | Fetched, cached, and **never read** |
|---|---|---|---|---|
| `openlibrary` | keyless | person / place / time (MARC) | `subject[]` → `theme` (R1) | — |
| `audnexus` | keyless | **none** | genres + tags → `genre` (R1) | `rating`, `runtimeLengthMin` — ~~`narrators[]`~~ (R3), ~~`description`~~ (R2) |
| `googleBooks` | API key | **none** | BISAC, capped at 12 → `genre` (R1) | ~~`volumeInfo.description`~~ (R2) |
| `wikidata` | keyless | P674 characters, P840 place | P136 genre → `genre` (R1) | `sitelinks.enwiki.title` (R5 would use it) |
| `hardcover` | token | none (deliberate) | genres → `genre`, moods → `mood`, tags dropped (R1) | — (`rating` → `w_rec`) |

R1 reads Hardcover's facets from `raw` rather than the stored `subjects`,
because `subjectsFrom` flattens genres/moods/tags into one array before
storage and the mood/genre distinction is unrecoverable from it. See R1 below
for how the verified search hit is identified.

### Where each payload actually goes

Grepped, not assumed. As reviewed, `external_metadata` had exactly three
consumers:

1. `rebuild.ts#rebuildBookEntities` — reads `entities`, writes `book_entities`.
2. `enricher.ts#collectSubjects` — reads `subjects`, renders them in the
   `qualityReport` for a human to eyeball. **Nothing else.**
3. `librarian/tools.ts:557` — reads the `hardcover` row for the reception prior.

Wave A added three more, all cache-only (no `fetchImpl`, no network, `raw`
never mutated, `fetched_at` never advanced — the `rederive.ts` contract):

4. `promoteSubjects.ts#promoteSubjectsFromCache` — reads `subjects` (and, for
   Hardcover only, `raw`), writes `vocab_terms` proposals. **Closes F2.**
5. `descriptionBackfill.ts#backfillDescriptions` — reads `raw`'s descriptions,
   writes `books.description_enriched` / `description_source`. **Closes F3.**
6. `narratorBackfill.ts#backfillNarratorsFromCache` — reads `raw.narrators[]`,
   writes `books.narrator`. **Closes F4.**

What remains cached and read by nobody: Audnexus `rating` and
`runtimeLengthMin`, and Wikidata's `sitelinks.enwiki.title` (R5's input).

---

## 2. Findings

### F1. Only two of five providers produce entities, and neither covers this library

`book_entities` is fed by `openlibrary` and `wikidata` alone. Audnexus, Google
Books, and Hardcover all write `entities: []` — in Hardcover's case
deliberately and correctly (its taxonomy is genre/mood tags, not MARC person
headings; see its module docblock).

Plan §2 already records that Google Books moved grounded-entity coverage from
297 to 298 books. `wikidata.ts` is explicitly designed as a low-recall,
high-precision confirmer. So the 31% grounded-entity coverage that gates
`tagging/ground.ts#groundCharacter` rests almost entirely on Open Library's
MARC concordance.

Per §10.M, this library's population is indie and mid-list genre fiction —
the Laurence Shames Key West capers, 65 books tagged `mystery`, and a long
tail of singleton cozy subgenres. **That is precisely the population with no
MARC subject headings and no Wikidata item.** The gap is structural, not a
coverage percentage that a sixth bibliographic source would raise.

**Consequence for source selection:** LOC, VIAF, WorldCat, ISBNdb, and Bowker
all draw on the same cataloguing tradition and would fail in exactly the same
way, on exactly the same books. Sources that *do* cover this population are
reader-community and fandom sources. That single fact drives most of the
ranking in §3.

### F2. ✅ `subjects` is a dead-end field — *resolved by R1, 2026-09-02*

Every provider populates it. `EnrichmentPayload.subjects` is documented as
"candidate facet terms in the provider's own vocabulary". Plan §2's runner
spec says the output per book includes "stash provider `subjects` for the
canonicalizer".

That wiring does not exist. `collectSubjects` caps the union at 8 and hands it
to the QC report for display. No `vocab_terms` row, no `tag_aliases` row, no
promotion-queue entry, no tag.

Five providers' worth of BISAC codes, Audible genre tags, Wikidata P136
genres, and Hardcover **moods** are sitting in SQLite feeding nothing. The
Hardcover moods are the sharpest loss: `mood` is a first-class
`TAG_CATEGORIES` member and a required-ish axis for vibe queries, and
community mood tags map onto it more directly than anything an LLM proposes.

> **Resolved.** `promoteSubjects.ts` now routes every provider's cached
> subjects to a `TAG_CATEGORY` and files unknown terms as `vocab_terms`
> proposals with `origin='enrichment'`. Hardcover moods land in `mood`
> specifically, as this finding demanded.

### F3. ✅ Descriptions are fetched and discarded — *resolved by R2, 2026-09-02*

`googleBooks.ts:375` notes that a later extractor run can read
`raw.volumeInfo.description` without re-fetching. No such extractor exists.
Audnexus caches a `description` too. Neither is ever written anywhere.

`books.description` comes only from Audiobookshelf, and that value feeds two
distinct things:

- the `Description:` line of the embedding card (`bookCard.ts`, 800 chars);
- `entityNotability.ts#scoreOne`, where a name appearing in the description
  earns `DESCRIPTION_MATCH_SCORE` (+2) — enough on its own to clear
  `NOTABLE_THRESHOLD`.

On indie audiobooks the ABS description is frequently thin or absent. So a
missing description simultaneously starves the embedding *and* suppresses
entity notability for the exact books that already have the least metadata.
The failure compounds.

> **Resolved,** though not by writing `books.description` — see R2's errata.
> Both consumers named above now read through
> `descriptionText.ts#resolveDescription`, so a harvested description feeds
> the card *and* `DESCRIPTION_MATCH_SCORE` exactly as an ABS one does.

### F4. ✅ Narrator is parsed twice and stored zero times — *resolved by R3, 2026-09-02*

`audnexus.ts:57` declares `narrators?: Array<{ name?: string }>` and never
reads it. `absBookMetadataSchema` declares `narratorName`, and the only
consumer is `librarian/services/realign.ts:110`, which uses it to build a
folder name.

There is no `books.narrator` column, no card line, and no way to answer
"something narrated by R.C. Bray" or "a full-cast production". Narrator and
production style are the one retrieval axis no text-only book source can ever
supply, and this is an audiobook librarian.

`core/derivedTags.ts:31` already reasons about narrator/production as a
concept, which suggests the omission is an oversight rather than a decision.

> **Resolved.** `books.narrator` stores the list (JSON-encoded, mirroring
> `genres`), populated from ABS `narratorName` on every sync and from cached
> Audnexus payloads by `narratorBackfill.ts`. `composeBookCard` emits a
> `Narrator:` line between `Series:` and the tag categories.

### F5. Match verification is sound and is the thing that makes expansion safe

`providers/matching.ts` (`candidateTitlesFor`, `deinvertAuthor`,
`matchesBook`) is applied consistently: every search-based path in every
provider gates its hit through `matchesBook`, and only the ISBN/ASIN paths are
trusted verbatim, correctly. `throttle.ts` gives every provider a
module-scoped limiter, a `Retry-After`-aware penalty, and the rate-limit /
quota-exhausted split that keeps a throttle from being reported as a book's
failure.

This is the reason adding sources is a reasonable thing to consider at all: a
new provider inherits verification and back-off for free and cannot easily
introduce a false positive on its own. No recommendation below asks for a
loosening of it.

---

## 3. Recommendations, ordered by impact

Ordered by expected impact on what is actually blocked — grounded-entity
coverage, the unconsumed `subjects` stage, and embedding quality — with build
cost and risk as the tiebreak. Items R1–R3 require **no new network calls at
all**; they run against the 90-day cache already on disk.

### R1. ✅ Wire `subjects` into the canonicalizer — *highest impact, lowest cost*

**What:** give F2's dead-end field a consumer. Feed the union of cached
`subjects` into `tag_aliases` / `vocab_terms` and the promotion queue that
plan §1.4 and §3 already built.

**Why first:** it is the only item in this document that costs zero fetches,
zero quota, no new provider, no new failure mode, and no new external
dependency — and five sources are already filling it. It also changes the
value of every other recommendation here: until `subjects` has a consumer, a
sixth provider's subjects go to the same place the existing five's do, which
is nowhere.

**Shape:** a `rederive`-style pass over cached `'ok'` rows. `rederive.ts`
already demonstrates the pattern (walk cached payloads, recompute derived
parts, write, no network).

**Watch for:** BISAC strings are hierarchical (`FICTION / Mystery & Detective
/ Cozy`) and `googleBooks.ts#extractSubjects` already caps at 12 to stop an
over-categorized volume crowding out other providers. The canonicalizer needs
its own splitting rules; do not assume a subject string is a single term.
Hardcover moods deserve routing to `mood` specifically rather than into one
undifferentiated pool.

#### What shipped (2026-09-02)

`core/enrichment/promoteSubjects.ts#promoteSubjectsFromCache(db, options)`,
plus the pure `core/enrichment/subjectFacets.ts`. Route:
`POST /api/enrichment/subjects {dryRun?, bookIds?}`.

- **Category is a property of the provider *field*, never of the term.** A
  routing table (`SUBJECT_FACETS`) maps `(provider, facet) → TAG_CATEGORY`:
  Google Books BISAC / Audnexus `genres[]` / Wikidata P136 / Hardcover
  `genres` → `genre`; Hardcover `moods` → `mood`; Open Library `subject[]`
  (a MARC topical heading — "what the book is about") → `theme`. Hardcover
  `tags` are dropped. An unrecognised provider contributes nothing.
- **Splitting is not re-invented.** `splitHeading` / `isMachineTag` moved
  verbatim out of `googleBooks.ts` into `subjectFacets.ts` and now apply to
  every provider's strings. They are idempotent on their own output, so Google
  Books rows contribute exactly what they did before.
- **Noise control:** an exact-form stoplist kills top-level `FICTION`;
  `general` dies as a form and as a comma-blob token; a 40% library-share
  ceiling (`MAX_LIBRARY_SHARE`) kills Open Library boilerplate; and
  `MIN_BOOK_COUNT_FOR_PROPOSAL = 2` keeps single-book terms out of the queue.
  The 12-term cap is inherited per (book, provider, facet), applied *after*
  the stoplist so junk cannot burn a slot.
- **Writes nothing but `vocab_terms`.** No `book_tags`, no `tag_aliases`, no
  `external_metadata`. That is deliberate and load-bearing: `composeBookCard`
  includes tags of every source, so writing tags would invalidate `card_hash`
  library-wide and destroy §5's "R1 can land in parallel with the backfill"
  guarantee. Tests assert card hashes are unchanged after a full run.

**Deviation — R1 landed its own migrations.** `vocab_terms` gained `origin`
(`'tagger' | 'enrichment'`), `tagger_book_count` and `enrichment_book_count`.
Without `origin`, `refreshProposedVocabCounts` — which DELETEs every
`proposed` row not backed by an `llm-open` `book_tags` row — would silently
wipe everything R1 wrote on the first `GET /vocab/proposed`. The two count
columns exist because a term both passes propose would otherwise have its
`book_count` frozen; `book_count` is now `MAX(tagger, enrichment)`. Reviewed
after the fact against the live-DB bar (fresh vs. migrated `PRAGMA
table_info` identical; backfill is `UPDATE`-only) — but this broke the
single-schema-owner rule and is recorded here rather than glossed.

**Correctness note — Hardcover's verified hit.** `hardcoverFacets(raw,
verifiedSubjects)` identifies which of `raw`'s search hits `lookup()` actually
accepted by finding the one whose own genres+moods+tags union equals the row's
stored `subjects`; on a tie or no match it returns nothing rather than guess.
Trusting `hits[0]` instead attributes another book's moods to this book, since
Hardcover requests `per_page: 5` and multi-hit pages are normal. That premise
holds only while nothing rewrites stored `subjects`, so `hardcover.rederive()`
— which recomputed them from `hits[0]` — was **removed** (`48fdabd`);
`rederiveFromCache` now reports Hardcover rows as `rowsUnsupported`. Re-deriving
Hardcover safely needs the hook widened to take the whole payload, a change to
the shared `EnrichmentProvider` contract deliberately not made.

### R2. ✅ Backfill the effective description from cached payloads

**What:** where the effective description is null or below a threshold
length, fill it from `raw.volumeInfo.description` (Google Books) or
`raw.description` (Audnexus), with explicit provenance.

> **This recommendation's title changed, and that is the deviation.** R2 as
> written said "backfill `books.description`". It must not, and does not.
> `upsertBook` writes `description=@description` unconditionally on every ABS
> sync, so a harvested value written there would be nulled at the next sync,
> would make `bookContentEqual` report the book `updated` forever, and would
> flip `card_hash` back and forth on every sync/enrich cycle — an unbounded
> re-embed loop. Instead:
>
> - `books.description` stays the ABS mirror, untouched by R2.
> - A dedicated pair, `Book.descriptionEnriched` / `Book.descriptionSource`
>   (`DescriptionSource = 'audnexus' | 'googlebooks'`; `'abs'` deliberately
>   not a member), is written only by `CuratorDb#setEnrichedDescription` and
>   never by `upsertBook`.
> - Every consumer resolves at read time via
>   `descriptionText.ts#resolveDescription(book)`: ABS if non-empty after
>   trim, else the harvested text, else null.
>
> This makes "fill absences only" **structural** rather than a policy a future
> caller can forget, lets a later ABS description reclaim the field with zero
> reclamation code, and makes R2 reversible with one
> `UPDATE books SET description_enriched=NULL, description_source=NULL`.

**Why second:** zero fetches, and it fixes F3's compounding failure in both
directions at once — a better embedding card *and* a working
`DESCRIPTION_MATCH_SCORE` for entity notability. It raises the value of the
entity sources in R3/R5/R6 rather than competing with them.

**Watch for:** ABS is the user's own library metadata and should stay
authoritative; only fill absences, never overwrite. Google Books descriptions
sometimes carry publisher marketing HTML — strip it before it reaches a card.

#### What shipped (2026-09-02)

`core/enrichment/descriptionBackfill.ts#backfillDescriptions(db, providers,
options)` and the pure `core/enrichment/descriptionText.ts`. Route:
`POST /api/enrichment/backfill-descriptions {dryRun?, bookIds?}`, which on
completion re-embeds **only** `result.changedBookIds`.

- **Precedence** is the fixed constant `DESCRIPTION_SOURCE_PRECEDENCE =
  ['audnexus', 'googlebooks']` — Audnexus is audiobook-native and usually
  ASIN-keyed, i.e. the edition actually owned. The winner is recomputed
  deterministically from all currently-cached `'ok'` rows on every run, never
  "first write wins", so a backfilled description is re-replaceable only by
  the precedence function.
- **No length threshold.** A 40-character ABS blurb keeps the field. The only
  argument for a threshold is signal volume, and that is unmeasurable until
  §10.M's backfill has run.
- **Eligibility:** cleaned candidates must be ≥ `MIN_HARVESTED_DESCRIPTION_CHARS`
  (80) and ≤ `MAX_HARVESTED_DESCRIPTION_CHARS` (10 000); over-length is
  rejected rather than truncated and counted separately.
- **HTML** is cleaned by `cleanHarvestedDescription` at write time (`raw` keeps
  the original verbatim, so the rule can improve and re-run). Entities are
  decoded **before** tag-stripping — the reverse order lets entity-escaped
  markup survive the strip and then decode into live markup in card text.
- **Provenance is its own column, not `titleMetaSource`:** `updateTitleParse`
  overwrites `title_meta_source` wholesale from title-parse facts, so a
  `description` key there would be deleted by the next title-parse run.
- **Extraction** is an optional `extractDescription?(raw)` hook on
  `EnrichmentProvider`, implemented on `googlebooks` and `audnexus` only.
  A provider absent from the passed `providers` array is treated as *unknown*,
  not as "no candidate" — otherwise an unset `GOOGLE_BOOKS_API_KEY` (the
  provider is conditionally registered) would silently clear every
  Google-Books-sourced description library-wide.
  **Errata (2026-09-02, contract-widening adversarial review):** this is
  *aspirational, not implemented*. `computeDescriptionWinner`
  (`descriptionBackfill.ts`) just `continue`s past a provider absent from
  `providers`, so with no eligible candidate at all the caller clears the
  stored pair exactly as if the source had gone `'not-found'` — the
  library-wide-clear failure mode this paragraph says can't happen, can. Pinned
  by `descriptionBackfill.test.ts`'s "KNOWN DIVERGENCE from the R2 errata doc"
  test. Pre-existing, out of scope for the contract-widening commit; still
  unfixed.
- **`resolveDescription` reaches all seven read sites:** `bookCard.ts`,
  `enricher.ts` and `rederive.ts` (the `rebuildBookEntities` description
  argument, i.e. `entityNotability`'s `DESCRIPTION_MATCH_SCORE`),
  `tagging/compose.ts` (grounding + the has-description gate), `llmClient.ts`,
  and `recommendations.ts`.

### R3. ✅ Persist narrator, and put it on the card

**What:** a `books.narrator` column populated from ABS `narratorName` and
Audnexus `narrators[]`, plus a `Narrator:` line in `composeBookCard`.

**Why third:** zero fetches, and it opens a query axis that is currently
unanswerable at any cost. Ranked below R1/R2 only because it serves a narrower
band of queries than a working subject vocabulary or a working description.

**Watch for:** adding a card line changes `card_hash` for **every** book that
has a narrator — see the sequencing note in §5. Multi-narrator lists are also
a signal in themselves (full-cast production); store the list, not a joined
string.

#### What shipped (2026-09-02)

`books.narrator` (JSON-encoded list, decoded defensively exactly as `genres`
is; `null`, never `[]`), a `Narrator:` line in `composeBookCard` emitted
between `Series:` and the tag categories, and
`core/enrichment/narratorBackfill.ts#backfillNarratorsFromCache`. Route:
`POST /api/enrichment/narrator-backfill {dryRun?, bookIds?}`.

- **Two writers, one column.** `upsertBook` applies ABS's `narratorName` on
  every sync (comma-split via `parseNarrators`); the backfill fills from
  cached Audnexus `narrators[]`.
- **The card-hash invalidation is intended,** not a bug: every book with a
  narrator gets a new `card_hash` the moment this deploys, which is the
  re-embed trigger. Tests assert both directions — a narrator book's hash
  changes, and a narrator-less book's hash is byte-identical.

**Two sync-interaction bugs found in review, both fixed:**

1. `upsertBook` wrote `narrator=@narrator` unconditionally, so a sync where
   ABS reported no narrator erased whatever `setNarrator` had written and
   marked the book `updated` forever. Now
   `narrator=COALESCE(@narrator, narrator)`. The accepted consequence, which
   should be ratified rather than discovered later: **ABS can no longer clear
   a narrator.**
2. The backfill originally *overwrote* ABS's value with Audnexus's cleaner
   list (e.g. correcting a naive comma-split `"Bray, R.C."` to `"R.C. Bray"`).
   ABS's COALESCE write then reverted it on the next sync, and the two writers
   alternated forever — `card_hash` flipping every cycle, re-embedding the
   book indefinitely. The pass now **fills absences only**: it writes only
   where `books.narrator` is currently null. The cost is that a book whose ABS
   parse is already wrong-but-non-empty is not auto-corrected; `setNarrator`
   remains available for a targeted fix.

### R4. ⬜ Fandom series wikis via the MediaWiki API — *largest addressable gain on F1*

**What:** the curated cast and location lists that Wikidata provides only for
canonical works, obtained for indie series from their fan wikis.

**Why this is not scraping.** Fandom exposes a standard MediaWiki action API
at `https://{wiki}.fandom.com/api.php` — the same interface `wikidata.ts`
already speaks, with the same `list=`/`prop=` grammar. This is a sanctioned
read interface, not HTML parsing, and it inherits `throttle.ts`'s limiter and
descriptive User-Agent unchanged.

**Why it ranks above the cheaper R5/R6:** it is the only recommendation here
that targets the 69% of the library with *no* grounded entities. R5 mostly
re-serves books that already resolved on Wikidata — i.e. the covered
minority. R4 goes where the gap is.

**Shape — key on series, not on book.** This is what makes it bounded:

- ~965 books collapse to a few dozen distinct `books.series` values.
- One `series → wiki subdomain` mapping table, seeded by Fandom's search API
  and **confirmed once by a human** before use. A wrong mapping poisons an
  entire series' allowlist, so this must not be fully automatic.
- Extract via `list=categorymembers` on `Category:Characters` and
  `Category:Locations`.
- Cost: one request per series, cached indefinitely. Dozens of requests total,
  in perpetuity.

**The honest caveat, stated plainly.** These are *series*-level entities, and
`book_entities` is a *per-book* allowlist. A character introduced in book 1
would authorize a character tag on book 7. Given that the allowlist's purpose
is rejecting fabrications rather than asserting presence, this is a bounded
and probably acceptable loosening — but it **is** a loosening of the §2
premise, and it should be recorded as `sources: ['fandom']` so its effect on
tag quality can be measured separately and reverted independently.

**Licensing:** Fandom content is CC-BY-SA. Attribution is required if entities
are surfaced in the UI — the same condition plan §2 already accepted for
LibraryThing CK.

### R5. ⬜ Wikipedia extracts on the page Wikidata already verified

**What:** `wikidata.ts:371` reads `sitelinks.enwiki.title` to verify a match
and then discards it. For any book that passed P31 verification, one
additional `action=query&prop=extracts&exintro` call on that exact title
returns the article intro: dense, character-named prose, effectively a plot
summary.

**Why here:** the best value-per-request available — same API, same limiter,
same User-Agent, and the expensive part (resolving and *verifying* the right
work item, rejecting the film and the disambiguation page) is already done and
paid for. It ranks below R4 because it can only help books that already
resolved on Wikidata, which are largely the books that already have entities.

**Watch for:** the extract is a description-class field, so it feeds R2's
target and F3's notability score — meaning R5's real value depends on R2
existing. **R2 has since shipped and already answers the precedence
question — and already did the contract-widening part of it:** `'wikidata'`
(not a separate `'wikipedia'` member — see `descriptionText.ts`'s
`DESCRIPTION_SOURCE_PRECEDENCE` docblock for why splitting it out was
rejected) already sits in both `DescriptionSource` and
`DESCRIPTION_SOURCE_PRECEDENCE`, landed by the contract-widening commit
ahead of R5. What R5 actually adds is the provider's `extractDescription`
hook — give `wikidataProvider` one, reading the P31-verified enwiki extract
this section describes, and that flips the already-landed precedence slot
from inert to live (see `enrichment/types.ts`'s `extractDescription`
docblock for why an unimplemented hook doesn't disqualify a precedence
member, just keeps it from ever winning). Never write `books.description` —
that is the ABS mirror. R5 is purely additive to R2's winner computation,
which recomputes from all cached rows on every run.

**Rollback risk, not just an inert widening.** `'wikidata'` already sits in
`DESCRIPTION_SOURCE_PRECEDENCE` (contract-widening commit, 2026-09-02) with no
`extractDescription` hook, which today is a provable no-op — see
`core/types.ts`'s `descriptionSource` docblock and
`descriptionBackfill.test.ts`'s "DescriptionSource contract widening" suite.
Once R5 lands the hook and a full-library `refreshBefore` campaign attributes
books to `'wikidata'`, that stops being true in one direction: rolling the
deploy back to a pre-R5 build removes the hook again, and that build's *next*
`backfill-descriptions` run finds no eligible candidate for every
`'wikidata'`-attributed book and clears `description_enriched` for all of
them — a library-scale re-embed caused purely by the rollback, not by any
data change. Read-path retrieval during the rollback window is unaffected
(`resolveDescription` still returns the harvested text, just with
`source: null`); it is specifically the next backfill run that pays the cost.
Plan the rollback story (e.g. hold off running backfill again until rolling
forward) before running the campaign, not after.

### R6. ⬜ Audnexus chapter titles

**What:** chapter listings for a book we already resolve by ASIN. Named
chapters are a genuine signal for indie fiction: POV-character chapter names
yield a cast list for exactly the books Wikidata misses, and `Part One:` /
`Interlude` patterns yield `structure` tags.

**Verify before building.** The endpoint is believed to be
`GET /books/{asin}/chapters`, but this has **not** been confirmed against the
live API. Treat that as unverified in the same way `hardcover.ts` flags its
own GraphQL document, and confirm with a sample run before writing extraction
logic against it.

**Why here rather than higher:** the hit rate will be bimodal. Many
audiobooks ship with nothing but `Chapter 1 … Chapter N`, which yields
literally nothing. Where it does hit, it hits the exact gap — which is why it
is on the list at all despite the uncertainty.

**Watch for:** chapter titles are not verified against anything the way
`matchesBook` verifies a search hit. A character name extracted from a chapter
title is a *guess*, and `book_entities` is an allowlist where a false `person`
row authorizes a hallucinated tag. Gate it hard: require the name to also
appear in the description, or mark the entity's source so notability can
discount it.

### R7. ⏸ UCSD Book Graph offline dump — the folksonomy for `mood` and `pacing`

**What:** the reader-shelf frequency data plan §2 already names, used offline
to seed `vocab_terms` with the folksonomy terms real readers converge on.

**Why it matters:** community shelf and mood vocabulary is the single signal
that would most improve the `mood` and `pacing` categories, which are where
vibe queries live and where LLM-proposed tags are weakest (§10.M found
`setting: locations-and-place-vibes` — a prompt category label echoed back as
a tag).

**Why it is parked rather than scheduled:** it needs a manual one-time
download, and its licence is academic-use with no redistribution. That is fine
for a personal instance and not fine for anything shipped. No runtime
dependency, no per-book cost — it either happens or it doesn't, and nothing
else blocks on it.

**Do this before ever reconsidering §4's rejected sources.** It is the
legitimate route to the same signal.

### R8. ⬜ Open Library work records — GATED, not built (Wave C, 2026-09-03)

**What:** the provider only ever hits `search.json`, which returns the search
document. `/works/{key}.json` — on a key already resolved and verified — adds
`description` and `first_sentence`.

**Why last:** genuinely marginal. One extra request per already-matched book,
for a description that Google Books usually already supplied.

**Wave C decision: gate behind a coverage measurement, do not build
unconditionally.** Three code facts, not just the marginality argument above,
drove this:

1. `providers/openLibrary.ts`'s `FIELDS` constant has never contained a
   description-class field (`git log -S'const FIELDS'` shows one commit,
   `530b123`, unchanged since). Every cached `openlibrary` `raw` today is a
   bare search doc — an `extractDescription` hook added ahead of the work
   fetch is provably dead code, unreachable against any real cached row.
2. R5 lands `wikidataProvider`'s `extractDescription` hook (the
   `'wikidata'` precedence slot itself already landed with the contract
   widening — see the R5 section above; R5 does not touch
   `DESCRIPTION_SOURCE_PRECEDENCE`). Once that hook ships and its
   `refreshBefore` campaign completes, `computeDescriptionWinner` — which
   recomputes every book's winner from all cached rows on every run — starts
   letting `'wikidata'` actually win where it previously never could. The
   "books with no effective description" population that gates R8 shrinks
   the moment that campaign finishes, so measuring before it lands measures
   a number that is about to change.
3. Acquisition is not free even though the request is, but it is far
   cheaper than a naive reading suggests. `OK_TTL_MS` is 90 days, so reaching
   an already-cached book's fields at all needs a `refreshBefore` campaign —
   but `EnrichmentOptions.bookIds` (`enricher.ts:68`, honoured together with
   `refreshBefore` in `db.ts#getEnrichmentCandidates`) scopes that campaign
   to an explicit book-ID list instead of the whole library. Seeded from
   Gate B's own result set (see design point 10 below), a campaign over a
   just-cleared-the-threshold-sized set (dozens of books, not 965) costs
   dozens of books x 5 providers — minutes of Wikidata floor time, well
   inside one day of Google Books quota — not the full-library cost a bare
   `refresh: true` would incur. Still not free, but not the blocker this
   bullet used to imply either.

**The gate query in this doc's earlier draft was wrong and must not be
used**: `SELECT description_source, COUNT(*) FROM books GROUP BY 1`'s null
bucket conflates books that already have a good ABS description (which
`resolveDescription` prefers and R8 could never displace) with books that
have no `openlibrary` row at all (which R8 cannot reach for lack of a
verified key) — it over-reports the gap in both directions. The correct gate
is two queries, run by the operator against the live `curator.db`, valid
**only after both** `POST /api/enrichment/backfill-descriptions {}` (non-dry)
**and** R5's `refreshBefore` campaign have completed:

```sql
-- Gate A: the true effective-description distribution (mirrors
-- descriptionText.ts#resolveDescription's trim() !== '' presence rule).
-- NOTE: SQLite's one-argument TRIM() strips only U+0020 (space) — a
-- '\n\n'/'\r\n'/'\t'-only value passes its `<> ''` test and misclassifies as
-- 'abs' where resolveDescription (JS .trim(), which strips all Unicode
-- whitespace) treats it as absent. The explicit two-argument form below
-- strips space/tab/LF/CR, matching JS .trim() on any value this schema can
-- actually hold. Verified against a live in-memory build of this schema: the
-- one-argument form undercounted the addressable population by 67% on a
-- fixture mixing '\n\n'/'\r\n'/'\t' values (all Windows/Docker-plausible).
SELECT CASE
    WHEN TRIM(COALESCE(description,''), ' ' || char(9) || char(10) || char(13)) <> ''
      THEN 'abs'
    WHEN COALESCE(description_enriched,'') <> '' THEN COALESCE(description_source,'unknown')
    ELSE 'none'
  END AS effective_source, COUNT(*)
FROM books WHERE sync_status='active' GROUP BY 1;

-- Gate B: R8's maximum addressable population — no effective description,
-- AND already holds a verified Open Library work key. This is a ceiling:
-- work records frequently carry no description at all, so realised yield is
-- strictly lower. Same TRIM correction as Gate A. `description_enriched`
-- is compared with COALESCE(...,'')<>'' rather than IS NOT NULL for the same
-- reason resolveDescription checks `.length > 0` and not merely
-- non-null — currently unreachable in practice (setEnrichedDescription
-- writes `text ?? null`, and callers only pass text past
-- MIN_HARVESTED_DESCRIPTION_CHARS), but the belt-and-suspenders form costs
-- nothing and removes the trap if that ever changes.
SELECT COUNT(*) FROM books b
WHERE b.sync_status='active'
  AND TRIM(COALESCE(b.description,''), ' ' || char(9) || char(10) || char(13))=''
  AND COALESCE(b.description_enriched,'')=''
  AND EXISTS (
    SELECT 1 FROM external_metadata em
    WHERE em.book_id=b.id AND em.provider='openlibrary' AND em.status='ok'
  );
```

**Threshold: build R8 only if Gate B returns >= 50 active books** (~5% of the
965-book library — a policy number in the same class as R1's
`MIN_BOOK_COUNT_FOR_PROPOSAL` and `MAX_LIBRARY_SHARE`; moving it is a human
call and must be recorded here with the date). Below 50, R8 stays unstarted.

**As of this entry, the gate has not been run**: this worktree's base
predates both R5 landing and a completed `backfill-descriptions` run, so
running it now would measure a population R5 is about to shrink. No R8 code
was written — `providers/openLibrary.ts` and its test are untouched, and no
`extractDescription` hook was added to it. Re-run this gate after R5 lands
and backfill completes, and record the two counts and the date here.

**What is, and is not, already done to `DescriptionSource`.** Do not treat
this as an open item when the gate clears — `'openlibrary'` is already a
member of both `DESCRIPTION_SOURCES` (`core/types.ts`) and
`DESCRIPTION_SOURCE_PRECEDENCE` (`descriptionText.ts`, as the last-position
floor — see that array's docblock), landed by the contract-widening commit
ahead of this branch. That widening is presently inert: it is
mutation-tested — deleting `'openlibrary'` from `DESCRIPTION_SOURCES` fails
`descriptionText.test.ts`'s "DescriptionSource contract shape (R5/R8
widening)" suite, proving the member is load-bearing contract shape, not
dead text; nothing else changes, proving it does nothing yet. What
implementing R8 actually adds is `openLibraryProvider.extractDescription`
(design point 8 below) — that is what flips the slot from inert to live
(`enrichment/types.ts`'s `extractDescription` docblock explains why an
unimplemented hook doesn't disqualify a precedence member, just keeps it
from ever winning). **Tripwire to expect:**
`descriptionBackfill.test.ts`'s "production precondition this decision
rests on" test currently asserts `openLibraryProvider.extractDescription` is
`undefined`, as a guard against the hook landing without a description-
bearing work-record fetch behind it. Adding the hook without updating that
specific assertion will fail it by design — update it as part of the same
change, not as a surprise to debug.

**If the gate opens, here is the full binding design** — identifier source,
key validation, throttling, failure taxonomy, precedence position, and the
`first_sentence` exclusion. There is no separate discussion document this
points to; it is recorded here in full so a future implementer does not have
to re-derive it (in particular point 5 below, whose whole point is to
prevent an R8 regression from ever reaching production):

1. **Identifier source.** The work key already lives in the cached search
   doc: the matched `OpenLibraryDoc.key` (e.g. `/works/OL123456W`) that
   `toPayload` stores verbatim as `EnrichmentPayload.raw.key` today. R8
   reads that field from the already-cached row — it does not search again
   and does not accept a key from anywhere else. This is what keeps R8
   inside F5's constraint: the key was already produced by a
   `matchesBook`-verified search hit, so R8 spends no new trust, only one
   new request against an already-verified identifier.
2. **Key validation.** Open Library's search `key` field is not guaranteed
   to be a work key — some hits key off an edition (`/books/OL...M`).
   Validate `/^\/works\/OL\d+W$/` before fetching; a non-matching key is
   treated as "no work record" (silently, same as a missing key), never as
   an error.
3. **URL construction.** `` `https://openlibrary.org${key}.json` `` — `key`
   already carries the leading `/works/` segment, so prefixing it again
   produces `/works/works/OL...W.json`, a guaranteed 404. And `key` is pure
   `[A-Za-z0-9/]`, so running it through `encodeURIComponent` would
   percent-encode its slashes and break the path. Neither transformation is
   applied; the key is spliced in as-is.
4. **Throttling.** The same module-scoped limiter `runSearch` already uses
   (`OPEN_LIBRARY_MIN_INTERVAL_MS`, `throttle.ts`) — the work-record fetch
   is a second request against the same host and must serialize behind the
   same 1 req/s budget, not acquire its own limiter.
5. **Failure taxonomy — never downgrades a successful match.** A `lookup()`
   call that already has a verified search-doc match must not let the
   follow-up work-record fetch's failure (404 — many work keys genuinely
   have no work-level JSON — timeout, or malformed response) turn what
   would be an 'ok' row into 'error' and discard the entities/subjects the
   search hit already earned. That would be a strict regression from
   pre-R8 behaviour, which returns 'ok' with no description at all for the
   same book. The work-record fetch is wrapped in its own try/catch inside
   `lookup()`; any failure there is swallowed (not rethrown, not treated as
   the provider's failure) and `toPayload` proceeds from the search doc
   alone. The one exception: a 429/503 from the work-record fetch still
   calls `limiter.penalize` and is thrown via `markRateLimited`, exactly as
   `runSearch` does today — throttling is a pool-wide signal and must
   propagate regardless of which endpoint tripped it.
6. **`first_sentence` is excluded, unconditionally.** Never read as a
   fallback for `description`, even when `description` is absent. Open
   Library's `first_sentence` is frequently a stock catalogued lead-in, not
   independent prose, and it is a structurally different field (`{value,
   lang}` in OL's schema, same shape as `description` sometimes takes) —
   silently treating it as a description substitute would make one contract
   slot mean two different things depending on which field happened to be
   populated.
7. **Payload shape — omit the key when the value is absent.** On a
   successful work-record fetch, `raw` becomes `{ ...searchDoc, work:
   workDoc }`; on no key, a validation failure, or a swallowed fetch
   failure, `raw` stays exactly the bare search doc it is today — no
   `work: undefined` key is ever attached. This is what keeps every
   existing `openLibrary.test.ts` assertion that checks `raw` against the
   bare search doc passing unmodified: an absent property round-trips
   through `toEqual` identically to one that was never added.
8. **`extractDescription` hook.** Reads `raw.work?.description` — a plain
   string in most work records, but OL sometimes nests it as `{value:
   string, type: 'work'}` the same way it nests `first_sentence`, so the
   hook must accept either shape — and returns it verbatim (uncleaned, per
   the hook's contract), `null` when absent or `raw.work` doesn't exist.
9. **Precedence position.** Already landed — `'openlibrary'` sits last in
   `DESCRIPTION_SOURCE_PRECEDENCE` as a floor (see that array's docblock).
   Nothing to change here when the gate opens; see the note above this list.
10. **Acquisition.** `POST /api/enrichment/run {"refresh": true, "bookIds":
    [...]}` seeded from Gate B's own row IDs — never a bare `refresh: true`.
    `EnrichmentOptions.bookIds` and `refreshBefore` compose (both honoured
    together by `db.ts#getEnrichmentCandidates`), which is what keeps the
    campaign scoped to the addressable population instead of the whole
    library — see rationale #3 above for the corrected cost.

**Same rollback risk as R5** (see that section): once R8 gives
`openlibrary` an `extractDescription` hook and a `refreshBefore` campaign
attributes books to it, rolling back to a pre-R8 build makes that build's next
`backfill-descriptions` run clear every `'openlibrary'`-attributed book's
harvested description and re-embed it. `'openlibrary'` is a floor in
`DESCRIPTION_SOURCE_PRECEDENCE`, so the affected population is whatever has no
higher-precedence source — plan for that before running the campaign.

---

## 4. Sources considered and rejected

| Source | Why not |
|---|---|
| LOC, VIAF, WorldCat | Same MARC cataloguing tradition as Open Library. Would miss exactly the same indie/mid-list books, for the same reason (F1). No new coverage. |
| ISBNdb, Bowker | Paid, edition-level bibliographic data. No entities, no subjects worth having. |
| Goodreads | API retired in 2020. What remains is Cloudflare-fronted HTML behind a ToS that forbids it. Use R7 for the same signal instead. |
| StoryGraph | No public API. Same reasoning as Goodreads. |
| Audible / Amazon HTML | Aggressive anti-bot, and against ToS. `audnexus` exists precisely so this is unnecessary. |
| LibraryThing CK | Already parked in plan §2; full feeds 404 as verified there. Nothing has changed. Stays parked. |
| Author websites / series bibles | Genuinely unstructured, one-off parsers per site, no leverage. The effort belongs in R4 instead, which gets the same class of data from a structured API. |
| AudiobookDB | Plan §2 asks whether it has superseded Audnexus. Worth a look during R6, but the `EnrichmentProvider` interface already isolates the choice, so it is a swap and not an addition. |

---

## 5. Sequencing

**Card-hash invalidation is the constraint.** `composeBookCard` includes
notable entities and the description, and `book_embeddings.card_hash` drives
re-embedding. R2, R3, R4, R5, and R6 all change card text, and R3 changes it
for essentially every book.

§10.M's embedding backfill is the stated live blocker: 569 of 965 books have
no vector, and four of the five expected Q1 winners are among them. Nothing
downstream is measurable until it runs.

The tension resolved like this — **the "land them first" branch was taken**
(R1–R3 shipped 2026-09-02, before the backfill):

- R1 does **not** touch card text. It landed with no interaction, and can be
  run at any time, including during the backfill.
- R2 and R3 landed first, saving a full second re-embed pass over 965 books.
- R4–R8 should follow the backfill regardless. They are new-source work, they
  will each invalidate hashes anyway, and `reembedAffectedBooks` already
  scopes a re-embed to the books an enrichment run actually touched.

**Run order now that R1–R3 are deployed.** All three passes are cache-only and
idempotent, so the sequence is safe to repeat:

1. `POST /api/enrichment/subjects {"dryRun": true}` → review → real run.
   Card-neutral; no re-embed consequence.
2. `POST /api/enrichment/backfill-descriptions {"dryRun": true}` → real run.
3. `POST /api/enrichment/narrator-backfill {"dryRun": true}` → real run.
4. `GET /api/embeddings/coverage` to size the pool, then
   `POST /api/embeddings/run` — `{"dryRun": true}`, then `{"sample": true}`,
   then the full run.

Doing 2 and 3 *before* 4 is the point: both change card text, and the full
embedding run then covers everything once. Their routes trigger a scoped
re-embed of only the books they changed, so running them first keeps that
scoped work near-empty. Note that books whose narrator came from ABS have an
invalidated `card_hash` with no scoped re-embed to cover them — they are
picked up by `getStaleEmbeddings` during step 4, which is precisely why step 4
comes last.

**A library-sized re-check is now survivable.** `EnrichmentOptions.refreshBefore`
(the campaign epoch added to `enricher.ts`) means a refresh run that cannot
finish inside Google Books' 1000/day quota resumes where it stopped instead of
re-burning the day on the same alphabetical head. Any recommendation here that
needs a full-library refresh — R4, R5, R6, R8 — depends on that mechanism and
should use it rather than a bare `refresh: true`.

## 6. Suggested order of work

1. ✅ **R1** — `subjects` → canonicalizer. Zero cost, unblocks a whole stage.
2. ✅ **R2** — description backfill from cache.
3. ✅ **R3** — narrator column and card line.
4. **← YOU ARE HERE.** *(§10.M embedding backfill — existing blocker, per the
   sequencing note above. 569 of 965 books have no vector, and R2/R3 have now
   invalidated `card_hash` for the books they touched, so the pool is larger
   than 569. This is an operational run, not agent work.)*
5. **R4** — Fandom series wikis, behind a human-confirmed series mapping.
6. **R5** — Wikipedia extracts on already-verified pages.
7. **R6** — Audnexus chapters, after verifying the endpoint lives.
8. **R7** — UCSD Book Graph, whenever the dump is obtained.
9. **R8** — Open Library work records, only if R2 leaves a gap. **Gated, not
   built** (Wave C, 2026-09-03): the gate query is corrected and the
   threshold recorded in §3 R8 above; it must be run by the operator against
   the live `curator.db` after backfill-descriptions and R5 have both
   landed, and only proceeds if it clears 50 books.

---

## 7. Carried forward from Wave A

Known-and-unfixed as of `48fdabd`. None blocks §10.M; all were surfaced by
adversarial review rather than found in production.

### Correctness

- **`hardcoverReceptionPrior` still trusts `hits[0]`.** Same defect class as
  the one R1 fixed in `hardcoverFacets`, still live, and it feeds the `w_rec`
  reception prior at `librarian/tools.ts:557`. On a multi-hit row it scores an
  unrelated book's rating as this book's. The call site already passes
  `cached.payload`, so it has the stored `subjects` needed to identify the
  verified hit the same way `hardcoverFacets` does — the fix is to widen the
  signature and reuse that selection, not to invent anything.
- **A `vocab_terms` row can reach a state neither refresh pass will collect.**
  `refreshEnrichmentVocabProposals` only considers rows with
  `enrichment_book_count > 0`, and `refreshProposedVocabCounts`' blanket
  DELETE is scoped `origin='tagger'`. A row that ends `proposed` /
  `origin='enrichment'` / both counts `0` is unreachable by both, and shows up
  as a permanent 0-book entry in `GET /vocab/proposed` — dismissible only by a
  human rejecting it. The mirror-image case self-heals; the asymmetry is the
  bug.

### Observability

- **Hardcover's multi-hit tie is silent.** When two hits tie on their facet
  union, `hardcoverFacets` correctly returns nothing rather than guess — but
  there is no counter, so `byProvider.hardcover` reporting zero terms is
  indistinguishable from "Hardcover had no facets" and from "the routing table
  dropped everything". Given Hardcover moods are F2's sharpest win, a healthy
  zero and a discarded one need to be tellable apart.

### Test gaps (each verified by neutralising the code and watching nothing fail)

- The stoplist-before-cap ordering is guarded in `subjectFacets.ts` but not in
  `promoteSubjects.ts`' own loop.
- The `try/finally` that closes the `sync_log` row on a late failure has no
  test; without it a tail failure leaves the row `running` forever.
- `origin` reaching the frontend vocab panel is unasserted end to end, as is
  the `POST /enrichment/subjects` route itself.
- One backend test failed exactly once during integration and could not be
  reproduced in five subsequent full runs; it was not identified. Recorded
  here so a recurrence is recognised rather than re-diagnosed.

### Process

- **R1 landed schema outside the single-owner rule** (`vocab_terms.origin`,
  `tagger_book_count`, `enrichment_book_count`) after the designated schema
  owner had already merged. Reviewed after the fact and found safe, but the
  rule was broken; see R1's deviation note.
- **R2 edited files outside its declared ownership** (`bookCard.ts`,
  `compose.ts`, `llmClient.ts`, `recommendations.ts`) because wiring
  `resolveDescription` to its consumers is inherently cross-cutting. That was
  a scoping error in the brief, not agent misbehaviour — a slice that adds a
  read-time resolver owns its call sites by definition.
