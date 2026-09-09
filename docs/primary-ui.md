# Primary UI Architecture

## Purpose

AudioShelf-Librarian provides one responsive interface for expert sidecar work: scouting and acquiring titles, curating metadata and collections, planning directory organization, managing M4B conversion, and reviewing activity. Audiobookshelf remains the canonical listening and consumer-library application.

## Canonical routes

P4 has completed the final navigation cutover. Desk has been retired into
`/ask` redirect, `/` lands directly on `/discover/charts`, the floating action button
has been removed, and the top-level shell reflects Discover, Library, and Activity.

| Role | Route | Live workflow |
|---|---|---|
| Discover | `/discover/charts`, `/discover/for-you`, `/discover/search`, `/discover/saved`, plus legacy `/scout/*` | Bestseller discovery, recommendations, saved acquisitions, and lowercase AudiobookBay search. |
| Library books | `/library/books`, `/library/books/:id` | Library browser and book detail; legacy `/curate/review` and `/curate/books/:id` remain valid. |
| Library collections | `/library/collections`, `/library/collections/:id` | Generate, review, approve, reject, reorder, and push collections; legacy `/curate/collections` routes remain valid. |
| Manage library | `/library/manage`, `/library/manage/metadata`, `/library/manage/files`, `/library/manage/audio`, `/library/manage/audio/jobs`, `/library/manage/health` | Metadata/vocabulary, directory realignment, M4B conversion/history and library diagnostics grouped under Library; old `/curate/tags`, `/curate/realign`, `/curate/encode`, `/curate/encode/jobs`, `/curate/health` and matching `/process/*` bookmarks remain valid. |
| Activity | `/activity`, `/activity/:id` | Unified Actionable Activity feed (Needs Attention, In Progress, Completed within 24h) plus Diagnostics & History (Librarian History with Undo, Curator Logs, System Console). |
| Ask | `/ask` | Dedicated conversation history and shelf-backed questions. `/desk` preserves query/hash/state and redirects here. |
| Settings | Gear button or `/settings` | Field-level autosave, protected secrets, server path browsing, live integration diagnostics, and 100-state non-secret history. Gear opens over current route; direct `/settings` opens over `/discover/charts`. |

Desktop navigation presents Discover, Library, and Activity, with Ask and Settings
accessible in the header. Mobile bottom navigation provides Discover, Saved, Activity,
and More (opening a focus-trapped bottom sheet with Library, Ask, Settings, and Task shortcuts).
`/` lands on `/discover/charts`. Redundant floating action button (FAB) is removed.
Compatibility redirects preserve encoded book and collection identifiers, query
strings, hashes and router state for legacy bookmarks.

## Settings behavior

- Text changes are coalesced and stored after 700 ms; switches and selects are stored immediately.
- Writes are serialized so an older response cannot replace a newer draft. Failed writes remain editable and expose Retry.
- Credential fields submit only non-empty replacements. Secrets are never returned to the browser or included in history.
- The newest 100 prior non-secret states are retained. A restore first checkpoints the current state, making restore itself reversible.
- Environment-managed values are labeled and disabled because persisted UI settings cannot override them.
- Library and inbox paths can be selected through the server-scoped directory browser; choosing a path enters the same autosave queue as a typed edit.
- Full AudiobookBay, qBittorrent, Audiobookshelf, and proxy diagnostics are fetched only when requested from the compact Diagnostics group.
- Curate > Books includes **Copy all titles** for exporting the complete library title list, independent of the current filter or page.

## Loading architecture

- The shell and initial Discover route load first.
- Ask, Curate, Realign, Activity, Settings, details, encoding history, and tag analytics are route- or interaction-loaded.
- Curate loads Books, Collections, M4B, and Tags independently so Recharts analytics do not load with the book browser.
- The Vite manifest is checked after every production build. CI fails if deferred workflows enter the initial dependency graph, a classic UI chunk returns, or initial JavaScript exceeds the enforced budget.
- `#ui-v2-root[data-ui-version="v2"]` remains as the scoped design-system boundary while shared workflow components are progressively modernized.

## Filesystem safety

- New scans default to **Plan only** in the primary UI's intake review. They discover and display proposed paths without moving, renaming, integrating, or deleting files.
- Plan-only status is persisted on the server scan session. Commit, delete, duplicate integration, rollback, enhancement, and retry endpoints reject that session even if a client bypasses the disabled UI controls.
- A live scan must be started explicitly after reviewing the plan. Existing confirmations and path-containment checks continue to apply to consequential actions.
- Progress events carry the ingest job ID so validation and Activity cannot mistake a stale scan completion for the current operation.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run verify:bundle
npm run release:check
```

Use [Controlled live validation](controlled-live-validation.md) before and after a tagged deployment.
