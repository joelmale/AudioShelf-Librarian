# UI v2 Preview

## Purpose

UI v2 is a reversible, fully live interface running alongside the classic AudioShelf-Librarian UI. It is an Audiobookshelf sidecar for scouting, acquiring, curating, organizing, converting, and auditing. It does not replace Audiobookshelf playback or consumer browsing.

## Access and rollback

- Open **Try UI Preview** in the classic sidebar or navigate to `/preview/desk`.
- Use **Return to classic UI** at the bottom of the desktop rail. On mobile it is available from the slide-out rail.
- Classic URLs remain unchanged: `/`, `/curator/*`, `/logs/*`, `/status`, and `/settings`.
- The preview is lazy-loaded as a separate JavaScript and CSS chunk. A preview error is contained by its own error boundary.

The preview is connected to the live backend. Search downloads, scans, filesystem actions, metadata updates, collection pushes, and M4B conversion are real operations. The interface labels this state explicitly.

## Capability parity matrix

| Role | Preview route | Live implementation | Classic remains available |
|---|---|---|---|
| Desk | `/preview/desk` | Health, operations, tag stats, collection proposals, encoding queue, audit log, sync | `/curator` |
| Scout | `/preview/scout/trends` | Bestseller services and candidate-to-search handoff | `/` |
| Acquire | `/preview/scout/search`, `/preview/acquire/downloads` | AudiobookBay search, anti-bot flow, qBittorrent handoff | `/` |
| Intake | `/preview/acquire/intake` | Directory scanner and live WebSocket progress | `/` |
| Curate review | `/preview/curate/review` | Books, filters, metadata/tag visibility | `/curator/books` |
| Collections | `/preview/curate/collections` | Generate, discover, approve/reject, reorder, push | `/curator/collections` |
| Tags | `/preview/curate/tags` | Dry run/sample/full tagging and operation controls | `/curator/tag` |
| Scan/organize | `/preview/process/scan`, `/preview/process/review` | Scan, enhance, duplicate handling, commit, rollback | `/` |
| Convert | `/preview/process/encode` | Candidate scan, queue, controls, status, history | `/curator/encode` |
| Activity | `/preview/activity` | Librarian history, curator logs, system console | `/logs` |
| Settings | `/preview/settings` | Existing live settings and connection diagnostics | `/settings` |

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
npm run build -w @audioshelf/frontend
```

The contract suite proves classic route retention, preview route coverage, style scoping, responsive and reduced-motion rules, classic escape affordances, and reuse of live workflow components. The production build proves lazy preview chunk creation.

Manual responsive checks are required at 320×568, 390×844, 768×1024, 1280×800, 1440×900, and 1920×1080 before default cutover.

## Cutover status

The classic interface remains the default. Do not redirect or delete classic routes until workflow parity, responsive QA, accessibility review, and rollback verification all pass. Update this document and the parity matrix whenever a workflow moves from shared classic presentation to a native v2 component.
