# Phase 4 readiness — working the §10 blockers

Companion to `librarian-engine-plan.md` §10. That section states the problems;
this states the plan, the order, and what "done" means for each.

Written 2026-08-24, after the Phase 3.5 live validation. Several §10 entries
are **already partly resolved** by that work — the notes below reflect the real
current state, not §10's view at the time it was written.

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
classification, 599 backend tests). Two follow-ups came out of review and are
**not** optional:

- **Invalidate `tag_runs` at the write side, not the read side.** The current
  classifier infers "tags were wiped" from a zero `book_tags` count, which
  re-creates the produced-vs-attempted conflation in mirror image: a book that
  was genuinely audited across every category and legitimately produced *no*
  tags reports `unaudited` forever, and re-running can never clear it. Proven
  end-to-end through the real `tagUntaggedBooks`. Reachability today is narrow
  (needs null `durationSeconds` **and** null `publishedYear` so no derived tag
  rescues it), which is why it did not block the merge — but the fix is to have
  `deleteBookTags`/`deleteTagTerm` delete or supersede the affected `tag_runs`
  rows, and drop the `hasAnyTags` gate. **Must land before D**, since D is what
  puts this number in front of the user.
- **Couple `evaluableTagCategories` to `groundCharacter` with a test.** The
  drop condition at `tagging/compose.ts:97` mirrors `ground.ts` by hand, in a
  different file, with no assertion linking them. If the description fallback
  is ever removed and `ground.test.ts` updated alongside it, `compose.ts` would
  silently start claiming `character` was attempted for description-only books
  — invariant 5 reintroduced, in the one place that now looks handled.

Also: the comment at `db.ts:1373` overclaims `deleteTagTerm` coverage (only
handled when the term was the book's last tag).

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

**Blocked on A's write-side follow-up** — do not surface a coverage number
that can read `unaudited` for a book that was audited. See A above.

Now cheap, because the numbers exist.

- Summary of % enriched, % tagged at current schema version (needs A), %
  embedded.
- Surface in the Desk header.
- Rule: the librarian states materially low coverage in its answer — the §8.6
  honesty posture at library level.
- **Exit:** a library at 31% entity coverage says so, rather than answering
  confidently and reading as broken.

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
   number.** Cost us twice: the M4B metric read 0% because ABS list responses
   are minified, and structure read "811 misaligned" because it compared
   against a hardcoded folder scheme.
6. **Testing discipline** (AGENTS.md): fixture-based, `fetchImpl`/
   `MessageCreator` injection, failure paths tested, no test touches the
   network or a real library path.
