# UI v2 Preview

## Purpose

UI v2 is a reversible, fully live interface running alongside the classic AudioShelf-Librarian UI. It is an Audiobookshelf sidecar for scouting, acquiring, curating, organizing, converting, and auditing. It does not replace Audiobookshelf playback or consumer browsing.

## Access and rollback

- Open **Try UI Preview** in the classic sidebar or navigate to `/preview/desk`.
- Open the compact settings panel from the gear in the preview command bar. The `/preview/settings` deep link opens the same panel and returns to Desk.
- Use **Return to classic UI** at the bottom of the desktop rail. On mobile it is available from the slide-out rail.
- Classic URLs remain unchanged: `/`, `/curator/*`, `/logs/*`, `/status`, and `/settings`.
- The preview is lazy-loaded as a separate JavaScript and CSS chunk. A preview error is contained by its own error boundary.

The preview is connected to the live backend. Search downloads, scans, filesystem actions, metadata updates, collection pushes, and M4B conversion are real operations. The interface labels this state explicitly.

## Capability parity matrix

| Role | Preview route | Live implementation | Classic remains available |
|---|---|---|---|
| Desk | `/preview/desk` | Health, operations, tag stats, collection proposals, encoding queue, audit log, sync | `/curator` |
| Scout & Acquire | `/preview/scout/trends`, `/preview/scout/search` | Bestseller discovery, AudiobookBay search, anti-bot flow, and qBittorrent handoff in one section | `/` |
| Intake | `/preview/acquire/intake` | Directory scanner and live WebSocket progress | `/` |
| Curate review | `/preview/curate/review` | Dark glass book browser, filters, metadata/tag visibility | `/curator/books` |
| Needs M4B | `/preview/curate/encode` | Finds MP3/M4A books without an M4B, then queues and monitors ABS conversion | `/curator/encode` |
| Collections | `/preview/curate/collections` | Generate, discover, approve/reject, reorder, push | `/curator/collections` |
| Tags | `/preview/curate/tags` | Dry run/sample/full tagging and operation controls | `/curator/tag` |
| Scan/organize | `/preview/process/scan`, `/preview/process/review` | Scan, enhance, duplicate handling, commit, rollback | `/` |
| Convert compatibility route | `/preview/process/encode` | Existing direct link to the shared conversion workflow; Curate > Needs M4B is the primary entry | `/curator/encode` |
| Activity | `/preview/activity` | Librarian history, curator logs, system console | `/logs` |
| Settings | Gear button, `/preview/settings` compatibility link | Preview-native compact panel with field-level autosave, protected secrets, and 100-state rollback history | `/settings` |

## Preview settings behavior

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

- `App.tsx` routes `/preview/*` before the wildcard classic branch.
- Preview code is loaded with `React.lazy`; the classic bundle does not eagerly import it.
- `#ui-v2-root[data-ui-version="v2"]` owns all preview tokens and reset rules.
- Preview CSS contains no `body`, `html`, or `:root` selectors.
- Existing `theme.css` and Curator styles are retained. Reused workflow components receive preview overrides only while nested under the preview root.
- Radix/Tailwind adoption can continue inside this boundary without changing classic route behavior. The current foundation uses scoped semantic CSS so it does not introduce a global preflight.

## Verification

Run:

```powershell
npm run test -w @audioshelf/frontend
npm run test -w @audioshelf/backend
npm run build -w @audioshelf/frontend
```

The contract suite proves classic route retention, preview route coverage, style scoping, responsive and reduced-motion rules, classic escape affordances, preview-native settings, and reuse of live workflow components. Focused store and autosave tests cover history retention, secret exclusion, reversible restores, write ordering, debounce, and retry behavior. The production build proves lazy preview chunk creation.

Manual responsive checks are required at 320×568, 390×844, 768×1024, 1280×800, 1440×900, and 1920×1080 before default cutover.

## Cutover status

The classic interface remains the default. Do not redirect or delete classic routes until workflow parity, responsive QA, accessibility review, and rollback verification all pass. Update this document and the parity matrix whenever a workflow moves from shared classic presentation to a native v2 component.
