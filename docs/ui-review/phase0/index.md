# Phase 0 — Runtime ground truth

Captured 2026-09-04 against the local dev stack. Every number here was measured in a
real browser at 390×844, not estimated. Reviewers: cite these values directly.

## How the app was run (and a dev-config bug found doing it)

`.claude/launch.json` originally ran the root `npm run dev`, which uses `concurrently`
to start backend and frontend together. The launcher exports `PORT=5173`; `concurrently`
passes it to **both** children, so the backend bound 5173 (racing Vite) instead of its
3050 default, while `apps/frontend/vite.config.ts` proxies `/api` → `localhost:3050`.
Result: every API call 502s and the whole app renders as an error state.

Fix applied to tooling only (no app code): `launch.json` now starts the frontend alone,
and the backend runs separately with `PORT=3050`. **This is a real bug in the repo's dev
setup** — anyone using launch.json hits it. Worth reporting even though it is not a UI
finding.

## Environment caveat — READ THIS BEFORE JUDGING EMPTY STATES

No `apps/backend/.env` exists, so **Audiobookshelf is not connected**:
- `/api/readiness` → `totalBooks: 0`, all metrics "Unknown", mirror empty
- `/api/librarian/recently-added` → 503 `{"error":"ABS not configured"}`
- qBittorrent unresolvable (`ENOTFOUND qbittorrent` — a Docker service name)
- Some AudiobookBay mirrors 404

**What this means for the review:**
- ✅ **Bestseller browsing works fully** — the priority mobile surface is real and
  reviewable, populated with live data from Audible / AudiobooksNow / Apple Books.
- ✅ Shell, navigation, search UI, settings, and all empty/error states are real.
- ❌ Library-aware behavior cannot be observed live: "already in my library" markers,
  personalized recommendations, curate screens with actual books. Trace those in code
  and label the finding "not observable locally" rather than asserting.

## Measured: the bestseller card (`/scout/trends`, 390×844)

Source: `features/librarian/components/BestsellerLists.tsx` + `BestsellerLists.css`.

- **43 cards** rendered, all visible in one DOM list, no virtualization.
- Card box **362×90 px**; one card per row.
- Card markup per item:
  `li.bestseller-card` > `span.bestseller-card__rank[aria-hidden=true]`
  + `button.bestseller-card__search[aria-label="Search for {title} by {author}"]`
    > `img.bestseller-card__cover[alt="" loading=lazy]`
    + `span.bestseller-card__details` > `__title` + `__author` + `__badges`
  + a second `button` `aria-label="Show description for {title}"` (44×44)
- **The entire card is a "Search AudiobookBay" button.** There is no other primary
  action, no save/dismiss, no library-state indicator anywhere in the markup.
- Chart filter chips: All charts 43 · Audible 20 · AudiobooksNow 20 · Apple Books 25 ·
  **NYT Fiction 0 · NYT Nonfiction 0** (two sources present in the UI but returning
  nothing — decide whether that is a data bug or a dead chip).
- Duplicate authors dominate the top of the list (Matt Dinniman appears at #8, #10,
  #11, #13, #14) — no series or author dedupe.
- Long titles truncate mid-word: "The Dungeon Anarchist's Coo…".

### Cover images — the biggest measured waste
- 39 image requests, **~1008 KB total**, for the bestseller list alone.
- Natural sizes served: **500×500** and 300×300.
- Rendered size: **52×52 CSS px**.
- `loading="lazy"` is set, `object-fit: cover`, `alt=""` (correct — the wrapping
  button carries the accessible name).
- Covers are **square**, not book aspect ratio.

## Measured: type, color, contrast (whole `#ui-v2-root`, `/scout/trends`)

Distinct font sizes in use (count of leaf text nodes):
`13.6px ×86 · 10.88px ×65 · 14px ×58 · 12px ×6 · 13px ×5 · 9px ×5 · 11px ×3 ·
11.6667px ×1 · 10px ×1 · 16.38px ×1 · 24px ×1 · 29px ×1`
— 12 distinct sizes; the fractional values (13.6, 10.88, 11.6667, 16.38) indicate
`em`-relative sizing rather than a defined scale.

Font weights: `700 ×74 · 650 ×48 · 550 ×47 · 750 ×44 · 400 ×19 · 600 ×1`
— six weights including non-standard 550/650/750.

**75 leaf text elements render below 12px** on a 390px-wide phone.

Text colors: only **7 distinct** across the surface —
`rgb(154,166,189) ×116 · rgb(245,247,255) ×68 · rgb(34,211,238) ×43 ·
rgb(110,123,148) ×3 · rgb(185,156,255) ×1 · rgb(74,90,106) ×1 · rgb(26,42,58) ×1`

### Contrast — mostly passing, contrary to expectation
Measured against resolved ancestor backgrounds:
- Card title `#f5f7ff` on `#0d1320` → **17.36:1**
- Card author `#22d3ee` on `#0d1320` → **10.27:1**
- Card rank / badges `#9aa6bd` on `#0d1320` → **7.57:1**
- Only **2** of ~230 text nodes fall below 4.5:1 — `"Ctrl K"` at 10px (**4.35:1**) and
  the disabled `"Clear"` button (**1.44:1**, expected for a disabled control).

**Tap targets: zero controls measured below 24×24.** Do not report undersized targets
without measuring first.

## Layout / theming notes
- `body` background is **`rgb(247,245,240)` (light)** while `#ui-v2-root` paints
  `rgb(7,10,17)` (dark). The root element spans the full document height so it is not
  visible normally, but overscroll/rubber-band would expose a light band. `index.html`
  sets no `theme-color` and no `color-scheme`.
- Document height at `/scout/trends`: 5355px. Normal document scrolling; no nested
  scroll containers on the route.
- The center FAB overlaps card content and the lower chart chips at 390px width.
- The Trends/Recommendations tab strip overflows horizontally and is clipped at the
  right edge.

## Console / network on cold load of `/scout/trends`
- 153 total resource requests.
- Errors are all ABS-dependent 503s plus one 500 — correct behavior for an
  unconfigured backend, **not** UI defects. Do not report these as bugs.

## Routes confirmed rendering
`/desk`, `/scout/trends`, `/scout/search`, `/scout/recommendations` (shell renders;
results need ABS), `/curate/review` (empty), `/activity`, settings dialog.
