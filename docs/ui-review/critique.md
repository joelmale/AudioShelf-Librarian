# Critique of the UI/UX review

Reviewer: review critic. Read-only pass over `.claude/ui-review/context.md`,
`docs/ui-review/phase0/index.md` and all eight reports. Every claim I mark
**VERIFIED** I re-derived from source myself in this session; every claim I mark
**UNVERIFIED** I could not settle and it must not anchor a recommendation.

---

## Verdict on the review

**Better than it needed to be, and it converged.** Eight reviewers working
independently landed on the same defect — the card tap throws the reader ~2700px up
a 5355px page with no history entry — and four of them ranked it first. That is not
groupthink; three of them measured it different ways and got compatible answers.
The review has earned the right to be believed on that one.

Two reports did outstanding work and the lead should weight them accordingly:

- **`platform-capabilities.md`** is the best report in the set, and it is best
  because of what it *refused*. Six Skips with reasons — virtualization at 43 rows,
  View Transitions with nothing to transition, React 19, service workers on a
  no-TLS compose stack, `srcset` on a fixed 52px slot, `content-visibility` — each
  killed on evidence rather than taste. It also corrected the brief's own Phase 0
  (the 153-request figure, the `launch.json` non-fix). A reviewer who tells you the
  brief was wrong is worth more than one who agrees with it.
- **`accessibility.md`** is the most disciplined. It separated "confirmed from
  source" from "needs a live screen reader" in a dedicated section, declined to
  report 1.4.4 as a violation when the arithmetic said it passed, and credited the
  four things the codebase gets right. Its §5 decomposition of Phase 0's 75
  sub-12px nodes is correct and `visual-craft.md`'s competing decomposition is not
  (kill list K4).

`discovery-acquisition.md` is the most useful report and also the one with the most
load-bearing error. Its browse-model reasoning is the strongest piece of design
argument in the review — it rejects three alternatives *on the data* rather than on
preference, which is rare. But its headline claim about where feedback data goes is
false, and I break it below.

**What the review as a whole missed:**

1. **Nobody traced what happens to a verdict after it is written.** Seven reports
   recommend intent capture. One traced the endpoint. None traced the reader.
   `buildTasteProfile` discards every external-key row (`tasteProfile.ts:213`). The
   engine cannot consume the data the review's headline recommendation produces.
2. **Nobody noticed that Phase 0's one dismissed contrast failure is real.** Phase 0
   wrote off the 1.44:1 node as "expected for a disabled control." The control is
   never disabled. `accessibility.md` accepted the dismissal and explicitly declined
   to file it. There is a live WCAG 1.4.3 failure on the priority route and eight
   reviewers walked past it.
3. **Nobody costed the cover-weight fix honestly.** Two reports call it the highest-
   leverage item in the entire review. Its stated magnitude rests on two unverified
   third-party URL-rewrite hypotheses, and the one source whose lever *is* proven
   contributed zero measured bytes.
4. **Nobody asked whether `AudiobookSearch` should be on `/scout/trends` at all.**
   Six separate findings across five reports — the scroll jump, the light-theme
   island, the unlabelled input, the h1→h3 heading skip, the duplicate "Top
   Bestsellers", the inline `1fr auto auto` grid — are all downstream of one JSX
   fragment at `ScoutPage.tsx:17`. Deleting it resolves all six. Only
   `discovery-acquisition.md` proposed it, buried in a sub-clause on line 481.

---

## Verification of the load-bearing claims

### 1. Safe-area insets — both reviewers are right, in sequence. `mobile-interaction.md` is right *today*.

**VERIFIED.** `apps/frontend/index.html:5` is
`<meta name="viewport" content="width=device-width, initial-scale=1.0" />` — no
`viewport-fit=cover`. Per spec the `env(safe-area-inset-*)` values resolve to `0`
without it, and the browser letterboxes the page inside the safe area itself. The
four inset call sites in `preview.css` are **inert on every real device today**.
`mobile-interaction.md` finding 11 is correct.

**VERIFIED.** `preview.css:9` is
`#ui-v2-root *,#ui-v2-root *::before,#ui-v2-root *::after{box-sizing:border-box}`,
and `preview.css:56` sets
`.v2-bottom-nav{height:72px;padding:7px 4px calc(7px + env(safe-area-inset-bottom))}`.
With a 34px inset the content band collapses from 58px to 24px, against ~32px of
icon + gap + 9px label. `visual-craft.md` F4's arithmetic is correct.

**Adjudication: they compose into a trap, not a contradiction.** F4 is not the
operative problem today; it becomes the operative problem the moment F11's
"missing" `viewport-fit=cover` is added. **Adding `viewport-fit=cover` on its own is
a regression, not a fix.** The two must ship in the same commit: `viewport-fit=cover`
+ `height:72px` → `min-height:72px`, and the three inset-blind siblings
(`.v2-app{padding-bottom:92px}`, `.v2-mobile-fab{bottom:38px}`,
`.v2-job-capsule{bottom:78px}`) rebased on one `--nav-h` token. Anyone who ships half
of this makes a notched phone worse than it is now.

### 2. The FAB overlap — real, and here is the single correct description.

**VERIFIED** by independent derivation, and `mobile-interaction.md`'s live
measurement (`156.8–233.2` for the Curate cell at 390px) matches my arithmetic to the
decimal.

At 390px: `.v2-bottom-nav` has `padding:7px 4px …`, so its content box is 382px wide
across 5 equal tracks of 76.4px. Track 3 (**Curate** — the bottom-nav order in
`PreviewApp.tsx` is Desk, Scout & Acquire, Curate, Activity, Settings-button) spans
x 156.8–233.2. `a:nth-child(3){padding-right:28px}` shrinks its content region to
156.8–205.2, so its icon and label centre at **x = 181**.

`.v2-mobile-fab` is `left:50%;translateX(-50%);width:58px;height:58px;bottom:38px;
border-radius:50%;z-index:55` — a circle of radius 29 centred at (x 195, y 67 above
the viewport bottom), spanning x 166–224 and y 38–96.

The nav's link band runs y 7–65 above the bottom (72 − 7 top − 7 bottom, inset = 0).
So the FAB overlaps Curate's *content region* across roughly **39 × 27 px**, and the
distance from the FAB's centre to the Curate icon's centre (~181, ~47) is **~24px —
inside the 29px radius**. `z-index:55` beats the nav's `50`, and hit testing honours
`border-radius`, so the FAB both hides and **intercepts taps on** the Curate icon.

**Root cause:** the `nth-child(3)/nth-child(4)` padding split cuts the notch at the
3|4 track boundary — **60% of the nav width, x = 233.2** — while the FAB is centred at
**50%, x = 195**. They are 38px apart. That pairing is only self-consistent for a
**six**-track nav.

Scoring the three accounts: `flow-architecture.md` HIGH 5 has the correct root cause
*and* the correct vertical band (27px) — it is the accurate one. `visual-craft.md` F3
has the correct icon centre (181) but calls the split "the standard trick for parting
a **four**-item nav" (wrong — a four-item nav notches between children 2 and 3) and
computes the overlap against the full 72px nav height (34px) instead of the 58px link
band. `mobile-interaction.md` #3 supplies the only live numbers and the only proof
that the geometry is proportional, not width-dependent — but its "the 3rd-of-5 column
centers at 60%" is muddled (the 3rd of 5 columns centres at 50%; the *boundary* is at
60%).

Use flow-architecture's diagnosis, mobile-interaction's measurements, and
visual-craft's icon-centre number. Ignore the "four-item nav" gloss.

### 3. Missing fonts — VERIFIED, and undercounted. Six typefaces, not four.

I ran this independently. `apps/frontend/index.html` is 11 lines with **no `<link>`
of any kind**. There is **no `@font-face` anywhere in `apps/frontend`**, no
`fonts.googleapis`/`gstatic` reference, no `@fontsource*` dependency, and no `.woff`
asset. Every named family resolves to a fallback:

| Family | Declared at | Resolves to |
|---|---|---|
| `Inter` | `preview.css:6`, `theme.css:30`, `curator/styles.css:32` | system UI stack, via the later entries |
| `Outfit` | `preview.css:23,24,30,42,45,62` | **generic `sans-serif`** — Arial on Windows |
| `JetBrains Mono` | `preview.css:24` | generic `monospace` |
| `Crimson Pro` | `curator/styles.css:51`, `:166` | generic `serif` |
| `Fira Code` | `curator/styles.css:314` | `'Courier New', monospace` |

`visual-craft.md` F1 is correct and, if anything, understated — it missed `Fira Code`
at `curator/styles.css:314`. The consequence it names is real: every `h1`/`h2` inside
`#ui-v2-root` falls past both `Outfit` and `Inter` to **generic `sans-serif`**, which
is *not* the same font body text resolves to. Headings render in Arial over body text
in Segoe UI Variable, on Windows, today.

**Does it invalidate other typography findings?** Partly, and the report says so
itself: computed style reports the *declared* weight, so Phase 0's `550 ×47 · 650 ×48
· 750 ×44` is a record of what the CSS asked for, not what rendered. On any platform
whose generic `sans-serif` is a static family those collapse to 500/700/700. So:

- Phase 0's **font-weight census is unreliable** and no recommendation may be anchored
  on "six weights are rendering." `visual-craft.md`'s 3-weight proposal is still
  right, but for the reason it gives second (four weights on one card is noise).
- Phase 0's **font-size census is reliable** — sizes are declared in px/rem and are
  family-independent. The 75-nodes-below-12px finding stands.
- Phase 0's **contrast census is reliable** — colour does not depend on the family.

### 4. `POST /api/feedback` as the cheap win — the endpoint is real; the claim about what reads it is FALSE.

**VERIFIED, in full:**

- `apps/backend/src/modules/curator/api/routes/feedback.ts` — `feedbackSchema`
  accepts `{bookId?, externalKey?, queryText, verdict: 'accepted'|'rejected'}` with
  `.refine(Boolean(bookId) !== Boolean(externalKey))`. Either satisfies it. Non-owned
  works are a first-class case. **Confirmed.**
- Mounted at `/api` (`api/server.ts:72`, `:112`), so the URL is `/api/feedback`.
  **Confirmed.**
- The write is one SQLite insert (`db.ts:3439`), no ABS, no LLM. It works on this
  unconfigured machine today. **Confirmed.**
- `GET /api/feedback` returns the rows with `externalKey` intact. **Confirmed.**
- The only caller is `RecommendationFinder.tsx:71-82`, on a route that needs ABS.
  **Confirmed.**

**Now the part that is wrong.** `discovery-acquisition.md` finding 2 states the data
"the taste profile reads (`feedback.ts:126-133` feeds `buildTasteProfile`)". It does
not. `apps/backend/src/modules/curator/core/feedback/tasteProfile.ts:213`:

```ts
for (const row of input.feedback) {
  if (row.bookId === null || seen.has(row.bookId)) continue;
```

**Every feedback row with a null `bookId` — i.e. every external-key verdict ever
recorded — is skipped outright.** It has no embedding vector, so it cannot be placed
in embedding space at all. The taste profile has never seen one of them and cannot, by
construction.

Three consequences the lead has to absorb:

1. The headline recommendation is still worth shipping, but **its value is entirely
   session/UX memory, not engine learning.** "Record a verdict, read it back on next
   load, dim the row, hide the decided ones" — that is real and it is what the
   two-minute triage job needs. "It feeds the taste profile" is not available and must
   be struck from the pitch.
2. `discovery-acquisition.md` **open question 1** ("does chart browsing pollute the
   taste profile?") is **moot**. It cannot. Do not spend a product decision on it.
3. **G7** (a third `deferred` verdict, gated on "how does `buildTasteProfile` weight
   it?") is also moot for external keys. If `Maybe later` is wanted, the weighting
   objection does not apply. Un-gate it.

**And it is worse than a two-key problem — there are three key spaces.**

| Writer | Format | Example |
|---|---|---|
| `recommendations.ts:382` (impressions) | `${normalized}\|${normalized}`, **no prefix** | `dungeon crawler carl\|matt dinniman` |
| `RecommendationFinder.tsx:142` (feedback) | `${raw}\|${raw}` | `Dungeon Crawler Carl (Unabridged)\|Matt Dinniman` |
| `externalKey.ts` `externalBookKey()` (book_edges) | `ext:${normalized}\|${normalized}` | `ext:dungeon crawler carl\|matt dinniman` |

`recommendations.ts:382` hand-rolls the format and omits the `ext:` prefix, in direct
violation of `externalKey.ts`'s own module docblock — *"This module is the ONLY place
an external key may be minted."* `discovery-acquisition.md` finding 2 caught the
UI↔impressions mismatch and is **VERIFIED** on that. It missed that the impressions
writer is itself off-contract.

**This breaks G4 as specified.** G4 says "have the backend mint each item's
`externalBookKey(title, author)` and include it as `key`." That mints `ext:`-prefixed
keys, which will **not** join to `rec_impressions` either. G4 must either (a) fix
`recommendations.ts:382` to call `externalBookKey` in the same change, or (b) be
explicit that it is creating a fourth space. As written it creates the fourth space.
**G4 is amended, not killed.**

Mitigating: **nothing joins these tables today.** `grep rec_impressions` across the
backend returns only the schema, the index, the insert and a by-slate select. So the
bug is real and is accumulating unjoinable data, but it has no live user-visible
symptom. It is a data-integrity finding, not a UX one, and it should not delay the
verdict-capture work — it should be a one-line fix landed alongside it.

### 5. The impression-key join bug — VERIFIED (see above). Severity re-rated: latent, not live.

Verified at `recommendations.ts:382` and `RecommendationFinder.tsx:142`;
`normalizeForMatching` behaviour verified at `externalKey.ts` (lowercase, strip
`(Un)abridged`, NFKD + Latin fold, collapse `[^a-z0-9]+` to a single space). The keys
provably never match. The second mismatch is also verified: `api.ts:117-118` documents
`slateId` as *"send it back with feedback"* and neither `sendFeedback` (`api.ts:617`)
nor `feedbackSchema` accepts it.

Re-rating: `discovery-acquisition.md` presents this as "every thumbs-up lands in a key
space nothing else writes to," which is true, but the implied harm ("the taste profile
can't correlate") is not the harm — the taste profile never sees these rows at all.
The actual harm is that **offline slate evaluation is impossible**: you cannot ask
"did the ranker put the accepted item first?" for any external candidate, ever, which
is precisely the question `recommendations.ts:377-388`'s own comment says the
impression rows exist to answer.

### 6. `loading="lazy"` defers nothing — the *observation* is confirmed; the *mechanism* is UNVERIFIED, and that is fine.

Phase 0 recorded the attribute as present in markup — `BestsellerLists.tsx:355-361`
has `loading="lazy"`, `alt=""`, no `width`/`height`, no `onError`. **Confirmed by
reading.** That is a markup claim.

`performance.md` measured runtime behaviour on a production build, twice, cold: all 43
requests fired inside a 12ms window (81–93ms) across a 5474px document at a 375×812
viewport. These are not in conflict — one is markup, one is behaviour.

The mechanism is **UNVERIFIED**, and `performance.md` says so, offers two candidates,
and — correctly — refuses to spend engineering on it until it is re-tested under real
throttling. I would add a third candidate it did not name: a headless/automation
Chrome with no `navigator.connection` signal may fall back to its most permissive
lazy-load lookahead distance, which would make the whole result a harness artifact.
That is exactly why the report's own sequencing (re-test before coding, and only
*after* the cover-size fix ships, because today the payload arrives either way) is
right. **Do not act on this. Do not delete it. It is a test, not a task.**

---

## Kill list

Cutting is not the same as saying the observation was wrong; several of these are
correct observations attached to unearned recommendations.

**K1 — The swipe-gesture triage deck (`mobile-interaction.md` rec #3).**
Trend-chasing. `discovery-acquisition.md` rejected the swipe deck explicitly and on
the data: "swipe is undiscoverable and this surface has no onboarding," and a deck
forces a decision on all 43 items when the honest answer for most is *skip*.
`mobile-interaction.md`'s own finding #7 supplies the counter-argument to its own
recommendation — there is zero gesture vocabulary in the app (VERIFIED: a repo-wide
grep for `onTouchStart|touchstart|pointerdown|onPointerDown` in `apps/frontend/src`
returns nothing), so a swipe needs an onboarding hint, an edge dead-zone to avoid
stealing the OS back-swipe, and a threshold heuristic. That is a week of work with a
discoverability problem baked in, against two 44×44 buttons that need no teaching.
**Cut the swipe. Keep the sub-recommendation to wire the existing `.v2-sheet-handle`
to a real drag-to-dismiss** — that one is cheap and the handle currently promises a
gesture that does not exist.

**K2 — The 2-column poster grid for `/scout/trends` (`visual-craft.md` F2, fix step 2).**
Head-on collision with `discovery-acquisition.md`'s row-list argument, adjudicated
below in favour of the row. Two facts decide it and neither reviewer used them: a
167px tile with a two-line title and author is **~115px of vertical per item versus
the row's 90–96px**, so the grid is *less* dense, not more; and `performance.md`
observed **26 of 43 covers never completing** in one session (cause unattributed, but
there is no `onError` path either way). A grid whose only content is the cover is
unusable when covers fail; a row list still reads. **Cut the grid. Keep F2's core
complaint** — 52×52 is too small — and land it as a 72px cover inside the row.

**K3 — "Serve a 2:3 source into a 2:3 slot" (`platform-capabilities.md` #1,
corollary 2).** Built on a Phase 0 framing error ("Covers are **square**, not book
aspect ratio", written as a defect). `discovery-acquisition.md` corrected it:
audiobook art *is* square by convention and `object-fit:cover` on a 1:1 box crops
nothing. There is no 2:3 source to serve. `visual-craft.md` F2 independently reached
the same conclusion and went further — the 2:3 boxes at `preview.css:67,68` and
`DeskPage.tsx:327` are the ones cropping 33% off square art. **Cut the corollary.**

**K4 — `visual-craft.md` F5's attribution of the five 9px nodes.** F5 credits them to
"recommendation tags/links, folder-pattern chrome." **VERIFIED false.**
`preview.css:56` contains
`.v2-bottom-nav a span,.v2-bottom-nav button span{font-size:9px;line-height:1.05;text-align:center;max-width:64px}`.
They are the five bottom-nav labels — on **every mobile screen in the app**, not just
Scout. `accessibility.md` §5 got this right and called it "a real low-vision usability
problem on the priority surface"; `content-editorial.md` #6 got it right and built a
finding on it. F5's proposed fix (raise the badge to a 12px floor) does not touch the
nav at all. **Cut F5's decomposition table, keep F5's badge fix, adopt accessibility's
decomposition as canonical.**

**K5 — `visual-craft.md` F11's second half: "the search form's inline grid is
unhandled on mobile."** **VERIFIED false.** `preview.css:56` contains
`.v2-legacy-surface form{grid-template-columns:1fr!important}` and
`.v2-legacy-surface form select{width:100%!important}`. The form stacks correctly at
≤800px. Both `flow-architecture.md` and `discovery-acquisition.md` cite this rule
correctly, and `discovery-acquisition.md` flagged it *to* visual-craft in its "For
other reviewers" section — and it was still missed. **Cut the claim.** F11's first
half (the tab strip has no scroll affordance) survives, amended by
`mobile-interaction.md` #8 — the strip *scrolls*, so it is a discoverability defect,
not lost content.

**K6 — The full token-system rollout (`visual-craft.md` "Proposed token set").**
Not wrong; unearned as a unit of work. Six type sizes, three weights, seven spacings,
four radii, three elevations and four layout tokens, applied across a 65KB stylesheet
whose mobile layout is one 4,020-character line, is a multi-week refactor with **no
user-visible win on its own**. The three pieces that pay for themselves stand on their
own merits and are sequenced below: define the seven phantom variables (F7), scope
`body{font-size:14px}` out of the global (F6), and set a 12px floor on the badge plus
a legibility floor on the nav label. **Cut the rest until something needs it.**

**K7 — PWA manifest (`platform-capabilities.md` #9, cheap half) and SSE for
`POST /recommendations` (#10).** Both honestly gated by their own author and both
unschedulable: #9 is blocked on an unanswered question (is the app reachable over
HTTPS?) and #10 is on a route that cannot be validated without ABS. Neither is
trend-chasing — the SSE case is unusually well argued because the `SseChannel`, the
Zod event union and a working client consumer all already exist in-repo — but neither
can be sequenced. **Label speculative, do not schedule.**

**K8 — "Search stops being a peer tab" (`flow-architecture.md` HIGH 6 / After-IA
item 1).** This is the one place a mobile-first recommendation damages the desk.
`/scout/search` is a legitimate desktop curation entry point: the topbar command
button routes to it (`PreviewApp.tsx:59`) and the New-task sheet's "Acquire" tile
routes to it (`PreviewApp.tsx:101-106`). Demoting it to "a step reached from a card"
breaks the deliberate *I know what I want, go get it* flow, which is a real job at the
desk. **Cut it. Keep the compatible half** — stop rendering `<AudiobookSearch/>`
*inside* `/scout/trends` (`ScoutPage.tsx:17`), which is `discovery-acquisition.md`'s
version and costs the desk nothing.

**K9 — Optimistic-mutation infrastructure ahead of the mutation
(`platform-capabilities.md` #11).** Already self-killed by its author, correctly.
Recorded here so it does not get re-proposed: `RecommendationFinder.tsx:73-85` already
implements apply-then-roll-back by hand, correctly. Copy those twelve lines into the
verdict control. Do not build a react-query `onMutate` layer for one call.

---

## Adjudication table

| # | Collision | Reviewers | Ruling | Reasoning |
|---|---|---|---|---|
| A1 | Safe-area: border-box squeeze vs. inert CSS | visual F4 / mobile #11 | **Both. Ship together.** | Insets are inert today (no `viewport-fit=cover`, VERIFIED). F4's squeeze is latent and activates the instant F11's fix lands. Shipping `viewport-fit=cover` alone is a regression. |
| A2 | Browse model: row list vs. poster grid | discovery / visual F2 | **Row list.** | Grid is *less* dense per item (~115px vs 90-96px), strips the only differentiating signal (source badges), leaves no room for 44x44 verdict controls, and fails hard when covers fail - which `performance.md` observed at 26/43. Keep visual's complaint that 52px is too small: 72px cover inside the row. |
| A3 | Cover aspect: 1:1 everywhere vs. leave the Desk | visual F2 / visual OQ7 | **1:1 for the two external-source surfaces; leave `DeskPage.tsx:327` alone.** | Bestsellers and recommendations are fed by Apple/Amazon/ABN, which serve square (Phase 0: 500x500, 300x300). Desk "Recently added" is fed by Audiobookshelf, whose art population is **not observable locally**. Change `preview.css:67,68`; defer the Desk until a populated library is seen. |
| A4 | The card rank `#N`: un-hide it / cut it / replace it | a11y F7 / content / discovery | **Replace with tier headers on "All charts"; label the real rank on single-source tabs.** | VERIFIED: `renderCard` is called without `appearances` on single-source tabs (`:451`, `:512`), so the same `#N` glyph means merged-array position on one tab and true chart rank on another. a11y F7's "un-hide the rank" would make a screen reader announce a number meaning two different things. discovery's tier headers (`On 3 charts`) state the sort key plainly and satisfy F7 by removing the ambiguity rather than exposing it. Content-editorial's "cut it" is right for the All tab, wrong for the source tabs. |
| A5 | Badges: raise to 12px / re-type per source / cut the ranks / expose to AT | visual F5 / a11y F7 / content #11 | **One change: rebuild the accessible name from contents, set 12px, expand ABN to AudiobooksNow, keep the ranks.** | These compose exactly. VERIFIED: no `.bestseller-card__badge--*` rule exists in any stylesheet, so the per-source modifier hook is dead markup; and the `title` attribute is the *only* expansion of "ABN", delivered by a tooltip that does not exist on touch. Content-editorial's "cut the ranks" loses the tie-breaker the sort actually uses - reject that half. |
| A6 | Card tap: keep the CustomEvent + fix scroll vs. route to `?q=` | mobile rec #1 / discovery / flow C1 | **Route to `/scout/search?q=...`.** | VERIFIED: `AudiobookSearch.tsx:75-80` already reads `?q` on mount. Routing gives a history entry (mobile #1's core complaint is that there is none), makes the state shareable, and lets the browser's own scroll restoration do the return trip. "Surface the result inline under the card" is more work, adds a second results renderer, and gives Back nothing to do. |
| A7 | Scroll restoration: `ScrollRestoration` API vs. cache first | platform #13 / discovery / flow | **Cache first (platform #13).** | VERIFIED reasoning: `BestsellerLists.tsx:150-193` is `useState` + bare `fetch`, so the list renders empty on remount and there is no document height to restore *into*. `ScrollRestoration` additionally requires migrating both route trees to `createBrowserRouter`. platform is the only report that noticed the dependency. |
| A8 | Nav item count: drop to four / delete the FAB / move the notch | visual F3 / flow H5 / mobile #4 | **Move Settings out of the bottom nav (flow H5).** | VERIFIED: the fifth slot is a `button aria-label="Open settings"`, and the identical trigger already lives in the topbar at `.v2-settings-trigger{margin-left:auto}` - *visible on mobile* (the mobile block hides `.v2-command`, `.v2-active-top`, `.v2-new-task`, but not the settings trigger). So the fifth slot is pure duplication. Four items + a genuine centre FAB is the only fix that resolves the geometry rather than nudging it. Zero desktop impact - the bottom nav is `display:none` above 800px. |
| A9 | Contrast: "2 of 230 nodes, both excusable" vs. a live failure | Phase 0 + a11y §5 / visual F10 | **visual F10. Phase 0 and a11y are wrong.** | See P1 below. The review's worst shared miss. |
| A10 | 9px text: five recommendation chips vs. five nav labels | visual F5 / a11y §5 / content #6 | **a11y and content. VERIFIED.** | `preview.css:56` contains `.v2-bottom-nav a span, .v2-bottom-nav button span{font-size:9px;line-height:1.05;text-align:center;max-width:64px}`. |
| A11 | Tab strip: "clipped" vs. "scrolls but undiscoverable" | Phase 0 + flow + visual F11 / mobile #8 | **mobile #8.** | It has `overflow-x:auto` and mobile measured `scrollWidth 665` vs `clientWidth 345` with the last two tabs reachable. Phase 0's word "clipped" was repeated by two reports that did not check. Downgrade from a reflow problem to a discoverability one - which a11y §5 also concluded independently. |
| A12 | Rail icon-only band 801-1279px: "tablet/small-laptop" vs. landscape phones | a11y F14 / mobile #4 | **Both, and the severity goes up.** | a11y F14 (all four rail links have an empty accessible name in that band, labels hidden with `display:none`) is filed as medium on the assumption the band is desks. mobile #4 proves the band is **every modern phone in landscape** - VERIFIED, the only shell breakpoint is `max-width:800px` and an iPhone 13 mini landscape is 812px. Same band, two reviewers, neither saw the other's half. Re-rate F14 as a priority-surface finding. |

---

## Phase 0 audit - claims reviewers built on that nobody verified

Two were already corrected downstream (the 153-request count, the `launch.json`
workaround). Here is the rest.

**P1 - "Only 2 of ~230 text nodes fall below 4.5:1 ... the disabled `Clear` button
(1.44:1, expected for a disabled control)." - WRONG, and it is a live WCAG failure.**

`AudiobookSearch.tsx:144-157`: the Clear button has **no `disabled` prop**. It is
never disabled. Its colour comes from an inline
`style={{background:'rgba(0,0,0,0.05)', color:'var(--text-primary)', boxShadow:'none'}}`,
and `--text-primary` is defined at `theme.css:16` as `#1a2a3a` - the *light* theme's
navy. Inline style beats the `.v2-legacy-surface` `!important` shim's class-based
rules, so navy renders on the dark shell permanently. The genuinely-disabled control
in that form is the **Search** button, which takes
`.glass-button:disabled{color:var(--text-secondary)}` = `#4a5a6a` = Phase 0's separate
`rgb(74,90,106) x1` node.

So: Phase 0 misattributed the 1.44:1 node, `accessibility.md` §5 accepted the
misattribution and explicitly declined to file it ("disabled controls are exempt from
1.4.3"), and `visual-craft.md` F10 diagnosed the cause correctly without connecting it
to the contrast number. **There is an always-on 1.4.3 Level AA failure on the priority
mobile route and the review concluded contrast was solved.** Fix: delete the inline
`color`/`background` at `AudiobookSearch.tsx:147`.

**P2 - "Covers are square, not book aspect ratio."** A correct observation with a
wrong implication, written as a defect, and one report built a recommendation on the
implication. Corrected in K3.

**P3 - "The center FAB overlaps card content and the lower chart chips at 390px."**
Half of this is trivially true and not a finding - a `position:fixed` FAB floats over
scrolling content by design. Two reports cited it as independent corroboration of the
*nav* overlap, which it is not. The nav overlap stands on its own arithmetic and on
mobile-interaction's measurements; it does not need this.

**P4 - "Font weights: 700 x74 / 650 x48 / 550 x47 / 750 x44 ..."** Unreliable, as F1
establishes: computed style reports declared weight. No recommendation may rest on
"six weights are rendering." Nobody did, but the number is quoted in three reports as
though it were observed.

**P5 - "39 image requests, ~1008 KB ... natural sizes 500x500 and 300x300."** The
bytes are real; the *attribution* is incomplete and the fix costed from it is
optimistic. Phase 0 recorded no 400x400 natural, but `bestsellers.ts` upsizes Apple to
exactly 400x400 - so either Apple's 25 cards did not load in Phase 0 (consistent with
`performance.md` measuring 0/7 Apple completions), or the census was partial. That
matters because:

- The **only verified size lever** is Apple's `.replace("100x100","400x400")` in
  `bestsellers.ts` - one token, certain.
- **Amazon** (`bestsellers.ts:47` scrapes `img.bc-image-inset-border[src]` verbatim)
  and **AudiobooksNow** (`:83` regex-matches `/jackets/large/`) have **UNVERIFIED**
  levers. Swapping `._SL500_.` to `._SL160_.`, and a `/jackets/small/` path segment,
  are both plausible hypotheses about third-party URL schemes. Neither was tested.
- Those two unverified sources are precisely the ones that produced the measured
  ~1008 KB.

So `platform-capabilities.md`'s "~3 backend lines, ~1008 KB to ~90 KB" and
`performance.md`'s "highest leverage item in this entire review" are **built on two
untested string rewrites**. The fix is still right and still cheap. Its *magnitude* is
UNVERIFIED and it must not anchor the sequencing. Two `curl`s settle it.

**P6 - "Tap targets: zero controls measured below 24x24."** Consistent with the CSS
and not contradicted. `mobile-interaction.md` #9's 0px gap between the two card
buttons is a real ergonomic complaint but not a 2.5.8 failure (spacing exceptions
apply only below 24px). Correctly not filed as a conformance issue by anyone.

**P7 - Document height 5355px (Phase 0) vs 5474px (`performance.md`).** Different
builds, different viewport widths. Immaterial; noted so nobody re-derives it.

**P8 - "Errors are all ABS-dependent 503s plus one 500 - not UI defects. Do not report
these as bugs."** Right about the network layer, and it caused one miss.
`content-editorial.md` #2 is the only report that noticed `DeskPage.tsx:338` renders
that 503 as the calm empty state "No recently added books found." **VERIFIED** - the
guard is `{(!recentlyAdded.data?.results || recentlyAdded.data.results.length === 0) && ...}`
and never reads `isError`. A backend error reviewers were told to ignore is being
rendered to the user as a fact about their library, on the landing route, refreshed
every 60s. Credit content-editorial for looking anyway.

---

## The cheap win

**Stop rendering `<AudiobookSearch/>` on `/scout/trends`, and make the card tap a
route change instead of a window event.**

Four small edits, two of them one-liners. All verified against source this session:

1. `ScoutPage.tsx:17` - the `trends` branch renders
   `<><AudiobookSearch/><div className="v2-section-divider">...</div><BestsellerLists/></>`.
   Reduce it to `<BestsellerLists/>`.
2. `BestsellerLists.tsx:206-212` - replace `window.dispatchEvent(new
   CustomEvent("trigger-audiobook-search", ...))` with a `useNavigate()` call to
   `/scout/search?q=<encoded buildBestsellerSearchQuery(book)>`. `useNavigate` is not
   yet imported in that file; the component is inside `BrowserRouter`, so it is
   available.
3. `AudiobookSearch.tsx:57-73` - delete the now-dead listener effect, including the
   `scrollIntoView({behavior:"smooth"})`. **VERIFIED: there is exactly one listener
   for that event in the app.** The `?q` reader at `:75-80` already exists and already
   runs the search on mount. (One caveat to check: that reader is guarded by an
   `autoSearchStarted` ref, so it fires once per mount - fine for this flow, since the
   component now mounts fresh on each arrival.)
4. `BestsellerLists.test.tsx:209-226` - update the assertion from "dispatches the
   event" to "navigates". This is the only reason it is not a 20-minute job.

**What that one change resolves, by report:**

| Finding | Report |
|---|---|
| CRITICAL 1 - decision step is a scroll jump with no history entry | flow-architecture |
| #1 - tapping a card erases scroll position, Back has nothing to undo | mobile-interaction (its top finding) |
| F2 - primary action scrolls away from focus, announces nothing, and overrides `prefers-reduced-motion` | accessibility |
| #4 - the one action destroys browse position irreversibly | discovery-acquisition |
| #5 - the primary mobile action scrolls the reader 5000px away | platform-capabilities |
| MEDIUM 9 / #12 - duplicate stacked "Top Bestsellers" heading | flow-architecture, content-editorial |
| F18 - h1 to **h3** to h2 heading-level skip on `/scout/trends` | accessibility |
| F5 - the unlabelled search input and unnamed `<select>` leave the trends route | accessibility |
| F10 / P1 - the navy `--text-primary` "Clear" button (the 1.44:1 node) leaves the trends route | visual-craft |
| #14 - "Search acquisition sources" euphemism sitting over "Search AudiobookBay" | content-editorial |
| Twenty inline styles and the `[style*="display: flex"]` substring selector leave the priority route | visual-craft F10 |

Eleven findings across six of the eight reports, from one afternoon. That is
embarrassing for the bigger proposals and it should be, because none of them can start
until the browse loop has a back button.

**The immediate follow-on, and it is a hard dependency:** react-query on
`BestsellerLists` (`platform-capabilities.md` #4, `performance.md` #3). VERIFIED: the
component holds everything in `useState` and fetches in a bare `useEffect`, so
returning from `/scout/search` remounts it empty and refetches all 43 cards and every
image. Without the cache, the browser has a zero-height document to restore a scroll
position into and the cheap win's Back button lands at the top. **~30 lines, no new
dependency** - `@tanstack/react-query` is already a top-level dep configured at
`main.tsx:15-17`. Do these two together or the first under-delivers.

---

## Sequenced plan

Ordered by impact-per-effort. Dependencies marked. Anything I could not sequence is
labelled speculative and should not be scheduled.

### Quick wins - under a day each

| # | Change | Files | Resolves | Depends on |
|---|---|---|---|---|
| Q1 | **Route the card tap; drop `AudiobookSearch` from `/scout/trends`** | `ScoutPage.tsx`, `BestsellerLists.tsx`, `AudiobookSearch.tsx`, + its test | flow C1, mobile #1, a11y F2/F5/F18, discovery #4, platform #5, content #12/#14, visual F10 leak | - |
| Q2 | **react-query on `BestsellerLists`** | `BestsellerLists.tsx` | platform #4, perf #3, discovery #13 | none, but Q1 under-delivers without it |
| Q3 | **Move Settings out of the bottom nav; centre the FAB on a 4-track grid** | `PreviewApp.tsx`, `preview.css:56` | flow H5, visual F3, mobile #3 | none. Zero desktop impact. |
| Q4 | **Delete the inline colour and background on the Clear button** | `AudiobookSearch.tsx:147` | P1 - a live 1.4.3 AA failure nobody filed | - |
| Q5 | **Define the seven phantom CSS variables as `--v2-*` aliases** | one `:root` block | visual F7. VERIFIED: `--cyan`, `--text-muted`, `--bg-card`, `--bg-secondary`, `--bg-primary`, `--text-tertiary`, `--bg-inset` are referenced 15 times and defined nowhere, so the three-level hierarchy on the `/desk` landing route renders as one flat white | - |
| Q6 | **`viewport-fit=cover` + `min-height:72px` + one `--nav-h` token, in one commit** | `index.html`, `preview.css:56` | mobile #11, visual F4 | **Must be atomic** (A1). Do after Q3 so nav geometry is settled. |
| Q7 | **`scroll-padding-bottom` and `-top` at the mobile breakpoint** | `preview.css` | a11y F6. VERIFIED zero declarations exist today | Q6 (uses `--nav-h`) |
| Q8 | **`color-scheme:dark` on `:root` + a `theme-color` meta; drop the light `body` background** | `theme.css`, `index.html` | platform #2, visual F10 overscroll band, Phase 0 layout note | - |
| Q9 | **Accessible names: sheet close button, intake checkboxes, recommendation textarea, AudiobookSearch input and select** | 5 files | a11y F4 (partial), F5, F10, F12, mobile #5 | - |
| Q10 | **`onError` fallback on the cover image, reusing the existing placeholder branch** | `BestsellerLists.tsx` | perf #8, visual F12 | - |
| Q11 | **`ToastProvider` gets `role="status"`; error toasts get `role="alert"` and stop auto-dismissing** | `toast.tsx` | a11y F8, content #20 | - |
| Q12 | **Branch the Desk "Recently added" card on `isError`** | `DeskPage.tsx:337-339` | content #2, P8 - stops rendering a 503 as a fact about the library | - |
| Q13 | **Prettier the 65KB single-line `preview.css` once** | `preview.css` | visual F9 | No Prettier config exists in the repo (VERIFIED) - this adds one, or runs it once via npx. Do it **before** any other CSS work or none of it is reviewable. Accept the blame-history cost. |

### Structural - days to weeks

| # | Change | Resolves | Depends on |
|---|---|---|---|
| S1 | **Fix the external-key contract: `recommendations.ts:382` calls `externalBookKey()`; the backend mints `key` on `BestsellerBook` (amended G4)** | discovery #2, plus the third key space found above | Must land *before* any verdict is written, or the data is unjoinable from day one |
| S2 | **Verdict capture on the bestseller card** - two 44x44 buttons, optimistic apply/roll-back copied from `RecommendationFinder.tsx:73-85`, read back via `GET /api/feedback`, plus a "Hide decided" filter | discovery #1, flow C2, mobile #2, content #1 | S1. **Pitch it as session memory, not engine learning** - `tasteProfile.ts:213` discards every external-key row. |
| S3 | **One combined bestseller-card rebuild** - accessible name from contents, badges at 12px with ABN expanded, tier headers replacing `#N` on the All tab, 72px cover, two-line title clamp, verdict controls with hit-slop | a11y F7, visual F2 (core) and F5, content #11 and the card table, discovery's row spec, mobile #9 | S2. These **compose, they do not collide** - every one edits the same ~80 lines of `renderCard` and the same three CSS rules. Five commits means five rounds of re-reading the same markup. **Make this one change.** |
| S4 | **Right-size cover URLs at the source** | platform #1, perf #1, Phase 0's biggest measured waste | **Gated on P5.** Apple's lever is one verified token; Amazon's and AudiobooksNow's are untested hypotheses. Two curls settle it; do not scope until they do. |
| S5 | **Per-source status and `fetchedAt` in the bestsellers payload (G2, G3)** | discovery #6 and #7, content #3, flow POLISH 11 | S3 (needs somewhere to render the strip). VERIFIED: `bestsellersCacheTime` is already in scope at `librarian/index.ts:752`, so G2 is a response-shape change, not new work. |
| S6 | **Extract `useModalDialog` from `PreviewSettingsDialog.tsx:341-376`, or convert to `<dialog>`, and apply to all four overlays** | a11y F3/F4/F16/F21, platform #5, mobile #5 and #6 | independent. platform's `<dialog>` route is net -30 lines and gives Escape plus focus trap for free. |
| S7 | **Route-change focus management plus one persistent live region at shell level** | a11y F1, F8 (partial), F11, F12 | S6 (shares the live-region infrastructure) |
| S8 | **Batch ownership check (G1) and the "already on your shelf" marker** | discovery #3, content's card table, flow OQ3 | S3. **Not observable locally** - its whole value depends on what fraction of chart titles are owned, which cannot be measured without ABS. Sequence last despite being the highest-value single affordance in the abstract. |
| S9 | **Scope the two light stylesheets under a class; kill the global 14px body font-size and the global serif h1** | visual F6, F10, and the rem-on-a-14px-body fractional sizes | Q13. This is the subset of the token proposal that earns its keep. |
| S10 | **Decide the font question and act on it either way** | visual F1 | A decision, not a file. Self-host Inter and Outfit as variable woff2, or delete all six names and design against the system stack. The current state is the cost of a font decision with none of the benefit. |
| S11 | **Container queries on `.bestseller-card`** | platform #7 | S3. VERIFIED as a genuine problem: `auto-fill minmax(300px,1fr)` puts cards in ~330px columns at a 1400px viewport, and those get the *wide* layout because the compact rules are keyed to a 480px viewport. This one is a **desktop** fix and composes with S3 rather than fighting it. |

### Speculative - cannot be sequenced; do not schedule

- **PWA manifest, icons, Web Share Target** (platform #9). Blocked on an unanswered
  question: is the app served over HTTPS? `docker-compose.yml` shows plain HTTP on
  `homelab-net` with no published ports and no TLS terminator. Settled by asking what
  URL Joel actually types on his phone.
- **SSE for the recommendations route** (platform #10). Well argued - the `SseChannel`,
  the nine-variant Zod event union and a working client consumer all exist in-repo -
  but the route cannot be validated without ABS.
- **`loading="lazy"` remediation** (perf #2). Observation confirmed; mechanism
  UNVERIFIED and possibly a harness artifact. This is a **test**, not a task, and it is
  worthless until S4 ships.
- **Landscape-phone layout** (mobile #4). Real and VERIFIED - the only shell breakpoint
  is `max-width:800px` and an iPhone 13 mini landscape is 812px - but the right answer
  is unknown; a landscape phone 375px tall may want something neither the rail nor the
  bottom nav provides. Note that **a11y F14 lives in this same band** and is currently
  under-rated because of it (A12).
- **The terminology-drift table** (content-editorial). Excellent inventory, no user
  pain attached to any single row, and several rows are **load-bearing on control
  flow**: `ScanResultsReview.tsx:230` tests whether `commitMessage` starts with
  "Success" and `:272` tests whether it contains "Error", to choose a colour. A rewrite
  silently changes UI behaviour. That component needs a `status` field before any copy
  work touches it. Its own open question 4 says so.
- **Data-router migration** for `ScrollRestoration` and View Transitions. Correctly
  skipped by platform #13. Revisit only if Q2 lands and native history scroll
  restoration demonstrably still fails.

---

*No source file was modified. This document is the only file created.*
