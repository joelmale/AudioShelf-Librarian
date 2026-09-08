# UI/UX Review — Shared Context

Read this first. It is the ground truth every reviewer starts from, so nobody
re-derives the app map. Verify anything you rely on heavily; correct this file's
claims in your report if you find them wrong.

## The product

AudioShelf Librarian sits on top of an Audiobookshelf library. The engine side
(recommendations, embeddings, series/wiki metadata resolution, tag canonicalization)
is mature. The interface is the weak surface.

Two distinct jobs:

1. **Desktop / at-the-desk** — curation: library management, metadata correction,
   tag work, encode jobs, realign. This is a management console and should stay one.
2. **Mobile / away-from-the-desk — THE PRIORITY** — acquisition: browsing bestseller
   lists and other discovery sources, triaging candidates, capturing intent
   ("get this" / "not this" / "maybe later") in seconds, one-handed, in a spare two
   minutes. Mobile is a *browse-and-decide* surface, not a shrunken desktop. Where
   the build treats it as one, say so.

## Verified app map (as of this review)

Monorepo, npm workspaces: `apps/frontend`, `apps/backend`, `packages/*`.
Dev server: `npm run dev` (frontend on :5173, launch.json name `audioshelf-dev`).

Frontend stack — `apps/frontend/package.json`:
- React 18.3, Vite 8, TypeScript 5.9
- react-router-dom 6.23, @tanstack/react-query 5
- recharts 3.9, lucide-react, @dnd-kit
- No CSS framework, no component library, no PWA/manifest plugin

Routing — `apps/frontend/src/App.tsx` sends everything to `PrimarySurface`
(`apps/frontend/src/preview/PreviewApp.tsx`, the "v2" shell); `/preview/*`,
`/classic/*`, `/curator/*`, `/logs/*`, `/status` are compatibility redirects.

Routes under the v2 shell (`PreviewApp.tsx:64-91`):
- `desk` — bento dashboard (`preview/pages/DeskPage.tsx`, 343 lines)
- `scout/trends` | `scout/search` | `scout/recommendations` | `scout/intake`
  — all four are `ScoutPage` modes (`preview/pages/ScoutPage.tsx` is a 19-line
  wrapper; the real UI lives in `features/librarian/components/*`)
- `curate/review` | `curate/books/:id` | `curate/encode` | `curate/collections` |
  `curate/tags` | `curate/health` | `curate/realign`
- `activity`, `activity/:id`, `settings` (deep-link that opens a dialog)

The acquisition surface — the mobile priority — is `scout/*`, backed by:
- `features/librarian/components/BestsellerLists.tsx` (545 lines) + its own
  `BestsellerLists.css` (336 lines)
- `features/librarian/components/RecommendationFinder.tsx` (171 lines)
- `features/librarian/components/AudiobookSearch.tsx`
- `features/librarian/components/ScanResultsReview.tsx`, `ScannerControl.tsx`
- `preview/components/IntakePanel.tsx`

## Existing mobile work (do not report as missing)

`preview/preview.css` already has a `max-width:800px` block with: fixed bottom nav
(`.v2-bottom-nav`, 5 columns, `env(safe-area-inset-bottom)`), an off-canvas rail,
a center FAB, bottom-sheet overlays with a drag handle, a job-status capsule, and
44px minimum control heights in settings. Judge whether it is *good*, not whether
it exists.

## Known structural facts worth weighing

- `preview/preview.css` is 65KB across 102 lines — the source is minified/single-line.
  Consider what that costs review, diffing, and iteration.
- Three unrelated style systems coexist: `styles/theme.css` (158 lines, no media
  queries), `features/curator/styles.css` (490 lines, no media queries), and
  `preview/preview.css` (all 13 media queries in the app, plus per-component CSS in
  `BestsellerLists.css` and `TagAnalytics.css`).
- `apps/frontend/index.html` has viewport meta only — no manifest, no `theme-color`,
  no icons, no `apple-*` tags.
- Routes ARE code-split: `PreviewApp.tsx:8-16` lazy-loads ScoutPage, CuratePage,
  BookDetail, CollectionDetail, JobDetailPage, UnifiedLogsPage, PreviewSettingsDialog
  and HealthReportPage via `React.lazy`; `DeferredRoute` (`PreviewApp.tsx:23`) is the
  `Suspense` wrapper, fallback `Loading {label}…`. `DeskPage` is imported eagerly as
  the landing route. Verify what actually lands in each chunk before claiming a win
  or a problem.
- Several routes are `Navigate` redirects from an older IA (`acquire/*`, `process/*`),
  which suggests the IA has already been reorganized once.

## Rules for every reviewer

- Evidence or it didn't happen. Every finding carries `file:line` or a named capture
  from the Phase 0 artifacts. Never invent a path, component, prop, or number.
- If you can't determine something, write "unknown" and say what would settle it.
- You review; you do not edit. No file changes, not even via Bash.
- Concrete over comprehensive. Twelve sharp evidenced findings beat sixty generic ones.
- "Improve contrast" is not a finding. "The metadata line at `BestsellerLists.tsx:312`
  renders 12px at 3.1:1 on the card background, and it carries the only signal that
  differentiates two adjacent cards" is a finding.
