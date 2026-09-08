# Platform capabilities — front-end platform review

Reviewer: `ux-frontend-platform`. Read-only pass. Scope: whole app, mobile acquisition
surface (`/scout/*`) weighted highest.

Method: grep the source for what is already in use, then run
`npm run build -w @audioshelf/frontend` and read `dist/.vite/manifest.json` before
opining on bundling. Every claim below carries a `file:line` or a build-output line.

---

## Verdict

The platform gaps on this app are smaller than the review brief assumes, and they are
in different places than expected.

Three things I expected to find broken are fine. Code splitting genuinely works — the
416 kB recharts chunk never reaches the mobile Scout path. Tap targets and contrast were
already measured clean in Phase 0. The bottom-nav/sheet/safe-area mobile shell in
`preview.css` is real work, not a stub.

The actual cost centres are: **~1 MB of cover art the backend deliberately upsizes
before serving it into a 52 px slot**, **a list component that throws its data away on
every unmount**, and **a set of one-line CSS mistakes** (`100vh`, missing
`color-scheme` on `:root`) that cost nothing to fix and are visible on every phone.

Almost none of the marquee capabilities in the brief are worth adopting here. View
Transitions has nothing to transition — the primary mobile action does not navigate.
Virtualization at 43 rows is the wrong answer. A service worker cannot run at all on
this deployment. React 19 buys this app nothing.

Six Adopts, three Trials, seven Skips. The Adopts total roughly a day of work and
about 900 kB of transfer on the priority surface.

---

## Adopt / Trial / Skip

| # | Capability | Verdict | Cost | User-visible win |
|---|---|---|---|---|
| 1 | Right-size cover URLs at the source | **Adopt** | ~3 backend lines | ~1008 kB → ~90 kB on `/scout/trends` |
| 2 | `color-scheme: dark` on `:root` + matching `body` | **Adopt** | 2 lines | Kills the light overscroll band; fixes UA form/scrollbar defaults |
| 3 | `dvh`/`svh` for the mobile shell and sheet | **Adopt** | 4 declarations | Bottom sheet and nav stop hiding under iOS chrome |
| 4 | react-query for `BestsellerLists` | **Adopt** | ~30 lines, no new dep | Instant return to the list; precondition for any scroll restoration |
| 5 | `<dialog>` for the two modal overlays | **Adopt** | net −30 lines | Escape + focus trap on the New-task sheet, which has neither |
| 6 | Fix the dev `PORT` collision | **Adopt** | 1 script line | `npm run dev` works again for the next person |
| 7 | Container queries for `.bestseller-card` | **Trial** | ~10 CSS lines | Card layout matches its column, not the window |
| 8 | Popover API for the description overlay | **Trial** | ~20 lines | Removes `z-index: 9999` and a global keydown listener |
| 9 | Manifest + icons + `theme-color` (no SW) | **Trial** | 1 file + 2 icons | Home-screen launch for a two-minutes-in-the-queue surface |
| 10 | SSE for `POST /recommendations` | **Trial** | backend + client | Pipeline shows progress instead of a spinner; pattern already exists in-house |
| 11 | Virtualization of the bestseller list | **Skip** | — | 43 rows. Not a problem. |
| 12 | `content-visibility` / `contain-intrinsic-size` | **Skip** | — | Optimises the cost that isn't there |
| 13 | React Router data router (`ScrollRestoration`, `unstable_viewTransition`) | **Skip** | — | Both need `createBrowserRouter`; revisit after #4 |
| 14 | View Transitions API | **Skip** | — | The primary mobile action does not navigate |
| 15 | Service worker / offline shortlist / Web Share Target | **Skip** | — | Blocked on secure context (see #9) |
| 16 | React 19 | **Skip** | — | Nothing the app needs; `lucide-react` peer-caps at 18 |
| 17 | `srcset` / `sizes` on covers | **Skip** | — | Fixed 52–60 px slot; only DPR varies. One URL is correct. |
| 18 | Optimistic mutations via react-query | **Skip (premature)** | — | There is no intent-capture mutation to make optimistic yet |

---

## Corrections to `.claude/ui-review/context.md` and Phase 0

**The 153-request figure is a dev-server artifact.** Phase 0 was captured against
`npm run dev`, where Vite serves every module unbundled. The production build emits
**36 assets** totalling 1022 kB uncompressed, of which the `/scout/trends` path pulls
roughly 20 files. Do not spend effort reducing 153; it does not exist in production.

**Code splitting is not just present, it is working correctly.** Build output:

```
dist/assets/MetadataPipeline-hbbP7Gzn.js  416.23 kB │ gzip: 118.98 kB
dist/assets/index-B8_yIdiZ.js             189.87 kB │ gzip:  61.84 kB
dist/assets/PreviewSettingsDialog-*.js    100.06 kB │ gzip:  24.94 kB
dist/assets/PreviewApp-jbk4880g.js         58.07 kB │ gzip:  16.31 kB
dist/assets/ScoutPage-CAWwhglc.js          40.85 kB │ gzip:  11.62 kB
dist/assets/PreviewApp-DhezOUB6.css        62.40 kB │ gzip:  11.74 kB
```

`recharts` is imported from exactly one file (`features/curator/components/TagAnalytics.tsx:14`),
and the manifest confirms `MetadataPipeline` is a **dynamic** import of `CuratePage.tsx`
only. The 416 kB chunk never touches the Scout path. `@dnd-kit` is likewise confined to
`EncodeQueueList.tsx` inside `EncoderPage` (60.78 kB). This is the right shape already —
do not add `manualChunks`.

The one real bundling observation: the mobile Scout path is a **three-hop waterfall** —
`index.js` → `PreviewApp` (dynamic, from `App.tsx:7`) → `ScoutPage` (dynamic, from
`PreviewApp.tsx:8`). `dist/index.html` preloads only `jsx-runtime`. Three sequential
round trips before any Scout pixel, on a phone, is the dominant TTI cost, not bytes.
A `<link rel="modulepreload">` for `PreviewApp` in `index.html` collapses one hop for
free; collapsing the second would mean un-lazying `ScoutPage`, which is not worth it.

**Media queries: 13 in `preview.css`, 18 app-wide.** Of the 18, three are
`prefers-reduced-motion` and 15 are width-keyed, across **six distinct breakpoints** —
420, 480, 600, 800, 900, and the `801–1279` band (`preview.css:55,63`;
`BestsellerLists.css:294,316`; `TagAnalytics.css:32`). The 800 px line is the real
one; the other five are one-offs.

**Vite: 8.1.0 confirmed**, but note the repo has two copies — `node_modules/vite`
is 7.3.6 (hoisted) while `apps/frontend/node_modules/vite` is 8.1.0, and the build log
confirms `vite v8.1.0` is what runs. Harmless, but it will confuse the next person
debugging a build.

---

## Ranked findings

### 1. The backend upsizes cover art before serving it into a 52 px slot — Adopt

This is the largest measured cost on the priority surface and the fix is server-side,
three lines, no client machinery.

`apps/backend/src/modules/librarian/services/bestsellers.ts:130`:

```ts
// The feed serves 100x100 thumbnails, but the CDN renders any
// requested size from the same URL.
coverUrl: (entry.artworkUrl100 || "").replace("100x100", "400x400"),
```

Apple's feed hands us a 100×100 URL. The code enlarges it to 400×400. It is rendered at
52×52 (`BestsellerLists.css:322`, the `≤480px` block) or 60×60 above that
(`BestsellerLists.css:189`). The comment is correct that the CDN renders any size from
the same URL — which means `156x156` (2× DPR of the 52 px slot, with slack) is the same
one-token edit, going the other way.

The other two populated sources are the same shape:
- **AudiobooksNow** — `bestsellers.ts:83` regex-matches specifically
  `static.audiobooksnow.com/jackets/large/…`. The path segment is the size knob.
- **Audible** — `bestsellers.ts:47` scrapes `img.bc-image-inset-border[src]` verbatim.
  Amazon media URLs carry an `._SL500_.` segment; swapping it to `._SL160_.` is a regex
  replace on the scraped string.

Phase 0 measured **39 images, ~1008 KB, natural sizes 500×500 and 300×300**. At 156 px
that payload is roughly 90 kB. This one change is worth more than every other item on
this list combined.

Two corollaries:

- **`srcset`/`sizes` is the wrong tool here and I am recommending against it.** The slot
  is a fixed 52–60 CSS px at every breakpoint. Only device pixel ratio varies, and one
  2× URL covers 1×–3× at negligible cost. `srcset` would add markup and a second
  decision point for zero benefit.
- **Covers are square** (`BestsellerLists.css:186-187`, `width:60px; height:60px`) with
  `object-fit: cover`, so book jackets are centre-cropped. Serving a 2:3 source and a
  2:3 slot would cost nothing extra and stop cropping the title off every spine. That is
  a visual-design call, not mine, but the platform cost is zero.

**Also worth re-measuring:** 39 of 43 covers loaded on a 390×844 viewport with a 5355 px
document, despite `loading="lazy"` being correctly set (`BestsellerLists.tsx:360`).
Four cards have no `coverUrl`, so *every* lazy image fetched. That is not what lazy
loading should do at that document height. Either the capture scrolled the page, or the
attribute is not taking effect. Settle it by reloading `/scout/trends` and reading the
network panel without scrolling. The fix in #1 is correct either way.

### 2. `color-scheme` is set on the wrong element — Adopt, 2 lines

`preview/preview.css:7` sets `color-scheme: dark` on `#ui-v2-root`. Nothing sets it on
`:root` or `html`. Meanwhile `styles/theme.css:36-38` paints
`body { background: var(--bg-dark) }` where `--bg-dark: #f7f5f0` (`theme.css:7`) —
exactly the `rgb(247,245,240)` Phase 0 measured.

So the app declares itself dark one element too deep. Consequences beyond the overscroll
band Phase 0 caught: the UA paints light scrollbars, light default form controls, and a
light `<select>` popup, which is why `preview.css` has to re-declare `color-scheme: dark`
twice more as a patch (`preview.css:35` on `.v2-curate-surface` inputs, `preview.css:49`
on `.v2-setting-field select`). Setting it once at the root makes both of those patches
redundant.

Fix: `color-scheme: dark` on `:root`, and either give `body` the dark `--v2-bg` or drop
its background declaration so the root's shows through. `index.html` should also carry
`<meta name="theme-color" content="#070a11">` so the iOS status bar and the Android
address bar stop rendering light against a dark app.

I would **not** reach for `overscroll-behavior: none` here. It fixes the band by
disabling the gesture, and on a browse surface pull-to-refresh is a reasonable thing for
a reader to expect. Fix the colour, keep the gesture.

### 3. `100vh` in a mobile shell that has a fixed bottom nav — Adopt, 4 declarations

`preview.css` uses `100vh` three times and `100dvh` once:

- `preview.css:7` — `#ui-v2-root { min-height: 100vh }`
- `preview.css:15` — `.v2-app { min-height: 100vh }`
- `preview.css:16` — `.v2-rail { height: 100vh }`
- `preview.css:42` — `.v2-sheet { max-height: 88vh }`
- `preview.css:56` — `.v2-settings-dialog { max-height: calc(100dvh - 10px) }` ← the
  only one that is right

On iOS Safari `100vh` is the *large* viewport — it includes the space the URL bar
occupies. The bottom sheet at `88vh` therefore measures against a viewport taller than
what is actually visible while the URL bar is expanded, and its top edge (the drag
handle at `preview.css:56`) can sit above the visible area. The same block already knows
the right answer for the settings dialog and not for the task sheet, in the same media
query.

Fix: `min-height: 100svh` for the two shell containers (small viewport — the safe floor),
`height: 100dvh` for the rail, `max-height: 88dvh` for the sheet. Support is Safari 15.4 /
Chrome 108 / Firefox 101 — no risk. This is four token swaps.

### 4. `BestsellerLists` throws its data away on every unmount — Adopt

`BestsellerLists.tsx:150-193` holds the entire chart payload in `useState` and fetches it
in a bare `useEffect` with `fetch`. It does not use react-query, which is a top-level
dependency, is configured in `main.tsx:15-17`, and is used by essentially every other
data surface in the app (`features/curator/api.ts`).

The consequence on the priority surface: every departure from `/scout/trends` and back —
tapping the bottom nav, opening a book, opening settings via the deep link — discards 43
cards and refires the whole `/api/librarian/bestsellers` request plus 39 image requests.
`ScoutPage` is lazy (`PreviewApp.tsx:8`), so React unmounts it on every route change.

This is why I am **skipping** `ScrollRestoration` below and adopting this instead. Wiring
scroll restoration to a list that renders empty on mount restores a scroll position into
a zero-height document. The cache has to come first; once it does, the browser's own
history scroll restoration gets most of the way there on its own.

`main.tsx:16` already sets `refetchOnWindowFocus: false`, which is the right call for a
phone that gets backgrounded mid-browse. `staleTime: 5_000` will trigger a background
refetch on remount, but react-query renders the cached list synchronously first, which is
all that matters here. A `staleTime` of a few minutes on the bestsellers key specifically
would be more honest — these are daily charts.

### 5. The primary mobile action scrolls the reader 5000 px away from their place

Not strictly a platform finding, but it determines the verdicts on View Transitions and
scroll restoration, so it belongs here.

On `/scout/trends`, `ScoutPage.tsx` renders `<AudiobookSearch/>`, then a divider, then
`<BestsellerLists/>`. Tapping a card does not navigate. It dispatches a window
`CustomEvent` (`BestsellerLists.tsx:206-212`) which `AudiobookSearch` catches
(`AudiobookSearch.tsx:57-72`), runs a search, and then calls:

```ts
searchEl.scrollIntoView({ behavior: "smooth" });   // AudiobookSearch.tsx:67
```

The search section is above the bestseller list. So on a 5355 px document, tapping card
#30 smooth-scrolls the reader back to the top of the page, and returning to where they
were means manually scrolling ~5000 px, with no history entry to go back through.

That is the single worst thing about the mobile browse loop, and it is why **View
Transitions is a Skip**: there is no list → detail navigation to animate. The interaction
is a same-page scroll jump. Fixing the loop is an interaction-design decision (a sheet
anchored to the card, or a real route with a back stack) — but until it is fixed, no
transition or restoration API has anything to attach to.

### 6. The dev `PORT` collision — Adopt, and the applied workaround is not the fix

Confirmed, and the mechanism is narrower than Phase 0 describes.

- Root `package.json:9`: `concurrently "npm run dev -w @audioshelf/backend" "npm run dev -w @audioshelf/frontend"`
- Backend reads it: `apps/backend/src/config/index.ts:8` — `PORT: process.env.PORT`
- Frontend does **not**: `grep process.env.PORT apps/frontend` returns nothing. Vite has
  read `server.port` / `--port`, never `$PORT`, for several major versions. It lands on
  5173 by default regardless.

So the collision is one-sided. The launcher exports `PORT=5173` for Vite's benefit; Vite
ignores it; the backend obeys it and binds 5173, racing Vite, while
`vite.config.ts:19` proxies `/api` → `localhost:3050`. Every API call 502s.
`concurrently` is doing exactly what it should — the bug is that one global,
single-valued variable is being asked to configure two servers.

The `.env` route does not rescue this: `config/index.ts:5` calls `loadEnv({ quiet: true })`
without `override`, so dotenv will not overwrite an ambient `PORT`.

**The workaround applied to `.claude/launch.json` is not a fix.** It starts the frontend
alone, which means the launcher no longer brings up the backend at all, and it leaves the
repo's own documented `npm run dev` broken for anyone who runs it under any parent that
sets `PORT` — a launcher, an IDE, a CI runner, a Procfile.

Ranked fixes:

- **(A) Pin it in the script.** Add `cross-env` as a devDependency and write
  `concurrently "cross-env PORT=3050 npm run dev -w @audioshelf/backend" "npm run dev -w @audioshelf/frontend"`.
  One dev-only dependency of the same kind as `concurrently`, which is already there.
  Works on the PowerShell dev box. This is the smallest fix that actually fixes it.
- **(B) Give the backend its own variable.** `config/index.ts:8` →
  `PORT: process.env.API_PORT ?? process.env.PORT`, add `API_PORT` alongside `PORT` in
  `docker-compose.yml:14`, and put `API_PORT=3050` in `apps/backend/.env.example`. Zero
  new dependencies, and it is the more principled shape — but it only works in dev once
  an `apps/backend/.env` actually exists, and Phase 0 confirms none does.
- **(C) Make it an argument, not an ambient.** Have `index.ts` accept `--port` and pass it
  from the script. An explicit flag beats an inherited variable for something this
  load-bearing, but it is the most app-code churn of the three.

I would take (A) now and (B) as the eventual shape.

### 7. Container queries — Trial

The bestseller grid is already intrinsic and does not need a media query:

```css
/* BestsellerLists.css:110 */
grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
```

But the card *internals* switch on viewport width:

```css
/* BestsellerLists.css:316-329 */
@media (max-width: 480px) {
  .bestseller-card { grid-template-columns: 32px minmax(0, 1fr) 44px; }
  .bestseller-card__search { grid-template-columns: 52px minmax(0, 1fr); gap: 11px; }
  .bestseller-card__cover { width: 52px; height: 52px; }
}
```

These two disagree. At a 1400 px viewport the `auto-fill minmax(300px, 1fr)` grid puts
cards into ~330 px columns — narrower than the 480 px viewport that triggers the compact
rules — and those cards get the *wide* layout: a 36 px rank gutter, a 60 px cover, a 48 px
info column, leaving ~180 px for a title and author that already truncate mid-word
("The Dungeon Anarchist's Coo…", Phase 0). The compact variant is exactly what a 330 px
card wants, and it is unreachable there.

`container-type: inline-size` on `.bestseller-card` (or on the `<li>`) plus
`@container (max-width: 380px)` in place of the 480 px viewport query makes the card
respond to its column. That is what container queries are for, and this is a textbook
instance of the problem they solve, in a codebase where the component demonstrably
renders in two different containers.

Support: Chrome 105, Safari 16, Firefox 110 — no risk. Cost: ~10 lines, one file.

Trial rather than Adopt only because it is worth doing once, on this one component,
before deciding whether to convert the other five width breakpoints. Do not do a
wholesale media-query-to-container-query migration on `preview.css` — the 800 px line
is a genuine shell-layout decision (rail vs. bottom nav) and belongs to the viewport.

### 8. `<dialog>` and Popover — Adopt the first, Trial the second

**Three overlay implementations, three different levels of correctness.**

`PreviewSettingsDialog.tsx:341-374` hand-rolls the full modal contract: body scroll lock,
Escape, forward and backward Tab cycling over a `querySelectorAll` of focusables, initial
focus, and focus return. About 34 lines. It is correct, and it is 34 lines that
`dialog.showModal()` provides for free — top layer, `::backdrop`, Escape, and focus
containment without a focusable-element query. The only thing still needing code is
focus return, which is one `returnFocus?.focus()` on close.

`PreviewApp.tsx:101` — the New-task bottom sheet — has `role="dialog"` and
`aria-modal="true"` and **none** of that behaviour. No Escape handler exists anywhere in
`PreviewApp.tsx`. No focus trap, no scroll lock, no focus return. It closes only on
`onMouseDown` of the backdrop, which on a phone means the reader has to find the strip of
dimmed page above a bottom sheet. `aria-modal="true"` on an element that does not trap
focus is a promise the markup does not keep. Converting this one to `<dialog>` is the
higher-value half of this item.

`<dialog>` support: Chrome 37, Safari 15.4, Firefox 98. `::backdrop` styling is stable.
The existing `.v2-overlay` / `.v2-sheet` CSS (`preview.css:42`, `:56`) maps onto
`dialog::backdrop` and `dialog` with minimal change — the mobile bottom-sheet variant
(`border-radius: 22px 22px 0 0`, `env(safe-area-inset-bottom)`) transfers as-is.

**The description overlay** (`BestsellerLists.tsx:519-542`) is the Popover candidate.
Today it is `position: fixed; z-index: 9999` (`BestsellerLists.css:246-248`) with the
position clamped in JS against hardcoded constants that must be kept in sync with the CSS
by hand:

```tsx
// BestsellerLists.tsx:455-462
`${Math.min(overlay.x + 14, window.innerWidth - 334)}px`   // 334 tracks width: min(320px, …)
`${Math.min(overlay.y + 14, window.innerHeight - 416)}px`  // 416 tracks max-height: min(400px, …)
```

Plus a global `window` keydown listener for Escape (`BestsellerLists.tsx:195-202`) and a
manual `pinned` / transient state machine.

The `popover` attribute with `showPopover()` gives top layer (deleting the `z-index: 9999`
that currently has to out-rank the FAB at 55, the bottom nav at 50, and the overlay at 80),
light dismiss, and Escape — removing the keydown listener and the pinned/transient split.
Support: Chrome 114, Safari 17, Firefox 125.

Trial rather than Adopt because **positioning still has to be manual**. CSS anchor
positioning, which would delete the clamping math too, is Chrome-only; there is no
portable path to that half yet. So Popover here buys stacking and dismissal, not layout —
worth trying on this one overlay, not worth a sweep.

One thing to fix regardless of the API: the overlay fires on `onMouseEnter` **and**
`onFocus` (`BestsellerLists.tsx:328-345`), and a cache miss issues a cross-origin request
straight from the browser to `https://itunes.apple.com/search` (`BestsellerLists.tsx:249`)
with **no `AbortSignal`** — unlike the list fetch at `:161-192`, which correctly uses one.
Tabbing through 43 cards fires 43 uncancellable third-party requests. On mobile the hover
path is dead anyway (no hover), so the only reachable trigger is the 44×44 info button.

### 9. PWA — adopt the cheap half, skip the expensive half

The two halves have completely different cost profiles here and should not share a verdict.

**The cheap half — Trial.** `index.html` has viewport meta and nothing else. A
`manifest.webmanifest` with `display: standalone`, `background_color`/`theme_color` matching
`--v2-bg` (`#070a11`), a `start_url` of `/scout/trends`, plus a 192/512 icon pair and an
`apple-touch-icon`, is one small file and two PNGs. On a surface whose stated job is
"one-handed, in a spare two minutes," landing directly on the browse list from the home
screen instead of through a browser tab is a real win. iOS honours Add-to-Home-Screen and
`apple-touch-icon` over plain HTTP. This pairs naturally with the `theme-color` in #2.

**The expensive half — Skip, and it is blocked, not merely unattractive.**
`docker-compose.yml` runs the app on `homelab-net` with `PORT: "3050"`, no published
ports, no TLS terminator, and Express serves the built SPA directly
(`apps/backend/src/index.ts:150-156`). **Service workers require a secure context.** Unless
there is a reverse proxy terminating HTTPS in front of this that the compose file does not
describe (see Open questions), then service-worker cover-art caching, an offline-readable
shortlist, `beforeinstallprompt`, and **Web Share Target** — which specifically requires a
manifest served over HTTPS with a registered service worker — will silently not run.

I would not build any of them on a maybe. Ship the manifest, confirm the scheme, revisit.

### 10. Streaming — the pattern already exists in this repo and Scout does not use it

The shell already streams in the sense that matters without SSR: the route chunks are
split, `DeferredRoute` (`PreviewApp.tsx:23-25`) is a real Suspense boundary, and the
build output confirms the split is effective. There is no case for SSR here.

The one genuinely blocking surface is `/scout/recommendations`.
`RecommendationFinder.tsx:88-104` does `setLoading(true)`, awaits a single
`POST /recommendations`, and shows a spinner labelled "Looking beyond your shelf…" until
the entire pipeline — retrieval, LLM, and per-candidate iTunes verification — completes.
All or nothing.

What makes this a strong recommendation rather than a generic one is that **the repo has
already solved this problem once, for a different route.**
`apps/backend/src/modules/curator/api/routes/librarian.ts:165-200` serves
`POST /librarian/chat` as SSE over an `SseChannel`, and
`apps/backend/src/modules/curator/core/librarian/events.ts` defines a nine-variant,
Zod-validated event union (`interpretation | action | pile | retrieval | answer | audit |
token | …`) explicitly described as "a public contract that tests assert against."
`apps/frontend/src/features/curator/librarianChat.ts:219-241` is a working client-side
consumer of that stream.

So the work is not "adopt streaming." It is "point the recommendations route at the sink
that already exists," and the vocabulary needed to render progress — which candidate is
being verified, how many cleared — is already typed. The `retrieval` event alone would let
the panel say "read 240 of your books for context" while the LLM is still running,
instead of after.

Trial rather than Adopt purely on sequencing: this route needs a configured
Audiobookshelf to do anything at all (Phase 0), so it cannot be validated on the current
dev stack, and it is not the mobile browse loop. Do it after the acquisition surface.

### 11. Optimistic UI — nothing to be optimistic about yet

Phase 0 is unambiguous: on the bestseller card, "there is no other primary action, no
save/dismiss, no library-state indicator anywhere in the markup." The entire card is one
"Search AudiobookBay" button (`BestsellerLists.tsx:320-397`). Grepping confirms the
backend has no shortlist, wishlist, or intent endpoint either.

So "adopt optimistic mutations for intent capture" is advice about a feature that does not
exist. I am not going to recommend a pattern for it.

Two things worth recording for when it is built:

`grep onMutate` across the frontend returns **zero results** — no mutation in the app is
optimistic today. But `RecommendationFinder.tsx:73-85` already implements the pattern by
hand, and implements it correctly:

```tsx
setVerdicts((prior) => ({ ...prior, [externalKey]: verdict }));
api.sendFeedback({ externalKey, queryText: prompt, verdict })
  .catch(() => setVerdicts((prior) => { const next = { ...prior }; delete next[externalKey]; return next; }));
```

Apply, roll back on failure, never let a failed opinion break the thing the reader is
looking at. That is the right behaviour for "get this / not this / maybe later" on a card,
and when it moves into react-query it is `onMutate` + `onError` with `cancelQueries` —
about the same amount of code, with the cache invalidation handled. The rule that matters
is the one the existing comment already states: an intent capture that fails to record
must never interrupt the browse loop.

### 12. Long lists — Skip virtualization and Skip `content-visibility`

43 cards, one per row, 362×90 px, in a 5355 px document (Phase 0). Virtualization is the
wrong answer at this length and would be a net loss: a windowing dependency, broken
in-page find, broken anchor links, a scroll-restoration problem where there wasn't one,
and a measurable a11y regression on a `role="tabpanel"` list. React's reconciliation of 43
list items is not a cost anyone will perceive.

`content-visibility: auto` with `contain-intrinsic-size` is the cheaper version of the
same misdiagnosis. The card has a fixed `min-height: 86px` (`BestsellerLists.css:172`) so
the intrinsic size is trivially known and it would be safe — but it optimises layout and
paint, and layout and paint are not what makes this list expensive. **1008 kB of images
is.** Fix #1 and re-measure before spending anything here.

The list length also comes from a real cap: each source is limited to 20
(`bestsellers.ts:44,88`) across five sources, deduped to a consensus ranking
(`BestsellerLists.tsx:112-147`). 43 is close to the structural ceiling. If a future source
pushes this past a few hundred, revisit — with `content-visibility` first, not
virtualization.

### 13. React Router data router, `ScrollRestoration`, View Transitions — all Skip

These three collapse into one decision, because in react-router-dom 6.30.4 the latter two
are gated on the first.

Verified in the installed package:
- `node_modules/react-router-dom/dist/index.js:967` — `useScrollRestoration` throws
  `"… must be used within a data router"`.
- `dist/index.js:418-502` — every `startViewTransition` call site lives inside the
  `RouterProvider` / data-router path.

The app uses `<BrowserRouter>` (`main.tsx:24`) with declarative `<Routes>` in two places
(`App.tsx:30`, `PreviewApp.tsx:64`). Neither `ScrollRestoration` nor `unstable_viewTransition`
is reachable without migrating both route trees to `createBrowserRouter` + `RouterProvider`.
`grep` confirms neither is used anywhere today.

That migration is mechanical but not small — it touches the app's two route definitions,
including the `PreviewShell` chrome that wraps the inner `<Routes>` and the
`SettingsDeepLink` redirect at `PreviewApp.tsx:112-116`. I am not recommending it, for
two independent reasons:

**Scroll restoration is not the actual bug.** Finding #4 is: the list has no data on
remount, so there is nothing to restore a position *into*. And finding #5 is: the primary
mobile action does not create a history entry at all, so back-navigation is not the loop
that is broken. Fix the cache first; then check whether the browser's native history scroll
restoration is already sufficient. It very often is once the data renders synchronously.
Only if it demonstrably is not does the data-router migration earn its keep.

**View Transitions has nothing to transition.** A list → detail → back animation requires a
list → detail navigation. On the mobile acquisition surface there isn't one (finding #5).
The `curate/books/:id` route is a genuine detail navigation, but it is the desktop
management console — the surface explicitly deprioritised in this review, and one where a
morph animation is decoration rather than orientation.

Revisit both together, once, if and when the browse loop gains a real card → detail route.
At that point the data-router migration pays for two features instead of zero.

### 14. React 19 — Skip

No feature in React 19 addresses anything on this list. The app uses exactly one React 18
concurrent feature today (`useDeferredValue` at `RecommendationFinder.tsx:59`) and uses it
correctly. `useOptimistic` would be the one plausible draw, and finding #11 explains why
it is moot: there is no intent mutation, and when there is, react-query's `onMutate` —
already a dependency — covers it on React 18 with better cache semantics.

Compatibility is close but not free. `@tanstack/react-query` 5.101.1 declares `^18 || ^19`,
`recharts` 3.9.1 declares up to `^19`, `@dnd-kit` and `react-router-dom` both declare
`>=16.8`. The blocker is `lucide-react` **0.378.0**, whose peers are
`^16.5.1 || ^17.0.0 || ^18.0.0` — no React 19. That version is also very old for a package
that ships weekly, so a React 19 move implies a large icon-library bump alongside it, on a
codebase that imports icons in dozens of files.

Cost: a dependency sweep and a `StrictMode` re-verification pass, on an app with several
hand-rolled `useEffect` lifecycles (`PreviewSettingsDialog.tsx:341`,
`BestsellerLists.tsx:160`, `AudiobookSearch.tsx:57,74`) that would all need re-checking
under 19's stricter double-invoke. Benefit: none that a reader would notice.

Stay on 18.3.1. Revisit when a dependency forces it.

---

## Open questions

1. **Is the app reachable over HTTPS?** `docker-compose.yml` shows plain HTTP on
   `homelab-net` with no published ports and no TLS terminator, which would make every
   service-worker capability in #9 dead on arrival. If there is a reverse proxy in front
   of it (Caddy, Traefik, Nginx Proxy Manager) terminating TLS, the offline-shortlist and
   Web Share Target items move from Skip to genuinely worth costing. Settled by: what URL
   Joel actually types on his phone.

2. **Why did 39 of 39 lazy images load at 390×844?** `loading="lazy"` is correctly set
   (`BestsellerLists.tsx:360`) on a 5355 px document, and Phase 0 still recorded every one
   fetched. Settled by: a cold reload of `/scout/trends` at 390×844 with no scrolling,
   reading the network panel.

3. **Are the two NYT chips a data bug or dead UI?** Phase 0 measured `NYT Fiction 0 ·
   NYT Nonfiction 0`. The code path exists (`bestsellers.ts:155-170`) and the empty state
   is honest about the cause ("NYT charts need a Books API key in Settings → Discovery",
   `BestsellerLists.tsx:507`), and `docker-compose.yml` forwards `NYT_API_KEY`. So it is
   probably just unconfigured locally rather than broken — but a chip that reads `0` and is
   still tappable is a dead end on a two-minute browse surface. Whether to hide unconfigured
   sources is an IA call, not mine.

4. **Is `preview.css` minified on purpose?** 65 kB across 102 lines, source-authored as
   single-line. Every finding in this report that touches it (#2, #3, #7, #8) requires
   editing a 4000-character line, and none of them will produce a reviewable diff. This is
   not itself a platform capability, but it is a tax on every platform change recommended
   here. Settled by: whether there was ever a source form of this file, or whether it was
   authored this way.

5. **Does anything actually consume the frontend's `WebSocketProvider` for librarian
   events?** `contexts/WebSocketProvider.tsx` is a well-built typed pub/sub, and the SSE
   vocabulary in `core/librarian/events.ts` is thorough, but `grep librarian`
   against the provider returns nothing. If the two were meant to meet, finding #10 gets
   cheaper than I have costed it.
