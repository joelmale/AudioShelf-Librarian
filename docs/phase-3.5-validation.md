# Phase 3.5 — validation status and Phase 4 decision point

Date: 2026-08-22 · Branch: `feat/librarian-engine` · Head: see `git log`

Phase 3.5 exists to answer one question before any UI gets built on top of
the retrieval layer: **does this work on the real library, or only on the
30-book synthetic fixture?**

It is **partially complete**. The external-data half was measurable and has
been measured. The library half is blocked on deployment, not on code.

---

## 1. What was validated, and how

### ✅ Enrichment provider coverage — measured against live APIs

`npm run probe:providers` runs the real `openLibrary` and `audnexus` provider
clients against 20 real audiobook titles spanning four popularity tiers.
Read-only: no database writes, no authenticated calls, no library mutation.

**Open Library, n=20:**

| Metric | Result |
|---|---|
| Record resolved | **20/20 (100%)** |
| Carries `person` data | **10/20 (50%)** |
| Carries `place` data | 7/20 (35%) |
| Carries `subject` terms | **20/20 (100%)**, range 2–41 |
| Errors | 0 |

By tier (resolved / with-people / n):

| Tier | Result |
|---|---|
| canonical | 5 / 2 / 5 |
| popular | 6 / 4 / 6 |
| midlist | 5 / 3 / 5 |
| recent | 4 / 1 / 4 |

**Audnexus:** only 1 of the 20 sample entries carried a real ASIN, so its
coverage is *unmeasured*. That one resolved and returned 5 subject terms and
0 entities (expected — Audnexus has no character data). True coverage can
only be measured against the real library, where ABS supplies an ASIN per
book.

### ✅ Retrieval correctness — validated against the fixture library

437 backend tests pass, including the exit criterion: the fixture query
"melancholic coastal autumn" returns `fx-01 > fx-02 > fx-03` as a
hand-labelled **ordering**, and `findSimilar(fx-10, {acrossGenre: true})`
surfaces the cross-genre structural match `fx-20`.

---

## 2. What the numbers actually mean

**Resolution is not the constraint; entity coverage is.** Open Library found
a record for every single title. The 50% figure is specifically about the
`person` facet, which is what character grounding depends on.

**Coverage does not track fame — and that matters.** *Dune*, *Hyperion*, and
*The Left Hand of Darkness* have **zero** person data. *Gideon the Ninth* and
*A Memory Called Empire* have plenty. The strongest real signal is recency:
recent releases were weakest (1/4), presumably because catalogue records
accrete over time.

This validates a design decision rather than undermining one. Absence of an
allowlist was deliberately treated as a *soft* signal (grounding degrades to
a description substring check) rather than a hard one. Had coverage been
assumed to track popularity, the fallback would have been tuned wrongly.

**The practical consequence:** the hallucination filter — dropping a
character tag that no external source confirms — will fire on roughly half
the library. On the other half, character tags stay `llm-open` and are
excluded from hard filters by design. This is working as intended, but it
means **character-based querying will be materially weaker than
facet-based querying** until entity coverage improves. See §5 for options.

**A better-than-expected finding:** 100% subject coverage. Every book yields
external subject terms, which feeds the canonicalization vocabulary and the
promotion queue regardless of whether entities resolved. That is a stronger
foundation for the vocabulary loop than the plan assumed.

---

## 3. What is blocked, and why

Phase 3.5's library-side validation cannot be run from here:

1. **The code is not deployed.** `docker-compose.yml` pulls
   `ghcr.io/joelmale/audioshelf-librarian:latest`, built from `main`. All
   Phase 0–3 work lives on `feat/librarian-engine` and has never run outside
   tests. The running container has no `/enrichment/run`, `/embeddings/run`,
   or `/vocab/*` routes.
2. **There is no local library to run against.** The only `curator.db` on
   this machine is 4 KB and contains just `ingest_jobs` / `ingest_job_items`
   — the librarian module's tables. No `books` table, no synced library.
3. **The remaining steps are consequential.** A real enrichment or tagging
   run spends LLM tokens, calls external APIs at library scale, writes to the
   live `curator.db`, and pushes tags back to AudiobookShelf. That needs an
   explicit decision, not an assumption.

**Not attempted deliberately:** deploying the branch, connecting to the
homelab, or running anything against the real library.

---

## 4. The remaining Phase 3.5 checklist

Once the branch is deployed, in this order. Each step is cheap and gated by
the one before it.

| # | Step | Command / action | What it answers |
|---|---|---|---|
| 1 | Sync | existing `POST /sync` | Library mirrors; `asin`/`isbn` populated (Audnexus depends on ASIN) |
| 2 | Enrichment plan | `POST /enrichment/run {"dryRun":true}` | How many books are candidates; no cost |
| 3 | Enrichment sample | `POST /enrichment/run {"sample":true}` | **Real hit rates and entity coverage on your shelf.** Compare against the 50% measured above |
| 4 | Enrichment full | `POST /enrichment/run` | Populates `book_entities` library-wide |
| 5 | Tagging sample | `POST /tags/run {"sample":true}` | Tag quality; OOV rate; whether grounding drops look right |
| 6 | Tag quality | `GET /tags/quality` | Required-category coverage, out-of-vocabulary counts |
| 7 | Promotion queue | `GET /vocab/proposed` | Whether real proposed terms look like facets or noise |
| 8 | Tagging full | `POST /tags/run` | |
| 9 | Embeddings | `POST /embeddings/run` | Requires Ollama reachable at `OLLAMA_URL`; `EMBEDDING_MODEL` defaults to `nomic-embed-text` |
| 10 | Archetype spot-check | manual, via `query_library` / MCP | The four §5.2 queries against real data |

**Gate for Phase 4:** step 3 (enrichment sample) and step 5 (tagging sample)
are the two that produce evidence rather than side effects. If those look
right, the rest is mechanical.

---

## 5. Open questions for a human decision

1. **Deploy the branch?** Nothing else in Phase 3.5 can proceed without it.
   Options: build and push an image from `feat/librarian-engine`, or merge to
   `main` first. Merging first means shipping unvalidated code to the
   default branch — deploying the branch image is the safer order.
2. **Trope coverage is the load-bearing unknown.** Negative filtering
   ("absolutely zero chosen-one tropes") is only as good as how densely
   tropes got tagged. Nothing measured so far tells us this; step 5 will.
   If coverage is thin, the §8.6 audit disclosure becomes essential rather
   than nice-to-have.
3. **Ranker weights are provisional.** `0.55 / 0.35 / 0.10` were chosen
   analytically against the four archetypes, never tuned against real
   results. Step 10 is the first honest test.
4. **Character grounding on the ~50% without allowlists.** Options, roughly
   in cost order: accept it (character queries are weaker there); add
   Wikidata as a third provider (high precision, low recall — likely helps
   canonical titles like *Dune* specifically); pursue the LibraryThing Common
   Knowledge bulk dump (curated character lists, CC-BY-SA, requires asking
   LibraryThing for feed access).

---

## 6. Recommendation

**Do not start Phase 4 yet — but the blocker is a deployment decision, not
more engineering.**

The case for pausing: Phase 4 builds a conversational UI plus a "process
transparency" Desk on top of retrieval whose real-data behaviour is entirely
unmeasured. If trope coverage turns out thin or the ranker weights are badly
off, those are cheap fixes now and expensive ones after a chat interface,
an SSE event contract, and a UI depend on their shapes.

The case against over-pausing: the enrichment layer's biggest unknown has
now been measured and the answer was *better* than planned for (100%
resolution, 100% subjects, 50% entities with a well-understood fallback).
Retrieval is correct against a fixture designed to catch the failure modes
that actually occurred. The remaining risk is concentrated in steps 3 and 5,
which together take minutes once deployed.

**Suggested next action:** deploy `feat/librarian-engine` as a non-`latest`
image tag, run steps 1–5, and treat the two sample reports as the Phase 4
go/no-go. If you would rather not deploy yet, the alternative is to start
Phase 4's agent-loop work — which is the one slice that depends on tool
contracts rather than on data quality — and defer the Desk UI until
validation lands.
