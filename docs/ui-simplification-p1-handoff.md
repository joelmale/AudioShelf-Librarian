# P1 candidate handoff

Status: integrated locally and independently reviewed; publication identifiers pending commit, CI and registry verification. P0 was accepted and merged at `69b9d43`; local integration is based on latest `origin/main` at `f4faf8d`.

## User testing after publication

Deploy only the exact P1 digest recorded in `docs/ui-simplification-status.md` using Dockhand. At desktop width and around 390 pixels wide, check:

1. Open Desk. Its chat, health, recent books and operational widgets remain.
2. Open Ask. From my library shows saved conversations. Reopen one and read it; reopening should not start another answer. Submit a follow-up deliberately: it should continue that conversation. Something new opens Discover For you.
3. Browse Discover charts and source search. P1 changes labels and routes; chart layout and browsing restoration are later phases.
4. Open Library Books, a book detail, Collections and a collection. Old `/curate/review` and `/curate/collections` bookmarks should reach these homes. Check Back/Forward and an existing bookmark containing query/hash values.
5. Open Library Manage. Metadata, file organization, audio conversion/history and library health must be reachable. Inspect controls without starting work.
6. Open New task. Acquire, Intake, Realign and Convert remain available. Intake still opens its existing screen; Activity still exposes current logs/history.
7. Open Settings from Library and close it. Stay on Library with focus returned to the gear. Direct `/settings` should open over Discover charts. Existing autosave and failure messages should behave as before.
8. With a keyboard, inspect visible focus, menu/dialog Tab cycling, Escape and return focus. At mobile width, the closed rail must not receive keyboard focus; Ask and all retained navigation/actions must remain reachable.

Report issues against this P1 candidate. P2 implementation waits for acceptance. No application provider call is needed merely to inspect Ask history; submitting a question or requesting new suggestions uses the existing provider behavior.

## Migration and backup

P1 is a frontend destination/composition change with no new business schema or database migration. Preserve existing environment, permissions and volume mounts. Before upgrading, stop every process writing the shared data directory and make a consistent backup of the entire DATA_DIR, including `curator.db`, any WAL/SHM, settings, secrets, settings history and organization history. Protect the backup as secret material. Do not run old and new workers against the same data.

## Rollback

Accepted P0 rollback image:

`ghcr.io/joelmale/audioshelf-librarian@sha256:76b11fb896a6e4c0c53ec7caf13e39e840b2a2a7e8ae66b3f1ba349f3651f3c5`

Stop the P1 worker, select that immutable image in Dockhand and reuse the existing mounts/data. Do not delete data or overwrite subsequent user actions with a stale backup. For a git-built stack, use accepted source `fdbf0d4a5ecae210c79e7aa014aa53fc8308d8f5`; the registry digest above identifies the previously verified build exactly. Agents do not deploy or mutate the library.

## Phase boundaries and limitations

Desk and the mobile New task action remain intentionally. Intake and current Activity remain until P4. Saved intent, provider status, discovery restoration, acquisition correlation and offline support are later phases. Browser evidence uses synthetic data; user review validates the deployed application with its real configuration. One broad workspace test run had a transient backend proxy-test timeout; isolated and full backend reruns passed.
