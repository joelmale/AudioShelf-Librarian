# Performance review - mobile acquisition surface

Reviewer: ux-frontend-performance. Scope: whole app, scout/trends and scout/search
weighted highest. Method: npm run build -w @audioshelf/frontend, serve the real dist/
(the already-running backend on :3050 serves it via express.static, confirmed by
matching asset hashes before/after the build), and measure with PerformanceObserver
in the live page at a 375x812 mobile viewport. Builds on Phase 0, platform-capabilities.md,
and mobile-interaction.md - findings already established there are cited, not re-derived.

## Measurement conditions (read before comparing these numbers to anything else)

- Production build only, per the brief: apps/frontend/dist, served by the backend
  already running on :3050. Dev-server (:5173) numbers are cited once, for comparison,
  and labelled as such.
- Viewport: 375x812, emulated via the review tool mobile preset.
- No CPU throttling and no network throttling were available in this harness - there
  is no DevTools-protocol throttle exposed through the provided browser tools (the prior
  interaction reviewer hit the same wall; see mobile-interaction.md methodology notes).
  Localhost timings below are therefore a floor, not a real-device number. Where a
  measurement genuinely crosses the live internet (the AudiobookBay search scrape, the
  three external cover-art CDNs), the latency is real, just not from a controlled or
  reproducible connection profile.
- A reproducible ~800ms constant offset exists in this harness paint timing, present
  on every route: /desk (an eagerly-loaded route with zero dynamic imports) measured
  first-paint at 828ms; /scout/trends measured 880ms. Since /desk needs none of Scout
  chunk chain and still shows ~800ms, that baseline is almost certainly this automation
  harness tab-activation/paint-scheduling cost (the same limitation the interaction
  reviewer documented for requestAnimationFrame), not a real cost a phone would pay. I
  therefore treat absolute LCP/FCP figures as unreliable and the delta between
  routes (~52ms, Scout minus Desk) as the trustworthy number. Reproduce on a real device
  with Chrome DevTools (4x CPU slowdown, Fast 4G) to get a trustworthy absolute figure -
  this harness cannot apply that throttle.
- All measurements taken cold (fresh navigate()) unless marked "remount" (same-session
  SPA route change, used specifically to test the react-query-less cache).
- /api/librarian/bestsellers resolved in 3ms server-side in every run - this is a warm
  cache hit inside the backend, not a genuinely cold scrape of Audible/AudiobooksNow/Apple.
  A true cold cache (first hit after a backend restart) was not measured, per the standing
  instruction not to restart the backend.

## Verdict

The bytes-and-splitting story here is already fine - platform-capabilities.md verified
that with a real build, and this pass confirms it holds at runtime: CLS is 0.000 on every
load tested, no long task fired during a full-document scroll of the 43-card list, and the
Scout-reachable initial JS is 282,154 of a 300,000-byte budget the repo already enforces via
verify:bundle. Virtualizing the list would fix nothing that is actually broken.

The real cost on this surface is stale state, not bytes: every route-away-and-back
throws away the bestseller list and every one of its 43 images and re-fetches from zero
(confirmed live, not just read from source), loading="lazy" is not deferring a single one
of those images on this connection despite being correctly set in markup, and the one
interactive verb on a card costs a measured 1.18s live scrape on top of the scroll-jump
mobile-interaction.md already found. None of this shows up in a bundle report, and
verify:bundle - the only automated gate that exists - checks none of it.

## Measurements

| Metric | Route | Value | Target | Verdict |
|---|---|---|---|---|
| LCP (element: p subtitle text) | /scout/trends, cold | 880ms | <2.5s | Pass, but see harness-offset caveat above |
| LCP (control, no dynamic Scout chunks) | /desk, cold | 828ms | <2.5s | Pass - establishes the ~800ms harness floor |
| LCP delta attributable to the 3-hop chunk waterfall | Scout vs Desk | ~52ms | n/a | Small on this idle link; mechanism compounds under real latency (Finding 5) |
| CLS | /scout/trends, cold x2 runs | 0.000 | <0.1 | Pass |
| CLS | /desk, cold | 0.000 | <0.1 | Pass |
| INP | /scout/trends | not reliably measurable in this harness | <200ms | Unknown - see Finding 4 for the best available proxy |
| Long tasks during full-document scroll (5377-5474px, 43 cards) | /scout/trends | 0 tasks over 50ms, 2 separate runs (cache-warm and cache-cold) | 0 | Pass (unthrottled CPU, see caveat) |
| Initial JS to reach Scout (raw / gzip) | /scout/trends | 282,154 B raw (94% of budget) / approx 102 KB gzip | <300,000 B (repo own budget) | Pass, 6% headroom left |
| Total production JS+CSS assets | whole app | 36 files, 1.1 MB uncompressed | n/a | Confirms platform-capabilities.md corrected figure |
| Time for all render-blocking data to be ready (JS parsed + bestsellers API resolved) | /scout/trends, cold | 74ms after nav start | n/a | Not the bottleneck - see Finding 1/2 |
| Cover image payload, bestseller grid | /scout/trends | 39-43 images, natural 500x500 / 300x300, rendered 52x52 | approx 90 KB if right-sized (platform review calc) | Fail - confirms Phase 0/platform figure, Finding 1 |
| loading="lazy" effectiveness | /scout/trends, cold x2 runs | 0 of 43 images deferred - all requested within a 12ms window (81-93ms) regardless of position in a 5474px document | Images below the fold should not fetch until scrolled near | Fail - Finding 2 |
| Cache reuse on remount (Desk to Scout) | /scout/trends | 0 percent - bestsellers API refetched, all 43 img nodes recreated (naturalWidth reset to 0 for all) | Instant cached render | Fail - Finding 3 |
| Card-tap round trip (the only primary action) | /scout/trends to AudiobookSearch | 1,176ms live search scrape | n/a (subjective: browse-and-decide loop) | Compounds mobile-interaction.md finding #1 - Finding 4 |
| Background poll cadence, every route incl. Scout | app-wide | operations endpoint every approx 3.0s indefinitely (800ms if a job is active) | n/a | Finding 6 |

## Ranked findings

### 1. Approximately 1 MB of cover art into a 52 px slot - largest measured cost, confirmed at runtime

Independently re-confirmed the platform reviewer finding with live DOM inspection this
session: every loaded cover naturalWidth/naturalHeight reads exactly 500x500
(Amazon) or 300x300 (AudiobooksNow), rendered into a 52x52 CSS px slot
(BestsellerLists.css, the <=480px block). The fix and its ~90 KB target size are already
scoped in docs/ui-review/platform-capabilities.md finding #1
(apps/backend/.../bestsellers.ts:130 and neighbors) - not re-derived here, only
confirmed with fresh measurement that the natural sizes are real, not a stale capture.

Consequence: on a real mobile connection this is approximately 1 MB the reader pays
before or while scrolling a list they may act on in seconds.

Fix and magnitude: unchanged from the platform review - 3 backend lines, approximately
1008 KB down to approximately 90 KB.

### 2. loading="lazy" is set correctly and defers nothing - upgraded from open question to confirmed

Phase 0 flagged this as unresolved ("why did 39 of 39 lazy images load at 390x844") and
platform-capabilities.md listed it as an open question. It was run twice, cold, on the
production build: all 43 img loading="lazy" elements fire their network request
within a 12ms window (resource-timing startTime 81-93ms), spanning the full
5474px-tall document, at a 375x812 viewport where only the first approximately 8 cards
are visible. Not one image was deferred in either run.

Two candidate mechanisms, and this harness cannot distinguish them without a throttled
connection: (a) Chrome scales its lazy-load lookahead distance by estimated connection
speed, and on an idle/fast link that distance may simply cover the whole 5474px document;
or (b) the list mounts all 43 img nodes via client-side React in one commit, and if the
loading="lazy" viewport-distance check runs before that batch layout has settled, Chrome
can default every node to "near enough." Either way, the measured behavior is the same:
on the connection quality this component was tested on, the attribute buys nothing.

Consequence: the approximately 90 KB post-fix-#1 payload (or today approximately 1 MB) is
not trickled in as the user scrolls, it is front-loaded regardless of scroll position, on
every load, for every list length.

Fix: re-test under real throttling (Chrome DevTools "Slow 4G" on a real device, which this
harness cannot apply) before spending more here - if it still does not defer, replace the
native attribute with an IntersectionObserver-gated src assignment, which does not depend
on a browser heuristic. Effort: small (one hook, reusable across the list). Impact: only
matters after Finding 1 ships - right now the whole payload downloads either way, so this
is a second-order fix, not a first one.

### 3. The list discards itself on every departure - confirmed live, not just from source

platform-capabilities.md finding #4 read this from BestsellerLists.tsx:150-193
(useState plus a bare fetch, no react-query). This was reproduced live: navigated
/scout/trends to /desk to /scout/trends within one SPA session (no full reload) and
monkey-patched fetch to log timing. Result: the bestsellers API refires on the return
visit (measured, approximately 166.5s into the session, i.e. on the very next route
change), and all 43 .bestseller-card__cover elements report naturalWidth: 0 and
complete: false immediately after remount - the DOM nodes are new, not reused.

Consequence, quantified: every tap on the bottom nav (Desk, Curate, Activity,
Settings) and back - the only way to recover from the scroll-jump in
mobile-interaction.md finding #1, since that jump creates no history entry - re-pays
the full list fetch plus a fresh image payload (currently approximately 1 MB,
approximately 90 KB post-fix-#1), every single time, for a screen whose data changes at
most daily.

Fix: unchanged from the platform review - react-query, approximately 30 lines, no new
dependency (already a top-level dependency, already used by features/curator/api.ts).
A staleTime of minutes-to-hours is honest for a daily chart and would make this instant
on any repeat visit within a session.

### 4. The one interactive verb costs 1.18s of live scrape, on top of a scroll-jump that already destroys the user place

mobile-interaction.md finding #1 already established that tapping a card fires a
window.CustomEvent, does not navigate, and smooth-scrolls the reader approximately
2700px away with no history entry. What happens next was measured directly: the
resulting AudiobookBay search (the search API endpoint) took 1,176ms end-to-end in a
live run this session (request at t=237,536ms, resolved at t=238,712ms, HTTP 200). No
long task was recorded during this window - it is not blocking the main thread, but it
is blocking meaningful content in the panel the reader was just forcibly relocated to.

Consequence: the true cost of the single working verb on this surface is not just the
disorienting jump - it is the jump plus over a second staring at a panel with nothing in
it yet, for a query that is not cached, so tapping the same title twice pays this twice.

Fix: cache search results client-side keyed by query (the same react-query
infrastructure as Finding 3 covers this for free via useQuery), and - the higher-value
half, already recommended in mobile-interaction.md prioritized list - stop moving the
viewport at all; surface the result inline under the card instead. This finding does not
re-rank that interaction fix; it is the performance number that makes its cost concrete.

INP could not be measured directly in this harness (no trusted-event timeline survives
the tool tab-hidden state - see methodology notes in mobile-interaction.md); this 1.18s
figure is the best available proxy for "how long after tapping a card does anything
useful appear."

### 5. Three-hop chunk waterfall - confirmed at runtime, small on this link, structurally worse on a real one

platform-capabilities.md found this by reading dist/.vite/manifest.json. This was
confirmed with live resource timing on the production build: index-B8_yIdiZ.js
requested at 12ms (done 18ms), then PreviewApp-jbk4880g.js at 28ms (done 33ms), then
ScoutPage-CAWwhglc.js at 60ms (done 63ms). Each hop only starts after the previous chunk
is parsed and its import() call executes - three sequential round trips, not one.

Consequence, measured: on this idle localhost link, the gap is approximately 52ms (the
/scout/trends vs /desk LCP delta). On a real cellular connection this does not scale
linearly - each hop pays a full request-response latency, not the 5-27ms of local
parse/schedule time seen here. No throttled-network number is fabricated here since none
was measurable in this harness; the reproducible test is: apply Chrome DevTools "Fast
4G" profile (170ms RTT) to this exact build and re-run the same resource-timing script.

Fix: unchanged from the platform review - a modulepreload link for the PreviewApp
chunk in index.html, one line, collapses one of the two extra hops for free.

### 6. Background polling runs on every route, forever, including Scout

New finding. useOperations() (apps/frontend/src/features/curator/api.ts:857-866) is
mounted in PreviewApp.tsx:32 - the shell every route renders inside, Scout included -
and polls the operations endpoint on a refetchInterval of 3000ms when idle, 800ms if
any operation is active, with no upper bound and no route-based gating. Confirmed both
in source and in a live network capture spanning several minutes of this session, with
operations requests landing at a consistent approximately 3005-3020ms cadence
throughout, on /scout/trends as much as anywhere else.

Consequence: a reader who opens /scout/trends for their stated "spare two minutes"
and just reads leaves the radio waking every 3 seconds for an endpoint whose result
Scout never displays. The payload is small (an operations array, empty in this
unconfigured environment) so this is not a bytes problem - it is a battery/radio-wake
problem on a surface explicitly designed for a phone in a pocket.

Fix: gate the interval by whether anything on the current route actually renders
operation state (Scout does not), or lengthen the idle interval well past 3s for routes
with no operations UI. Effort: a flag on the existing hook call. Impact: small in
isolation, but it is the one item on this list that costs something for as long as the
tab stays open, not just at load.

### 7. verify:bundle - what it checks, and what it does not

Read the script (scripts/verify-frontend-bundle.mjs) before proposing anything new, per
the brief. It does exactly two things, well: (a) sums the byte size of every JS file in
the initial (non-deferred) dependency graph and fails above 300,000 bytes - currently
282,154 bytes, 94 percent of budget; (b) asserts that six named routes/components
(ScoutPage, RealignPage, CuratePage, UnifiedLogsPage, PreviewSettingsDialog,
MetadataPipeline) are absent from that initial graph, and that no classic/ chunk
survives. Ran it clean: npm run verify:bundle passes today.

It does not check, and would not catch, any of findings 1 through 6: no image-weight
budget, no runtime LCP/CLS/INP gate, no assertion about hop count or modulepreload. It
is a build-graph gate, not a runtime-performance gate. Worth keeping - it is doing its
one job correctly and is close enough to its own budget (94 percent) to be worth
watching - but it should not be cited as evidence that the runtime issues above do not
exist; it was never built to see them.

### 8. No error handling on cover images - real code gap, failure rate observed but not attributable

BestsellerLists.tsx:356-361: the img branch has no onError. The sibling branch for a
missing coverUrl already renders a numbered placeholder
(bestseller-card__cover--placeholder) - that fallback exists in the component but is
never reached for a URL that 404s, times out, or is blocked after render.

In this session, over two minutes after a cold load, 26 of 43 covers never completed
(18/20 Amazon succeeded, 4/16 AudiobooksNow, 0/7 Apple), leaving a blank 52x52 box with
no retry and no fallback, because alt="" means even the browser own broken-image glyph
never appears. This specific failure rate cannot be attributed to the app with
confidence - it may well be this sandbox outbound network policy toward the Amazon,
Apple, and AudiobooksNow CDNs rather than anything reproducible for a real user, and
should be labelled "unknown, re-verify outside this sandbox" rather than asserted as a
defect rate. What is not in question is the code fact: there is no error path, so
whatever a real user failure rate turns out to be (dead mirror, hotlink protection,
ad-blocker, flaky carrier DNS), it currently resolves to a silent, permanent blank card.

Fix: an onError handler that swaps to the existing placeholder span. A few lines,
reusing markup that already exists for the adjacent case.

## Fix list, ordered by impact-per-effort

1. Right-size cover URLs at the source (Finding 1) - approximately 3 backend lines,
   approximately 1 MB down to approximately 90 KB on the priority surface. Highest
   leverage item in this entire review; unchanged from the platform review, now
   confirmed at runtime.
2. React-query for BestsellerLists (Finding 3) - approximately 30 lines, no new
   dependency, makes every return visit instant instead of a full refetch and reload;
   now confirmed live, not just read from source.
3. onError fallback on the cover img (Finding 8) - a handful of lines, reuses the
   placeholder branch that already exists; protects against a failure mode this session
   actually hit, at low cost regardless of the true real-world failure rate.
4. modulepreload link for the PreviewApp chunk (Finding 5) - one line in index.html,
   removes one of two extra network round trips before any Scout pixel; small on this
   link, larger on a real cellular one.
5. Cache the AudiobookBay search response (Finding 4, the caching half) - comes free
   once #2 react-query pattern exists; stops re-paying the measured 1,176ms scrape for
   a repeated query. The bigger half of this finding - stop moving the viewport at all -
   is an interaction-design fix already prioritized in mobile-interaction.md and not
   re-ranked here.
6. Re-verify loading="lazy" under real network throttling (Finding 2) - no code change
   until this is settled; costs one test session with a real device or a
   throttling-capable tool this harness did not have. Only worth acting on once Finding
   1 ships, since today the payload downloads immediately either way.
7. Gate or lengthen the 3s operations poll on routes that do not use it (Finding 6) -
   a flag on an existing hook; smallest, least urgent item, but the only one that costs
   something for the entire duration a reader keeps the tab open, not just at load.
