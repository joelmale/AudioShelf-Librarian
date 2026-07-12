# UI v2 Default and Classic Rollback

## Purpose

UI v2 is the default, fully live AudioShelf-Librarian interface. It remains a sidecar for scouting, acquiring, curating, organizing, converting, and auditing; it does not replace Audiobookshelf playback or consumer browsing. The classic application is retained under `/classic/*` until the rollback period is explicitly approved for removal.

## Access and rollback

- `/` now opens UI v2 by redirecting to `/preview/desk`.
- Open the compact settings panel from the upper-right gear. Its **Open classic UI** link enters the retained application at `/classic`.
- Classic destinations are `/classic`, `/classic/curator/*`, `/classic/logs/*`, `/classic/status`, and `/classic/settings`.
- Existing bookmarks for `/curator/*`, `/logs/*`, `/status`, and `/settings` redirect to equivalent UI v2 workflows.
- UI v2 and classic are independently lazy-loaded. A UI v2 failure is contained by its own error boundary, which also links to `/classic`.

| Former public destination | Redirect target |
|---|---|
| `/` and `/curator` | `/preview/desk` |
| `/curator/books` and `/curator/books/:id` | `/preview/curate/review` and `/preview/curate/books/:id` |
| `/curator/tag` | `/preview/curate/tags` |
| `/curator/collections` and `/curator/collections/:id` | `/preview/curate/collections` and `/preview/curate/collections/:id` |
| `/curator/encode` and `/curator/encode/jobs` | `/preview/curate/encode` and `/preview/curate/encode/jobs` |
| `/logs/*` | `/preview/activity` |
| `/status` and `/settings` | `/preview/settings` |

The previous `/preview/acquire/downloads` and `/preview/acquire/intake` URLs remain compatibility aliases for `/preview/scout/search` and `/preview/process/scan` respectively.

UI v2 is connected to the live backend. Search downloads, scans, filesystem actions, metadata updates, collection pushes, and M4B conversion are real operations. The interface labels this state explicitly.

## Capability parity matrix

| Role | UI v2 route | Live implementation | Classic remains available |
|---|---|---|---|
| Desk | `/preview/desk` | Health, operations, tag stats, collection proposals, encoding queue, audit log, sync | `/classic/curator` |
| Scout & Acquire | `/preview/scout/trends`, `/preview/scout/search` | Bestseller discovery, AudiobookBay search, anti-bot flow, and qBittorrent handoff in one section | `/classic` |
| Intake | `/preview/acquire/intake` | Directory scanner and live WebSocket progress | `/classic` |
| Curate review | `/preview/curate/review` | Dark glass book browser, filters, metadata/tag visibility | `/classic/curator/books` |
| Needs M4B | `/preview/curate/encode` | Finds MP3/M4A books without an M4B, then queues and monitors ABS conversion | `/classic/curator/encode` |
| Collections | `/preview/curate/collections` | Generate, discover, approve/reject, reorder, push | `/classic/curator/collections` |
| Tags | `/preview/curate/tags` | Dry run/sample/full tagging and operation controls | `/classic/curator/tag` |
| Scan/organize | `/preview/process/scan`, `/preview/process/review` | Scan, enhance, duplicate handling, commit, rollback | `/classic` |
| Convert compatibility route | `/preview/process/encode` | Existing direct link to the shared conversion workflow; Curate > Needs M4B is the primary entry | `/classic/curator/encode` |
| Activity | `/preview/activity` | Librarian history, curator logs, system console | `/classic/logs` |
| Settings | Gear button, `/preview/settings` compatibility link | Compact panel with field-level autosave, protected secrets, 100-state rollback history, and classic-UI access | `/classic/settings` |

## UI v2 settings behavior

- Text edits are coalesced and stored after 700 ms; switches and selects are stored immediately. Leaving a field or closing the panel flushes pending valid edits. There is no Save button.
- Writes are serialized so a slow response cannot overwrite a newer local edit. Failed writes keep the draft in place and expose a Retry action.
- Credential fields start blank and only submit a non-empty replacement on blur or Enter. Existing credentials are represented by a configured/not-configured state and can be cleared with an explicit two-step action.
- `absToken`, `qbitPass`, `anthropicApiKey`, and `proxyUrl` remain in the separate restrictive-permission secret store. Secret values are never returned to the browser, written to settings history, or changed by a rollback.
- The server records the complete prior non-secret state before every meaningful settings change, retains the newest 100 entries in `DATA_DIR/settings-history.json`, and records the current state before a restore so restoring is itself reversible.
- History reads and restores require the administrator role. Environment-managed values are labeled and disabled in the panel because persisted UI edits cannot override them.
- Settings are persisted as they are entered. New Librarian operations read the latest state; work already in progress keeps the configuration it started with. Curator integrations that are constructed at backend startup use changed connection/provider values after the service restarts.
- Diagnostics retains the classic ABS connection check, runtime/database/library summary, and action-log verbosity. Verbosity is now persisted, applied immediately, and included in non-secret rollback history.
- Classic `POST /api/system/settings` remains supported. UI v2 uses field-level `PATCH /api/system/settings`, reads `GET /api/system/settings/history`, and restores with `POST /api/system/settings/history/:id/restore`.

## Architecture and isolation

- `App.tsx` redirects default and legacy public destinations to `/preview/*` equivalents and mounts the retained application only under `/classic/*`.
- UI v2 and classic code are separate `React.lazy` branches, so a normal UI v2 session does not eagerly download classic workflow components.
- Classic Curator links receive a `/classic/curator` base path, keeping book, collection, and encoding detail navigation inside the rollback branch.
- `#ui-v2-root[data-ui-version="v2"]` owns all UI v2 tokens and reset rules.
- UI v2 CSS contains no `body`, `html`, or `:root` selectors.
- Existing `theme.css` and Curator styles are retained. Reused workflow components receive UI v2 overrides only while nested under the UI v2 root.
- Radix/Tailwind adoption can continue inside this boundary without changing classic route behavior. The current foundation uses scoped semantic CSS so it does not introduce a global preflight.

## Verification

Run:

```powershell
npm run test -w @audioshelf/frontend
npm run test -w @audioshelf/backend
npm run build -w @audioshelf/frontend
```

The redirect tests cover every former public bookmark, dynamic book and collection identifiers, generic fallbacks, and trailing slashes. The contract suite proves classic route retention, UI v2 route coverage, style scoping, responsive and reduced-motion rules, rollback affordances, UI v2 settings, and reuse of live workflow components. Focused store and autosave tests cover history retention, secret exclusion, reversible restores, write ordering, debounce, and retry behavior. The production build must produce separate UI v2 and classic chunks; a browser network smoke test verifies that a default UI v2 session does not request the classic chunk.

Continue responsive regression checks at 320×568, 390×844, 768×1024, 1280×800, 1440×900, and 1920×1080 throughout the rollback period.

## Cutover status

UI v2 is the default. Keep `/classic/*`, its lazy bundle, and the Settings escape link until real-world use is approved and classic removal is explicitly requested. Removal is a separate change and must not be inferred from this cutover.
