# Phase 4 readiness — working the §10 blockers

Companion to `librarian-engine-plan.md` §10. That section states the problems;
this states the plan, the order, and what "done" means for each.

Written 2026-08-24, after the Phase 3.5 live validation. Several §10 entries
are **already partly resolved** by that work — the notes below reflect the real
current state, not §10's view at the time it was written.

---

## Status at a glance

Last updated 2026-08-25. Everything below marked done is on `main`; Wave 1 is
deployed. Wave 2's items landed on `main` directly — `feat/phase-4-wave-2`
is a stale branch and can be deleted.

| Item | State | Where |
|---|---|---|
| **A** — three-state tag coverage | ✅ Shipped; 1 of 2 review follow-ups closed | `main` `981a6c2`, follow-up `b32cbdf` |
| **A follow-up 2** — couple `evaluableTagCategories` to `groundCharacter` | ✅ **Done** — asserted as a biconditional, not the one-way form | `016bcd6` |
| **G** — chapter duration | ✅ **Done** — resolved by *striking* the claim, not building it | `main` `e210e2f` |
| **H** — external key convention | ✅ **Done**, incl. accent folding and the throw contract | `main` `c88d19e`, `bfb6673` |
| **B** — re-embed after tag mutation | ✅ **Done** | `db5fc36`, `b913395`, `86156f5` |
| **D** — library-readiness signal | ✅ **Done** — summary, Desk header, disclosure rule; "% embedded" measures freshness, not row presence | `f44c39f`, `7b12e43`, `dc66709` |
| **I** — token ceiling | ⬜ Not started | — |
| **E** — SSE terminal/error events | ⬜ Not started | — |
| **F** — conversation persistence | ⬜ Not started | — |

Gate at last commit: **backend 721, frontend 142, lint 146 warnings / 0 errors.**

### Work done alongside, not tracked as a §10 item

- **Title normalisation shipped.** 163 books renamed in ABS via
  `POST /title-parse/push`. The plan is now empty at `high` confidence; 28
  remain at `low` and need the review table, not a bulk push — at least one
  (`Batman - The Stone King` → `Batman`) would be destructive.
- **Two parser bugs found by the dry-run gate and fixed** (`6f81815`,
  `aae6448`): a stale parse could silently revert an ABS rename, and
  `Author - Series NN - Title` took the *middle* segment as the title at
  `high` confidence, which would have renamed *Dragons of Autumn Twilight* to
  "Chronicles 01". Every 3+ segment title in the library hit the second one.
- **Known flake, unfixed:** `librarian/services/audiobookbay.proxy.test.ts`
  does `vi.resetModules()` plus a full module-graph re-import per test and
  exceeds the 5s default under parallel load. Re-run before investigating a
  failure there. Fix is a `testTimeout` bump on that file or hoisting the
  reset.

---

## Current state that changes the picture

| Fact | Consequence |
|---|---|
| Enrichment ran on the real library: 692/955 Open Library resolved (72%), **297 books with grounded entities (31%)** | C steps 1–5 are done. D now has real numbers to render |
| Tagging ran: 958 books, $2.10, measured 542 in / 333 out per book | C steps 1–5 done |
| `getStaleEmbeddings()` already exists and compares `card_hash` against a freshly composed card | **B is half-built.** What is missing is *calling* the embed operation after tag-mutating work |
| Vocabulary consolidation rewrote **1,560 tag rows** (72 promotes, 76 aliases) with no re-embed | B is not hypothetical — it already happened once |
| Canonical trope vocabulary was 5 terms before consolidation; `chosen-one` covers ~29 of a likely 40–60 | A's honesty problem is live: the engine cannot tell thin coverage from absence |

---

## Wave 1 — schema and data (must land first; everything else reads it)

### A. Three-state tag coverage — **highest value, do first**

The headline differentiator (§5.4) is a sentence the schema cannot support:
*"none of these five is tagged chosen-one; two haven't been trope-audited
yet."* `book_tags` records what a book HAS. A book with no trope tags is
indistinguishable from one tagged before `trope` existed.

Guaranteed by our own migration path: `trope`/`structure` arrived in Phase 0,
`character`/`setting` in Phase 2.

- Add `tag_runs(book_id, categories, schema_version, tagged_at)` — preferred
  over a JSON column on `books`, because re-tag history is genuinely a list.
- Write it from `tagger.ts` at the same point `replaceBookTags` is called, so
  a run always records what it *attempted*, not what it produced.
- `tag_coverage` returns `present | absent | unaudited` per tag.
- **Exit:** a query for `excludeTags: ['chosen-one']` can report how many
  candidates were never trope-audited, and a test proves a pre-Phase-0 book
  reports `unaudited` rather than `absent`.

**Landed** at `981a6c2` (schema, `tagger.ts`, `retag_book`, three-state
classification). Two follow-ups came out of review.

**✅ Closed — write-side `tag_runs` retraction** (`b32cbdf`). The classifier
inferred "tags were wiped" from a zero `book_tags` count, which re-created the
produced-vs-attempted conflation in mirror image: a book audited across every
category that legitimately produced *no* tags read `unaudited` forever, and
re-running could never clear it. `deleteBookTags`/`deleteTagTerm` now retract
the affected runs and the read-side `hasAnyTags` gate is gone.

Two decisions inside that fix worth not re-litigating:

- `deleteTagTerm` retracts **narrowly** — only books left with zero tags lose
  their runs. Retracting one term corrects an audit; it does not unmake it, and
  a book still carrying other tags still has standing evidence its categories
  were checked. Per-category invalidation on every purge was considered and
  rejected: it would mass-downgrade a whole library's coverage on one bad-term
  purge.
- The retag pre-clear passes `retainRuns: true`. It wipes tags only to bound a
  mid-run failure to one book, and a fresh `recordTagRun` follows immediately;
  retracting there capped `tag_runs` at one row per retagged book, defeating
  the reason it is a table rather than a column. The retag's **catch** does the
  retraction, which is the path where the evidence really is gone.

**✅ Closed — couple `evaluableTagCategories` to `groundCharacter`** (`016bcd6`).
The drop condition at `tagging/compose.ts` mirrored `ground.ts` by hand, in a
different file, with no assertion linking them.

One thing the exit criterion got wrong, worth recording. As stated it asked
only for the forward implication — *not evaluable ⇒ grounding drops every
character candidate*. That does not catch the drift the follow-up was written
about. Remove `ground.ts`'s description fallback and a description-only book
still satisfies the forward implication (it stays evaluable, and the
implication says nothing about evaluable books), while `compose.ts` quietly
begins claiming `character` was attempted for a check that can no longer
succeed.

So the test asserts the **biconditional** across every structural shape a book
can have — person allowlist / description-only / place-only allowlist / neither
/ whitespace-only description — feeding grounding its *best-case* candidate in
each (the one that grounds if the mechanism works at all). The literal
one-way criterion is also asserted, for an unevaluable book against six
candidates. Neutralizing either side produces a failure; the forward-only form
would have caught only one.

### G. Chapter duration — **decide, then do one of two things**

Archetype 3 (commute) leans on median chapter duration. Nothing reads ABS
chapter data. Half-supporting it is not an option.

- Preferred: add `books.median_chapter_sec`, populated in sync from the ABS
  item payload, `derived` source.
- If the ABS payload does not carry it cheaply (check before committing —
  list responses are minified, see the M4B bug in §10.K), **strike the claim
  from §5.2** and resolve the archetype on `pacing` + `structure` + `length`.
- **Exit:** either the column is populated and the archetype uses it, or §5.2
  no longer mentions chapter duration. Not both, not neither.

### H. External key convention for `book_edges.to_book`

- Define `ext:<normalized-title>|<normalized-author>` using the existing
  `normalized()` idiom from `recommendations.ts`.
- Add a helper that mints it; use it everywhere an external anchor is stored.
- **Exit:** two differently-spelled references to the same non-owned work
  produce the same key, proven by test.

**Landed**, with one constraint the edge-writer must honour: `externalBookKey`
**throws for any title with no ASCII alphanumerics** — every non-Latin-script
title (`三体`, `Война и мир`, `こころ`) included. Accent folding does not help
there; CJK and Cyrillic have nothing to fold to. The throw is deliberate
(returning `null` would drop a readalike anchor silently), so **the edge-writer
must guard per-anchor** with the record-and-continue idiom from
`api/routes/titleParse.ts` (A4). One unmintable anchor must never abort a batch.

Also not unified, by design and now locked by test: series-prefixed vs bare
titles ("The Expanse: Leviathan Wakes" ≠ "Leviathan Wakes"). Strip the prefix
before minting if the caller knows one is present.

---

## Wave 2 — behaviour (depends on Wave 1 schema, parallelisable within)

### B. Re-embed after tag mutation

Half-built already: `getStaleEmbeddings()` exists and is the right design
(queryable staleness, not event plumbing). What is missing is the call.

- After any tag-mutating operation completes — tagging, retag, vocabulary
  promote/alias, enrichment — trigger the embedding operation.
- It is cheap by construction: unchanged cards are skipped.
- **Exit:** a test that promotes a vocab term and asserts the affected books'
  embeddings are stale, then no longer stale after the follow-up run.

### D. Library-readiness signal

**Unblocked** as of `b32cbdf` — A's write-side retraction landed, so a
coverage number can no longer read `unaudited` for a book that was audited.

Now cheap, because the numbers exist.

- Summary of % enriched, % tagged at current schema version (needs A), %
  embedded.
- Surface in the Desk header.
- Rule: the librarian states materially low coverage in its answer — the §8.6
  honesty posture at library level.
- **Exit:** a library at 31% entity coverage says so, rather than answering
  confidently and reading as broken.

**✅ Done** (`f44c39f`). `core/readiness.ts` turns `db.getReadinessCounts()`
into four metrics — external metadata, grounded entities, tagged at
`TAG_SCHEMA_VERSION`, embedded at the configured model — plus a `disclosure`
sentence. `GET /readiness` serves it; the Desk header renders it above the
fold; `query_library` attaches it as `libraryCoverage`.

Four decisions worth not re-litigating:

- **Every metric carries an explicit `unknown` count, sourced from SQL.**
  Invariant 5 could not be honoured any other way: only the query can tell
  "enrichment ran and missed" (a real 0%) from "enrichment never ran"
  (Unknown). The pairs are `enrichmentAttempted` vs `externalResolved`, and
  `taggedVersionUnknown` — books carrying `book_tags` with no `tag_runs` row,
  i.e. tagged before the run log existed, whose schema version we know we do
  not know. A metric whose `unknown` covers the whole library renders
  `pct: null` / `Unknown`, never `0%`.
- **The test asserts the invariant in BOTH directions.** "Unknown where
  nothing was checked" alone is satisfied by an implementation that maps every
  zero to Unknown, which would be the same bug in mirror image — the shape A's
  first fix shipped. So there is a paired case for a library where enrichment
  ran and every provider missed, which must read a confident `0%`.
- **The disclosure rides on `query_library`, not on a `library_readiness`
  tool.** A tool the model may or may not call is not a rule. Every answer
  about this library is built from a `query_library` result, so the model
  cannot answer without having seen the disclosure. It is *omitted entirely*
  when coverage is healthy: a caveat present on every answer stops being read,
  which would defeat the feature.
- **Materiality is a threshold, not "any imperfection".** Below 50%
  confirmed, or 10%+ of the library unknown. The 10% share (rather than
  `unknown > 0`) exists so two freshly-synced books cannot pin a permanent
  caveat to every answer.

Not built, deliberately: the §8.6 `audit` SSE event and its "audit these now"
button. There is no librarian chat loop yet (Phase 4 is not started), so
there is no event stream to emit into — that belongs with E and the loop
itself, not here.

**Follow-up — "% embedded" now measures USABLE coverage, not row presence**
(`dc66709`, `ff2d2ff`). The metric counted a `book_embeddings` row at the
configured model and ignored `card_hash` entirely, so a library where every
vector is stale reported **"100% Embedded / Great"** — the most reassuring
verdict the header can give, for its least usable state. B's own premise says
that is not hypothetical: the vocabulary consolidation rewrote 1,560 tag rows
with no re-embed.

Four decisions worth not re-litigating:

- **`covered` is judged by `isEmbeddingStale`**, the same predicate the
  embedder re-embeds on, so "readiness says fresh" and "the embedder would
  skip it" cannot disagree. A stale vector is not a neutral absence: it
  returns the book for queries it no longer matches and fails to return it for
  ones it now does. A missing embedding is honestly absent; a stale one is
  confidently wrong.
- **`stale` is its own count beside `unknown`, not a lower percentage.** They
  take different remedies — never-embedded needs a first run, stale needs a
  re-run — and only the count is actionable. It is named as its own clause in
  the disclosure/caveat (added once, to the shared clause list) and rendered
  on the Desk chip. Where staleness is unknowable (no model configured) it is
  `null`, never `0`: `0` reads as "nothing is stale", which is invariant 5 on
  a new axis. Stale is a *known* state; Unknown is not.
- **One `composeEmbeddingCard`, pinned to `EMBEDDING_CARD_OPTIONS`.** If the
  readiness path and `embedBooks` differed by one truncation length every hash
  would mismatch and the whole library would read stale — a catastrophic false
  alarm that looks exactly like a real finding. The guarding test embeds a
  book whose description is far past the truncation limit and asserts both
  directions: readiness reads it fresh, and a second embed run makes zero
  calls. Diverging the options by hand fails it with `expected 0 to be 100`.
- **The snapshot is memoized for 60s.** The freshness census costs ~51 ms on
  the real library (6.9 ms SQL, 44.1 ms composing 955 cards) — fine for `GET
  /api/readiness`, not fine attached to every `query_library` result and
  repeated each round of the agent loop. Readiness only moves when a pipeline
  run completes, which takes minutes to hours, so a snapshot a minute old
  cannot describe a meaningfully different library. Nothing invalidates the
  cache after a run yet; `invalidateReadinessCache()` is exported for when a
  caller wants that.

Expect the first real run against the live library to show a high stale count.
The 1,560-row rewrite predates B's re-embed trigger, so those books have
vectors composed from their pre-consolidation tags. That is the metric working,
not a bug.

### I. Token ceiling, and the pattern to forbid

- **The tool layer must never call `buildTagSummary`.** It serialises the
  entire library into a prompt and is the existing in-repo pattern an
  implementer would reasonably copy. The tool loop exists to retrieve
  incrementally instead.
- Per-conversation token budget that forces an answer when exceeded.
- Return `tokensUsed` on the terminal event.
- **Exit:** a test asserts the librarian tool layer has no path to
  `buildTagSummary`, and a budget-exhausted conversation still answers.

---

## Wave 3 — contracts (before frontend work starts, since it builds in parallel)

### E. SSE terminal and error events

Vocabulary is `interpretation | action | pile | answer | audit | token`. If a
tool throws or rounds are exhausted, the feed just stops — indistinguishable
from "still thinking".

- Add `error` `{stage, message, recoverable}`.
- Add terminal `done` `{status:'answered'|'exhausted'|'failed', rounds, tokensUsed}`.
- **Exit:** contract documented in §8.1 and a test drives each terminal status.

### F. Conversation persistence — **decided: SQLite**

Not an open question. Every other piece of state survives restart, the Desk
should reload a conversation, and a mid-run reboot has already cost us once.
In-memory erases a conversation the user is mid-way through.

- **Exit:** conversation survives a process restart.

---

## Not in scope for this pass

- **C** — steps 1–5 are done. Steps 6 (re-tune ranker weights against real
  cosine distributions) and 7 (hand-write 5–10 real queries as the regression
  suite) require running against the live library and Joel's own judgement
  about what a good answer looks like. **Prepare the harness; do not run it.**
- **J** — Phase 5, taste centroid cold start. Not a Phase 4 blocker.
- **K** — Phase 6, library hygiene. Interim fix already shipped.

### Carried over from the retired Phase 3.5 validation doc

Phase 3.5 answered its question — *does this work on the real library?* — and
was deleted once every step but the archetype spot-check had run. Three of its
open questions outlived it and belong to Phase 4 or later:

- **Ranker weights are still provisional.** `0.55 / 0.35 / 0.10` were chosen
  analytically against the four §5.2 archetypes and have never been tuned
  against real cosine distributions. This is C step 6.
- **Character grounding is weaker than the probe predicted.** The 20-title
  probe measured 50% of books carrying Open Library `person` data; the real
  library came in at **31% with grounded entities**, i.e. 69% without. Options
  in rough cost order: accept it (character queries stay weaker there); add
  Wikidata as a third provider (high precision, low recall — helps canonical
  titles like *Dune*, which notably has zero person data); or pursue the
  LibraryThing Common Knowledge bulk dump (curated character lists, CC-BY-SA,
  needs feed access from LibraryThing).
- **Entity coverage does not track fame.** *Dune*, *Hyperion*, and *The Left
  Hand of Darkness* have no person data while *Gideon the Ninth* has plenty;
  the strongest signal was recency, not popularity. This is why absent
  allowlists degrade to a soft description check rather than a hard drop —
  tuning that fallback on a popularity assumption would have been wrong.

One step was never run and is deliberately deferred: the **archetype
spot-check**, the four §5.2 queries against real data. It needs Joel's
judgement about what a good answer looks like, so it belongs with C step 7
rather than to a checklist.

---

## Invariants that must survive this work

Non-negotiable. Each was learned from a real failure:

1. **`excludeTags` ignores `trustedOnly` deliberately** (`9292fbd`). Unverified
   evidence is weak grounds *for* a book and sufficient grounds *against* one.
   A faithful implementation of the opposite already shipped once with 24
   passing tests locking it in. Do not re-widen it.
2. **curator.db is the system of record for tags.** The ABS push is a
   namespaced mirror under `GENERATED_TAG_PREFIX`, gated on `AUTO_PUSH`.
3. **Derived tags only claim their category when it is single-valued** —
   `EXCLUSIVE_DERIVED_CATEGORIES`. `full-cast` and `multi-pov` coexist.
4. **`ordinal` is never written to `series_sequence`.** `parse.series`/
   `seriesSequence` are, because the series is named next to the number.
5. **A check that cannot succeed must report `Unknown`, never a confident
   number.** Cost us three times: the M4B metric read 0% because ABS list
   responses are minified; structure read "811 misaligned" because it compared
   against a hardcoded folder scheme; and A's own classifier read `unaudited`
   for books it had genuinely audited. The third is the instructive one — it
   appeared *inside the fix for* the same class of bug.
6. **A tag run records what was ATTEMPTED, never what was produced.**
   Recording produced-only makes an untagged-but-audited book
   indistinguishable from an unaudited one. Its corollary: **retract evidence
   at the write side, where destruction is known, never by inferring it at the
   read side** — the read side cannot tell "wiped" from "audited, found
   nothing", and guessing produces the mirror-image bug.
7. **A passing test proves nothing unless it fails without the behaviour under
   test.** An exit criterion here was once "proved" by a test that filtered
   survivors through a hardcoded id list — it passed with the feature deleted,
   and was signed off on that basis. Verify by neutralizing the
   implementation, re-running, and confirming the failure. Applies to review
   sign-off as much as to authoring.
8. **A one-way write to Audiobookshelf gets a dry run read by a human first.**
   The dry-run gate caught two parser bugs that would have renamed real books
   to series labels (*Dragons of Autumn Twilight* → "Chronicles 01"), both at
   `high` confidence. Confidence scores are not a substitute for looking.
9. **Testing discipline** (AGENTS.md): fixture-based, `fetchImpl`/
   `MessageCreator` injection, failure paths tested, no test touches the
   network or a real library path.
