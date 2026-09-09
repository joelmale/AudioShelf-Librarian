# P1 candidate handoff

Status: P1-R1 is merged on current main and awaiting Dockhand review. Current main source `2f0f9404d5cedfd5ef62064c33291c51be8c74c7` published `ghcr.io/joelmale/audioshelf-librarian@sha256:c367e2052e4863a0924f932897237c70ca718c3a438422041b5f8402dd06dffa`.

Repair update, 2026-09-09: P1-R1 was merged as `96e371762639e75be23fbfa52bf32ea15b75da15` and is included in current `main` at `2f0f9404d5cedfd5ef62064c33291c51be8c74c7`, published as `ghcr.io/joelmale/audioshelf-librarian@sha256:c367e2052e4863a0924f932897237c70ca718c3a438422041b5f8402dd06dffa`. This replaces the earlier P1 review digest for Dockhand testing. The topbar acquisition-search control is now a real input: click/fill does not navigate, and Enter submits to `/discover/search?q=...`. CI https://github.com/joelmale/AudioShelf-Librarian/actions/runs/34410202617 and publisher https://github.com/joelmale/AudioShelf-Librarian/actions/runs/34410202604 passed; linux/amd64 manifest is `sha256:266eaf5fb643c6c6df0242c01e68ce693a5ab04bf4067ebd249e0573a72496fe`.

## Publication evidence

- Source commit: `2dbdd2fc6aa5d9e12a36606f4b2fa16b773b1a7b` on `codex/ui-simplification`.
- Pullable image: `ghcr.io/joelmale/audioshelf-librarian@sha256:ca913770ea13df34733e6cb45017b33a723b29aa808c12fac185ed3e139115e4`.
- CI: [CI run 34342476367](https://github.com/joelmale/AudioShelf-Librarian/actions/runs/34342476367) success. Publisher: [Publisher run 34342476408](https://github.com/joelmale/AudioShelf-Librarian/actions/runs/34342476408) success.
- `ui-preview` and `sha-2dbdd2fc6aa5d9e12a36606f4b2fa16b773b1a7b` resolve to the same index digest. OCI revision label and cosign claims match the source commit.
- Local isolated digest smoke passed health plus P1 SPA routes; no host mounts or live network were used.

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
