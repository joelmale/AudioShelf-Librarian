# Mobile Interaction Review - scout/* acquisition surface

Tested live against the dev stack (frontend :5173, backend :3050) at 375x812, 390x844,
430x932, and 812x375 (landscape). All numbers below are measured via
getBoundingClientRect() / getComputedStyle() in the running page, or observed
directly by dispatching real events at the DOM and reading resulting state, not
estimated. Screenshot capture in this tool environment is delivered inline to the
session and cannot be written to disk from here (no other reviewer report in
docs/ui-review/ references saved image files either, so this is a toolchain
limit, not a shortcut). Every visual claim below was also confirmed against a
live screenshot taken during the session; the surrounding text describes what
each one showed in place of a file path.

## Verdict

The mobile shell (bottom nav, FAB, sheet) is a competent, purpose-built mobile
skin, not a shrunken desktop. But the one flow this surface exists for, look at
a bestseller, decide, move on, actively destroys the user place in the list on
every single primary tap, has no capture-intent action anywhere (confirming
discovery-acquisition.md finding), and puts its one working piece of chrome
(the FAB) on top of another nav item at every width tested. On a phone, in
landscape, the app silently swaps into the full desktop console. None of this
is exotic to find; it is the first thing hit doing the literal task the
surface is for.

## Ranked findings

### 1. Tapping a card erases scroll position, with nothing to go back to - HIGHEST PRIORITY, CONFIRMED

BestsellerLists.tsx:208 dispatches window.dispatchEvent(new CustomEvent("trigger-audiobook-search", ...))
when the (only) primary action on a card, the whole card, aria-label="Search
for {title} by {author}", is pressed. A sibling component picks it up:

    apps/frontend/src/features/librarian/components/AudiobookSearch.tsx:57-68
    const handleTriggerSearch = (e: Event) => {
      ...
      setQuery(customEvent.detail.query);
      executeSearch(customEvent.detail.query, 1);
      const searchEl = document.getElementById("audiobook-search-section");
      if (searchEl) searchEl.scrollIntoView({ behavior: "smooth" });
    };

Measured, with the pane actually visible so the smooth-scroll animation could
run (rAF is throttled while the pane is hidden, see Methodology note below):

- Scrolled to scrollY = 3000 (card rank about #14, "The Eye of the Bedlam Bride").
  history.length = 5, location.href unchanged.
- Clicked the card. Result: scrollY animated down to 281.33px, which is
  exactly the measured top of #audiobook-search-section (281.73px), i.e. it
  scrolled to align the search panel with the viewport top.
- After the click: history.length still 5, location.href unchanged.
  No route change occurred at all.

So: the only "activate" affordance on the acquisition surface (a) is not
navigation, (b) creates no history entry, and (c) forcibly relocates the
viewport roughly 2700px away from wherever the user was reading, to run an
AudiobookBay text search that frequently returns an unrelated result. In one
run, tapping "The Eye of the Bedlam Bride" surfaced a torrent called "Huge
Progression Fantasy Audiobook Collection [Update 2026-06] - Many", a
343-book pack, as the top match, a relevance problem worth flagging on its
own, since it is what the user is dumped in front of after losing their place.

Consequence for Back: because no navigation occurred, there is nothing for a
browser or OS back gesture to undo. The only way back to the reading position
is to manually re-scroll, with no marker of where the reader was. This is a
stronger and more literal version of what the task brief predicted
("scrollIntoView to the top"), it does not go to the absolute top, but to a
fixed point far enough up the page that from mid-list or later it reads
identically to "back to the top of a 5300px page," and it happens with zero
affordance that it is about to happen, the card looks like a normal list
item, not a link that leaves the list.

Screenshot evidence (session capture, not a file): before-state showed cards
#13 through #18 filling the viewport at scrollY=3000; after-state showed the
"Search AudiobookBay" panel with the query pre-filled
"The Eye of the Bedlam Bride Matt Dinniman" and a download-card result,
with the bestseller list entirely scrolled out of view.

### 2. No intent capture exists - the only two actions per card are "search externally" and "read blurb" - CONFIRMED, matches discovery-acquisition.md

Per-card markup confirmed: button.bestseller-card__search (the whole 362x90
card) and a second 44x44 button[aria-label^="Show description"]. There is no
save, dismiss, "maybe later," or library-state affordance anywhere in the DOM.
This independently confirms docs/ui-review/discovery-acquisition.md finding
#1. For the stated mobile job, triage in a spare two minutes, the surface has
exactly one working verb, and it is destructive to the scroll position
(finding #1).

### 3. FAB sits directly on top of the Curate nav item at every width tested (375 / 390 / 430) - CONFIRMED

Measured getBoundingClientRect() for .v2-mobile-fab and each
.v2-bottom-nav item:

| Width | FAB x-range | Curate nav x-range | Overlap |
|---|---|---|---|
| 375px | 158.7-216.7 | 150.9-224.4 | full 58px FAB width inside Curate 73.5px box |
| 390px | 166-224 | 156.8-233.2 | full 58px FAB width inside Curate 76.8px box |
| 430px | 186-244 | 172.8-257.2 | full 58px FAB width inside Curate 84.4px box |

This reproduces and confirms the prior reviewers finding at every width, not
just 390px. Root cause as previously identified: the FAB is centered at 50%
of viewport width; the 5-column nav center notch/visual weighting sits at the
3rd-of-5 column, which centers at 60%, a 4-item-nav FAB position bolted onto
a 5-item nav. This is not just visual overlap, the FAB is above the nav in
stacking order (its own stacking context per v2-mobile-fab), so the top
35-40px of the Curate tap target is physically intercepted by the FAB, not
just visibly covered.

### 4. Landscape phone widths fall out of the mobile layout entirely and get the desktop console - CONFIRMED, new finding

preview.css's only mobile breakpoint is max-width:800px. Common phones in
landscape exceed that: tested 812x375 (iPhone 13 mini exact landscape CSS
size) and got the desktop rail plus topbar layout, .v2-mobile-fab and
.v2-bottom-nav both compute to display:none; .v2-rail (a 72px icon-only
sidebar, no text labels, confirmed via getComputedStyle) renders instead.
Any phone whose landscape width is 800 CSS px or more (most modern phones,
iPhone 14 Pro Max landscape is 932px, Pixel-class devices are similar) gets
this treatment. On a 375px-tall viewport, the sticky 76px topbar alone
consumes about 20% of vertical height before content starts. A "browse in a
spare two minutes" surface rotated to landscape (propped on a stand, or just
however the phone was already oriented) silently becomes the curation
console the product brief explicitly says should stay a desktop-only
surface.

(Screenshot capture at this exact viewport was unreliable in this tool,
repeated blank/white captures at scrollY=600 even though DOM inspection at
that same scroll position proved the correct dark-themed content was present
and correctly laid out, elementFromPoint returned .bestseller-card__title
inside .bestseller-list__items with the expected dark background. This looks
like a screenshot-pane rendering artifact at that specific viewport size, not
a product bug, and has been excluded as a finding, flagged only so the next
reviewer does not rediscover the same scary-looking blank screenshot and
misattribute it.)

### 5. The bottom sheet ("Start a task", opened from the FAB) does not lock body scroll - CONFIRMED

    apps/frontend/src/preview/PreviewApp.tsx:101 (single-line source)
    {taskOpen && <div className="v2-overlay" onMouseDown={() => setTaskOpen(false)}>
      <section className="v2-sheet" role="dialog" aria-modal="true" ...>

With the sheet open, getComputedStyle(document.body).overflow is "visible"
and window.scrollBy(0, 200) successfully moved the page (confirmed via
window.scrollY before/after: 281.3 to 481.3). Screenshot evidence: the sheet
stayed pinned to the same screen position (it is the fixed-position element)
while the dimmed content visible behind it shifted. This is a real, if minor,
defect for a role="dialog" aria-modal="true" element, the modal claims
exclusivity via ARIA but the page underneath remains fully scrollable, which
on iOS in particular is a well-known source of scroll-chaining and
rubber-band glitches.

Two things that do work correctly, worth crediting: opening the sheet
mid-scroll (scrollY=3000) does not force any scroll jump (unlike finding #1),
scrollY was still exactly 3000 immediately after open and after
backdrop-dismiss. And tap-outside-to-dismiss does work, it is wired via
onMouseDown on the overlay (confirmed by dispatching a real mousedown at a
backdrop point via elementFromPoint, which closed the sheet; a plain click
event does not, because there is no onClick handler, an easy trap to fall
into testing this by script but not a user-facing issue since real taps
generate mousedown).

One real, if minor, accessibility gap in this sheet: the close (X) button
(a plain button with an icon and no text) has no aria-label and no text
content, a screen-reader user gets an unnamed button.

### 6. The card-description popover is a different, weaker modal pattern than the FAB sheet, and does not track the card it describes

Tapping the (i) "Show description" button opens
.bestseller-description--pinned, confirmed via computed style: position:
fixed, z-index: 9999, anchored by bottom: calc(86px + env(safe-area-inset-bottom))
(BestsellerLists.css:306-313). Unlike the FAB sheet:
- role="dialog" but no aria-modal attribute at all (not even "true").
- No dimmed backdrop.
- No scroll lock (confirmed: window.scrollBy(0,150) moved the page while
  the popover stayed fixed on screen).

Because it is fixed at a constant screen position rather than anchored to the
card, and the background scrolls freely underneath it, a user who scrolls
while it is open ends up with a description panel hovering over an unrelated
card a few rows away, the text and the cover art next to it stop
corresponding to the same book. Screenshot evidence: description text for
"Theo of Golden" rendered directly on top of the next card cover art
("The Eye of the Bedlam Bride"), because the popover does not reserve layout
space, it overlays in place.

Two different bottom-of-screen overlay components, two different modality
contracts, in the same feature surface. Worth converging on one pattern.

### 7. Zero gesture vocabulary exists beyond tap - confirmed by full-repo grep

    grep -r "touchstart|touchmove|touchend|pointerdown|onTouchStart|useSwipe|Swipeable" apps/frontend/src
    -> No files found.

There is no swipe-to-dismiss, swipe-to-triage, pull-to-refresh, or swipeable
tab strip anywhere in the frontend. The sheet drag handle (a plain div with
class v2-sheet-handle, PreviewApp.tsx) is decorative only, it has no
pointer/touch handler attached, so it visually promises a swipe-down-to-dismiss
gesture that does not exist; only the X button and backdrop-tap actually
close the sheet. For a surface whose entire job is rapid one-handed triage,
the absence of any swipe gesture (see recommendations below) is the single
biggest interaction-design gap, and it also means there is no conflict with
the browser edge-swipe-back gesture today, worth keeping in mind as a
constraint if swipe gestures are added later (see recommendations).

### 8. Zero horizontal-scroll affordance on the mode tab strip - the last two tabs are reachable but invisible

.v2-section-tabs (the "Trends & discovery / Recommendations / Search &
download / Intake review" strip) is overflow-x: auto with scrollWidth 665
against clientWidth 345 at 375px, so the last two tabs ARE reachable by a
horizontal swipe, contradicting a literal read of the Phase 0 "clipped" note.
But the strip cuts hard at "Recommendations" with no partial-tab peek, no
edge fade, and no scroll-position indicator, so there is nothing to suggest
two more modes exist off-screen. This is a discoverability defect, not an
unreachability one.

### 9. Zero horizontal spacing between the two per-card tap targets

Measured on a card: the primary "Search" button occupies x: 46.7-316.7
(width 270); the "Show description" button occupies x: 316.7-360.7 (44x44),
0px gap, exactly abutting. A thumb landing near that boundary can hit either
target with no forgiveness zone, and the two actions have very different
weight: one is informational (expand a blurb in place), the other is the
scroll-destroying, page-relocating action from finding #1. The
higher-consequence action has no larger hit-slop buffer to protect against
accidental activation near the boundary.

### 10. Network-failure state is legible but color-coded as success, and shows a raw technical string

Simulated by monkey-patching window.fetch to reject only
/api/librarian/search calls, then activating a card. The UI correctly
enters its error branch (AudiobookSearch.tsx:48-51) and renders the message,
but:
- Text is the literal JS error string, "Failed to fetch", not a
  user-meaningful message ("Could not reach AudiobookBay, try again").
- Measured color: rgb(134, 205, 183), a mint/teal-green, the same family
  used for "Live system" and other positive-state indicators elsewhere in the
  shell, not a warning/error color. There is no retry button, just the text
  sitting under the (still-enabled) Search button.
On a real degraded 3G connection this is a state a user hits often (the card
tap already fires a network request on every single browse-then-tap); right
now it reads as quiet and possibly successful rather than as a failure.

(True network throttling was not available in this tool session, there is no
DevTools-protocol throttle exposed through the browser tools provided. The
fetch-rejection method above exercises the same code path a timeout or
offline condition would hit and is the best available substitute; a
follow-up pass with real Chrome DevTools throttling would be worth doing to
also check the 39-image, roughly 1MB cover-art payload behavior on 3G, which
Phase 0 already flagged as the biggest static weight on this surface.)

### 11. Safe-area-inset CSS exists but is currently inert - viewport-fit=cover is missing

apps/frontend/index.html:5:

    <meta name="viewport" content="width=device-width, initial-scale=1.0" />

No viewport-fit=cover. Per spec, env(safe-area-inset-*) resolves to 0 unless
the viewport declares viewport-fit=cover; without it, Safari/Chrome letterbox
the page inside the safe area automatically and env() insets are inert. The
three call sites that use env(safe-area-inset-bottom) (.v2-bottom-nav,
.v2-sheet padding, .v2-settings-scroll padding, plus the description popover
bottom offset) are written defensively for notched devices but currently do
nothing on any real device, in either direction, they do not create bugs
today, but they also do not do the edge-to-edge, home-indicator-aware layout
they appear to be trying to do. Also worth noting: safe-area-inset-top/left/right
are used nowhere in the codebase (grep -rn safe-area-inset apps/frontend/src
gives 4 hits, all -bottom), so a landscape notch or Dynamic Island cutout on
the left/right edge (relevant if viewport-fit=cover is ever added) has no
coverage at all in .v2-topbar, which is a plain position:sticky; top:0 with
fixed padding.

### 12. vh vs dvh - mixed, and mostly on the side that under-reacts to browser chrome

Counts in preview.css: 100vh x3 (#ui-v2-root, .v2-app, .v2-rail, all
min-height or fixed sidebar height, desktop-oriented), 88vh x3 (.v2-sheet
max-height in both the default and the max-width:800px mobile override,
.v2-settings-dialog), 100dvh x1 (.v2-settings-dialog in the mobile block
only, max-height:calc(100dvh - 10px)). So the settings dialog got the dvh
treatment but the task sheet (the one actually reachable from the mobile FAB
on the acquisition surface) did not, it is still sized against static 88vh,
which on a phone with the address bar visible (the common case, not the
scrolled-down chrome-hidden case) is larger than the true visible viewport in
browsers where plain vh reports the large/chrome-hidden height. .v2-sheet
does have overflow:auto as a safety net, so this manifests as "sheet content
can require an unexpected internal scroll" rather than a hard clip, but it is
inconsistent with the settings dialog own fix living 40 lines away in the
same file.

## Thumb-reach summary

- Bottom nav (5 items, y about 747-805 at 375px) and the FAB (y about
  716-774) both sit in the bottom ~15% of the viewport, objectively in the
  comfortable one-handed zone for all three portrait widths tested. This
  part is done right.
- But neither is an acquisition action. The FAB opens "Start a task" (Acquire
  / Intake / Realign / Convert, curation-flow entry points, confirmed via
  aria-label="New task" and its sheet contents), and the bottom nav relevant
  tab ("Scout & Acquire") just navigates to this same page.
- The actual triage actions, tap card / tap (i), live inline in a plain
  scrolling list with no fixed, thumb-zone-anchored equivalent. Because the
  whole card is the tap target and the list is full-width, individual card
  taps are reachable wherever they are scrolled to (that part is fine), but
  there is no persistent "act on the current/top card" affordance sitting in
  the money zone, the way a swipe-card interface would put accept/reject
  control within constant reach regardless of scroll position. Combined with
  finding #1, the net effect is: the one screen position that is always in
  comfortable reach (the FAB) does the least relevant thing, and the thing
  users are actually there to do requires reaching wherever the list happens
  to have scrolled to, then accepting that doing so relocates them elsewhere
  in the page.

## Prioritized interaction changes for the triage loop

1. Make card activation a real navigation with real history, or at minimum
   stop the scrollIntoView hijack. If "search AudiobookBay for this title"
   is genuinely the primary action, do it without moving the viewport,
   surface the result inline (expand under the card, same pattern already
   built for the description popover) instead of yanking focus to a shared
   panel at the top of the page. This alone fixes finding #1, the highest
   -value item found.
2. Add the intent-capture actions the product brief calls for ("get this /
   not this / maybe later") as a third and fourth control per card, sized
   and positioned with real hit-slop separation from the existing two
   (finding #9). discovery-acquisition.md already notes the backend
   endpoint exists, this is a frontend-only gap.
3. Introduce one swipe gesture for triage (for example, swipe card left or
   right for dismiss/save), scoped so its recognition threshold requires
   clear horizontal intent from roughly 24px in before capturing the touch,
   and with a dead zone along the outer 16px of the left edge so it cannot be
   mistaken for (or steal) the OS back-swipe. Make it discoverable with a
   one-time hint, since nothing on this surface currently teaches any gesture
   beyond tap (finding #7). Wire the existing sheet drag handle to actually
   support swipe-down-to-dismiss while at it, it already visually promises
   that gesture.
4. Fix the FAB/Curate overlap (finding #3) by moving the FAB off dead-center
   to align with the notch actually cut for it, or by cutting the notch at
   50% instead of 60%, either resolves all three tested widths at once since
   the geometry (58px FAB centered at 50%, 5-column nav) is fixed math, not
   width-dependent.
5. Give the landscape case a real mobile layout rather than silently falling
   back to the desktop rail (finding #4), even a same-breakpoint compact
   horizontal version of the bottom nav would beat a 72px icon rail eating a
   fifth of a 375px-tall screen.
6. Lock body scroll under both overlay types and give the description
   popover the same modality contract as the task sheet (dimmed backdrop,
   aria-modal="true", anchored-in-flow instead of position:fixed) so it
   cannot drift out of registration with the card it is describing (findings
   #5, #6).
7. Color-code and reword the network-failure state (finding #10), reuse
   whatever red/amber token exists elsewhere in the theme (Phase 0 measured
   #fb7185 as --v2-red in this same stylesheet) and add a retry button, since
   a card tap always costs a network round-trip on this surface.

## Methodology notes for the next reviewer

- The browser pane in this environment intermittently reports "hidden"
  between tool calls even when nothing closed it, which times out any
  computer action that needs to draw (click, coordinate-based screenshot).
  The reliable workaround: drive interactions via javascript_tool
  (element.click(), dispatchEvent, getBoundingClientRect) and use computer
  only for screenshot/wait, batched immediately together via browser_batch.
  Coordinate-based computer clicks failed consistently; ref-based and
  JS-based clicks did not.
- requestAnimationFrame-driven behavior (CSS scrollIntoView({behavior:
  "smooth"}), in particular) does not advance while the pane is hidden. Two
  otherwise-identical tests of finding #1 gave different final scrollY
  values depending on whether a computer:screenshot kept the pane fronted
  during the animation window or a javascript_tool sleep did not. Trust the
  runs where a screenshot bridges the wait; treat bare-setTimeout waits as
  unreliable for anything animation-dependent.
