# P1 work orders

Baseline: accepted P0 merge `69b9d43b1a812517de856e2323de62dbd5f2cb02`; final integration rebased by fast-forward onto latest `origin/main` at `f4faf8db67858c8574a6571e16237fec3c3640c3`. Root owns sequencing, integration, publication and the user gate. No live writes.

## Contract and sequence

Sol/high tech_lead completed P1-A read-only decomposition. Luna/medium explorer confirmed existing chat history, explicit submission, follow-up and live-only external continuation behavior. Effective child models are not exposed by the host unless noted.

1. **P1-C, Terra/medium ic_implementer:** isolated `AudioShelf-UI-P1-Pages`, branch `codex/ui-p1-pages`. Owned Desk/Curate/Ask pages, shared Library summary components, LibrarianChatPanel and tests. Outcome: Ask route, shared Library health/recent display, Desk preservation and chat history/follow-up request separation.
2. **Independent P1-C review, Terra/high ic_reviewer:** reviewed actual diff for request separation, router state, unknown/loading states and capability preservation. Findings were repaired in the Shell candidate: no chat/recommendation request on history reopen, stronger router-state preservation, LibrarySummary loading and health-error tests.
3. **P1-B/D, Terra/medium ic_implementer:** isolated `AudioShelf-UI-P1-Shell`, branch `codex/ui-p1-shell`. Owned PreviewApp, Scout labels, canonical/legacy route aliases, preview CSS, bundle verifier and shell/focus behavior. Outcome: Discover/Library route map, Settings fallback, retained New task operations, utility Ask, hidden mobile nav focus handling and improved contrast.
4. **Independent B/D/harness review, Terra/high and Sol/high ic_reviewer:** harness review found four medium gaps in traffic safety, fixture validation, route/content assertions and follow-up proof; all were repaired and rerun. Integrated Sol/high review requested four repairs and passed after focused reruns.
5. **Root integration and gate:** copied only reviewed P1-owned files into `AudioShelf-UI-P0` on `codex/ui-simplification` after fast-forwarding to latest main. Ran local release gate and synthetic browser QA before publication.

No backend persistence, schema, acquisition, qBittorrent, ABS write, Activity restructure, Saved intent, Discover continuity restoration, P4 cutover or P7 work was authorized or performed in P1. Desk and the mobile New task action intentionally remain. Shared contracts and shell/CSS writes were serialized.

## Stable page interface

`AskPage()` is exported from `apps/frontend/src/preview/pages/AskPage.tsx`.
`CuratePage({ section })` exports `LibrarySection` with `books`, `collections`, `manage`, `metadata`, `files` and `audio`, while retaining legacy `tags`, `realign` and `encode`. Health/detail/jobs remain shell-composed lazy routes. `LibrarianChatPanel` accepts optional `bookBasePath` and `acquisitionSearchPath`, defaulting to `/library/books` and `/discover/search`; existing Desk behavior stays shared.

Canonical destinations are `/discover/charts`, `/discover/for-you`, `/discover/search`, `/ask`, `/library/books`, `/library/books/:id`, `/library/collections`, `/library/collections/:id`, `/library/manage`, `/library/manage/metadata`, `/library/manage/files`, `/library/manage/audio`, `/library/manage/audio/jobs` and `/library/manage/health`. Old Scout/Curate/process aliases replace history while preserving encoded IDs, query, hash and router state. Intake stays `/scout/intake` until P4. Desk, root fallback, current Activity and mobile New task remain available. Direct Settings opens over `/discover/charts`; gear Settings preserves the current route.

## Verification evidence

Integration worktree `C:/Users/nelso/Documents/Coding/AudioShelf-UI-P0`, Node 24.4.1:

- `npm run typecheck`
- `npm run lint` - 0 errors, 131 existing warnings
- `npm --workspace @audioshelf/backend test` - 111 files, 1619 tests
- Frontend tests from broad `npm test` run - 24 files, 221 tests
- `npm run build`
- `npm run verify:bundle` - 289123/300000 initial JS, deferred Ask/Scout/Curate/Realign/Activity/Settings/Metadata
- `npm run release:check`
- `git diff --check`
- `node scripts/ui-p1-browser.mjs --dist apps/frontend/dist --output-dir temp/ui-p1-browser --playwright-prefix C:/Users/nelso/AppData/Local/Temp/audioshelf-ui-playwright/node_modules/playwright` - 390x844, 768x1024 and 1440x1000; 231 fixtures; no blocked requests

Publication records source SHA, CI runs, pullable digest and revision/signature verification in the main checkpoint and P1 handoff. P1 has no migration; accepted P0 digest is the rollback candidate.
