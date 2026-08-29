# Recommendation data model

What Netflix and Amazon actually do, which parts survive contact with a
single-user 955-book library, and the concrete datasets to build. Written as
input to Phase 5 (feedback and personalization); it is a design rationale
document, not a schedule. Nothing here is implemented unless a section says so.

---

## 1. How the reference systems work

**Two stages, always.** Candidate generation (cheap, high-recall) narrows the
catalog to a few hundred; ranking (expensive, high-precision) orders them. The
split is usually explained as a latency optimization, but the load-bearing
property is different: **candidate generation is never allowed to return
zero.** It is tuned for recall and forgiveness. All the "but I specifically
want X" logic lives in the ranker as a score contribution, not as a predicate.

**Three signal families feed the ranker.**

| Family | What it is | Our equivalent |
|---|---|---|
| Collaborative | the user x item matrix; Amazon's item-to-item CF precomputes item-to-item similarity from co-purchase and looks up neighbours at serve time | **absent** — see §2 |
| Content | item features; Netflix's "altgenre" microtags are human-authored, thousands of them | `book_tags`, `book_embeddings` — our strongest leg |
| Context | time of day, device, session length, weekday | **absent** — recoverable, see §3 |

**The trusted signal is behavioral, not stated.** Netflix ran the Prize on star
ratings and then largely abandoned rating prediction; thumbs and play/completion
beat stars because stated and revealed preference diverge. People rate
documentaries highly and watch sitcoms. Completion rate, abandon point and
re-listen are the real currency.

**Negatives are the hard part.** "Didn't watch" is not "dislikes". The
industry answer is impression logging: *we showed these 40, you picked #7*, so
the other 39 become weak negatives with known rank positions. That log is the
training set, and it is what makes offline evaluation possible without a human
judging every change.

---

## 2. The structural gap: no collaborative signal, and no negative class

Two facts about this project that no amount of engineering removes:

1. **One user.** There is no user x item matrix to factorize. The single most
   valuable signal in commercial recommenders is unavailable.
2. **The library is a positive-only dataset.** Every book in it was chosen.
   There is no negative class at all. This is the deeper problem, and it is why
   this recommender is harder than Netflix's, not easier.

Three substitutes, in descending value per unit of effort:

**A. Listening history is the negative class.** See §3. Free, no LLM spend,
and the only source of true in-library negatives that will ever exist.

**B. Borrowed collaborative signal.** We cannot build a co-purchase matrix, but
we can import other people's. **List co-occurrence** — books appearing together
on strangers' shelves and lists, via Hardcover (already in the Phase 5 plan) and
Open Library lists — is literally item-to-item CF computed over other people's
libraries. `book_edges` already exists with `(from_book, to_book, relation,
score, source)` and currently holds only `similar` from embeddings.

**C. Content similarity.** Already built: `book_embeddings` plus the tag
vocabulary. Keep it as the backbone; it is what carries cold-start books.

---

## 3. Layer A — behavior (highest value, not yet ingested)

Audiobookshelf tracks per-book progress and listening sessions. `absClient.ts`
ingests none of it — there is no `/api/me` call anywhere in the curator module.
This is the largest available win and it costs nothing per book.

Signals to derive, roughly in order of value:

- **Abandon point as a graded negative.** Dropped at 8% is a strong reject;
  dropped at 80% is nearly a completion. The only true in-library negative.
- **Shelf-sitting.** In the library 14 months, never started. A weak negative,
  and an excellent "stop surfacing this" signal. `books.abs_added_at` already
  exists, so this needs only the progress side.
- **Completion velocity.** A 22-hour book finished in four days is the binge
  signal — the strongest positive available, and stronger than anything the
  user would say out loud.
- **Playback speed.** 2.0x means *getting through it*; 1.0x means *savouring*.
  An unusually honest preference signal with no analogue in video.
- **Re-listens.** Rare, and very high confidence when they happen.
- **Session context** — hour of day, weekday/weekend, session-length
  distribution. This is the direct Netflix "context" analogue and it converts
  the *situational* query archetype from an inference into ground truth:
  "commute books" stops being a vibe guess and becomes *books consumed in
  25-45 minute weekday-morning sessions*.

Sketch (Phase 5, additive):

```sql
CREATE TABLE listening_progress (
  book_id        TEXT PRIMARY KEY REFERENCES books(id),
  progress       REAL NOT NULL,       -- 0..1, last observed
  is_finished    INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER,
  time_listening INTEGER NOT NULL,    -- seconds actually played
  last_played_at INTEGER,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE listening_sessions (
  id             TEXT PRIMARY KEY,    -- ABS session id, so re-sync is idempotent
  book_id        TEXT NOT NULL REFERENCES books(id),
  started_at     INTEGER NOT NULL,
  duration       INTEGER NOT NULL,    -- seconds of this session
  playback_speed REAL,
  device         TEXT
);
```

Sessions are append-only and keyed by the ABS session id so a re-sync is
idempotent. Progress is a snapshot and is overwritten.

---

## 4. Layer B — item features we are discarding

**Narrator is not in the `books` table.** This is the largest item-side gap.
Audiobookshelf supplies it (`narratorName` in `absBookMetadataSchema`,
`core/types.ts`) and Audnexus returns full narrator arrays; the sync path drops
it. For audiobooks narrator is a first-class taste axis **with no analogue in
Netflix or Amazon** — a structural advantage this domain has over theirs.
"Anything read by Ray Porter" is currently unanswerable, and narrator affinity
is likely among the most predictive features obtainable.

Also worth carrying, in rough value order:

- **Production style** — full-cast / dramatized / author-read / abridged.
  Full-cast is already derived in `derivedTags.ts`; the rest are not.
- **Series position and completion state** — "finish what I started" is a real
  and currently unserved query.
- **Recording year vs publication year** — audiobook re-recordings make these
  diverge, and `books.published_year` silently conflates them.

---

## 5. Layer C — borrowed edges

`book_edges` is built and holds one relation. Populate more, all cheap:

| Relation | Source | Why |
|---|---|---|
| `also-enjoyed` | Hardcover, Open Library lists | the closest thing to real CF |
| `same-narrator` | ABS / Audnexus | see §4 |
| `same-series`, `same-universe` | ABS series + Wikidata | "more of this world" |
| `award-cohort` | Wikidata | "Hugo nominees from the year I loved" |

List co-occurrence is the one to build first: it is the only genuinely
collaborative signal reachable from a single-user deployment.

---

## 6. Layer D — taste representation

**Do not use a single taste centroid.** The Phase 5 plan says "taste-centroid
behavior"; one centroid over a library holding sci-fi, cozy mystery and history
lands in empty embedding space and recommends things mildly like everything and
strongly like nothing.

Instead: cluster the finished-and-fast books into **3-6 taste modes** (k-means
over `book_embeddings`), recency-weight them, and treat each as a separate
retrieval anchor. Netflix does not have "a user vector" either — it has many,
and the rows on the homepage *are* those modes made visible.

Per-facet preference weights (which genres/moods/pacings correlate with
completion rather than abandonment) are a cheap second layer on the same data.

---

## 7. Layer E — impression logging

Migration E as planned (`rec_feedback`) captures verdicts but not slates. Log
**the whole candidate list, each item's rank position, and the query** — not
only what was accepted.

```sql
CREATE TABLE rec_impressions (
  id           INTEGER PRIMARY KEY,
  query_text   TEXT NOT NULL,
  book_id      TEXT,
  external_key TEXT,
  rank         INTEGER NOT NULL,
  score        REAL,
  shown_at     INTEGER NOT NULL
);
```

Why this matters more than it looks: the Phase 4 gate is open because ranker
quality needs human judgment, and **every future weight change will need it
again**. An impression log turns "did the ranker put the winner at position 1?"
into NDCG/MRR over real history — an offline metric to iterate against between
human reviews. It is the cheapest item on this list and the one that compounds
hardest.

---

## 8. The design rule carried into the retrieval fix

Netflix scores rather than filters, and the reason applies here with extra
force: **a missing tag is indistinguishable from an absent trait.** Coverage
data says it is usually the former — 31% entity grounding, and a trope
vocabulary that was five terms until 2026-08-23. A hard positive tag filter
therefore does not select for "is a mystery"; it selects for "was tagged
thoroughly", and thoroughness is uncorrelated with fit.

This is the same asymmetry already recorded as a project invariant: *an
unverified tag is weak grounds for a book but sufficient grounds against one.*
It is why exclusions may be hard filters and inclusions may not.

Hard filtering stays correct only where absence is genuinely knowable — the
column-backed facts (duration, published year, series membership) and every
exclusion. Everything else belongs in the ranker.

The 2026-08-28 retrieval fix applies exactly this rule; see
`core/retrieval/tagResolution.ts`.

---

## 9. Suggested order

1. **Retrieval fix** — canonicalize tag filters, positives soft, never call the
   answer model on empty evidence. Nothing downstream is measurable until the
   ten-query gate passes. *(done 2026-08-28)*
2. **Ingest ABS listening history** (§3). Free, and it supplies the negative
   class.
3. **Narrator** (§4) in `books`, plus a `same-narrator` edge.
4. **Impression logging** (§7) — land it with Migration E, not after.
5. **Borrowed edges** (§5) from Hardcover / Open Library lists.
6. **Multi-centroid taste** (§6), recency-weighted.

Explicit query constraints always outrank personalization, at every step above.
