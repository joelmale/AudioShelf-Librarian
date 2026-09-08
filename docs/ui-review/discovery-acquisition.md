# Discovery & Acquisition — review

Reviewer: ux-discovery-strategist. Subject: `scout/*` and the pipeline behind it, judged
as a one-handed mobile acquisition surface. Read-only review; no file in this repo was
changed except this one.

Runtime numbers are cited from `docs/ui-review/phase0/index.md` and not re-derived.
Audiobookshelf is not connected locally, so every claim about library-aware behavior below
is traced in code and labelled **not observable locally**.

---

## Verdict

**The bestseller surface is a browsing surface that cannot record a decision.** It renders
43 candidates competently and then offers exactly one thing to do with any of them: throw
the title into a torrent search. There is no save, no dismiss, no "maybe", no ownership
marker, no history of what you already looked at. A user who triages 43 candidates in a
spare two minutes ends that session with the same state they started with — the work
evaporates. That is the defining failure, and it is one bad afternoon away from being
fixed, because **the backend intent-capture endpoint already exists, is already generic
over non-owned works, and already requires no Audiobookshelf connection**
(`apps/backend/src/modules/curator/api/routes/feedback.ts:21-35`, `:86-93`).

The second failure compounds the first: the single action that does exist is destructive
to the browse context. Tapping any card fires a window event that `AudiobookSearch`
answers with `scrollIntoView` to the top of a 5355px page
(`apps/frontend/src/features/librarian/components/AudiobookSearch.tsx:57-73`;
`apps/frontend/src/preview/pages/ScoutPage.tsx:17`). There is no scroll restoration
anywhere in the frontend. Investigating candidate #30 costs the position of candidates
#31–43. The loop is not slow; it is non-resumable.

Third: the surface has real signal it is throwing away — consensus across three charts is
computed correctly and then rendered as 10.88px badges, while the *only* per-item data the
engine could add (ownership, narrator, runtime, freshness) is either discarded at the
scraper or never asked for.

The strategy call: **do not redesign the browse model. Add the verdict.** The row list is
the right shape for the data that exists. Ship intent capture on `POST /feedback`, split
the tap target, and the surface becomes usable. Everything else in this report is second.

---

## Ranked findings

### 1. No intent can be captured anywhere on the bestseller surface — and the backend for it already ships

`renderCard` (`BestsellerLists.tsx:314-424`) emits exactly three elements: a rank `span`,
one `button` whose accessible name is `Search for {title} by {author}`, and one 44×44
`button` for the description. Phase 0 confirms this in the live DOM. There is no fourth
control anywhere in the file. A repo-wide search for `wishlist|shortlist|watchlist|saved
for later|maybe later` across `apps/`, `packages/` and `docs/` returns **zero hits** —
the concept does not exist in the product at all, not as UI, not as a type, not as a table.

What does exist:

- `POST /api/feedback` accepts `{ externalKey, queryText, verdict }` where `verdict` is
  `accepted | rejected`, and explicitly does **not** require the book to exist in the
  library — `bookId` and `externalKey` are mutually exclusive and either satisfies the
  schema (`feedback.ts:23-35`, `:69-72`). Non-owned works are a first-class case.
- `GET /api/feedback?limit=` returns the rows back, `externalKey` included
  (`feedback.ts:86-93`, `apps/frontend/src/features/curator/api.ts:624-630`).
- The write is a single SQLite insert with no LLM cost and no ABS dependency
  (`apps/backend/src/modules/curator/core/db.ts:3429-3450`) — it works today on this
  machine, unconnected.

So the round trip "record a verdict on a book I do not own, read it back on next load"
is already fully implemented server-side and is consumed by exactly one component
(`RecommendationFinder.tsx:71-82`) on a route that cannot return results without ABS.
The surface that *does* work locally, and that is the stated mobile priority, does not
call it.

**This is the highest-value change in the review and it is additive.**

### 2. Verdicts recorded by `RecommendationFinder` cannot be joined to the impressions that produced them — two independent key mismatches

The engine records the whole displayed slate, keying external candidates with the
normalized form:

```
externalKey: `${normalizeForMatching(book.title)}|${normalizeForMatching(book.author)}`
```
(`apps/backend/src/modules/curator/core/recommendations.ts:382`)

The UI builds its key from the raw strings and sends that:

```
const key = `${book.title}|${book.author}`;
```
(`RecommendationFinder.tsx:142`, sent at `:74`)

`normalizeForMatching` lowercases, strips `(Unabridged)`, folds accents and collapses all
non-alphanumerics to single spaces (`apps/backend/src/modules/curator/core/externalKey.ts`).
So the impression row for *Dungeon Crawler Carl (Unabridged)* is
`dungeon crawler carl|matt dinniman` and the feedback row for the same click is
`Dungeon Crawler Carl (Unabridged)|Matt Dinniman`. They never join. Every thumbs-up on the
recommendations panel lands in `rec_feedback` in a key space that nothing else in the
system writes to.

Second mismatch, same call site: `RecommendationResult.slateId` is returned specifically
so feedback can be grouped with its slate — the type says so
(`apps/frontend/src/features/curator/api.ts:117-118`) — and `sendFeedback` never sends it
(`RecommendationFinder.tsx:74`); the schema does not even accept it (`feedback.ts:23-30`).

Consequence for this review: the *only* intent capture that exists in `scout/*` produces
data the taste profile reads (`feedback.ts:126-133` feeds `buildTasteProfile`) but cannot
correlate. Any new verdict control must mint its key with `externalBookKey` semantics, not
string concatenation. Called out here rather than left to the engine reviewers because it
determines the contract of the control I specify below.

### 3. No library-state indicator exists on any bestseller card — and the ownership predicate is already computed elsewhere

*(Behavior partly **not observable locally**; traced in code.)*

`BestsellerBook` carries five fields and none of them is ownership
(`BestsellerLists.tsx:13-19`). Nothing in `renderCard` reads library state. The
`/api/librarian/bestsellers` route does not touch the books table at all
(`apps/backend/src/modules/librarian/index.ts:821-852`).

Meanwhile the recommendations path does exactly this check, correctly, on every call:

```
const owned = input.db.getAllBooks();
...
const alreadyOwned = owned.some((book) => normalizeForMatching(book.title) === title
  && (!book.author || normalizeForMatching(book.author) === author));
if (alreadyOwned || seen.has(key)) return false;
```
(`recommendations.ts:354-367`)

Two problems, one of them subtle. The obvious one: this predicate is unavailable to the
bestseller surface. The subtle one: even where it runs, it **drops** the owned title
silently rather than labelling it. A user asking "a fantasy series I haven't started" who
gets four results has no way to know whether the fifth was suppressed because they own it
or because verification failed — and the empty-state copy at
`RecommendationFinder.tsx:162-166` explains only the verification case. "You already own
this" is reassuring; a silent gap is confusing.

The nearest existing endpoint is not adequate: `GET /books/titles` returns bare title
strings with no author and no normalization, loaded with `limit: 1000000`
(`apps/backend/src/modules/curator/api/routes/books.ts:55-63`), and `GET /books?search=`
is a raw `b.title LIKE ? OR b.author LIKE ?`
(`apps/backend/src/modules/curator/core/db.ts:1739-1741`) which will not match
*The Dungeon Anarchist's Cookbook* against a differently-punctuated stored title. See
backend gap **G1**.

### 4. The one available action destroys browse position, irreversibly

`handleSearch` dispatches a global `trigger-audiobook-search` CustomEvent
(`BestsellerLists.tsx:206-212`). `AudiobookSearch` listens, sets the query, runs the
search, and scrolls itself into view (`AudiobookSearch.tsx:57-73`). On `/scout/trends`
`AudiobookSearch` is rendered *above* the divider and the list
(`ScoutPage.tsx:17`), so that scroll goes to the top of a 5355px document (Phase 0).

There is no `ScrollRestoration`, no saved offset, no "back to list" affordance — a
repo-wide search for `ScrollRestoration|scrollRestoration|scrollTo(0` in
`apps/frontend/src` returns nothing. Returning to card #31 is a manual thumb-drag through
thirty 90px rows every single time.

Two aggravating details. `.bestseller-list__items` is `max-height: 600px; overflow-y:auto`
on desktop but `max-height:none; overflow:visible` below 800px
(`BestsellerLists.css:85-95`, `:299-304`) — so on desktop the list keeps its own scroll
position while the page scrolls away, and on mobile, the priority case, it does not. And
the coupling itself is a global window event rather than a prop or route param, so the
two components cannot be reordered or separated without breaking the flow silently.

### 5. Tapping a card on a phone fires a cross-origin request to Apple that the user never asked for

The card's search button carries `onFocus`, `onMouseEnter`, `onMouseMove` and `onMouseLeave`
handlers (`BestsellerLists.tsx:328-353`). On touch, buttons take focus on tap, so a tap
runs `showDescription(..., pinned:false)` **and** `handleSearch`. When no description is
cached, `showDescription` fetches `https://itunes.apple.com/search?term=<title author>`
directly from the browser (`BestsellerLists.tsx:248-251`).

Most cards have no supplied description: AudiobooksNow always emits `description: ""`
(`bestsellers.ts:96`), Apple always emits `description: ""` (`bestsellers.ts:132`), and the
Audible scraper blanks its own description whenever it caught the byline
(`bestsellers.ts:50-52`). Of the 43 merged cards, the majority therefore trigger a live
third-party lookup on tap, on a mobile connection, as a side effect of an action whose
label is "Search for…".

The transient (unpinned) overlay it produces is `position:fixed` with `pointer-events:none`
(`BestsellerLists.css:253-270`), positioned by a desktop clamp
(`BestsellerLists.tsx:453-464`) — at 390×844 that pins it to roughly (56, 428). On a phone
it appears mid-screen, cannot be tapped away, and disappears on blur. The *pinned* overlay
is handled properly as a bottom sheet clearing the nav
(`BestsellerLists.css:306-313`) — that part is good work; the transient path is the one
that fires on touch.

Net: one tap produces a scroll jump, an unrequested overlay flash, and an unrequested
request to Apple carrying the title and author.

### 6. A source that breaks reports itself as an empty chart

Every fetcher swallows its own failure and returns `[]`:
`bestsellers.ts:60-63` (Audible), `:101-104` (AudiobooksNow), `:134-137` (Apple),
`:166-169` (NYT). The route then returns `success: true` with whatever it got
(`librarian/index.ts:828-839`), and caches that result for **three hours**
(`:749-753`). The UI derives its chip counts straight from array length
(`BestsellerLists.tsx:282-289`).

So if Audible changes `.productListItem` — an HTML scrape against a site that actively
resists scraping — the Audible chip silently reads `0`, the "All charts" consensus loses 20
of 43 items and reorders, and the empty state says *"No titles are currently available from
this source"* (`BestsellerLists.tsx:504-509`), which is a factual statement about a chart
that in reality has twenty entries. The surface cannot report its own degradation, and the
stale-empty result is then held for three hours.

The NYT chips at count 0 (Phase 0) are the *good* case and prove the pattern is
achievable: because the failure is key-gated rather than caught, the empty state can say
*"NYT charts need a Books API key in Settings → Discovery."* That is the right voice; it
just needs to generalize. The chips themselves should not render at `0` with a live count
badge at all — a dead chip that costs a tap to discover is worse than an absent one.

### 7. "As of when" is unanswerable — the response carries no timestamp

`/api/librarian/bestsellers` returns `{ success, results }` and nothing else
(`librarian/index.ts:823-839`). No `fetchedAt`, no per-source timestamp, no source URL. The
server caches for 3 hours (`:753`) and the client refetches on every mount, so the age of
what you are looking at ranges from 0 to 180 minutes with no way to tell. The heading says
`Top Bestsellers` (`BestsellerLists.tsx:468`) — no date, no "week of", no provenance link.

For an acquisition surface, freshness *is* the value proposition. A chart with no date is
indistinguishable from a cached artifact, and the user has no basis to decide whether it is
worth re-checking. See backend gap **G2**.

### 8. Consensus rank is presented as authority, and means two different things in two tabs

`aggregateBestsellers` (`BestsellerLists.tsx:112-147`) is genuinely good: it merges on
`consensusKey` (main title with parentheticals and subtitle stripped, plus first author's
last name — `:95-106`), orders by number of charts appeared on, then by best single-chart
rank (`:138-146`). That is a defensible ranking and the badges disclose the underlying real
ranks (`:378-395`).

But `#{index + 1}` (`BestsellerLists.tsx:316-318`) renders the *position in the merged
array* with the same typography, in the same slot, as the real chart rank shown when a
single-source tab is active — because in single-source tabs `renderCard` is called without
`appearances` (`:451`, `:512`), so no badges render and `#1..#20` genuinely is the Audible
rank. Same numeral, same position, two different meanings, no label distinguishing them.

The badges that would resolve the ambiguity render at `0.68rem`
(`BestsellerLists.css:207-216`) — Phase 0 measured 10.88px appearing 65 times and counted
**75 leaf text elements below 12px** at 390px width. The strongest signal this surface
computes is rendered in its smallest type.

And single-source tabs are *worse*: they strip the badges without adding anything, so a card
in the Audible tab shows title and author only. Filtering by source loses information.

### 9. Author and series monopolize the top of the list, and it is the sort that does it

Phase 0: Matt Dinniman at #8, #10, #11, #13, #14. To be precise about the cause — this is
**not** a dedupe failure. Those are five distinct books, and `consensusKey` correctly keeps
them separate. The cause is that the merge sorts purely by chart-appearance count then best
rank (`BestsellerLists.tsx:138-146`) with **no per-author or per-series diversification
term**. A series charting simultaneously on three sources sweeps the head of the list by
construction.

On a phone this is expensive: five of the first fourteen rows carry the same decision. A
user who does not want Dungeon Crawler Carl pays five swipes to say so, and a user who does
want it needs the series order — which the data does not carry (finding 10).

### 10. Signal per item: what a card actually tells you, and what was thrown away upstream

What reaches the UI is the whole of `BestsellerBook` — `title`, `author`, `coverUrl`,
`description`, `source` (`BestsellerLists.tsx:13-19`, identical to the backend type at
`bestsellers.ts:11-17`). Of these, `description` is not on the card at all, and `coverUrl`
renders at 52×52 below 480px (`BestsellerLists.css:326-329`) from a 500×500 source (Phase 0,
~1008 KB for the list).

So without tapping, a user learns: a title (truncated mid-word — Phase 0), an author, a
52px thumbnail, and up to three source-rank badges at 10.88px. **Series position, narrator,
runtime, genre, price, release date, ownership and "why this is here" are all absent.**

The critical part is that several of those are absent by discard, not by unavailability:

- **Audible.** The scraper already walks each `.productListItem` node and reads four things
  (`bestsellers.ts:43-57`). That is the same DOM node Audible renders narrator, runtime and
  star rating into. Verify the current selectors against a live fetch before building, but
  the scrape is already standing at the right element — narrator and runtime are the two
  fields an audiobook buyer weighs most and they are one selector each.
- **Apple.** The feed entry is destructured down to `name`, `artistName`, `artworkUrl100`
  (`bestsellers.ts:119-133`) and everything else in the marketing-feed result object is
  dropped on the floor — including the store URL and genre fields. The comment at `:128-130`
  shows the author already knows the CDN renders arbitrary sizes from the same URL, which
  is exactly the lever needed to stop shipping 500×500 into a 52px box.
- **NYT.** Four fields are read (`bestsellers.ts:153-165`). The NYT Books list payload is
  the richest of the three sources — it is the one place a "weeks on list" or
  "up from #7 last week" signal could come from — and none of it is requested.
  Not observable locally (no API key configured).

Cover aspect deserves a correction to a Phase 0 note: audiobook artwork **is** square, so
`object-fit: cover` on a 1:1 box is correct here and is not cropping anything. The finding
is not the aspect ratio; it is that 52px is far too small for cover art to do the
recognition work it is uniquely good at on a phone, while 500×500 is being paid for anyway.

### 11. The engine's reasoning reaches the desk and is stripped on the acquisition surface

`RecommendationResult` carries `interpretation`, `constraints`, `slateId`, and a `retrieval`
block with `candidateCount`, `evidenceCount`, `tagResolution[]` and `personalized`
(`apps/frontend/src/features/curator/api.ts:113-145`).

`LibrarianChatPanel` — the desk surface, for books you already own — renders essentially all
of it: evidence counts and semantic-ranking counts in prose
(`LibrarianChatPanel.tsx:64-78`), disclosed tag rewrites (`:65`), the personalization flag
(`:66`), and `matchedTags` as chips (`:132-133`).

`RecommendationFinder` — the acquisition surface, for books you are about to spend
bandwidth and disk on — renders `retrieval.candidateCount` in one sentence
(`RecommendationFinder.tsx:137`) and each item's `book.reason` as a blockquote (`:149`).
`interpretation` never renders. `tagResolution` never renders, so a silently rewritten tag
filter is disclosed on the desk and hidden here. `personalized` never renders, so the user
cannot tell whether a taste profile shaped the slate.

This is exactly backwards relative to the stakes. The desk recommends something you already
paid for; this panel recommends an acquisition. The one honest line the panel does carry —
*"Every suggestion below was verified against a store listing before being shown"*
(`:138`) — is good and load-bearing, and shows the voice is available; it just stops there.

On the bestseller surface there is no reasoning at all, which is defensible: a chart
position is its own explanation. But it means "why am I seeing this" is answered only by a
10.88px badge (finding 8).

### 12. After the search, the acquisition decision has no availability signal

Tapping a card lands the user in `AudiobookSearch` results. The `SearchResult` interface
declares `seeders: number` (`AudiobookSearch.tsx:5-14`) and the card never renders it —
which is moot, because the backend hardcodes `seeders: 0, leechers: 0`
(`apps/backend/src/modules/librarian/services/audiobookbay.ts:374-375`). The parser does
extract file size, format and posted date (`:346-364`) and those do render
(`AudiobookSearch.tsx:190-206`).

So the final step of the acquisition loop — choosing between N torrents for the same book —
offers size, format and age, and no signal at all about whether the thing will actually
download. The download button then fires and reports success on the *request*
(`AudiobookSearch.tsx:87-111`), not on the outcome. Not observable locally (qBittorrent
resolves to a Docker service name — Phase 0).

### 13. The priority surface is the one place in the app not using the app's data layer

`BestsellerLists` fetches with a bare `useEffect` + `fetch` + three `useState`s
(`BestsellerLists.tsx:150-193`) while the rest of the app is on `@tanstack/react-query`
(`RecommendationFinder.tsx:60-64` and throughout `features/curator/api.ts`).

Consequences that are specifically UX consequences, not code taste: no cache between route
visits, so every return to `/scout/trends` re-fetches and re-renders 43 cards from scratch;
no stale-while-revalidate, so the user sees `Loading bestsellers…` (`:426-432`) instead of
last-known content; no manual refresh control, so there is no way to ask for fresher data
when the 3-hour server cache is the thing you actually want to bust; and `descriptionCache`
(`:154-156`) is component state, so every description fetched from Apple is re-fetched
after any navigation away.

The FAB, incidentally, occupies the single most reachable pixel on the phone and is wired to
"New task" (`PreviewApp.tsx:99`), whose sheet offers Acquire / Intake / Realign / Convert
(`:101-106`) — three of the four are desk work. On the priority acquisition surface, the
best thumb position launches a curation menu.

---

## Mobile acquisition spec

Build target: 390×844. Existing shell constraints to respect — bottom nav is 72px plus
`env(safe-area-inset-bottom)` at `z-index:50` (`preview.css:56`), the FAB is a 58px circle
at `bottom:38px` centered, `z-index:55`. Anything sticky must clear
`calc(72px + env(safe-area-inset-bottom))`; the existing pinned-description sheet already
uses `calc(86px + env(safe-area-inset-bottom))` (`BestsellerLists.css:309`) and that value
should become the shared token.

### Browse model — recommendation, and why

**A single-column row list, grouped into consensus tiers, with a persistent inline verdict
control and a bottom-sheet detail view.** Explicitly rejecting the alternatives, on the
data:

- **Cover-led grid — rejected.** A 2- or 3-up cover grid asks the artwork to carry the
  decision. It can only do that for series a user already recognizes. With no series
  position, no narrator and no runtime available (finding 10), a cover grid strips the two
  text lines that are currently the *only* thing differentiating adjacent items.
- **Editorial rows ("Because you liked…", "New in fantasy") — rejected, no data.** There is
  no per-item genre reaching the client (Apple's genre fields are discarded at
  `bestsellers.ts:123-133`), no theme, no personalization signal on this route. Editorial
  rows without editorial metadata are decoration.
- **Swipeable deck — rejected.** It forces a decision on every one of 43 items when the
  honest answer for most is "skip", destroys any sense of position and consensus, and makes
  comparing the five Dinniman entries (finding 9) impossible. Decks suit surfaces with one
  rich item per screen; here each item is two lines of text.
- **Row list — chosen.** Text-forward matches text-shaped signal; a vertical list preserves
  ranked order, which is the only ordering signal that exists; and it is the one model where
  a per-item verdict control can be persistent, visible, and thumb-reachable without a
  gesture the user has to be taught.

This is deliberately *not* a redesign. The existing row list is the right answer; it is
missing the verdict.

### Screen structure

```
┌─ sticky header, top: 0 ───────────────────────────┐
│ Bestsellers            Updated 2h ago  ⟳          │   44px, one line
│ [All 43] [Audible 20] [ABN 20] [Apple 25]         │   h-scroll chips, 36px
│ [ Hide decided (6) ]                              │   toggle, only when >0
└───────────────────────────────────────────────────┘
   On 3 charts ─────────────────────────────────     28px tier header, sticky
┌─ row, 96px ───────────────────────────────────────┐
│ ┌──────┐  Dungeon Crawler Carl              ┌───┐ │
│ │ 72px │  Matt Dinniman                     │ + │ │  44×44
│ │cover │  Audible #3 · ABN #1 · Apple #6    ├───┤ │
│ │      │  ✓ In your library                 │ × │ │  44×44
│ └──────┘                                    └───┘ │
└───────────────────────────────────────────────────┘
   ... 42 more
┌─ bottom nav, 72px + safe area ────────────────────┐
```

- Header is sticky, not fixed — it scrolls with the first swipe and pins. It carries the
  one thing finding 7 says is missing (freshness) plus a manual refresh.
- Tier headers replace the ambiguous `#N` numeral entirely. `On 3 charts` / `On 2 charts` /
  `On 1 chart` is what the sort actually means (`BestsellerLists.tsx:138-146`), stated
  plainly, in a sticky 13px header instead of a 10.88px badge. In a single-source tab the
  tier headers are replaced by real chart ranks in the row's rank slot, labelled
  `Audible #7` — never a bare `#7`.
- Row: 96px tall, three columns `[72px cover][1fr text][48px verdict stack]`. The 72px
  cover is served at 144px for 2×; for Apple that is a URL substitution the code already
  knows how to do (`bestsellers.ts:128-130`) and for the rest it is a `width`/`height`
  attribute pair plus `sizes`. Every `<img>` gets explicit `width`/`height` to stop the
  reflow.
- Text block: title at 15px/600 clamped to **two lines** (`-webkit-line-clamp:2`), not one —
  the current single-line ellipsis produces "The Dungeon Anarchist's Coo…" (Phase 0), which
  is worse than a wrapped second line. Author 13px. Provenance line 12px — the current
  0.68rem badge type is below the floor.
- Verdict stack: two 44×44 buttons, right edge, in the thumb column. Not a swipe gesture —
  swipe is undiscoverable and this surface has no onboarding.

### Interaction model — the triage loop

The target is **one tap per decision, zero taps to skip, and no scroll loss ever**.

| Gesture | Result |
|---|---|
| Tap `+` | Verdict `want`. Row tints, control becomes filled. **No navigation.** |
| Tap `×` | Verdict `not`. Row dims to 40% opacity. **No navigation.** |
| Tap `+` or `×` again | Clears the verdict back to neutral. Same button, toggles. |
| Tap the text/cover area | Opens the detail sheet. Still no navigation — sheet over list. |
| Tap `Hide decided` | Collapses every decided row out of the list, count shown. |

The verdict is optimistic: local state flips immediately, the POST goes out fire-and-forget,
and a failure reverts the control and shows an inline retry on that row only — the pattern
`RecommendationFinder.tsx:71-82` already establishes, and which should be kept.

Crucially, **`+` does not trigger a search**. The current all-or-nothing coupling of
"interested" to "search AudiobookBay now" is what makes the loop non-resumable (finding 4).
Searching is a deliberate act inside the sheet. Triage and acquisition become separate
passes, which is what "in a spare two minutes" requires.

**Detail sheet** (bottom sheet, 88vh max, drag handle, the pattern `preview.css:56` already
implements for `.v2-sheet`):

```
────── drag handle ──────
[144px cover]  Title (full, wrapped)
               Author
               Audible #3 · AudiobooksNow #1 · Apple Books #6
               ✓ In your library — added 12 Mar

Description (from Apple, lazy)…

[ Want it ]  [ Maybe later ]  [ Not for me ]     ← 48px, full width row
[ Search AudiobookBay → ]                        ← secondary, navigates
```

`Maybe later` is the third verdict and lives only here — three states do not fit the row
without shrinking targets below 44px, and "later" is a considered decision, not a swipe-by
one. Dismissing the sheet returns to the exact scroll offset, because the sheet never
unmounted the list.

**Search navigation, fixed.** When `Search AudiobookBay →` is tapped, the route changes to
`/scout/search?q=…` (that route already reads `?q` on mount —
`AudiobookSearch.tsx:17`, `:75-80`), and the list route stores its scroll offset. Returning
restores it. This replaces the global `trigger-audiobook-search` CustomEvent
(`BestsellerLists.tsx:206-212`, `AudiobookSearch.tsx:57-73`) and the `scrollIntoView`
entirely — the coupling becomes a URL, which is restorable, shareable and back-button-safe.
`AudiobookSearch` should stop being rendered on `/scout/trends` at all
(`ScoutPage.tsx:17`); it is a different job.

**Session summary.** When ≥1 verdict is recorded, a capsule appears above the bottom nav —
same slot and styling as the existing `.v2-job-capsule` (`preview.css:56`, `bottom:78px`):
`6 to get · 11 skipped → Review`. Tapping it filters the list to `want`. This is what turns
two minutes of thumbing into something the user can act on later, and it is the single
element that makes the loop feel like it produced anything.

### Every state

**List**
1. *Loading, first ever* — 8 skeleton rows at 96px with the cover block shimmering. Never
   the bare `Loading bestsellers…` text (`BestsellerLists.tsx:426-432`), which collapses the
   page to one line and loses scroll anchoring.
2. *Loading, cached* — render cached rows immediately, header shows `Updating…` next to the
   timestamp. Requires react-query (finding 13).
3. *Loaded* — as drawn.
4. *One source failed* — an inline strip above the tiers:
   `Audible didn't respond — showing 23 of about 43. Retry`. Requires backend gap **G3**;
   without it this state is unreachable and finding 6 stands.
5. *Source empty but healthy* — chip renders with count, tab shows
   `This chart is currently empty.`
6. *Source not configured* — chip is **not rendered**. The reason belongs in Settings, not
   as a dead 0-count chip. The existing NYT copy (`BestsellerLists.tsx:506-508`) moves to
   an empty `All` state footnote: `NYT charts are off — add a Books API key in Settings.`
7. *All sources failed* — full-panel error with `Retry`, plus the last cached list beneath
   it labelled `Last loaded 3h ago` if one exists.
8. *Everything decided / all filtered out* — `All 43 triaged. 6 to get. Show all again`.
9. *Offline* — cached list, header reads `Offline — last updated 2h ago`, verdict buttons
   stay enabled and queue (see below).

**Per row**
10. *Neutral* — default.
11. *Want* — `+` filled, left edge accent, row background lifted.
12. *Not* — 40% opacity, `×` filled. Still tappable to undo.
13. *Later* — a small `Later` pill in the provenance line; row otherwise neutral.
14. *Verdict in flight* — control shows its target state immediately; no spinner.
15. *Verdict failed* — control reverts, a 12px `Couldn't save · Retry` replaces the
    provenance line for that row only.
16. *Owned* — `✓ In your library` on the provenance line, `+` replaced by a disabled
    `In library` chip. **Not observable locally**; requires **G1**.
17. *Queued / downloading* — `↓ Downloading` on the provenance line if the title matches an
    active acquisition. **Not observable locally** (qBittorrent unreachable — Phase 0);
    depends on `/api/librarian/downloads/pipeline` (`librarian/index.ts:768-802`) exposing a
    matchable title key. Ship as **phase 2**; do not block the verdict work on it.
18. *No cover* — the existing rank-numeral placeholder (`BestsellerLists.tsx:362-369`) is
    fine; scale to 72px.
19. *Cover 404s* — `onError` falls back to the same placeholder. Not currently handled.
20. *Very long title* — two-line clamp, full text in the sheet.

**Sheet**
21. *Description supplied* — render immediately.
22. *Description loading* — three shimmer lines. Never the current mid-screen
    `pointer-events:none` floating panel (finding 5).
23. *Description unavailable* — `No description available.` (existing copy,
    `BestsellerLists.tsx:62`).
24. *Description fetch failed* — `Couldn't load the description. Retry`.

**Offline queue.** Verdicts recorded offline persist to `localStorage` keyed by
`externalKey` and flush on reconnect. This matters more than it sounds: "away from the
desk, in a spare two minutes" is frequently a spare two minutes with one bar of signal.

### Data required per card

| Field | Available today? | Where |
|---|---|---|
| Title | Yes | `bestsellers.ts:11-17` |
| Author | Yes | same |
| Cover URL | Yes, 500×500 into 52px | same; Phase 0 |
| Source + rank per chart | Yes, computed | `BestsellerLists.tsx:112-147` |
| Description | Partial — Audible only, else a client-side Apple fetch | `bestsellers.ts:50-52`, `:96`, `:132`; `BestsellerLists.tsx:248-251` |
| **Stable item key** | **No** — cards are keyed `source:title:author` | `BestsellerLists.tsx:64-65` → **G4** |
| **Owned / not owned** | **No** on this route; computed in recommendations only | `recommendations.ts:354-367` → **G1** |
| **Existing verdict** | **No** on this route; endpoint exists | `feedback.ts:86-93` → **G5** |
| **Fetched-at, per source** | **No** | `librarian/index.ts:823-839` → **G2** |
| **Source health** | **No** — failures return `[]` | `bestsellers.ts:60-63` etc. → **G3** |
| Narrator | No — discardable at the Audible scrape | `bestsellers.ts:43-57` → **G6** |
| Runtime | No — same | same → **G6** |
| Series + position | No | — |
| Price / availability | No | — |
| Seeders on the eventual torrent | No — hardcoded `0` | `audiobookbay.ts:374-375` |

### Backend gaps, in build order

**G1 — batch ownership check.** `POST /api/library/owned` taking
`[{title, author}]` (cap 100) and returning `[{key, bookId | null, addedAt | null}]`, where
`key` is minted by `externalBookKey` and the match reuses the predicate at
`recommendations.ts:363-365` verbatim. The whole-library load it needs
(`input.db.getAllBooks()`, `:354`) is already performed per recommendation call, so the
cost profile is known. Do **not** build this on `/books?search=` — the raw `LIKE`
(`db.ts:1739-1741`) will not match punctuation variants. This unblocks card states 16 and
the honest "you already own this" the recommendations panel is currently swallowing
(finding 3).

**G2 — freshness in the bestsellers payload.** Add `fetchedAt` per source and a top-level
`cachedUntil` to the `/bestsellers` response (`librarian/index.ts:823-839`), plus each
chart's canonical URL. The cache timestamp already exists in scope as
`bestsellersCacheTime` (`:752`) — this is a response-shape change, not new work. Add
`?refresh=1` to bust the 3-hour cache for the manual refresh control.

**G3 — per-source status.** Change each fetcher to return
`{ books, status: 'ok' | 'failed' | 'not-configured', error? }` rather than swallowing to
`[]` (`bestsellers.ts:60-63`, `:101-104`, `:134-137`, `:141`, `:166-169`), and do not cache
a failed source for the full 3 hours — cache failures for minutes, successes for hours. This
is what makes list state 4 possible and stops a broken scraper from masquerading as an empty
chart for three hours (finding 6).

**G4 — stable item key on the wire.** Have the backend mint each item's
`externalBookKey(title, author)` and include it as `key` on `BestsellerBook`. Today the
frontend's `bookKey` is `source:title:author` (`BestsellerLists.tsx:64-65`), which is not
stable across sources, across chart refreshes, or against the key space
`rec_feedback.external_key` uses. Every verdict must be keyed by this. Guard the mint —
`externalBookKey` **throws** on any title with no ASCII alphanumerics, non-Latin scripts
included, and the module doc is explicit that callers must skip per-item rather than let one
bad anchor abort the batch (`externalKey.ts` module docblock). Fixing this also fixes
finding 2 at the root.

**G5 — verdict read-back, keyed.** `GET /api/feedback` exists and returns `externalKey`
(`feedback.ts:86-93`), but the client would have to pull up to 1000 rows and index them.
Add `GET /api/feedback/by-key?keys=a,b,c` returning `{key: verdict}`, or accept the
client-side index as a phase-1 shortcut — either way the round trip is already possible
today and this is an optimization, not a blocker.

**G6 — narrator and runtime from the Audible scrape.** Two selectors on a node the scraper
already has (`bestsellers.ts:43-57`), and two optional fields on `BestsellerBook`. Optional
because only one of three sources can supply them — the row must render correctly when they
are absent, which is the majority case.

**G7 — a third verdict.** `verdict` is `z.enum(['accepted','rejected'])`
(`feedback.ts:21`, `:30`) and the comment there is right that derived verdicts must not be
client-forgeable. `deferred` is an explicit human act, not a derived one, so it belongs in
the explicit set — but it must be weighted differently in `buildTasteProfile`
(`feedback.ts:126-133`) or "maybe later" will read as a weak endorsement. If that weighting
question is not settled, ship phases 1–2 with two verdicts and keep `Maybe later` out of the
sheet rather than mapping it onto `accepted`.

### Build order

1. **G4 + verdict controls + G5 read-back.** The loop becomes real and resumable. Nothing
   here needs ABS, so it is fully testable on this machine today.
2. **Row geometry, tier headers, sheet, `?q=` navigation, scroll restoration.** Removes the
   context loss and the accidental Apple fetches.
3. **G2 + G3.** The surface starts telling the truth about itself.
4. **G1.** Ownership markers — the payoff arrives only when ABS is connected, so it sequences
   last despite being the highest-value single affordance in the abstract.
5. **G6, G7, queued-state.**

---

## For other reviewers

- **Visual craft / IA.** `AudiobookSearch` result cards are inline-styled
  `rgba(255,255,255,0.6)` with `var(--text-primary)` (`AudiobookSearch.tsx:169-177`) inside
  the dark v2 shell; the `.v2-legacy-surface` override block only recolors `.glass-panel`,
  `.glass-input`, `.glass-button` (`preview.css:39`), so results render as a light island
  mid-flow.
- **Visual craft.** The entire legacy surface is held together by an `!important` wall in a
  minified single-line stylesheet (`preview.css:39`, `:56`) — including
  `.v2-legacy-surface form{grid-template-columns:1fr!important}`, which is the only reason
  the search form stacks on mobile at all. Any markup change to `AudiobookSearch` must be
  paired with an edit to that block.
- **Accessibility.** `aria-controls={DESCRIPTION_OVERLAY_ID}` on the info button
  (`BestsellerLists.tsx:403`) references an element that does not exist until the overlay
  opens. Roving tabindex on the chart tabs is implemented correctly
  (`BestsellerLists.tsx:291-303`, `:484`) — credit where due.
- **Accessibility.** The transient description overlay is `pointer-events:none` and
  dismissible only by blur (`BestsellerLists.css:269`), yet it is reachable by keyboard focus
  (`BestsellerLists.tsx:328-336`) — a screen-reader user gets an `aria-describedby` target
  they cannot interact with.
- **Performance.** ~1008 KB of covers for one list (Phase 0), no `width`/`height` on any
  `<img>` (`BestsellerLists.tsx:355-361`), 43 non-virtualized rows, and a full refetch on
  every route visit (`BestsellerLists.tsx:160-193`).
- **Performance / privacy.** Per-card `https://itunes.apple.com/search` calls issued from the
  client with title and author in the query string (`BestsellerLists.tsx:248-251`).
- **Reliability.** `GET /books/titles` runs `queryBooks({ limit: 1000000 })`
  (`books.ts:55-63`).
- **IA.** The mobile FAB — the best thumb position in the app — is `New task`
  (`PreviewApp.tsx:99`) on every route including the priority acquisition surface.
- **Engine.** Findings 2 and 3 are UI-visible symptoms of engine-side contract issues
  (`recommendations.ts:382` vs `RecommendationFinder.tsx:142`; the silent owned-drop at
  `recommendations.ts:365`) and are worth a second opinion from whoever owns the
  recommendation pipeline.

---

## Open questions

1. **Is a bestseller verdict the same object as a recommendation verdict?** Writing
   bestseller `+`/`×` into `rec_feedback` (`db.ts:1095-1105`) means chart-position browsing
   shapes the taste profile alongside considered recommendation feedback. That may be
   desirable or may be noise. Settled by: a decision on whether `source` should be
   `'explicit'` (as `feedback.ts:78` hardcodes) or a new `'browse'` value that
   `buildTasteProfile` down-weights.
2. **What does `Maybe later` mean to the engine?** See **G7**. Unresolved; do not guess.
3. **Can `want` become an acquisition intent rather than just a signal?** The natural next
   step is `want` → auto-search → present the best torrent. That crosses from "recording a
   preference" into "spending bandwidth", and the review has no evidence about how much
   automation the user wants there. Settled by asking.
4. **Does Audible's `.productListItem` still carry narrator and runtime?** Asserted from the
   scrape's position in the DOM (`bestsellers.ts:43-57`), not verified against a live fetch.
   Settled by one `curl` of `https://www.audible.com/charts/best` and a selector check
   before **G6** is scoped.
5. **How many bestseller titles are actually already owned?** The whole value of **G1**
   depends on this being a meaningful fraction. **Not observable locally** — no ABS
   connection, `totalBooks: 0` (Phase 0). Settled by running `/bestsellers` against a
   connected instance and applying the `recommendations.ts:363-365` predicate offline.
6. **Are NYT charts ever going to be configured?** If not, `BESTSELLER_SOURCES`
   (`BestsellerLists.tsx:31-42`) carries two entries that only ever produce dead chips, and
   the code path at `bestsellers.ts:140-141` is permanently dark. Settled by a product
   decision, not by code.
