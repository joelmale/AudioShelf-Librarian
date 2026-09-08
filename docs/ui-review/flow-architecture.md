# UX Flow & Information Architecture

Reviewer: ux-flow-architect. Scope: whole app, mobile acquisition weighted highest.
Evidence is `file:line` against the tree at review time, plus measured values cited from
`docs/ui-review/phase0/index.md`. Library-aware screens are traced in code and labelled
**not observable locally** (no `apps/backend/.env`, ABS unconfigured).

---

## Verdict

The acquisition path is architecturally a *browse* surface with a *transaction* bolted to
it: discovery, evaluation, and purchase all happen inside a single 5355px-tall route with
no history entries between them, so the phone's Back button cannot step backwards through
the one flow it exists to serve. The bestseller card's single verb is not a small omission
— it is the shape of the whole IA, because "get this" is the only intent the system can
receive from its highest-traffic surface, while the API that would accept "not this"
already exists and is wired only to the desktop-shaped panel next door. The v2 shell's four
groups are sound for the desk, but on a phone they rank acquisition alongside curation, put
the acquisition *outcome* on a different top-level tab from the acquisition *action*, and
spend the scarce fifth nav slot on a Settings dialog that is already reachable from the
top bar.

---

## Findings

### CRITICAL 1 — The decision step is a scroll jump, not a navigation; list position is destroyed and unrecoverable

**Evidence.** `BestsellerLists.tsx:206-212` — the card's primary action dispatches a
`window` `CustomEvent("trigger-audiobook-search")`. No router call, no state push.
`AudiobookSearch.tsx:57-73` — the listener sets the query, runs the search, and calls
`document.getElementById("audiobook-search-section").scrollIntoView({behavior:"smooth"})`.
`ScoutPage.tsx:17` — on `mode==="trends"`, `<AudiobookSearch/>` renders **above** the
divider and `<BestsellerLists/>`, so the scroll target is at the top of the page.
Phase 0: document height 5355px, 43 cards, 362×90 each, no virtualization.

**User consequence.** A user triaging at card #30 is roughly 2700px down the page. Tapping
the card yanks the viewport to the top of the document. The URL never changed, so Back does
not return to the list — it exits `/scout/trends` entirely (to `/desk`, or out of the app).
Returning to card #31 means manually re-scrolling ~2700px, past the search panel they just
used. Comparing candidate 30 against candidate 31 is the core mobile job described in
`context.md`, and it costs a full-page re-scroll per candidate. The chart-tab selection
survives only incidentally, because `BestsellerLists` never unmounts.

**Proposed fix.** Give evaluate its own history entry — a route or a bottom sheet pushed
with `navigate()` (e.g. `/scout/trends?candidate=<consensusKey>`), so Back returns to the
list. If the sheet is preferred, keep the list mounted underneath and never scroll it.

---

### CRITICAL 2 — The card carries one verb, the most expensive one; two of the three mobile intents have no representation, and the API for one already exists

**Evidence.** `BestsellerLists.tsx:314-423` — the `<li>` is exactly three children: a rank
`<span aria-hidden>`, the search `<button>`, and an info `<button>`. There is no save, no
dismiss, no library-state indicator. At ≤480px the search button owns ~286px of the 362px
card (`BestsellerLists.css:317-319`: `32px minmax(0,1fr) 44px`) — 79% of the card is one
target that means "search a torrent index".

The contrast is one component away: `RecommendationFinder.tsx:151-157` renders **More like
this** / **Not for me** against `api.sendFeedback`. And `api.ts:617-622` shows that call's
signature accepts `externalKey` with **no `bookId` required** — precisely the shape a
bestseller row needs, and `consensusKey()` (`BestsellerLists.tsx:95-106`) already computes a
stable cross-chart identity that would serve as one.

"Maybe later" has no representation anywhere: a repo-wide grep for
`watchlist|shortlist|savedForLater|wishlist` across `apps/frontend/src` returns nothing.

**User consequence.** The only way to say "yes" is to complete a torrent search and download
synchronously, in the moment — which is the opposite of the "spare two minutes, one-handed"
job. "No" and "later" cannot be said at all, so a second visit renders the same 43 cards in
the same order with no memory of what was already rejected. Phase 0 measured duplicate
authors dominating the top (Matt Dinniman at #8/#10/#11/#13/#14), so the un-dismissable
repetition is concentrated exactly where the user starts. The engine's taste profile — which
the desktop panel feeds — learns nothing from the surface that gets the most attention.

**Proposed fix.** Make the search button one of three verbs rather than the whole card:
Get (opens the evaluate sheet from CRITICAL 1), Not for me (`sendFeedback` with
`verdict:'rejected'`, `externalKey: consensusKey(book)`), Later (a saved list). Persist
dismissals so the list shrinks as it is worked.

---

### CRITICAL 3 — Acquisition's only confirmation lives on a different top-level tab

**Evidence.** `apps/backend/src/modules/librarian/index.ts:925-944` — `POST /download`
resolves a magnet, calls `qbtService.addMagnetLink`, returns `{success:true}`. It creates
**no operation record**. `AudiobookSearch.tsx:100-106` shows a toast and disables the button
to "Download sent". The floating job capsule (`PreviewApp.tsx:94`) is driven by
`useOperations`, so it never fires for a download. The only surface that shows the download
is the Desk's Acquisitions Queue (`DeskPage.tsx:287-316`), fed by `useAcquisitionPipeline`
(`api.ts:815-816`, polling every 5s) — a hook mounted **only** on `DeskPage`.

**User consequence.** The mobile flow ends on `/scout/trends` with a toast and a disabled
button. To confirm the book is actually downloading, the user must cross to another
top-level nav destination and scroll: on mobile the bento is a flex column ordered
`health(1) → review(2) → downloads(3)` (`preview.css`, second `@media(max-width:800px)`
block), and the bento itself sits below the page heading, the `ReadinessStrip`
(`DeskPage.tsx:201`) and the full `LibrarianChatPanel` (`DeskPage.tsx:207`). If the book then
needs a decision, the route back into Scout is a `Review` link inside that Desk card
(`DeskPage.tsx:306` → `/scout/intake`). One book crosses top-level tabs twice.
*Not observable locally* — the pipeline needs qBittorrent, which is unresolvable here.

**Proposed fix.** Surface the acquisition pipeline where the acquisition happened: a compact
status strip on `/scout/*` reusing `useAcquisitionPipeline`, or extend the job capsule to
cover downloads. Keep the Desk card for desk use.

---

### HIGH 4 — The mobile bottom nav computes active state differently from the desktop rail; 11 of 17 routes highlight nothing

**Evidence.** `PreviewApp.tsx:49` (rail) derives active state by **group**:
`location.pathname.startsWith('/' + group)`. `PreviewApp.tsx:96` (bottom nav) renders bare
`<NavLink to={'/' + to}>` with no `className` and no group logic, so react-router 6.23
(`apps/frontend/package.json:22`) marks it active only on an exact or `to`-prefixed match.
`.v2-bottom-nav a.active{color:#a78bfa}` is the only active styling.

Routes where **no** bottom-nav item highlights: `/scout/search`,
`/scout/recommendations`, `/scout/intake`, `/curate/books/:id`, `/curate/encode`,
`/curate/encode/jobs`, `/curate/collections`, `/curate/collections/:id`, `/curate/tags`,
`/curate/health`, `/curate/realign` — 11 of the 17 non-redirect routes.

**User consequence.** This lands hardest on the priority path: three of the four Scout modes
show no "you are here" on a phone, including `/scout/search` (the second half of every
acquire) and `/scout/intake` (where the New-task sheet sends you, `PreviewApp.tsx:103`). The
desktop, which needs it least, is the surface that gets it right.

**Proposed fix.** Reuse line 49's group comparison in the bottom nav.

---

### HIGH 5 — The FAB is centred at 50% but the nav notch is cut at the 3/4 boundary of a 5-column grid, so the FAB sits on top of the Curate tab

**Evidence.** From `preview.css` `@media(max-width:800px)`:
`.v2-mobile-fab{position:fixed;bottom:38px;left:50%;transform:translateX(-50%);width:58px;height:58px;z-index:55}`
`.v2-bottom-nav{grid-template-columns:repeat(5,1fr);height:72px;padding:7px 4px calc(7px + env(safe-area-inset-bottom));z-index:50}`
`.v2-bottom-nav a:nth-child(3){padding-right:28px}` · `a:nth-child(4){padding-left:28px}`

With five equal columns the boundary between children 3 and 4 is at **60%**, but the FAB is
at **50%** — the arithmetic only lines up for a six-column nav. Slot 3 is **Curate**
(`PreviewApp.tsx:96` order: desk, scout/trends, curate/review, activity, settings), whose
cell spans 40–60%. The FAB spans 38–96px from the viewport bottom; the nav's content box
runs ~7–65px, so the FAB covers the top ~27px of Curate's cell — where the icon renders
(flex column, icon then a 9px label). Phase 0 independently observed the FAB overlapping
card content and the lower chart chips at 390px.

Secondary collision: `.v2-job-capsule{bottom:78px;min-height:50px;z-index:45}` spans
78–128px and the FAB spans 38–96px — an 18px overlap, with the FAB (z-55) punching through
the capsule's lower edge between its label and its percentage.

**User consequence.** A top-level destination's icon is obscured and its tap area partly
occluded by a higher-z-index button that opens an unrelated sheet; the notch padding
meanwhile shifts items 3 and 4 apart at a point where nothing sits.

**Proposed fix.** Move Settings out of the bottom nav (it is already a top-bar control,
`PreviewApp.tsx:62`, and `.v2-settings-trigger{margin-left:auto}` keeps it visible on
mobile). That leaves four destinations; make the grid six columns with the FAB owning the
true centre, or keep four columns and move the notch onto the cell the FAB actually covers.

---

### HIGH 6 — `scout/*`'s four modes are three things, one of which is a strict subset of another

**Evidence.** `ScoutPage.tsx:17` — `trends` renders `<AudiobookSearch/>` + a divider +
`<BestsellerLists/>`; `search` renders `<AudiobookSearch/>` alone. "Search & download" is
exactly the top half of "Trends & discovery". `recommendations` (`RecommendationFinder`) and
`intake` (`IntakePanel`) are genuinely distinct.

**User consequence.** The tab strip (`ScoutPage.tsx:11-16`) presents four peers where two
are the same surface at different zoom levels — and a user on Trends who taps a card is
silently driven into the Search tab's content without the tab ever changing (CRITICAL 1).
Separately, Intake is *post-acquisition* triage over the local filesystem — its own heading
calls it "Live filesystem" and flags it `v2-live warning` (`ScoutPage.tsx:10`) — grouped with
three *pre-acquisition* discovery surfaces. Phase 0 measured the strip overflowing and
clipping at the right edge at 390px, so the fourth tab is the one that falls off.

**Proposed fix.** Scout becomes one discovery list with a source filter (Trends and
Recommendations are two sources of candidates, not two pages). Search stops being a peer tab
and becomes the evaluate step reached from a card. Intake leaves Scout.

---

### MEDIUM 7 — `/curate/health` is an orphan: no tab, no back, no nav highlight

**Evidence.** `CuratePage.tsx:14-20` lists five tabs (`/curate/review`, `/curate/encode`,
`/curate/collections`, `/curate/realign`, `/curate/tags`). `/curate/health`
(`PreviewApp.tsx:79`) renders `HealthReportPage` (107 lines), whose only `Link`s are outbound
(`:56` → `/curate/tags`, `:70` → `/curate/encode`, `:88` → `/curate/realign`). Its sole entry
point is `DeskPage.tsx:273`. Compare the sibling detail routes, which all pass an explicit
back path (`PreviewApp.tsx:73,75,77`).

**User consequence.** A leaf page rendered outside its own section's tab strip, with no back
control and — per HIGH 4 — no highlighted bottom-nav item. Every exit is a lateral jump into
a different curate section or the browser Back button. *Not observable locally* (needs ABS).

**Proposed fix.** Give it a `backPath` like its siblings, or add it to the Curate tab strip.

---

### MEDIUM 8 — The transient description overlay is desktop-pointer logic left on the touch surface, and it fires on the acquire tap

**Evidence.** `BestsellerLists.tsx:328-353` — the search button's `onFocus` and
`onMouseEnter` both call `showDescription(..., pinned:false)`, which may issue a live
`fetch` to `itunes.apple.com` (`:248-251`). The **pinned** overlay is correctly rebuilt as a
mobile bottom sheet (`BestsellerLists.css:306-313`: `bottom: calc(86px + safe-area)`,
`left/right:14px`, `max-height: min(42vh,320px)`) — good work, credit where due. The
**transient** one gets no such override and keeps the pointer-clamped geometry from
`BestsellerLists.tsx:453-464` plus `BestsellerLists.css:253-259`
(`width:min(320px, 100vw-32px)`, `max-height:min(400px, 100vh-32px)`).

On a 390×844 phone those clamps resolve to `left: max(16, min(x+14, 56))` — i.e. 56px for
any tap right of x=42 — and `top: max(16, min(y+14, 428))`.

**User consequence.** Tapping a card to acquire it also fires `onFocus`, which opens a
320×≤400px panel at a fixed mid-screen position unanchored to the tapped card, and can spend
a network round-trip on a description nobody asked for — all while the page smooth-scrolls
away underneath it (CRITICAL 1). It is `pointer-events:none` and closes on blur, so it does
not block, but the acquire tap renders a disconnected panel over the list. The consequential
verb gets the scroll jump; the inconsequential one gets the well-built bottom sheet.

**Proposed fix.** Gate the hover/focus preview behind a fine pointer, or drop the transient
variant on touch and let the ⓘ sheet be the only description affordance.

---

### MEDIUM 9 — Duplicate adjacent heading on the priority route

`ScoutPage.tsx:17` renders `<div className="v2-section-divider"><span>Top Bestsellers</span></div>`
immediately before `<BestsellerLists/>`, whose first child is
`<h2 id="bestseller-heading">Top Bestsellers</h2>` (`BestsellerLists.tsx:468`). Two identical
labels stacked, consuming above-the-fold vertical space on the one surface where vertical
space is the scarcest resource.

---

### MEDIUM 10 — The reorganization did not finish, and the stylesheet records it

**Evidence.** There are **two** separate `@media(max-width:800px)` blocks in `preview.css`
that both set the Desk bento order. The later wins, so the earlier block's
`.v2-review{order:1} .v2-active{order:2} .v2-plan{order:4} .v2-sync{order:5} .v2-queue{order:6}`
are entirely dead. That same dead block sets `.v2-trends{order:3;min-height:0}` — a
`grep -rn "v2-trends" --include=*.tsx` across `apps/frontend/src` returns **nothing**: the
element it targets no longer exists. Eight `@media(max-width:800px)` blocks exist in total.

The legacy redirect map is likewise maintained twice: `legacyRedirects.ts:30-37` and
`PreviewApp.tsx:70-71,81-86` both map `acquire/*` and `process/*`. Both are live, on
different entry paths — `App.tsx:27-31` routes only `/preview/*`, `/classic/*`, `/curator/*`,
`/logs/*` and `/status` through `CompatibilityRedirect`, so a bare `/acquire/downloads` is
served by the `<Route>` copy and `/preview/acquire/downloads` by the module copy.

**What the old IA was.** `acquire/{downloads,intake}` and
`process/{scan,review,organize,realign,encode}` — an Acquire / Process / Curate split. The
reorganization folded acquire **and** process-scan into `scout/*`, and process-realign and
process-encode into `curate/*`. That is why Scout now owns both "find a book" and "clean up
the files that arrived": two jobs at opposite ends of the pipeline, joined only by not being
curation. Finding HIGH 6 is the residue of that merge.

---

### POLISH 11 — Two of six chart chips are known dead ends before the tap

Phase 0 measured NYT Fiction 0 and NYT Nonfiction 0. The empty state explains the cause well
(`BestsellerLists.tsx:506-508`, "needs a Books API key in Settings → Discovery"), but the
chip itself renders a bare `0` (`:492-494`) with no disabled or configure affordance. On a
surface where taps are the budget, two of six filters spend one to learn they are empty.
Either mark the chip as needing configuration or hide unconfigured sources.

### POLISH 12 — "Scout & Acquire" is a two-concept compound in the narrowest slot in the app

`PreviewApp.tsx:96` puts that label in a 5-column bottom nav at
`font-size:9px; max-width:64px` (`preview.css`). It wraps. The label names the group's two
jobs because the group has two jobs; fixing HIGH 6 makes a one-word label possible.

---

## Before / after IA

### Before — mobile, bestseller → shelved (measured against the route table)

| # | Step | Route | Taps |
|---|------|-------|------|
| 1 | Launch → redirect | `/` → `/desk` (`App.tsx:32`, `PreviewApp.tsx:90`) | 0 |
| 2 | Bottom nav → Scout | `/scout/trends` | 1 |
| 3 | Scroll past heading, 4 section tabs, the whole `AudiobookSearch` panel (its form forced to one column by `.v2-legacy-surface form{grid-template-columns:1fr!important}` → 4 stacked rows), divider, duplicate `<h2>`, 6 chart chips | — | 0 |
| 4 | Scroll the 43-card list (5355px document, no virtualization) | — | 0 |
| 5 | *(optional)* ⓘ → bottom sheet → close | — | 2 |
| 6 | Tap card → iTunes fetch + smooth scroll to page top; **URL unchanged** | — | 1 |
| 7 | Scroll back down to the results grid | — | 0 |
| 8 | Tap "Download via qBittorrent" | — | 1 |
| 9 | Toast; disabled button. **Terminal state.** | — | 0 |
| 10 | Bottom nav → Desk; scroll past heading + ReadinessStrip + LibrarianChatPanel + health card + review card → Acquisitions Queue | `/desk` | 1 |
| 11 | *(if input needed)* Desk card's `Review` link | `/scout/intake` | 1 |

**Totals:** 4 taps minimum / 7 typical · **2 routes** for one book (3 with intake) ·
0 modal layers on the main path · **0 back-safe points between steps 2 and 9** — the entire
discover→evaluate→acquire sequence produces no history entries.

Two other flows, for comparison:

- **Correct bad metadata** (*not observable locally*): `/desk` → Needs review card
  (`DeskPage.tsx:278`) → `/curate/tags`, or → `/curate/review` → `/curate/books/:id`
  (`PreviewApp.tsx:73`, has a `backPath`). 2–3 routes, back-safe. This flow is fine.
- **Tune what the engine recommends**: only via `RecommendationFinder.tsx:155-156` on
  `/scout/recommendations`, which requires composing a prompt and submitting a slate first.
  There is no way to express taste while browsing — the loop that CRITICAL 2 leaves open.

### After — proposed

**IA changes**

1. **Scout = discover.** One candidate list; Trends and Recommendations become *sources* on
   that list rather than sibling tabs. Search stops being a peer tab.
2. **Intake leaves Scout.** It is post-acquisition triage; it belongs with Activity (or with
   the Desk pipeline card that already links to it).
3. **Settings leaves the bottom nav.** It is a dialog and already has a top-bar trigger
   (`PreviewApp.tsx:62`). Four destinations remain: Desk · Scout · Curate · Activity — and
   the FAB can then own a real centre slot (fixes HIGH 5).
4. **The card gets three verbs**: Get · Not for me · Later.
5. **Evaluate becomes a pushed sheet** with a history entry, and the acquisition status
   strip renders inside it (fixes CRITICAL 1 and 3 together — the outcome appears where the
   action was taken).

**After — same flow**

| # | Step | Route | Taps |
|---|------|-------|------|
| 1 | Launch → Scout (or Desk, one tap away) | `/scout` | 1 |
| 2 | Scroll the list — no search panel above it, dismissed titles already gone | — | 0 |
| 3 | Tap **Get** → sheet pushed, search runs inside it, list stays put underneath | `/scout?candidate=…` | 1 |
| 4 | Tap Download in the sheet; the sheet flips to the queued state in place | — | 1 |
| 5 | Back → returns to the list at the exact scroll position | `/scout` | 1 |

**Totals:** 3 taps to acquire (4 including the return) · **1 route** · 1 sheet layer ·
back-safe at every step. Triaging a second candidate costs 2 taps, not a 2700px re-scroll.
"Not for me" costs 1 tap and feeds `sendFeedback`; "Later" costs 1 tap.

---

## Open questions

1. **Is `/scout/intake` reached on a phone at all?** Its only mobile entry points are the
   New-task sheet (`PreviewApp.tsx:103`) and the Desk pipeline card's `Review` link
   (`DeskPage.tsx:306`, conditional on `requiresInput.length > 0`). If intake is a
   desk-only job, moving it out of Scout costs nothing. **Unknown** — settled by asking
   whether conflicts are ever resolved away from the desk.
2. **Should dismissals be per-device or persisted server-side?** `sendFeedback` persists
   (`api.ts:617-622`), which is right for taste but means a dismissal also reshapes
   recommendations. A "not now" that hides a card without teaching the engine may need a
   second, local-only state. **Unknown** — a product call.
3. **Does anything mark a bestseller as already owned?** Nothing in `apps/frontend/src`
   does; `BestsellerBook` (`BestsellerLists.tsx:13-19`) has no ownership field and
   `/api/librarian/bestsellers` (`modules/librarian/index.ts:821-852`) returns raw chart
   data. **Not observable locally**, but the code path does not exist to observe. If the
   mirror can be matched on `consensusKey`, an "on your shelf" marker would remove the
   worst class of wasted tap.
4. **Are the two `@media(max-width:800px)` bento-order blocks intentional?** One is fully
   dead and targets a `.v2-trends` element that no longer exists. **Unknown** — settled by
   `git log -p` on `preview.css`, which the minified single-line source makes painful (see
   below).
5. **Is `/scout/search` reachable by design or only as a leftover?** The section tab and the
   New-task sheet both point at it, but nothing else does, and it renders a strict subset of
   `/scout/trends`.

---

## For other reviewers

- **Performance / assets:** Phase 0's 39 cover requests / ~1008KB at 500×500 natural for a
  52×52 render is the single largest measured waste on the priority route.
- **Visual craft:** covers are square, not book aspect ratio (`BestsellerLists.css:326-329`).
- **Visual craft / typography:** Phase 0 counted 12 distinct font sizes and six weights
  (including non-standard 550/650/750), with 75 leaf nodes below 12px at 390px.
- **Visual craft:** `AudiobookSearch.tsx` is styled entirely with inline `style={{…}}` and
  the legacy `glass-*` classes, patched by nine `!important` overrides in
  `.v2-legacy-surface` — the acquisition surface is the one still on the old style system.
- **Front-end platform:** `preview.css` is 65KB on 102 lines (minified source). It made
  finding MEDIUM 10's dead rules a scripted search rather than a read, and it will do the
  same to every future diff.
- **Theming:** Phase 0's light `body` background under a dark `#ui-v2-root`, with no
  `color-scheme` or `theme-color` in `index.html`.
- **Tooling (not UI):** Phase 0's `launch.json` / `PORT=5173` collision is a real repo bug
  that makes the app render as an error state for anyone using the launcher.
