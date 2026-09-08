# AudioShelf Librarian — UI/UX Expert Review

Nine reviewers, eight independent passes plus an adversarial critique, against the
running app on 2026-09-04/05. Every finding below survived verification; claims the
critic could not confirm are excluded or explicitly labelled.

Source reports: [`flow-architecture`](flow-architecture.md) ·
[`discovery-acquisition`](discovery-acquisition.md) · [`visual-craft`](visual-craft.md) ·
[`platform-capabilities`](platform-capabilities.md) · [`accessibility`](accessibility.md) ·
[`content-editorial`](content-editorial.md) · [`mobile-interaction`](mobile-interaction.md) ·
[`performance`](performance.md) · [`critique`](critique.md) ·
[Phase 0 ground truth](phase0/index.md).

---

## 1. Verdict

The interface is a competent, restrained dark console that was designed for a desk and
then made to fit a phone — and the phone is where the product's actual job lives. The
engine underneath is mature and, in several places, more honest than the UI presenting
it: the backend refuses to print a percentage for a check that never ran, and then the
Desk renders a 503 as the calm sentence "No recently added books found." The acquisition
surface browses well and **cannot record a decision** — 43 candidates, one possible action
per card, no save, no dismiss, no "already own this", no memory that a triage session ever
happened. Worse, the one action that does exist destroys the browse position it took the
user 2,700px to earn, because tapping a card is not a navigation at all: it dispatches a
window `CustomEvent` and smooth-scrolls the page, leaving `history.length` and
`location.href` untouched. Eight reviewers converged on that defect and four ranked it
first; three measured it different ways and agreed. Everything else here — typography,
tokens, accessibility, performance — is real but secondary to it.

**The highest-leverage change is to make the card tap a route change and stop rendering
the search panel on the browse route.** Four small edits, resolving eleven findings across
six of the eight reports, and the precondition for every other mobile improvement.

---

## 2. Findings

Merged and de-duplicated across reviewers. Each carries the reviewer that raised it, the
verified evidence, the user consequence, and the fix.

### Critical

**C1 — The decision step is a scroll jump, not a navigation. List position is destroyed
and unrecoverable.**
*Flow, discovery, mobile, platform, performance — five reviewers independently.*
`BestsellerLists.tsx:206-212` dispatches a global `CustomEvent`; `AudiobookSearch.tsx:57-73`
intercepts it and `scrollIntoView({behavior:"smooth"})`s the page. Measured live: `scrollY`
went 3000 → 281 while `history.length` and `location.href` stayed identical. No navigation
occurs, so Back has nothing to undo and instead exits the route.
**Consequence:** investigating candidate #30 costs you #31–43. The triage loop is not slow,
it is *non-resumable* — fatal for a surface whose premise is two spare minutes.
**Fix:** `navigate('/scout/search?q=…')`. `AudiobookSearch.tsx:75-80` already reads `?q` on
mount. Hard dependency on C2, or Back lands on a zero-height document.

**C2 — The priority surface is the one route in the app not using the app's data layer.**
*Platform, performance, discovery.*
`BestsellerLists.tsx:150-193` is `useState` + bare `fetch` while the rest of the app uses
react-query. Confirmed at runtime: leaving and returning refetches the list and tears down
all 43 `<img>` nodes (`naturalWidth` resets to 0).
**Consequence:** every return trip is a cold load, and there is no document for a scroll
position to restore into.
**Fix:** ~30 lines, existing dependency.

**C3 — No intent can be captured anywhere on the bestseller surface, and the backend for
it already ships.**
*Discovery, flow, mobile, content.*
Verified end to end: `feedback.ts` accepts `{bookId?, externalKey?, queryText, verdict}`
with a refine allowing *either* key, mounted at `/api/feedback`, one SQLite insert, no ABS,
no LLM. It works on an unconfigured machine today. Its only caller is
`RecommendationFinder.tsx:71-82`, on a route that requires ABS. A repo-wide grep finds no
save / dismiss / maybe-later / owned string in any `.tsx`.
**Consequence:** a two-minute triage session produces nothing that survives it.
**Fix:** two 44×44 verdict buttons per row, read back via `GET /api/feedback`. **Pitch it
as session memory, not engine learning** — see C4.

**C4 — Verdicts on non-owned works can never reach the taste profile.**
*Found only by the critic; it corrects the discovery report's headline framing.*
`tasteProfile.ts:213` reads `if (row.bookId === null || seen.has(row.bookId)) continue;` —
every external-key feedback row is skipped outright. Such a row has no embedding vector, so
it cannot be placed in embedding space at all.
**Consequence:** "verdicts feed the taste profile" is false and must be struck from the
pitch for C3. C3 remains worth shipping; its value is UX memory.
**Fix:** none required to ship C3. Decide separately whether the engine *should* learn from
external verdicts.

### High

**H1 — Four typefaces are declared and none of them load.** *Visual; verified and extended
by the critic to six.*
`index.html` is 11 lines with no `<link>` of any kind. No `@font-face` anywhere in
`apps/frontend`, no `@fontsource` dependency, no `.woff` asset. `Inter`, `Outfit`,
`JetBrains Mono`, `Crimson Pro` and `Fira Code` all resolve to fallbacks — every `h1`/`h2`
in the shell falls past both `Outfit` and `Inter` to generic `sans-serif` (Arial on
Windows) while body text lands on `system-ui`. `letter-spacing:-.035em` is tuned for a font
that isn't there.
**Consequence:** the app renders in two unintended typefaces and has been designed against
a preview nobody has seen. **This also makes Phase 0's font-weight census unreliable** —
computed style reports the *declared* weight, so no recommendation may rest on "six weights
are rendering."
**Fix:** a decision, not a file — self-host Inter + Outfit as variable woff2, or delete all
six names and design against the system stack.

**H2 — The FAB intercepts taps on the Curate nav item.** *Flow, visual, mobile; arithmetic
re-derived by the critic and matching mobile's live measurement to the decimal.*
At 390px the nav content box is 382px across 5 tracks of 76.4px. Curate (track 3) spans
x 156.8–233.2, shrunk by `a:nth-child(3){padding-right:28px}` to 156.8–205.2, centring its
icon at x 181. The FAB is a 29px-radius circle centred at x 195, `z-index:55` against the
nav's `50`. Centre-to-centre distance is ~24px — inside the radius. Hit testing honours
`border-radius`, so the FAB both hides and steals the tap.
**Root cause:** the `nth-child(3)/(4)` padding split cuts the notch at the 3|4 boundary
(60%, x 233.2) while the FAB is centred at 50% (x 195). That pairing is self-consistent
only for a **six**-track nav.
**Fix:** move Settings out of the bottom nav — its identical trigger already exists in the
topbar and is visible on mobile, so the fifth slot is pure duplication. Four items plus a
genuine centre FAB. Zero desktop impact.

**H3 — A live WCAG 1.4.3 AA failure on the priority route that eight reviewers walked
past.** *Critic, correcting both my Phase 0 and the accessibility report.*
Phase 0 recorded a 1.44:1 node and dismissed it as "expected for a disabled control";
`accessibility.md` accepted that and explicitly declined to file it. **The control is never
disabled.** `AudiobookSearch.tsx:144-157` has no `disabled` prop; its colour is an inline
`var(--text-primary)` = `#1a2a3a`, the *light* theme's navy, rendered permanently on the
dark shell because inline style beats the `!important` shim.
**Fix:** delete the inline `color`/`background` at `AudiobookSearch.tsx:147`.

**H4 — A backend error is rendered to the user as a fact about their library.**
*Content-editorial, alone — and it looked despite Phase 0 telling reviewers to ignore these
503s.* `DeskPage.tsx:337-339` guards on `!data?.results || length === 0` and never reads
`isError`, so a 503 from `/api/librarian/recently-added` renders as "No recently added books
found." — on the landing route, refreshed every 60s.

**H5 — The mobile topbar claims the backend is healthy when it isn't.** *Content.*
`PreviewApp.tsx:58` hardcodes "Live system" with no state binding, while the desktop rail at
`:52` correctly shows "Unavailable". The phone is the surface that lies.

**H6 — 15 references to 6 CSS variables defined nowhere, with no fallbacks.** *Visual.*
`--text-muted`, `--bg-card`, `--cyan`, `--bg-secondary`, `--bg-primary`, `--text-tertiary`
(plus `--bg-inset`). On `/desk` today this renders the author, date and empty state at full
white instead of muted — the three-level hierarchy collapses to one flat tone. Two-line fix;
highest payoff-per-effort in the visual report.

**H7 — Safe-area insets are inert, and fixing that naively makes things worse.**
*Mobile #11 and visual F4; adjudicated by the critic as a sequencing trap, not a conflict.*
`index.html:5` has no `viewport-fit=cover`, so all four `env(safe-area-inset-*)` call sites
resolve to 0 today (mobile is right). But `.v2-bottom-nav` is `height:72px` under
`box-sizing:border-box` with the inset in its padding, so a 34px inset would collapse the
content band from 58px to 24px against ~32px of content (visual is right).
**Fix — must be atomic:** `viewport-fit=cover` + `height` → `min-height` + one `--nav-h`
token rebasing the three inset-blind siblings. **Shipping `viewport-fit=cover` alone is a
regression.**

**H8 — 11 of 17 routes highlight nothing in the bottom nav.** *Flow.* The rail uses
group-prefix matching (`PreviewApp.tsx:49`); the bottom nav uses bare `NavLink`s (`:96`).
It fails on 3 of Scout's 4 modes.

**H9 — Landscape phones fall out of the mobile layout entirely.** *Mobile; severity raised
by the critic.* The only shell breakpoint is `max-width:800px` and an iPhone 13 mini in
landscape is 812px, so every modern phone rotated gets the desktop icon-rail console — a
band in which `accessibility.md` F14 separately found all four rail links have an empty
accessible name. Same band, two reviewers, neither saw the other's half.

### Medium

- **M1 — A broken scraper is indistinguishable from an empty chart.** Every fetcher swallows
  to `[]`, the route returns `success:true`, cached 3 hours. This is why "NYT Fiction 0"
  renders identically to a working source. *(Discovery)*
- **M2 — "As of when" is unanswerable.** No timestamp on the wire at all, across a 0–180
  minute cache window. `bestsellersCacheTime` is already in scope at
  `librarian/index.ts:752` — a response-shape change, not new work. *(Discovery)*
- **M3 — Consensus rank means two different things in two tabs.** `renderCard` is called
  without `appearances` on single-source tabs (`:451`, `:512`), so `#N` is merged-array
  position on one tab and true chart rank on another. *(Discovery, a11y, content —
  adjudicated: tier headers on All, labelled real ranks on source tabs.)*
- **M4 — The bestseller card's accessible name swallows everything.** The wrapping button's
  label absorbs the badges; the rank is `aria-hidden`. Rebuild the name from contents.
  *(Accessibility)*
- **M5 — Zero gesture vocabulary exists in the frontend.** Grep-confirmed: no
  `onTouchStart`/`pointerdown` anywhere. Any gesture proposal is greenfield — and
  `.v2-sheet-handle` currently *promises* a drag that doesn't exist. *(Mobile)*
- **M6 — `useOperations()` polls every 3 seconds from every route, forever**, for data Scout
  never displays. A battery and radio-wake cost, not a bytes cost. *(Performance)*
- **M7 — Four style systems reconciled by six `!important`s and two selectors that
  substring-match React's serialised inline `style` attribute** (`div[style*="display:
  flex"]`). *(Visual)*
- **M8 — `preview.css` is 65KB across 102 lines**, line 56 alone at 4,020 characters
  containing the entire mobile layout. Every mobile change is a one-line diff — which is
  precisely why H2 and H7 survived this long. *(Visual)*
- **M9 — The FAB task sheet doesn't lock body scroll** despite `aria-modal="true"`, and the
  card-description popover uses a separate, weaker modal pattern with no backdrop, no scroll
  lock, and `role="dialog"` without `aria-modal`. *(Mobile, accessibility)*
- **M10 — Network failure renders in success-green with a raw "Failed to fetch"**, and ten
  raw backend errors ship with log-severity prefixes. Worse, the copy is load-bearing:
  `ScanResultsReview.tsx:230`/`:272` string-match `startsWith('Success')` /
  `includes('Error')` to pick a colour, so it cannot be reworded safely. *(Content, mobile)*
- **M11 — `/scout/intake` returns `null` when nothing needs review** — the page promises
  "Review intake conflicts" and renders nothing. *(Content)*
- **M12 — Title truncation is single-line ellipsis**, producing "The Dungeon Anarchist's
  Coo…" where a two-line clamp would read. 65 of Phase 0's 75 sub-12px nodes are one
  declaration (`.bestseller-card__badge{font-size:0.68rem}`); the other five are bottom-nav
  labels at 9px with `max-width:64px`, which "Scout & Acquire" cannot fit. *(Visual, a11y,
  content)*
- **M13 — Cover art gets 8.3% of the card** (52×52 of 362×90) while ~910 KB of the 1008 KB
  fetched is discarded by the renderer. Square sources are `object-fit:cover`-cropped into
  2:3 frames at `preview.css:67,68`, losing 33% of every cover. *(Visual, performance)*
- **M14 — Latent data-integrity bug: three external-key spaces, not one.**
  `recommendations.ts:382` hand-rolls the key without the `ext:` prefix, violating
  `externalKey.ts`'s own "ONLY place a key may be minted" contract; the UI sends raw
  `title|author`; `book_edges` uses `ext:`-prefixed. The keys provably never join. Nothing
  joins these tables today, so there is no live symptom — but it accumulates unjoinable data
  and makes offline slate evaluation impossible for external candidates, which is the exact
  question the impression rows exist to answer. *(Discovery; extended by the critic.)*

### Polish

Duplicate adjacent `<h2>` on the priority route; "Search acquisition sources" euphemising
"Search AudiobookBay" eight pixels above the literal phrase; "ABN" expanded only in a
`title` tooltip that cannot fire on touch; `/curate/health` orphaned with no tab, no back
link and no nav highlight; two competing `@media(max-width:800px)` bento-order blocks, one
fully dead and targeting a `.v2-trends` element no TSX emits; `.bestseller-card__badge--*`
and `__cover--placeholder` classes emitted by the TSX and defined in no stylesheet; the tab
strip scrolls but gives no scroll affordance; `--v2-cyan` spent on 43 static author names,
so nothing on the card announces itself as tappable.

### Explicitly *not* findings

Recorded so they are not re-raised. **Contrast is otherwise fine** — 228 of ~230 nodes pass;
the dark theme is well judged. **Tap targets pass** — zero controls below 24×24. **Code
splitting is correct** — the 416 KB recharts chunk is dynamically imported by `CuratePage`
only and never reaches Scout; do not add `manualChunks`. **Bytes and layout stability are
fine** — CLS 0.000, zero long tasks over a full 5474px scroll, 282,154 B initial JS against
the repo's own 300,000 B budget. **Mobile nav clearance is handled**
(`.v2-app{padding-bottom:92px}`), and the pinned description overlay *is* a proper bottom
sheet. **Only 7 distinct text colours** — there is no colour sprawl.

---

## 3. Mobile acquisition spec

Built from the discovery reviewer's spec as amended by mobile interaction and the critic.
Build target 390×844.

### Browse model: single-column row list, consensus tiers, persistent inline verdict

**This is deliberately not a redesign — the existing row list is the right answer and it is
missing the verdict.** Three alternatives were rejected on the data, not on taste:

| Model | Rejected because |
|---|---|
| Cover-led grid | Asks artwork to carry the decision. With no series position, narrator or runtime available, it strips the two text lines that are the *only* thing differentiating adjacent items. A 167px tile is also ~115px vertical per item versus the row's 90–96px — *less* dense. And `performance` observed 26 of 43 covers never completing; a cover-only grid is unusable when covers fail. |
| Editorial rows | No data exists to build them from. Apple's genre fields are discarded at `bestsellers.ts:123-133`; there is no theme and no personalization signal on this route. Editorial rows without editorial metadata are decoration. |
| Swipeable deck | Forces a decision on all 43 items when the honest answer for most is *skip*; destroys position and consensus; makes comparing the five Dinniman entries impossible. Also greenfield — the app has zero gesture vocabulary, so it needs onboarding, an edge dead-zone to avoid stealing the OS back-swipe, and a threshold heuristic. Two 44×44 buttons need none of that. |

### Screen structure

```
┌─ sticky header ───────────────────────────────────┐
│ Bestsellers            Updated 2h ago  ⟳          │  44px
│ [All 43] [Audible 20] [AudiobooksNow 20] [Apple]  │  h-scroll chips, 36px
│ [ Hide decided (6) ]                              │  only when >0
└───────────────────────────────────────────────────┘
   On 3 charts ─────────────────────────────────       28px tier header, sticky
┌─ row, 96px ───────────────────────────────────────┐
│ ┌──────┐  Dungeon Crawler Carl              ┌───┐ │
│ │ 72px │  Matt Dinniman                     │ + │ │  44×44
│ │cover │  Audible #3 · ABN #1 · Apple #6    ├───┤ │
│ │      │  ✓ In your library                 │ × │ │  44×44
│ └──────┘                                    └───┘ │
└───────────────────────────────────────────────────┘
```

- **Tier headers replace the ambiguous `#N` entirely.** "On 3 charts" is what the sort
  actually means (`BestsellerLists.tsx:138-146`), stated plainly in a 13px sticky header
  rather than a 10.88px badge. On single-source tabs the rank slot carries a real labelled
  rank — `Audible #7`, never a bare `#7`.
- **Row:** `[72px cover][1fr text][48px verdict stack]`. Cover served at 144px for 2×.
  Explicit `width`/`height` on every `<img>` to stop reflow, plus the `onError` fallback that
  currently doesn't exist.
- **Text:** title 15px/600 clamped to **two** lines; author 13px; provenance 12px (up from
  0.68rem, which is below the floor).
- Anything sticky must clear `calc(72px + env(safe-area-inset-bottom))` — the existing
  `BestsellerLists.css:309` value should become the shared token. Note H7: those insets are
  inert until `viewport-fit=cover` ships.

### The triage loop

Target: **one tap per decision, zero taps to skip, no scroll loss ever.**

| Gesture | Result |
|---|---|
| Tap `+` | Verdict `want`. Row tints, control fills. **No navigation.** |
| Tap `×` | Verdict `not`. Row dims to 40%. **No navigation.** |
| Tap either again | Clears back to neutral — same button toggles. |
| Tap text/cover | Opens detail sheet *over* the list. Still no navigation. |
| Tap `Hide decided` | Collapses decided rows, count shown. |

Verdict is optimistic: local state flips immediately, POST goes out fire-and-forget, a
failure reverts that row and shows an inline retry — the pattern
`RecommendationFinder.tsx:71-82` already establishes.

**Critically, `+` does not trigger a search.** Coupling "interested" to "search AudiobookBay
now" is what makes the loop non-resumable. Searching becomes a deliberate act inside the
sheet, so triage and acquisition are separate passes — which is what "a spare two minutes"
actually requires.

**Detail sheet** (88vh max, drag handle, reusing `.v2-sheet`): full title, author, all three
source ranks, ownership line, lazy description, then `[Want it] [Maybe later] [Not for me]`
at 48px and a secondary `Search AudiobookBay →` that *navigates* to `/scout/search?q=…`.
"Maybe later" lives only here — three states don't fit the row without dropping below 44px,
and "later" is a considered decision.

**Session summary.** Once ≥1 verdict exists, a capsule appears in the existing
`.v2-job-capsule` slot: `6 to get · 11 skipped → Review`. This is the single element that
makes two minutes of thumbing feel like it produced something.

### Backend gaps, in build order

1. **Fix the external-key contract first** (M14) — `recommendations.ts:382` must call
   `externalBookKey()`, and the backend must mint `key` on `BestsellerBook` with the same
   function. **This must land before any verdict is written**, or the data is unjoinable from
   day one. The original spec's version of this gap would have created a *fourth* key space;
   it is amended, not adopted as written.
2. **Per-source status + `fetchedAt`** in the bestsellers payload (M1, M2) —
   `bestsellersCacheTime` is already in scope.
3. **Batch ownership check** for the "already on your shelf" marker. The ownership predicate
   is already computed at `recommendations.ts:354-367` and the results *silently dropped*
   rather than labelled. **Sequence this last despite being the highest-value affordance in
   the abstract** — its value depends entirely on what fraction of chart titles are owned,
   which is not measurable without Audiobookshelf connected.

---

## 4. Flow redesigns

### Bestseller → shelved, on a phone

**Before** — measured against the route table: 4 taps minimum / 7 typical, **2 routes** (3
with intake), and **0 back-safe points between steps 2 and 9**. The entire
discover → evaluate → acquire sequence produces no history entries. Step 3 alone requires
scrolling past the page heading, four section tabs, the whole `AudiobookSearch` panel, a
divider, a duplicate `<h2>`, and six chart chips before the first card. Step 6 fires an
iTunes fetch and throws the reader ~2,700px back to the top. Confirmation for step 8 lives on
a different top-level tab, because `POST /download` creates no operation record so the job
capsule never fires.

**After** — 3 taps to acquire (4 including the return), **1 route**, 1 sheet layer, back-safe
at every step:

| # | Step | Route | Taps |
|---|---|---|---|
| 1 | Launch → Scout | `/scout` | 1 |
| 2 | Scroll the list — no search panel above it, dismissed titles already gone | — | 0 |
| 3 | Tap **Get** → sheet pushed, search runs inside it, list stays put underneath | `/scout?candidate=…` | 1 |
| 4 | Tap Download; the sheet flips to queued state in place | — | 1 |
| 5 | Back → list at the exact scroll position | `/scout` | 1 |

Triaging a second candidate costs 2 taps, not a 2,700px re-scroll.

### IA changes that enable it

1. **Scout = discover.** Trends and Recommendations become *sources* on one candidate list
   rather than sibling tabs. `scout/search` currently renders a strict subset of
   `scout/trends`, so the four modes are really three.
2. **`AudiobookSearch` stops rendering inside `/scout/trends`.** Six separate findings across
   five reports are all downstream of that one JSX fragment at `ScoutPage.tsx:17`. *(Critic's
   amendment: keep `/scout/search` reachable as its own route — it is entry-pointed from the
   topbar command button and the New-task "Acquire" tile, and removing it as a destination
   would damage the desk flow.)*
3. **Intake leaves Scout** — it is post-acquisition triage filed among pre-acquisition
   discovery.
4. **Settings leaves the bottom nav** — it is a dialog with an existing, mobile-visible
   topbar trigger. This is what makes H2's geometry solvable rather than nudgeable.
5. **Evaluate becomes a pushed sheet with a history entry**, and the acquisition status
   renders inside it — so the outcome appears where the action was taken.

---

## 5. Modern web adoption

The platform reviewer's verdicts, as adjudicated. **The reasoning behind the Skips is the
most valuable part of this table** — most of the fashionable answers are wrong for this app.

| # | Capability | Verdict | Cost | Why |
|---|---|---|---|---|
| 1 | Right-size cover URLs at the source | **Adopt** | ~3 backend lines | ~1008 kB → ~90 kB. **Magnitude gated** — see caveat. |
| 2 | `color-scheme: dark` on `:root` | **Adopt** | 2 lines | Currently on `#ui-v2-root`, which is why `body` paints light and the file patches `color-scheme` twice more |
| 3 | `dvh`/`svh` for shell and sheet | **Adopt** | 4 declarations | `100vh` ×3 vs `100dvh` ×1 today; the settings dialog got the fix, the task sheet didn't |
| 4 | react-query for `BestsellerLists` | **Adopt** | ~30 lines, no new dep | Precondition for C1 and any scroll restoration |
| 5 | `<dialog>` for the modal overlays | **Adopt** | net −30 lines | Escape + focus trap for free on a sheet that has neither |
| 6 | Fix the dev `PORT` collision | **Adopt** | 1 script line | See §7 |
| 7 | Container queries on `.bestseller-card` | **Trial** | ~10 CSS lines | Genuine: `auto-fill minmax(300px,1fr)` puts cards in ~330px columns at a 1400px viewport, and those get the *wide* layout because the compact rules key off a 480px *viewport*. A desktop fix. |
| 8 | Popover API for the description overlay | **Trial** | ~20 lines | Removes `z-index:9999` and a global keydown listener |
| 9 | Manifest + icons + `theme-color`, no SW | **Trial** | 1 file + 2 icons | Home-screen launch for a two-minutes-in-the-queue surface |
| 10 | SSE for `POST /recommendations` | **Trial** | backend + client | The `SseChannel`, a nine-variant typed event union and a working client consumer all already exist in-repo for `/librarian/chat` |
| 11 | Virtualization | **Skip** | — | 43 rows at a fixed 86px. Not a problem. |
| 12 | `content-visibility` | **Skip** | — | Optimises a cost that isn't there |
| 13 | React Router data router | **Skip** | — | `ScrollRestoration` and `unstable_viewTransition` both need `createBrowserRouter`; revisit only if #4 lands and native restoration still fails |
| 14 | View Transitions API | **Skip** | — | The primary mobile action doesn't navigate. Nothing to transition. |
| 15 | Service worker / offline / Web Share Target | **Skip** | — | Blocked on secure context, not merely unattractive |
| 16 | React 19 | **Skip** | — | No user-visible gain; `lucide-react` 0.378 peer-caps at 18 |
| 17 | `srcset` / `sizes` on covers | **Skip** | — | Fixed 52–72px slot; only DPR varies. One URL is correct. |
| 18 | Optimistic mutations | **Skip (premature)** | — | Becomes relevant the moment C3 ships, and the pattern to copy already exists |

**Caveat on #1, from the critic:** the "~1008 kB → ~90 kB" magnitude rests on two *untested*
third-party URL-rewrite hypotheses. Only Apple's lever is verified (`bestsellers.ts:130`
already does `100x100` → `400x400`; reversing it is one token). Amazon's `._SL500_.` →
`._SL160_.` and AudiobooksNow's `/jackets/large/` → `/jackets/small/` are plausible guesses
about third-party schemes, and those two sources produced the measured bytes. **Two `curl`s
settle it.** The fix is still right and still cheap; its magnitude must not anchor sequencing
until tested.

---

## 6. Sequenced plan

### Quick wins — under a day each

| # | Change | Resolves | Depends on |
|---|---|---|---|
| Q1 | **Route the card tap; drop `AudiobookSearch` from `/scout/trends`** | C1 + 10 other findings across 6 reports | — |
| Q2 | **react-query on `BestsellerLists`** | C2 | Q1 under-delivers without it |
| Q3 | **Move Settings out of the bottom nav; centre the FAB on a 4-track grid** | H2 | — (zero desktop impact) |
| Q4 | **Delete the inline colour/background on the Clear button** | H3 — a live 1.4.3 failure | — |
| Q5 | **Define the 7 phantom CSS variables as `--v2-*` aliases** | H6 | — |
| Q6 | **`viewport-fit=cover` + `min-height:72px` + one `--nav-h` token** | H7 | **Must be atomic.** Do after Q3. |
| Q7 | **`scroll-padding-bottom`/`-top` at the mobile breakpoint** | a11y F6 (zero declarations exist today) | Q6 |
| Q8 | **`color-scheme:dark` on `:root` + `theme-color`; drop the light `body` bg** | Adoption #2 | — |
| Q9 | **Accessible names: sheet close, intake checkboxes, rec textarea, search input + select** | a11y F4/F5/F10/F12 | — |
| Q10 | **`onError` cover fallback, reusing the existing placeholder branch** | M13 | — |
| Q11 | **`role="status"` on toasts; error toasts get `role="alert"`, stop auto-dismissing** | a11y F8 | — |
| Q12 | **Branch the Desk "Recently added" card on `isError`** | H4 | — |
| Q13 | **Prettier the 65KB single-line `preview.css` once** | M8 | **Do this before any other CSS work** or none of it is reviewable. No Prettier config exists; accept the blame-history cost. |

### Structural — days to weeks

| # | Change | Depends on |
|---|---|---|
| S1 | **Fix the external-key contract** — `recommendations.ts:382` calls `externalBookKey()`; backend mints `key` on `BestsellerBook` | Must land **before** any verdict is written |
| S2 | **Verdict capture on the card** — two 44×44 buttons, optimistic, read back via `GET /api/feedback`, "Hide decided" filter | S1. Pitch as session memory (C4). |
| S3 | **One combined card rebuild** — accessible name from contents, 12px badges with ABN expanded, tier headers, 72px cover, two-line clamp, verdict controls with hit-slop | S2. **These compose, they do not collide** — every one edits the same ~80 lines of `renderCard` and the same three CSS rules. Five commits means five rounds of re-reading the same markup. **Make it one change.** |
| S4 | **Right-size cover URLs** | **Gated on the two curls.** Do not scope until tested. |
| S5 | **Per-source status + `fetchedAt`** | S3 (needs somewhere to render the strip) |
| S6 | **Extract `useModalDialog` or convert to `<dialog>`; apply to all four overlays** | independent; net −30 lines |
| S7 | **Route-change focus management + one shell-level live region** | S6 |
| S8 | **Batch ownership check + "already on your shelf"** | S3. Not observable locally — sequence last. |
| S9 | **Scope the two light stylesheets under a class; kill the global 14px body font-size and global serif h1** | Q13. The subset of the token proposal that earns its keep. |
| S10 | **Decide the font question** (H1) — self-host, or delete all six names | A decision, not a file |
| S11 | **Container queries on `.bestseller-card`** | S3. A desktop fix that composes with S3. |

### Cut — recorded so they are not re-proposed

The swipe-gesture triage deck (trend-chasing; the app has zero gesture vocabulary and its own
reporter supplied the counter-argument). The 2-column poster grid (less dense, strips the
differentiating signal, fails hard when covers fail). "Serve a 2:3 source into a 2:3 slot"
(audiobook art is square; there is no 2:3 source — the 2:3 *boxes* are the bug). The full
token-system rollout (multi-week, no user-visible win as a unit; the three pieces that pay
are sequenced separately). Making `/scout/search` non-navigable (the one place mobile-first
would damage the desk). Two `visual-craft` findings were verified **false** and dropped
entirely: its decomposition of the five 9px nodes, and its claim that the search form's
inline grid is unhandled on mobile.

### Speculative — do not schedule

PWA manifest (blocked on whether the app is served over HTTPS). SSE for recommendations
(cannot be validated without ABS). `loading="lazy"` remediation — the observation is confirmed
(43 requests in a 12ms window) but the **mechanism is unverified and may be a harness
artifact**; this is a test, not a task, and it is worthless until S4 ships. Landscape-phone
layout (real, but the right answer is unknown — a 375px-tall landscape phone may want
something neither the rail nor the bottom nav provides). The terminology drift table
(excellent inventory, but several rows are load-bearing on control flow —
`ScanResultsReview.tsx` needs a `status` field before any copy work touches it).

---

## 7. Open questions

1. **Is the app served over HTTPS on your phone?** `docker-compose.yml` shows plain HTTP on
   `homelab-net` with no published ports and no TLS terminator. This one answer settles the
   entire PWA branch — manifest, home-screen launch, offline shortlist, Web Share Target.
   *Recommendation: answer it before investing anywhere near the PWA items.*
2. **The font decision.** Self-host Inter + Outfit as variable woff2, or delete all six family
   names and design honestly against the system stack. *Recommendation: self-host the two that
   carry the design. The current state is the cost of a font decision with none of the
   benefit.*
3. **Should external-key verdicts ever reach the taste profile?** `tasteProfile.ts:213`
   excludes them by construction because they have no embedding. *Recommendation: ship C3 as
   session memory now, and treat engine learning as a separate later question — it needs an
   embedding strategy for un-owned works, which is engine work, not UI work.*
4. **Two `curl`s on Amazon and AudiobooksNow cover URLs**, to confirm the size levers before
   scoping S4. *Recommendation: do this now. Five minutes, and it either confirms or halves
   the review's most-cited win.*
5. **Connect Audiobookshelf for a second pass?** The library-aware half — ownership markers,
   personalized recommendations, all of `/curate/*` with real books — could not be observed.
   *Recommendation: worth one focused follow-up once S8 is on the table, since ownership
   marking is the highest-value affordance in the abstract and its real value is unmeasurable
   until then.*
6. **Does anything need `/scout/search` as a peer tab**, or is the topbar command button plus
   the New-task tile sufficient? *Recommendation: keep the route, drop the tab.*

---

## Appendix — corrections to my own Phase 0

Recorded because reviewers built on these before they were caught.

| Claim | Status |
|---|---|
| "Only 2 of ~230 nodes below 4.5:1, one a disabled control" | **Wrong.** The control is never disabled — a live 1.4.3 failure (H3). |
| "153 requests on cold load" | **Dev-server artifact.** Production emits ~36 assets, ~20 on the Scout path. |
| "`launch.json` fixed the PORT collision" | **A workaround, not a fix.** It stops starting the backend at all. The real fix pins the port in the script (`cross-env`) or introduces `API_PORT`. |
| "Covers are square, not book aspect ratio" | Correct observation, wrong implication — audiobook art *is* square; the 2:3 frames are the bug. |
| "The FAB overlaps card content and chart chips" | Half trivial — a `position:fixed` FAB floats over scrolling content by design. The *nav* overlap (H2) is the real finding and stands on its own arithmetic. |
| Font-weight census (700/650/550/750) | **Unreliable** — computed style reports declared weight, and no font loads (H1). Sizes and contrast remain reliable. |
| "Three style systems" | **Four.** |
