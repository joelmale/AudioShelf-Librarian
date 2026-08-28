---
name: audioshelf-work-order
description: Coordinate complex AudioShelf-Librarian milestones through the repository's tech_lead, explorer, ic_implementer, and ic_reviewer roles. Use when the user asks for multi-agent execution, parallel implementation, or completion of a plan phase; do not invoke for a quick one-file change or a read-only question unless the user explicitly requests agents.
---

# AudioShelf Work Order

Use the repository's multi-agent operating model to complete a bounded milestone
without losing safety, state, or review accountability.

## Establish the baseline

Read, in order:

1. `AGENTS.md`.
2. `docs/agent-operating-model.md`.
3. `docs/current-status.md`.
4. The relevant sections of `docs/librarian-engine-plan.md` and any linked
   architecture or readiness documents.

Inspect `git status`, recent commits, the relevant implementation, and tests.
Treat the code and verified behavior as current reality; treat status documents
as checkpoints that must be reconciled. Preserve user changes and do not reuse a
dirty checkout for unrelated parallel writes.

## Orchestrate the milestone

Keep the main task as orchestrator. For a phase or cross-cutting milestone,
start with `tech_lead` to produce a dependency-ordered plan and explicit work
orders. Use `explorer` for bounded read-only investigations and
`ic_implementer` for one ownership slice at a time.

Use at most three spawned agent threads at once, or the host's lower limit.
Parallelize read-heavy work freely when independent. Parallelize writes only
when file ownership is disjoint and isolated; otherwise serialize them. Shared
schemas, migrations, API contracts, central registries, and safety-critical
files are single-writer surfaces.

Every work order must include:

- outcome and scope;
- relevant context and exact contracts;
- files or ownership boundaries, plus exemplar files;
- safety constraints and explicit exclusions;
- named test expectations;
- measurable completion criteria;
- required handoff format.

## Gate implementation through review

After each implementation slice, assign `ic_reviewer` a read-only review of the
actual diff. If it finds a material problem, return the findings to the original
implementer and review the correction again. Do not accept self-reported success
or a passing test that cannot fail when the claimed behavior is removed.

The orchestrator integrates only after dependencies are satisfied, material
review findings are closed, and the relevant checks pass. Run targeted checks
throughout; run the full repository gate when the combined milestone warrants
it.

## Stop at human gates

Do not perform live-library mutations, one-way Audiobookshelf writes, production
deployment, secret or credential changes, destructive git operations, or other
irreversible external actions without explicit user authorization for that
specific action.

The librarian plan also reserves judgment calls for the user, including real
cosine-weight tuning and the hand-authored expected results for real-library
queries. Prepare evidence and a reviewable harness, then ask for that judgment
instead of inventing it.

Keep the transcript pipeline parked until its documented prerequisites and
decision gate are satisfied. Do not treat parked work as permission to start it.

## Preserve restartability

Update `docs/current-status.md` when milestone state materially changes or
before a long handoff. Record completed work, current work, verification,
blockers, decisions, and the exact next action. Keep detailed design history in
the canonical plan or architecture decisions rather than expanding the
checkpoint indefinitely.

Finish with one consolidated report: outcome, work orders completed, files
changed, verification, review disposition, remaining risks, human decisions,
and next action.
