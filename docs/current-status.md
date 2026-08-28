# Current agent checkpoint

Last reconciled: 2026-08-27 against `HEAD` plus the current shared worktree.
The Phase 4 follow-ons below are implemented and reviewed but are not yet on
`main`.

This is a restart checkpoint, not a second project plan. Reconcile it against
git, the implementation, tests, and `docs/librarian-engine-plan.md` before
starting work. Update it only when milestone state materially changes or before
a long handoff.

## Active milestone

**Phase 4 — Librarian: code-complete; real-library acceptance pending.**

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

None of those implementation reviews is the human acceptance decision. The
harness has not run on a real snapshot, its query slots and expectations remain
empty, and the real Key West result has not been judged.

## Remaining sequence

### Phase 4 acceptance and follow-ons

- Populate and run the snapshot harness for §10.C step 6. The user judges the
  real cosine distributions and any ranker-weight change.
- Review `docs/phase-4-retrieval-query-proposal.md`: it now proposes ten
  representative queries and human-readable expected results for §10.C step 7,
  including the real Key West ranking. Approve or modify the wording,
  constraints, rank-1 titles, inclusions, and exclusions before IDs/vectors are
  encoded in the harness fixture.

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

Not started. Replace the hardcoded folder convention with a configurable or
detected pattern, rebuild the structure metric against the user's actual
convention, and make realignment safe for non-default libraries. The interim
health state remains `Unknown`; no agent may validate this by mutating the live
library.

### Transcript pipeline

Parked. Do not start until Phase 6 is complete and the cheaper-source sequence
in `docs/audio-transcript-pipeline-plan.md` has been measured. Re-evaluate
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

Joel approves or modifies `docs/phase-4-retrieval-query-proposal.md`, then
provides a distinct read-only Curator snapshot. Encode the approved stable book
IDs and real query vectors, run `npm run acceptance:retrieval`, and have Joel
judge the cosine distributions, weight grid, and Key West rank-1 result. Do not
begin Phase 5 before that acceptance.
