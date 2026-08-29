# Current agent checkpoint

Last reconciled: 2026-08-28 against `HEAD` plus the current working tree,
after the §10.L diagnostic was run against the live homelab database.
The earlier Phase 4 follow-ons, Phase 6 library-hygiene implementation, and
bounded Phase 4 query normalization/relaxation correction are on `main`. A
Desk tool-call schema correction is implemented and independently reviewed in
the current uncommitted worktree.

This is a restart checkpoint, not a second project plan. Reconcile it against
git, the implementation, tests, and `docs/librarian-engine-plan.md` before
starting work. Update it only when milestone state materially changes or before
a long handoff.

## Active milestone

**Phase 4 human gate approved by Joel on 2026-08-28. Phase 5 code-complete;
Phase 6 code-complete. The live blocker is now §10.M: only 396 of 965 books
are embedded (41%), and four of the five titles named as acceptance query
Q1's expected result have no embedding at all. Ranking quality is not
measurable until the embedding backfill runs.**

Built and tested on `main` before this milestone:

- five internal library-only retrieval tools, including semantic search;
- a prompt-backed `TurnDriver` over the existing `MessageCreator` boundary;
- persisted SSE at `POST /api/librarian/chat`;
- a minimal Desk chat and action feed;
- four scripted fixture archetypes.

Implemented, independently reviewed, and on `main`:

- deterministic read-time tag normalization plus strict-first
  `relaxableTags`: positive inferred tags demote to ranking preferences only
  after a zero-candidate strict pass, while absolute positive tags,
  exclusions, author, provenance, duration, series, and publication-year
  constraints remain hard;
- the shared Desk/Scout paths use that contract, normalize the original hard
  plan independently for external verification, disclose rewrites and
  relaxation, and return an honest empty shelf instead of asking a model to
  recommend from no evidence;

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

- Populate and run the snapshot harness for §10.C step 6. The user judges the
  real cosine distributions and any ranker-weight change.
- ~~Joel approved the ten representative queries and human-readable expected
  results in `docs/phase-4-retrieval-query-proposal.md`, including the Key West
  expectation.~~ Encode stable IDs/vectors only after obtaining the snapshot.

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

**Run the embedding backfill.** 569 of 965 books have no vector, including the
expected Q1 winner, so nothing downstream is measurable first. Establish why
it stalled — an incomplete run, or `card_hash` invalidated en masse by the
2026-08-23 vocabulary consolidation with no re-run after.

Then, in order:

1. Re-tag the visibly broken rows found on 2026-08-28 (`Tropical Depression`
   tagged `setting: derry-maine`; `Tropical Swap` tagged
   `setting: locations-and-place-vibes`; `Album` tagged
   `genre: fre-ac-converter`), and check whether `Album`/`Tropical Swap`
   indicate a wider title-parse problem.
2. Re-run the Key West query and judge the ranking.
3. Settle the `relaxableTags` question in §10.M — keep query-time
   canonicalization, remove the tool-owned retry loop.
4. Encode stable book IDs and real query vectors into the acceptance fixture,
   run `npm run acceptance:retrieval`, judge the cosine distributions and
   weight grid.
5. Run a live `POST /api/listening/sync` and confirm the implicit verdicts it
   derives look right before trusting the taste profile.
