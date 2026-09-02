# Enrichment sources — review and expansion recommendations

Reviewed 2026-09-01 against `HEAD` plus the current working tree, by reading
`core/enrichment/` end to end (five providers, the runner, `rebuild.ts`,
`rederive.ts`, `entityNotability.ts`), every consumer of `external_metadata`,
and `retrieval/bookCard.ts`.

This is a findings-and-recommendations document, not a third project plan.
Everything here is a proposal against `docs/librarian-engine-plan.md` §2 and
§10.M; nothing in it has been built. Reconcile it against the plan before
acting on it.

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

| Provider | Auth | Writes `entities` | Writes `subjects` | Fetched, cached, and **never read** |
|---|---|---|---|---|
| `openlibrary` | keyless | person / place / time (MARC) | `subject[]` | — |
| `audnexus` | keyless | **none** | genres + tags | `narrators[]`, `rating`, `runtimeLengthMin`, `description` |
| `googleBooks` | API key | **none** | BISAC, capped at 12 | `volumeInfo.description` |
| `wikidata` | keyless | P674 characters, P840 place | P136 genre | `sitelinks.enwiki.title` |
| `hardcover` | token | none (deliberate) | genres / moods / tags | — (`rating` → `w_rec`) |

### Where each payload actually goes

Grepped, not assumed. `external_metadata` has exactly three consumers:

1. `rebuild.ts#rebuildBookEntities` — reads `entities`, writes `book_entities`.
2. `enricher.ts#collectSubjects` — reads `subjects`, renders them in the
   `qualityReport` for a human to eyeball. **Nothing else.**
3. `librarian/tools.ts:553` — reads the `hardcover` row for the reception prior.

Everything else in `raw` is cached verbatim and read by nobody.

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

### F2. `subjects` is a dead-end field

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

### F3. Descriptions are fetched and discarded

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

### F4. Narrator is parsed twice and stored zero times

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

### R1. ⬜ Wire `subjects` into the canonicalizer — *highest impact, lowest cost*

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

### R2. ⬜ Backfill `books.description` from cached payloads

**What:** where the effective description is null or below a threshold
length, fill it from `raw.volumeInfo.description` (Google Books) or
`raw.description` (Audnexus), with explicit provenance.

> **Errata (2026-09-01, post schema/migration commit):** the schema that
> landed for this does **not** follow the `titleMetaSource` precedent of
> writing straight into `books.description` with a sidecar provenance map.
> It instead added a dedicated column pair — `Book.descriptionEnriched` /
> `Book.descriptionSource` (type `DescriptionSource`, both defined in
> `core/types.ts`) — that `CuratorDb#setEnrichedDescription` writes and
> `upsertBook` never touches, so ABS's own `books.description` mirror can
> never be clobbered by a harvested value and vice versa. **The R2
> implementation MUST target this pair, not `books.description`:** call
> `setEnrichedDescription`, import `DescriptionSource` from `core/types.js`
> rather than redeclaring it (it's `'audnexus' | 'googlebooks'` — `'abs'` is
> deliberately not a member), and read the effective description everywhere
> through `core/enrichment/descriptionText.ts#resolveDescription` (not yet
> built — this slice's job) rather than `book.description` directly. That
> resolver is also what still needs to reach `bookCard.ts`'s `Description:`
> line and `entityNotability.ts#scoreOne`'s `DESCRIPTION_MATCH_SCORE` — until
> it does, R2 has no live consumer even once the backfill pass itself is
> written.

**Why second:** zero fetches, and it fixes F3's compounding failure in both
directions at once — a better embedding card *and* a working
`DESCRIPTION_MATCH_SCORE` for entity notability. It raises the value of the
entity sources in R3/R5/R6 rather than competing with them.

**Watch for:** ABS is the user's own library metadata and should stay
authoritative; only fill absences, never overwrite. Google Books descriptions
sometimes carry publisher marketing HTML — strip it before it reaches a card.

### R3. ⬜ Persist narrator, and put it on the card

**What:** a `books.narrator` column populated from ABS `narratorName` and
Audnexus `narrators[]`, plus a `Narrator:` line in `composeBookCard`.

**Why third:** zero fetches, and it opens a query axis that is currently
unanswerable at any cost. Ranked below R1/R2 only because it serves a narrower
band of queries than a working subject vocabulary or a working description.

**Watch for:** adding a card line changes `card_hash` for **every** book that
has a narrator — see the sequencing note in §5. Multi-narrator lists are also
a signal in themselves (full-cast production); store the list, not a joined
string.

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
existing. Do not write it into `books.description` ahead of ABS or Google
Books without deciding a precedence order.

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

### R8. ⬜ Open Library work records

**What:** the provider only ever hits `search.json`, which returns the search
document. `/works/{key}.json` — on a key already resolved and verified — adds
`description` and `first_sentence`.

**Why last:** genuinely marginal. One extra request per already-matched book,
for a description that Google Books usually already supplied. Listed for
completeness; do it only if R2 finds Google Books' description coverage
inadequate.

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

The tension resolves like this:

- R1 does **not** touch card text. It can land at any time, in parallel with
  the backfill, with no interaction.
- R2 and R3 are small and zero-fetch. If they can land within days, landing
  them first saves a full second re-embed pass over 965 books.
- If they would take weeks, **run the backfill now and accept the re-embed.**
  §10.M is blocking acceptance; a saved re-embed pass is not worth stalling
  it. Scaling that call is Joel's, not an agent's.
- R4–R8 should follow the backfill regardless. They are new-source work, they
  will each invalidate hashes anyway, and `reembedAffectedBooks` already
  scopes a re-embed to the books an enrichment run actually touched.

**A library-sized re-check is now survivable.** `EnrichmentOptions.refreshBefore`
(the campaign epoch added to `enricher.ts`) means a refresh run that cannot
finish inside Google Books' 1000/day quota resumes where it stopped instead of
re-burning the day on the same alphabetical head. Any recommendation here that
needs a full-library refresh — R4, R5, R6, R8 — depends on that mechanism and
should use it rather than a bare `refresh: true`.

## 6. Suggested order of work

1. **R1** — `subjects` → canonicalizer. Zero cost, unblocks a whole stage.
2. **R2** — description backfill from cache.
3. **R3** — narrator column and card line.
4. *(§10.M embedding backfill — existing blocker, per the sequencing note above.)*
5. **R4** — Fandom series wikis, behind a human-confirmed series mapping.
6. **R5** — Wikipedia extracts on already-verified pages.
7. **R6** — Audnexus chapters, after verifying the endpoint lives.
8. **R7** — UCSD Book Graph, whenever the dump is obtained.
9. **R8** — Open Library work records, only if R2 leaves a gap.
