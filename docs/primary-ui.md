# Primary UI Architecture

## Purpose

AudioShelf-Librarian provides one responsive interface for expert sidecar work: scouting and acquiring titles, curating metadata and collections, planning directory organization, managing M4B conversion, and reviewing activity. Audiobookshelf remains the canonical listening and consumer-library application.

## Canonical routes

| Role | Route | Live workflow |
|---|---|---|
| Desk | `/desk` | Health, recommendations, review counts, active work, conversion queue, and recent audit events |
| Scout & Acquire | `/scout/trends`, `/scout/search` | Bestseller discovery, lowercase AudiobookBay search, anti-bot recovery, and intentional qBittorrent handoff |
| Curate | `/curate/review`, `/curate/books/:id`, `/curate/tags` | Metadata diagnosis, book detail, tags, dry runs, and operation controls |
| Collections | `/curate/collections`, `/curate/collections/:id` | Generate, review, approve, reject, reorder, and push |
| M4B | `/curate/encode`, `/curate/encode/jobs` | Candidate discovery, queue controls, progress, and history |
| Process | `/process/scan`, `/process/review`, `/process/organize` | Plan-only-by-default directory analysis, scan progress, proposed changes, controlled commit, and rollback |
| Activity | `/activity`, `/activity/:id` | Librarian history, curator operations, and system console |
| Settings | Gear button or `/settings` | Field-level autosave, protected secrets, server path browsing, live integration diagnostics, and 100-state non-secret history |

`/` redirects to `/desk`. Compatibility redirects preserve the former `/preview/*`, `/classic/*`, `/curator/*`, `/logs/*`, and `/status` bookmarks, including encoded book and collection identifiers, query strings, and hashes.

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

- The shell and Desk load first.
- Scout, Process, Curate, Activity, Settings, details, encoding history, and tag analytics are route- or interaction-loaded.
- Curate loads Books, Collections, M4B, and Tags independently so Recharts analytics do not load with the book browser.
- The Vite manifest is checked after every production build. CI fails if deferred workflows enter the initial dependency graph, a classic UI chunk returns, or initial JavaScript exceeds the enforced budget.
- `#ui-v2-root[data-ui-version="v2"]` remains as the scoped design-system boundary while shared workflow components are progressively modernized.

## Filesystem safety

- New scans default to **Plan only** in the primary UI. They discover and display proposed paths without moving, renaming, integrating, or deleting files.
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
