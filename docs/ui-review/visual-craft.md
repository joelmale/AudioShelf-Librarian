# Visual Craft Review — AudioShelf Librarian

**Reviewer:** principal product designer (read-only pass)
**Scope:** whole app, mobile acquisition surface (`/scout/*` at 390×844) weighted highest
**Evidence:** `docs/ui-review/phase0/index.md` measurements + the CSS/TSX source. No browser
this pass; every geometric claim below is derived from CSS values and labelled as such.

---

## Verdict

**Competent dark UI with a real point of view, undermined by a missing foundation layer.**

This is not a generic dashboard. Somebody chose a palette and stuck to it — 7 text colors
across ~230 nodes is genuine restraint, and better than most shipped products. The bento
desk, the violet/cyan split, the bottom-sheet pattern, the `focus-visible` ring on every
control: these are deliberate decisions by someone with taste.

What's missing is the layer underneath. There is no type scale (12 sizes), no spacing scale
(33 distinct px values in `padding`/`gap`/`margin`), no radius scale (16 values), and — the
finding that reframes everything else — **none of the three typefaces the CSS names are
actually loaded.** `Inter`, `Outfit`, and `JetBrains Mono` appear in seven `font-family`
declarations and in zero `@font-face` rules, zero `<link>` tags, and zero packages. The
brand voice of this product does not ship. Every measurement Phase 0 took was of a fallback.

And the product's best asset — the cover art — is rendered at 52×52. That is a favicon.
For a library, that is the design decision I'd overturn first.

Ranked findings follow. F1–F5 are on the mobile acquisition path.

---

## What is already good (don't regress it)

- **Color restraint.** 7 text colors, 14 `--v2-*` tokens, one accent + one secondary.
  Do not "expand the palette."
- **Contrast.** 2 of ~230 nodes under 4.5:1, one of them a disabled control. Solved.
- **Focus.** `#ui-v2-root :focus-visible{outline:2px solid var(--v2-cyan);outline-offset:3px}`
  (`preview.css:14`) is a single global rule that covers everything. Correct approach.
- **Motion is disciplined.** Two `@keyframes` in 65KB, ten transitions, all on
  `transform`/`opacity`/`width`. No decorative animation. The drawer's
  `transition:transform .22s` (`preview.css:56`) and the progress bar's
  `transition:width .3s cubic-bezier(.16,1,.3,1)` (`preview.css:41`) both communicate
  state change. Nothing here needs cutting.
- **Safe-area awareness exists** — `env(safe-area-inset-bottom)` in 3 places. It's applied
  wrongly (F4), but the intent is there.

---

## Findings, ranked

### F1 — The typefaces are never loaded. The entire type system is a fallback.

`preview.css` names three families:

| Declaration | Location | Resolves to (no webfont present) |
|---|---|---|
| `font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif` | `preview.css:6` (`#ui-v2-root`) | system UI font — Segoe UI Variable / SF |
| `font-family:Outfit,Inter,sans-serif` | `preview.css:23,24,30,45,62` (all h1/h2) | **generic `sans-serif`** — Arial / Helvetica |
| `font-family:Outfit,sans-serif` | `preview.css:42` (`.v2-sheet h2`) | **generic `sans-serif`** |
| `font-family:"JetBrains Mono",monospace` | `preview.css:24` (`.v2-path code`) | generic `monospace` — Courier New |
| `font-family:'Crimson Pro',serif` | `curator/styles.css:51` (global `h1`) | generic `serif` — Times New Roman |

Verified absent: no `@font-face`, no `fonts.googleapis` link, no `@fontsource*` dependency,
and `apps/frontend/index.html` is 12 lines with no `<link>` at all.

Two consequences that are visible today, not theoretical:

1. **Headings and body text render in two different typefaces, unintentionally.** Body falls
   to `ui-sans-serif`/`system-ui`. Every `h1`/`h2` falls past `Outfit` and `Inter` to generic
   `sans-serif`, which is *not* the system UI font — it's Arial on Windows, Helvetica on
   macOS. A dark product UI in Segoe UI Variable with Arial headlines reads as a mistake,
   because it is one.
2. **The tracking is tuned for a font that isn't there.** `.v2-page-heading h1` carries
   `letter-spacing:-.035em` and `line-height:1.06` (`preview.css:23`) — settings that make
   sense for Outfit's tight geometric forms and look cramped on Arial's wider ones.

Related: Phase 0 measured **six font weights including 550/650/750**. Computed style reports
the *declared* weight regardless of what renders. Whether those non-standard weights render
as distinct depends entirely on whether the resolved family is variable — which now varies by
operating system. On any platform whose generic `sans-serif` is a static family, 550 → 500,
650 → 700, 750 → 700, and the intended four-step hierarchy collapses to two. The weight
system is unreliable by construction.

**Fix:** either self-host Inter + Outfit as variable woff2 (`@fontsource-variable/inter`,
`@fontsource-variable/outfit`) and add `font-display:swap`, or delete both names and design
honestly against the system stack. Do not leave it in the current state, which is the worst
of both: the cost of a font decision with none of the benefit. If you self-host, add
`preload` for the display face — headings are above the fold on every route.

---

### F2 — Cover art is rendered at 52×52 on the surface whose entire job is "do I want this book?"

`BestsellerLists.css:161-172` sets `.bestseller-card__cover{width:60px;height:60px}`, dropped
to 52×52 under `@media (max-width:480px)` (`BestsellerLists.css:326-329`).

The arithmetic, from Phase 0's measurements:

- Card box is 362×90 = 32,580 px². Cover is 52×52 = 2,704 px². **The art gets 8.3% of the card.**
- 43 cards × 90px = 3,870px of a 5,355px document is this row.
- Images served at 500×500, ~1008 KB for 39 requests. A 52px box needs 156×156 at DPR 3.
  156²/500² = 9.7%. **~910 KB of the 1008 KB is discarded by the renderer.**

The bytes are the smaller problem. The design problem is that this is a *browse-and-decide*
surface — Phase 0 confirms it is the one fully-populated, fully-reviewable route — and the
strongest decision signal a book has is its cover. At 52px you can perceive a dominant hue
and nothing else. Meanwhile the card spends its width on: a rank number, a title truncated
mid-word (`"The Dungeon Anarchist's Coo…"`, forced by `white-space:nowrap` at
`BestsellerLists.css:185`), an author name, and 10.88px badges.

Compounding it, **three different cover aspect ratios coexist in one app**:

| Surface | Geometry | Source |
|---|---|---|
| Bestsellers | 60×60 / 52×52 — **1:1** | `BestsellerLists.css:162,327` |
| Recommendations | 92×138 / 72×108 — **2:3** | `preview.css:67,68` |
| Desk "Recently added" | `aspectRatio:'1/1.5'` — **2:3**, inline | `DeskPage.tsx:327` |
| AudiobookSearch results | `width:100%; height:200px` — **container-dependent**, inline | `AudiobookSearch.tsx:183` |

Audiobook cover art is square by convention (Audible, Apple Books, Libro.fm) and Phase 0
confirms the served naturals are 500×500 and 300×300. The 2:3 boxes are a *print-book*
ratio. With `object-fit:cover`, feeding a square into a 2:3 box **crops 33% off a square
cover — top and bottom — on the recommendations grid and the Desk.** Titles and series
badging live at the top and bottom of audiobook art. You are cutting off the part that
identifies the book.

**Fix, in order:**
1. Standardise on **1:1** everywhere. It is what the sources actually serve, and it stops
   the cropping. Change `preview.css:67,68` and `DeskPage.tsx:327`.
2. Make `/scout/trends` a **2-column poster grid** on mobile: at 390px with 16px gutters and
   a 12px gap that is a 167px cover — **10× the current area** — with title and author under
   it, two-line clamped. Twelve books per screen instead of nine, each actually legible.
   Keep the list only if you can show a reason the rank number matters more than the art.
3. Add `srcset`/`sizes` once the box is large enough for it to matter, and `decoding="async"`.

---

### F3 — The center FAB overlaps the third bottom-nav item. The pattern assumes an even item count.

From `preview.css:56`:

```
.v2-bottom-nav{...grid-template-columns:repeat(5,1fr);height:72px;z-index:50}
.v2-bottom-nav a:nth-child(3){padding-right:28px}
.v2-bottom-nav a:nth-child(4){padding-left:28px}
.v2-mobile-fab{position:fixed;z-index:55;bottom:38px;left:50%;transform:translateX(-50%);width:58px;height:58px}
```

The `nth-child(3)/nth-child(4)` padding split is the standard trick for parting a **four**-item
nav around a center FAB. The nav has **five** items (`PreviewApp.tsx:95-98`: Desk,
Scout & Acquire, Curate, Activity, Settings). With five equal columns at 390px:

- Column 3 = x 156–234; `padding-right:28px` shrinks its content box to 156–206, centered **181**.
- FAB spans x 166–224, y 38–96 from viewport bottom; nav occupies y 0–72.
- Overlap region: **40 × 34 px**, and the FAB's `z-index:55` paints over the nav's `50`.
- Distance from FAB center (195, ~67) to the Curate icon center (~181, ~55) is ~18px — inside
  the FAB's 29px radius.

**The FAB covers the Curate tab's icon and takes its taps.** (Derived from CSS; Phase 0
independently observed "the center FAB overlaps card content and the lower chart chips at
390px." A screenshot at 390px would confirm the nav collision in one look — worth doing.)

The padding hack also destroys the nav's rhythm: item centers land at 39, 117, 181, 287, 351
— gaps of 78, 64, 106, 64. A five-item nav should be evenly divided.

**Fix:** pick one. Either drop to **four** nav items and let the FAB own the fifth slot (the
"New task" sheet is arguably a nav destination anyway), or **delete the FAB** and put "New
task" in the top bar — which on mobile is currently near-empty because
`.v2-command,.v2-active-top,.v2-new-task{display:none}` (`preview.css:56`). The second option
costs nothing and removes a whole class of overlap bugs.

---

### F4 — Safe-area insets are applied in a way that breaks on notched phones.

`preview.css:56`:

```
.v2-app{display:block;padding-bottom:92px}
.v2-bottom-nav{height:72px;padding:7px 4px calc(7px + env(safe-area-inset-bottom))}
.v2-mobile-fab{bottom:38px}
.v2-job-capsule{bottom:78px}
```

`#ui-v2-root *{box-sizing:border-box}` (`preview.css:9`) means **`height:72px` includes the
padding**. On an iPhone with a 34px inset, the nav's content box becomes
`72 − 7 − 41 = 24px` — for an 18px icon + 4px gap + 10px label ≈ 32px of content. **The nav
content overflows its own box by ~8px and the labels clip.** The inset should grow the
element, not squeeze it: `min-height:72px`, or `height:calc(72px + env(safe-area-inset-bottom))`.

The three sibling offsets are all inset-blind hard numbers: `.v2-app` reserves a flat 92px
while the nav needs 72 + 34 = 106; the FAB sits 38px from the *screen* edge, i.e. 4px above
the home indicator; the job capsule at `bottom:78px` lands *under* the nav on a notched
device. Each should be `calc(<n>px + env(safe-area-inset-bottom))`, and the whole set should
derive from one `--nav-h` token rather than four independent magic numbers.

---

### F5 — 87% of the sub-12px text is one declaration.

Phase 0: **75 leaf elements render below 12px** on a 390px phone. Decomposed against the CSS:

| Rendered | Count | Source |
|---|---|---|
| 10.88px | 65 | `.bestseller-card__badge{font-size:0.68rem}` — `BestsellerLists.css:212` |
| 9px | 5 | explicit `font-size:9px` (recommendation tags/links, folder-pattern chrome) |
| 11px | 3 | explicit `font-size:11px` |
| 11.667px | 1 | an unstyled `<small>` (browser default `0.8333em` × 14px body) |
| 10px | 1 | `.v2-command kbd{font-size:10px}` — `preview.css:20` |

**One value — `0.68rem` on the bestseller badge — accounts for 65 of the 75.** Those badges
carry the source and rank ("AUD #3", "APL #7"), which is real information on the acquisition
surface, set below the legibility floor.

Worse, the badges are **visually undifferentiated**. `BestsellerLists.tsx:386` emits
`bestseller-card__badge--${source}` per badge; grep confirms **no `__badge--*` rule exists in
any stylesheet**. Every badge is the same grey pill. The markup allocated a hook for source
identity and the design never used it, so the densest, smallest text on the card asks the
reader to parse three-letter codes with no color assist.

Also unstyled: `.bestseller-card__cover--placeholder` (`BestsellerLists.tsx:364`) — referenced,
never defined.

**Fix:** raise the badge to a 12px floor with `letter-spacing:.03em`, and either give each
source a tinted border via the existing modifier hook, or cut the badge to a single dominant
source and move the rest into the description overlay. Do not keep 10.88px.

---

### F6 — There is no type scale, and the fractional sizes have a traceable cause.

Twelve distinct sizes, from two incompatible systems layered on each other:

`curator/styles.css:35` sets `body{font-size:14px}` — a global, unscoped rule that reaches
the whole document. `BestsellerLists.css` then sizes in **decimal `rem`**, which is
root-relative (16px), not body-relative. The measured fractions fall out exactly:

| Measured | Declared | Where |
|---|---|---|
| 13.6px ×86 | `0.85rem` | `.bestseller-card__rank:134`, `.bestseller-card__author:196` (43 cards × 2) |
| 10.88px ×65 | `0.68rem` | `.bestseller-card__badge:212` |
| 12px ×6 | `0.75rem` | `.bestseller-lists__tab-count:77` (the 6 chart chips) |
| 24px ×1 | `1.5rem` | `.bestseller-lists > h2:27` |
| 14px ×58 | *inherited* | `body{font-size:14px}` — `curator/styles.css:35` |
| 21px ×2 | *browser default* | unstyled `<h2>` (1.5em × 14px) |
| 16.38px ×1 | *browser default* | unstyled `<h3>` (1.17em × 14px) |
| 11.667px ×1 | *browser default* | unstyled `<small>` (0.8333em × 14px) |

Three separate problems visible in that table:

1. **rem-on-a-14px-body.** The author decided the author line should be "85% of normal" and
   got 13.6px against a 14px title — **0.4px of size difference.** The hierarchy on the
   bestseller card is carried *entirely* by weight (650 vs 550) and color, and per F1 the
   weight half of that may not render. The title is functionally the same size as its
   metadata.
2. **Browser-default headings leak through** (21px, 16.38px, 11.667px). That is the
   default-framework smell: `<h2>`, `<h3>`, `<small>` reaching the page with no rule.
3. `.bestseller-card__title` has **no `font-size`, no `line-height`, and `white-space:nowrap`**
   (`BestsellerLists.css:181-191`). The most important string on the card is unstyled and
   truncated. Give it 15px/1.3, weight 700, and `-webkit-line-clamp:2` — two lines is the
   difference between "The Dungeon Anarchist's Coo…" and a decision.

Supporting: only **18 `line-height` declarations in 65KB of CSS.** Everything else inherits
`normal` (~1.2 in the fallback family), which is too tight for wrapping metadata in a dark UI.

---

### F7 — Fifteen references to six CSS variables that are defined nowhere in the repo.

Audited every `var()` in CSS and TSX against every `--x:` definition:

| Token | No-fallback uses | Locations |
|---|---|---|
| `--cyan` | 4 | `DeskPage.tsx:214,217`, `HealthReportPage.tsx:28,32` |
| `--text-muted` | 4 | `DeskPage.tsx:283,332,333,338` |
| `--bg-card` | 3 | `DeskPage.tsx:213,327`, `HealthReportPage.tsx:27` |
| `--bg-secondary` | 2 | `ScanResultsReview.tsx:236,383` |
| `--bg-primary` | 1 | `ScanResultsReview.tsx:250` |
| `--text-tertiary` | 1 | `ScanResultsReview.tsx:384` |
| `--bg-inset`, `--text-muted` | 2 | `preview.css:90` (`.v2-realign-candidate`) |

None is defined in `theme.css`, `curator/styles.css`, `preview.css`, `BestsellerLists.css`, or
`TagAnalytics.css`. They are ghosts from a **fourth** token vocabulary that was removed
without removing its consumers. Every one is `var(--x)` with **no fallback**, so each fails
silently: color properties become invalid-at-computed-value-time and **inherit**, backgrounds
resolve to nothing.

Visible today on `/desk`, the landing route:

- `DeskPage.tsx:332-333` — the author and date under every "Recently added" book are
  `color:var(--text-muted)` → **inherit `--v2-text` (#f5f7ff)**. Title, author, and date all
  render the same white. The three-level hierarchy the developer wrote does not exist.
- `DeskPage.tsx:327` — the cover box is `background:var(--bg-card)` → **transparent**. The
  frame that should hold a cover while it loads is invisible.
- `DeskPage.tsx:338` — the "No recently added books found" empty state, likewise full white
  instead of muted.

This is a two-line fix (define the aliases, or replace them with `--v2-*`) with a
disproportionate payoff, which is why it's ranked this high.

---

### F8 — 33 spacing values, 16 radii, 27 shadows. There is no rhythm layer.

Distinct px values inside `padding`/`margin`/`gap`/`row-gap`/`column-gap` in `preview.css`:

```
1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 24 25 26 27 28 30 32 34 48 70 92
```

**33 values.** Look at the `gap` distribution alone: 5px ×10, 6px ×19, 7px ×18, 8px ×18,
9px ×10, 10px ×12, 11px ×2, 12px ×19, 13px ×4, 14px ×3. Every consecutive integer from 5 to
14 is in use. That is not a scale with a few exceptions; that is a value picked by eye at each
call site. Nothing in the interface can line up, because nothing shares a unit.

`border-radius`: **16 distinct** — 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 99px.
Adjacent components differ by 1px, which reads as sloppiness rather than intent:
`.v2-card` 16px vs `.bestseller-card` 12px vs `.v2-realign-candidate` 11px vs
`.bestseller-card__info` 9px.

`box-shadow`: **27 distinct values**, none tokenised — so elevation has no meaning. A card at
`0 16px 50px rgba(0,0,0,.12)` and a sheet at `0 32px 100px rgba(0,0,0,.6)` are the only two
that read as a deliberate pair.

---

### F9 — `preview.css` is 65KB in 102 lines, and the entire mobile layout is one 4,020-character line.

Not a style nit; it has a measurable cost on the surface you care most about.

`grep -n "@media" preview.css` returns 13 hits across 11 lines. **Line 56 alone is 4,020
characters** and contains: the off-canvas rail, the collapsed topbar, the bento reorder, the
bottom nav, the FAB, the job capsule, the bottom-sheet conversion, the settings dialog
mobile layout, the 44px control minimums, and all three `env(safe-area-inset-bottom)` uses.

Consequences:

- **Every mobile change is a one-line diff.** Git cannot show you what moved. Code review of
  the priority surface is effectively impossible, and two people editing mobile always conflict.
- **F3 and F4 are exactly the kind of bug this hides.** The FAB overlap and the border-box
  safe-area squeeze are visible in ten seconds in formatted CSS and invisible in a 4,020-char line.
- **Line numbers are useless as evidence.** Every citation in this report that matters for
  mobile says `preview.css:56`.

The file is not minified output — the rest of the repo is formatted source, and this file has
comment-free hand-authored structure. It appears to be hand-written this way.

**Fix:** run Prettier over it once. It is a zero-risk, no-behavior-change commit that pays for
itself on the first mobile bug. Do it before any of the other work in this report.

---

### F10 — Four style systems, patched together by `!important` and an inline-style substring selector.

Not three — four, counting the phantom set in F7.

| System | Tokens | Scope | Palette |
|---|---|---|---|
| `styles/theme.css` (158 ln) | 19 | global `:root` + `body` | **light** — "Summer Beach" glassmorphism, teal `#6db6b8` |
| `features/curator/styles.css` (490 ln) | 20 | global `:root`, `body`, `h1`, `input` | **light** — beige `#f7f5f0` / navy `#1a2a3a` |
| `preview/preview.css` (65KB) | 14 `--v2-*` | `#ui-v2-root` | **dark** — `#070a11` / violet / cyan |
| phantom (F7) | 0 defined, 6 named | inline styles in 4 files | — |

Both global stylesheets are **light-theme, unscoped, and loaded unconditionally** by
`main.tsx:9-10`, while every route renders inside the dark `#ui-v2-root`. Phase 0 caught the
top-level symptom: `body` paints `rgb(247,245,240)` under a `#ui-v2-root` painting
`rgb(7,10,17)`, so a rubber-band overscroll exposes a cream band. `index.html` sets no
`color-scheme` and no `theme-color`, so on mobile the browser chrome won't match either.

The reconciliation mechanism is `.v2-legacy-surface` (`preview.css:39`) — six rules, six
`!important`s, patching `.glass-panel`, `.glass-input`, `.glass-button` back to dark. It
works for *classed* elements. It cannot reach **inline styles**, and there are ~167 `style={{`
occurrences across the librarian and preview components. The leaks Phase 0 measured are
exactly the inline exceptions:

- `AudiobookSearch.tsx:146-148` — the "Clear" button carries
  `style={{background:'rgba(0,0,0,0.05)', color:'var(--text-primary)'}}`. `--text-primary`
  is `#1a2a3a` (theme.css:16), navy. Inline beats the shim. **This is Phase 0's
  `rgb(26,42,58) ×1`** — and Phase 0's 1.44:1 disabled control, from
  `.glass-button:disabled{color:var(--text-secondary)}` = `#4a5a6a` = the measured
  `rgb(74,90,106) ×1`. Two of the three colour outliers on `/scout/trends` are this one
  component.
- This component is on `/scout/trends` **above the bestseller list** (`ScoutPage.tsx:16`), so
  the first thing on the priority mobile route is the one piece rendered in the wrong theme.

Then there is this, at `preview.css:56` and `:59`:

```
.v2-legacy-surface>div[style*="display: flex"]{flex-direction:column!important}
.v2-legacy-surface>div[style*="grid-template-columns: 1fr 1fr"]{...}
```

**The stylesheet targets elements by substring-matching the serialised React inline `style`
attribute.** It depends on React's exact property serialisation, on the author writing
`display: 'flex'` rather than a shorthand, and on nobody reordering the object. It is the
clearest possible signal that the inline styles have become load-bearing and the CSS is
reaching around them.

Dead weight found along the way: `theme.css:2-5` defines `--color-bg/--color-surface/
--color-primary/--color-text` (Catppuccin values) — **0 references anywhere.**

**Consolidation direction** (not a rewrite plan — three ordered moves):

1. **Scope the two light stylesheets.** Wrap `curator/styles.css` and `theme.css` in
   `.legacy-scope { }` or move `:root`/`body`/`h1`/`input` rules under a class. The global
   `body{font-size:14px}` and `h1{font-family:'Crimson Pro'}` in particular have no business
   being global. This alone kills F6's rem/px mismatch and the F10 body-background band.
2. **Promote `--v2-*` to the one token layer**, defined on `:root` rather than `#ui-v2-root`,
   with the F7 ghosts aliased to it (`--text-muted: var(--v2-muted)` etc.) as a one-commit
   bridge. Then the inline styles become correct instead of silently broken.
3. **Retire `.v2-legacy-surface` by converting the inline-styled components** — start with
   `AudiobookSearch.tsx` (20 inline styles, on the priority route) and `DeskPage.tsx` (34, on
   the landing route). When those two are classed, the `!important` shim and both
   `[style*=]` selectors can be deleted.

Do not build a fourth system. The `--v2-*` set is good; it just needs to be the only one.

---

### F11 — The scout tab strip overflows with no affordance, and the search box is a desktop grid on a phone.

`.v2-section-tabs` (`preview.css:25`) is `display:flex; width:fit-content; max-width:100%;
overflow-x:auto`, going to `width:100%` on mobile. Four tabs — "Trends & discovery",
"Recommendations", "Search & download", "Intake review" — at 13px with a 14px icon and
`padding:0 12px` come to roughly 550px against a 390px viewport. Phase 0 confirms it is
clipped at the right edge.

`overflow-x:auto` means it *does* scroll, but there is **no scroll affordance**: no edge
fade, no partial-item peek by design, and touch scrollbars are invisible at rest. Combined
with `border-radius:14px` and a 1px border, the cut looks like a rendering bug rather than an
invitation. Two of four sections on the acquisition surface are effectively undiscoverable.

**Fix:** a `mask-image: linear-gradient(90deg,#000 85%,transparent)` on the right edge when
scrollable, plus `scroll-snap-type:x mandatory`. Or shorten the labels to
"Trends / Picks / Search / Intake" and fit all four.

Directly below it, `AudiobookSearch.tsx:117` renders
`gridTemplateColumns:'1fr auto auto'` — input, a 150px-min `<select>`, and a two-button row
— as an inline style, so **no media query can reach it.** At 390px that grid cannot fit; it
will either overflow or crush the input to nothing. The mobile shim's answer
(`.v2-legacy-surface>div[style*="display: flex"]{flex-direction:column!important}`) matches
`display: flex`, not this `display: grid`. It is unhandled.

---

### F12 — Small motion and state-affordance gaps

- `transition:.16s ease` and `transition:.2s ease` (`preview.css`, 3 occurrences) omit the
  property, meaning `transition: all`. On elements that also change `padding` or `border`,
  `all` animates layout and causes jank. Name the properties.
- `.bestseller-card:hover{transform:translateX(3px)}` (`BestsellerLists.css:129`) — a 3px
  lateral nudge is below the perceptual threshold for communicating anything, and there is no
  hover on the priority surface at all. Meanwhile `:focus-within` shares the rule, so keyboard
  users get the same non-signal. Replace with a border-color + background change that survives
  on touch.
- **No cover-load treatment.** `BestsellerLists.tsx:356-361` renders the `<img>` with
  `loading="lazy"` and no `onError` (grep confirms **zero `onError` handlers on any cover img
  in the app**). These are third-party hotlinks to Audible/Apple; when one 404s the reader
  gets a 52×52 empty box with `alt=""`. The `.bestseller-card__cover` gradient background is
  the right instinct but it sits *behind* a failed `<img>`, not in place of it. Add an
  `onError` that swaps to the placeholder span that already exists.
- **The whole card is one button** (Phase 0; `BestsellerLists.tsx:317` — the card's only
  primary action is "Search AudiobookBay"). There is no visual state for "already in my
  library", "saved", or "dismissed", because there is no such state in the markup. That is an
  IA finding more than a visual one, but from a craft angle it means the card has **no
  designed states at all** beyond hover — no selected, no acted-on, no visited. A triage
  surface needs at least "decided" vs "undecided."

---

## Proposed token set

Concrete replacements. Numbers chosen to land near the existing values so the visual delta is
small — this is a consolidation, not a redesign.

### Type scale — 6 sizes replacing 12

| Token | Size / line-height | Weight | Replaces | Used for |
|---|---|---|---|---|
| `--t-display` | 28px / 1.10 | 700 | 29, 30, 36, 44, `clamp(30,3vw,44)` | page `h1` |
| `--t-title` | 20px / 1.25 | 700 | 20, 21, 23, 24, 25, 27, 28 | card `h2`, sheet titles |
| `--t-subtitle` | 16px / 1.30 | 700 | 16, 16.38, 17 | `h3`, card titles in grids |
| `--t-body` | 15px / 1.45 | 400 | 13.6, 14 (inherited) | default; set on `#ui-v2-root`, not `body` |
| `--t-label` | 13px / 1.35 | 600 | 12, 13, 13.6 | nav, tabs, metadata, buttons |
| `--t-micro` | 12px / 1.30 | 700, `+0.04em` | 9, 10, 10.88, 11, 11.67 | badges, eyebrows, kbd |

`--t-micro` at 12px is the floor — it removes all 75 sub-12px nodes.
Set `font-size` on `#ui-v2-root`, delete `body{font-size:14px}` (`curator/styles.css:35`), and
**stop using `rem` in component CSS** — the two systems can't coexist.

### Weight scale — 3 replacing 6

| Token | Value | Replaces |
|---|---|---|
| `--w-regular` | 400 | 400, 450 |
| `--w-medium` | 600 | 550, 600 |
| `--w-bold` | 700 | 650, 700, 750 |

550/650/750 buy nothing without a guaranteed variable font (F1). If you self-host Inter
Variable, 500/600/700 are still the right three steps — four weights in one card is noise.

### Spacing scale — 7 replacing 33

| Token | Value | Absorbs |
|---|---|---|
| `--s-1` | 4px | 1, 2, 3, 4, 5 |
| `--s-2` | 8px | 6, 7, 8, 9 |
| `--s-3` | 12px | 10, 11, 12, 13 |
| `--s-4` | 16px | 14, 15, 16, 17 |
| `--s-5` | 24px | 18, 19, 20, 21, 22, 24, 25, 26 |
| `--s-6` | 32px | 27, 28, 30, 32, 34 |
| `--s-7` | 48px | 48, 70, 92 (+ `--nav-h` below) |

### Radius & elevation — 4 + 3 replacing 16 + 27

| Token | Value | Absorbs |
|---|---|---|
| `--r-sm` | 8px | 4, 5, 6, 7, 8, 9 |
| `--r-md` | 12px | 10, 11, 12, 13, 14 |
| `--r-lg` | 16px | 16, 18, 20, 22 |
| `--r-pill` | 999px | 50%, 99px |
| `--e-0` | `none` | resting surfaces |
| `--e-1` | `0 8px 24px rgba(0,0,0,.28)` | cards, popovers |
| `--e-2` | `0 24px 64px rgba(0,0,0,.55)` | sheets, dialogs, drawer |

### Color roles — same 7 colors, named jobs

The palette is already right. What's missing is role assignment, and one misallocation.

| Role token | Value | Current name | Note |
|---|---|---|---|
| `--fg` | `#f5f7ff` | `--v2-text` | primary text |
| `--fg-muted` | `#9aa6bd` | `--v2-muted` | secondary text — 7.57:1, fine |
| `--fg-subtle` | `#6e7b94` | `--v2-dim` | tertiary; **must not go below 12px** |
| `--bg` / `--surface` / `--surface-2` / `--surface-3` | `#070a11` … `#182236` | unchanged | 4 elevations is right |
| `--accent` | `#8b5cf6` violet | `--v2-violet` | brand / nav-active / FAB |
| `--interactive` | `#22d3ee` cyan | `--v2-cyan` | **reserve for actionable things** |
| `--ok` / `--warn` / `--danger` | `#34d399` / `#fbbf24` / `#fb7185` | unchanged | status only |

**The one color change I'd make:** `--v2-cyan` is currently spent on 43 author names
(`.bestseller-card__author{color:var(--bestseller-accent)}`, `BestsellerLists.css:195`) —
Phase 0's `rgb(34,211,238) ×43`. The author name is not interactive and not the decision
signal. Burning the interaction color on the most-repeated static field means nothing on the
card can announce itself as tappable. Move authors to `--fg-muted` and keep cyan for the
action. This costs one line and buys back the entire accent.

### Layout tokens (mobile) — kill the magic numbers from F4

| Token | Value |
|---|---|
| `--nav-h` | `calc(72px + env(safe-area-inset-bottom))` |
| `--nav-pad` | `var(--nav-h)` → `.v2-app{padding-bottom:var(--nav-pad)}` |
| `--fab-bottom` | `calc(var(--nav-h) + var(--s-2))` |
| `--capsule-bottom` | `calc(var(--nav-h) + var(--s-3))` |

---

## Open questions

1. **Was a webfont ever intended to ship, or are `Inter`/`Outfit`/`JetBrains Mono` aspirational?**
   The answer decides F1 (self-host vs. delete the names) and whether the 550/650/750 weight
   ladder is salvageable. Settled by: a decision, not a file.
2. **Should `/scout/trends` be a list or a poster grid?** F2 assumes browse-and-decide favours
   art. If the rank number is genuinely the primary signal — i.e. the user is tracking chart
   position, not judging books — the list is correct and the covers should shrink further or
   go away. Settled by: what Joel actually does in those two minutes.
3. **Is the bottom nav five items or four?** F3 has two clean fixes and they diverge. Settled
   by: whether "New task" is a destination or an action.
4. **NYT Fiction / NYT Nonfiction return 0** (Phase 0). If they are permanently dead, the two
   chips are 2 of 6 slots on the mobile filter row spent on nothing. Data bug or dead chip —
   this is an engine question I can't answer from CSS.
5. **Does the FAB visibly cover the Curate icon?** F3's geometry says yes; I could not run a
   browser. One 390×844 screenshot of `/scout/trends` settles it.
6. **Is there a case for a light mode?** There is no designed light variant — there are two
   *abandoned* light stylesheets. Given the product is a personal at-home library tool used in
   the evening, I'd say no: commit to dark, add `<meta name="color-scheme" content="dark">`
   and a `theme-color`, and delete the light palettes rather than half-maintain them.
7. **The 2:3 vs 1:1 cover question is partly a data question.** If Audiobookshelf serves
   portrait art for owned books while the bestseller sources serve square, the app has two
   genuinely different image populations and F2's "standardise on 1:1" needs qualifying.
   Not observable locally — ABS is unconfigured. Settled by: one look at a populated library.

---

*No files were modified. This document is the only file created.*
