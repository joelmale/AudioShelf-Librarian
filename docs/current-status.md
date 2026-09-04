# Current agent checkpoint

Last reconciled: 2026-09-03 against `HEAD` plus a live query against the
homelab deployment, after §10.M's embedding blocker was confirmed resolved.
The earlier Phase 4 follow-ons, Phase 6 library-hygiene implementation,
bounded Phase 4 query normalization/relaxation correction, and enrichment
Wave A (`docs/enrichment-sources-review.md` R1–R3: subjects → canonicalizer,
description backfill, narrator persistence — 14 commits, `1add593..48fdabd`)
are on `main`. A Desk tool-call schema correction is implemented and
independently reviewed in the current uncommitted worktree.

This is a restart checkpoint, not a second project plan. Reconcile it against
git, the implementation, tests, and `docs/librarian-engine-plan.md` before
starting work. Update it only when milestone state materially changes or before
a long handoff.

## Active milestone

**Phase 4 human gate approved by Joel on 2026-08-28. Phase 5 code-complete;
Phase 6 code-complete. §10.M closed 2026-09-03: live `/api/readiness` reports
961/961 books embedded (100%, 0 stale) — up from 396/965 (41%) on 2026-08-28.
Q1 was re-run live against `POST /api/recommendations` and passed: rank 1 is
`Relative Humidity: Key West Capers, Book 17`, the exact expected title and
one of the four books that had no embedding when §10.M was found. No
hard-SF/space-opera title outranks it. See §10.M's resolution note in
`librarian-engine-plan.md` for the full ranked list, the live-environment
fixes that were needed to get a clean run (an invalid then
workspace-scoped `ANTHROPIC_API_KEY`, and a down `ollama` container), and the
one caveat this doesn't close: the interpreter's parsed constraints for this
run were thin, so Q1 passing rides partly on the semantic/tag blend rather
than tight constraint parsing — not proof every archetype's parsing is
solid. Ranking quality is now genuinely measurable; it has been judged
correct on one of the ten approved queries.**

Built and tested on `main` before this milestone:

- five internal library-only retrieval tools, including semantic search;
- a prompt-backed `TurnDriver` over the existing `MessageCreator` boundary;
- persisted SSE at `POST /api/librarian/chat`;
- a minimal Desk chat and action feed;
- four scripted fixture archetypes.

Implemented, independently reviewed, and on `main`:

- deterministic read-time tag normalization (query-time canonicalization,
  e.g. `murder mystery` → `mystery`), with every positive/negative tag filter
  — `allTags`, exclusions, author, provenance, duration, series, and
  publication-year constraints — enforced as a single hard pass with no
  retry (`relaxableTags` and the tool-owned retry were removed 2026-09-04;
  see `docs/architecture/decisions.md` #18);
- the shared Desk/Scout paths use that contract, normalize the original hard
  plan independently for external verification, disclose rewrites, and
  return an honest empty shelf instead of asking a model to recommend from
  no evidence;

- a snapshot-only retrieval acceptance harness with read-only/live-path guards,
  cosine distributions, a weight grid, explicit expectations, and a CLI;
- retrieval-first Scout recommendations through the registered semantic tool,
  with bounded evidence and independently verified iTunes external lookup;
- registry-backed MCP exposure of all five librarian tools, with
  `query_library` retained as a deprecated delegating alias.
- additive conversation threads and turns, bounded history/list/detail APIs,
  restart-safe follow-ups, and prior-answer context that cannot authorize
  current-turn evidence.
- the Desk history consumer, including bounded list/detail pagination, persisted
  turn replay, restart/reopen, new-thread reset, and follow-up submission.
- honest Desk trace surfaces: live and replayed audit disclosures from successful
  coverage checks, a globally bounded additive candidate pile, and a collapsible
  action-only research trail with stable friendly labels and counts.

Implemented and independently reviewed in the current worktree:

- the Desk model response schema now derives concrete per-tool input branches
  from the runtime tool registry, preventing malformed schema-shaped objects
  from being accepted as search title, author, tag, or category values before
  retrieval runs.

None of those implementation reviews is the final human acceptance decision.
Joel approved the ten proposed query expectations on 2026-08-28. The machine
fixture still needs stable real-library IDs and query vectors from a consistent
snapshot, the harness has not run on that snapshot, and the real Key West result
has not been judged.

## Remaining sequence

### Phase 4 acceptance and follow-ons

- ~~§10.M: embedding backfill.~~ Closed 2026-09-03 — 961/961 embedded, Q1
  passes live. See the Active milestone note above.
- ~~Re-tag the visibly broken rows §10.M's second finding found.~~ Closed
  2026-09-04 — see the Exact next action section below for the root cause
  (a leaked encoder-signature description, not a title-parse bug) and the
  fix.
- ~~Settle the `relaxableTags` question in §10.M.~~ Closed 2026-09-04: kept
  query-time canonicalization (it earns its place — `murder mystery` →
  `mystery` reaches 65 books that were otherwise unmatchable), removed the
  tool-owned retry loop (it was built to fix a failure whose actual cause
  was missing embeddings, which are now present). See
  `docs/architecture/decisions.md` #18.
- Populate and run the snapshot harness for §10.C step 6 against the other
  nine approved queries in `docs/phase-4-retrieval-query-proposal.md`. Q1
  passing on a live, non-snapshot call is a positive signal, not a
  substitute for the harness — encode stable IDs and real query vectors
  from a consistent snapshot, run `npm run acceptance:retrieval`, and have
  the user judge the real cosine distributions and any ranker-weight
  change. Pay particular attention to whether the interpreter's constraint
  parsing is doing real work on the queries with more explicit hard
  constraints (duration bounds, exclusions, publication year) — Q1 didn't
  exercise that path.

The supported Phase 4 Desk surface is complete. These richer ideas are
deliberately deferred and do not block acceptance: editable interpretation
chips need a planner/override contract; pile removals need real cause data;
rich "Why this?" cards need answer evidence/narrator/cover/deep-link fields;
accept/reject feedback belongs to Phase 5; and an "audit these now" control
would initiate a write/cost-bearing tagging operation. The existing readiness,
promotion, and operations surfaces satisfy the implementable §8.7 work.

### Phase 5 — Feedback and personalization

Code-complete on 2026-08-28, fixture-tested, not yet verified against live
data:

- migration E — `rec_feedback` (with `source` and graded `weight`),
  `rec_impressions`, `listening_progress`, `listening_sessions`;
- explicit accept/reject capture, with thumbs on the Scout recommendation
  cards. Only `accepted`/`rejected` are postable: `finished`/`abandoned` are
  behavioural facts derived server-side and must not be forgeable by a client;
- Audiobookshelf listening ingest (`/api/me`, `/api/me/listening-sessions`)
  turned into graded implicit verdicts — abandoning at 8% is a rejection,
  abandoning at 80% barely counts, and nothing is called abandoned until 60
  days of silence so a mid-listen book is not punished for being mid-listen;
- a **multi-centroid** taste profile (3–6 modes, recency-weighted, k-means
  with deterministic farthest-point seeding) rather than the single centroid
  §6 originally specified — see `docs/recommendation-data-model.md` §6;
- a `taste` term in the ranker, defaulting to **0** so personalization is
  opt-in and the §10.C acceptance harness stays impersonal;
- slate impression logging on every Scout answer, which is what makes future
  ranker tuning an offline measurement instead of another human judgment;
- a Hardcover provider populating §4.3's `w_rec` reception prior, which has
  been scoring a neutral 0.5 for every book since Phase 3.

Explicit query constraints always outrank personalization: taste is a prior
over books that already passed every hard filter.

**Not done, and deliberately so.** No live ABS listening sync has been run.
The Hardcover GraphQL document and rating scale have never touched the real
API — they are from the published schema and must be confirmed against a real
response before the reception prior is trusted. The LibraryThing CK loader
stays out; no dump was obtained. Google Books and Wikidata are Phase 1
enrichment work, not Phase 5, despite being mentioned here previously.

### Phase 6 — Library hygiene

Code-complete and independently reviewed in the current worktree:

- validated per-Audiobookshelf-library folder conventions with safe rendering,
  finite read-only detection, persisted settings/history, and explicit UI
  confirmation;
- honest structure measurement against confirmed conventions, with `Unknown`
  retained unless every populated library is configured and at least 75% of
  observed books are eligible;
- server-authored, expiring realignment plans whose execute route accepts only
  a plan ID and stable book IDs, then re-fetches and recomputes paths;
- canonical containment, symmetric overlap/collision checks, service-wide
  mutation serialization, pre-mutation durable recovery journals, per-library
  rollback authorization, and rename-only failure handling;
- Desk, health, settings, and Realign UI updated to the typed/runtime-validated
  contract, including low-coverage and stale-plan fail-closed behavior.

The synthetic non-default convention exit criterion passes. No agent ran a
live scan, move, rollback, or Audiobookshelf write. Any live realignment still
requires a separately reviewed dry run and explicit authorization.

### Librarian surface unification (UX recs 1 & 2)

Implemented and independently reviewed on 2026-08-29 (its deliberate
trade-offs are recorded in `docs/architecture/decisions.md` #17):

- the librarian path is finally diagnosable — `librarian_turn_started` /
  `_tool_call` / `_finished` / `_failed` reach the action log keyed on the turn
  id, carrying the loop's measured `tokensUsed`, no question text, no tool
  input, and no recommendation (a failing tool's own error message is the one
  documented exception);
- `POST /librarian/chat` accepts resolved `seedBookIds` anchors that are
  pointers, not evidence;
- the Desk answer carries card-parity fields and a `retrieval` event with the
  ranker's own measurements, both additive and optional;
- one surface: the Desk chat panel, reached from `/desk` and from Scout's
  compact opener via a `?q=`/`?seeds=` deep link;
- the scope toggle and its dead settings control are gone; the shelf is always
  searched and shown first, and the verified acquire half is a separate lazy
  section fed by `POST /recommendations`, never by the chat loop.

`POST /recommendations` and `RecommendationFinder` both remain — retiring the
route is explicitly out of that plan's scope.

### Transcript pipeline

Parked. Phase 6 is complete, but the cheaper-source sequence in
`docs/audio-transcript-pipeline-plan.md` has not been measured. Re-evaluate
whether transcription is necessary before authorizing GPU or CPU pipeline work.

## Human decisions and authorization gates

- Real ranker quality and expected results for representative queries require
  the user's judgment.
- Live Audiobookshelf writes require a human-reviewed dry run and explicit
  authorization for the specific write.
- Filesystem organization, realignment, rollback, or deletion must never use a
  real library during automated testing.
- Deployment, releases, credentials, and destructive Git operations require
  explicit authorization.

## Known operational note

`librarian/services/audiobookbay.proxy.test.ts` has a documented timeout flake
under parallel load due to module resets and graph re-imports. Re-run an isolated
failure before treating it as a product regression; do not hide a consistent
failure behind the known-flake note.

## Exact next action

**§10.M is closed — 961/961 books embedded, Q1 passes live.** The blocker
that made every step below unmeasurable is gone. In order:

1. ~~Re-tag the visibly broken rows found on 2026-08-28~~ Closed 2026-09-04.
   Root cause: `books.description` for all three was the literal string
   `"fre:ac - free audio converter"` — an audio-encoder signature leaked into
   the ABS record, not a title-parse bug. The original 2026-08-23 tag runs
   used it as if it were the book's blurb. `descriptionText.ts`'s
   `isJunkDescription`/`JUNK_DESCRIPTIONS` guard (added since) already
   excludes this exact string and falls through to the harvested
   description, so once R2's `backfill-descriptions` populated
   `descriptionEnriched` for these books (run live the same day), a plain
   `POST /tags/retag` produced correct, description-grounded tags —
   `character:murray-zemelman`/`tommy-tarpon`/`franny` and
   `setting:key-west`/`florida` for *Tropical Depression*,
   `character:phoebe`/`nicky` for *Tropical Swap*, and
   `genre:music-reference`/`non-fiction` for *Album* (which turns out to be
   *The New Rolling Stone Album Guide*, a reference book misfiled in the
   Key West Capers folder — a library-organization anomaly, not a tagging
   bug). Checked the wider question: two more books in the same series,
   *Florida Straits* and *Mangrove Squeeze*, carry the identical junk
   description but already had sane tags (evidently tagged at a different
   time), so the contamination was confirmed scoped to these three, not a
   systemic title-parse defect.
2. Encode stable book IDs and real query vectors into the acceptance fixture,
   run `npm run acceptance:retrieval`, and judge the cosine distributions and
   weight grid against the remaining nine approved queries — Q1 alone is not
   full acceptance; see the constraint-parsing caveat in the Active milestone
   note above.
3. Run a live `POST /api/listening/sync` and confirm the implicit verdicts it
   derives look right before trusting the taste profile.
4. Once Phase 4 acceptance and Phase 5's live verification are both judged,
   `docs/enrichment-sources-review.md`'s R4–R8 (Fandom series wikis,
   Wikipedia extracts, Audnexus chapters, UCSD Book Graph, Open Library work
   records) were explicitly sequenced behind this same embedding blocker —
   see that doc's §5 — and are now unblocked to schedule.
