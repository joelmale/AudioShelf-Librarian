# Current agent checkpoint

Last reconciled: 2026-08-28 against `HEAD` plus the current shared worktree.
The Phase 4 follow-ons and Phase 6 library-hygiene implementation below are
reviewed on `codex/phase-4-librarian-followons` but are not yet on `main`.

This is a restart checkpoint, not a second project plan. Reconcile it against
git, the implementation, tests, and `docs/librarian-engine-plan.md` before
starting work. Update it only when milestone state materially changes or before
a long handoff.

## Active milestone

**Phase 4 acceptance pending; Phase 6 code-complete; Phase 5 blocked by the
Phase 4 human gate.**

Built and tested on `main` before this milestone:

- five internal library-only retrieval tools, including semantic search;
- a prompt-backed `TurnDriver` over the existing `MessageCreator` boundary;
- persisted SSE at `POST /api/librarian/chat`;
- a minimal Desk chat and action feed;
- four scripted fixture archetypes.

Implemented and independently reviewed in the current worktree:

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

Not started. Includes migration E, explicit and implicit feedback capture,
taste-centroid behavior with a cold-start gate, feedback-aware ranking,
Hardcover, and the planned dataset additions. Google Books and Wikidata are
already implemented enrichment providers. Explicit query constraints always
outrank personalization.

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

Obtain a consistent read-only Curator snapshot from the live AudioShelf data
volume. The public catalog APIs are reachable but do not expose stored embedding
vectors, so catalog JSON alone cannot run the cosine/weight harness. Encode the
approved stable book IDs and real query vectors, run
`npm run acceptance:retrieval`, and have Joel judge the cosine distributions,
weight grid, and Key West rank-1 result. Do not begin Phase 5 before that
acceptance.
