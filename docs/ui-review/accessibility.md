# Accessibility review — WCAG 2.2 AA

Reviewer: ux-accessibility. Date: 2026-09-04. Scope: whole app, weighted toward the
mobile acquisition surface (`/scout/*`). Static review — code plus the Phase 0 runtime
capture. **No browser and no screen reader this pass**; §4 lists what that leaves open.

Contrast and tap targets were measured in Phase 0 and pass. They are not re-litigated
here beyond §5.

---

## Verdict

**Fail.** Not a close call, and the failures concentrate exactly where the product
cares most.

The surface layer is better than average: a real focus ring, correct `alt=""` on cover
art, a roving-tabindex tablist, a genuinely complete focus trap in the settings dialog,
and reduced-motion coverage that actually holds. What is missing is the layer
underneath — **nothing tells a non-visual or keyboard user that anything happened.**

Three systemic gaps produce most of the findings:

1. **No focus management anywhere except the settings dialog.** Not on route change,
   not in the bottom sheet, not in the off-canvas rail, not in the description dialog,
   not after a destructive re-render.
2. **No status messaging.** Search results, search errors, scan progress, toasts, and
   recommendation results all arrive silently. The toast system — which carries the
   only confirmation *and* the only error text for the download action — is not a live
   region at all.
3. **Labels are applied by convention, not by rule.** Some components label everything
   (`PreviewSettingsDialog`); the acquisition search form labels nothing.

The single worst finding is F2: on `/scout/trends`, the app's one primary action moves
the *viewport* to the results and leaves *focus* 5000px below it, announcing nothing.
For a keyboard or screen-reader user the acquisition funnel does not have a working
first step.

---

## 1. Confirmed findings — critical

Ranked by severity × mobile weighting. All confirmed from source or Phase 0 data.

### F1 — SPA route change strands focus and announces nothing
**SC 2.4.3 Focus Order (A), 4.1.3 Status Messages (AA)**
`apps/frontend/src/preview/PreviewApp.tsx:64-91`, `:23-25`

There is no focus management on navigation anywhere in the app. I grepped the whole
frontend: no `useEffect` keyed to `location.pathname` that moves focus, no route
announcer, no `.focus()` outside `PreviewSettingsDialog` and the bestseller tablist.

What happens on every one of the ~18 route transitions:

- Focus stays on the `NavLink` that was activated. In the rail that link is
  `position:fixed; transform:translateX(-105%)` on mobile (see F3) — so focus is now
  **off-screen** while an entirely new page has rendered.
- The new `<h1>` is never announced. A screen-reader user hears nothing and has no
  signal that the view changed; they must manually re-explore to discover it.
- Because focus never moved into `<main>`, the next Tab resumes from the nav, so the
  user re-traverses the whole navigation before reaching the new content.

The lazy `Suspense` fallbacks make this worse, not better. `DeferredRoute`
(`PreviewApp.tsx:23-25`) renders `<div role="status">Loading {label}…</div>`. A
`role="status"` region that is **inserted into the DOM already containing its text**
is not reliably announced — live regions announce *changes* to an existing region, and
the mount/unmount race here is exactly the pattern that goes unspoken. So the loading
state is silent, and its replacement by real content is also silent. Every code-split
route (all of `/scout/*` and `/curate/*`) is affected.

Also note the label text itself is inconsistent — `"Loading Scout…"` vs
`"Loading recommendations…"` vs `"Loading M4B candidates…"` (`:66-80`) — capitalised
for two routes and not the rest.

**Fix.** Add a route-change effect in `PreviewShell` keyed to `location.pathname`: move
focus to a `tabIndex={-1}` wrapper on `<main>` (or the route's `<h1>`), and render a
persistent visually-hidden `aria-live="polite"` region, mounted once at shell level,
whose text you set to the new page title after the transition. Keep the `role="status"`
fallback but let the persistent region do the announcing.

---

### F2 — The one primary action on the acquisition surface scrolls away from focus and announces nothing
**SC 2.4.3 Focus Order (A), 2.4.7 Focus Visible (AA), 4.1.3 Status Messages (AA)**
`apps/frontend/src/features/librarian/components/BestsellerLists.tsx:206-212`
→ `apps/frontend/src/features/librarian/components/AudiobookSearch.tsx:57-73`

Per Phase 0, "the entire card is a Search AudiobookBay button" — there is no other
primary action on the mobile acquisition surface. Activating it:

```
handleSearch → window.dispatchEvent(CustomEvent("trigger-audiobook-search"))
             → AudiobookSearch sets query, runs the fetch,
               searchEl.scrollIntoView({ behavior: "smooth" })
```

`AudiobookSearch` is rendered *above* `BestsellerLists` on `/scout/trends`
(`ScoutPage.tsx:17`). Phase 0 measured the document at 5355px. So:

- **The viewport scrolls up; focus does not move.** Focus remains on the bestseller
  card, now far below the fold. The focus ring is rendered off-screen → 2.4.7 fails,
  because for the sighted keyboard user there is no visible focus indicator anywhere
  in the viewport.
- **Tab does not reach the results.** The next Tab goes to the *next bestseller card*,
  scrolling the user straight back down. To reach the results that just appeared, they
  must Shift+Tab backwards past every preceding card and the whole tab strip.
- **Nothing is announced.** No live region, no focus move, no `aria-busy`. A
  screen-reader user activates the card and receives no evidence that the app did
  anything at all.

Secondary: `behavior: "smooth"` is passed explicitly in JS, which **overrides** the
`scroll-behavior:auto!important` reduced-motion rule in `preview.css` (CSS
`scroll-behavior` loses to an explicit `ScrollBehavior` argument). This is the one real
hole in the app's otherwise solid reduced-motion coverage.

**Fix.** After the results render, move focus to the results container
(`tabIndex={-1}`) or to the search input, and announce
`"{n} results for {query}"` in a polite live region. Replace the raw `scrollIntoView`
with a call that reads `matchMedia("(prefers-reduced-motion: reduce)")` and passes
`behavior: "auto"` when set — moving focus will scroll the element into view anyway,
which makes the manual scroll largely redundant.

---

### F3 — The off-canvas rail stays in the tab order and the accessibility tree while closed
**SC 2.4.3 Focus Order (A), 2.4.7 Focus Visible (AA), 2.4.11 Focus Not Obscured (AA)**
`apps/frontend/src/preview/preview.css` — inside `@media(max-width:800px)`:
```css
.v2-rail{position:fixed;transform:translateX(-105%);transition:transform .22s;width:min(310px,86vw);…}
.v2-rail.is-open{transform:translateX(0)}
```

The drawer is hidden by **transform only** — not `display:none`, not
`visibility:hidden`, not `inert`, and `PreviewApp.tsx:44` sets no `aria-hidden` when
`mobileOpen` is false. Consequently, on every mobile page load:

- The brand block, the four primary nav links, and the connection-status text are all
  **still focusable and still exposed to assistive technology** while invisible.
- A keyboard or switch user tabbing from the top of the page hits four links they
  cannot see, with the focus ring rendered off the left edge of the screen (2.4.7).
- A screen-reader user gets the **entire primary navigation twice** — once from the
  off-screen rail, once from `.v2-bottom-nav` (`PreviewApp.tsx:95-98`), which lists the
  same four destinations.

The drawer also has none of the modal behaviour its visual design implies: no focus
trap, no initial focus, no Escape handler, no focus restoration, and the background
page stays focusable behind it. And the trigger at `PreviewApp.tsx:57` is
`aria-label="Open menu"` with **no `aria-expanded`** and a label that never changes to
"Close menu" even though the icon swaps to `<X/>`.

**Fix.** Gate the rail on the open state — `hidden` / `inert` when closed at that
breakpoint (or `display:none` in the closed CSS state, animating with a
`@starting-style`/visibility pair). Add `aria-expanded={mobileOpen}` and
`aria-controls` to the trigger, swap the label with the icon, and give the open drawer
`role="dialog" aria-modal="true"` with focus trap, Escape, and restore — or reuse the
pattern already written in `PreviewSettingsDialog.tsx:341-376`.

---

### F4 — The bottom sheet declares `aria-modal="true"` while focus sits outside it
**SC 2.4.3 Focus Order (A), 1.3.1 Info and Relationships (A), 4.1.2 Name Role Value (A)**
`apps/frontend/src/preview/PreviewApp.tsx:101-106`

```jsx
{taskOpen && <div className="v2-overlay" onMouseDown={() => setTaskOpen(false)}>
  <section className="v2-sheet" role="dialog" aria-modal="true" aria-labelledby="new-task-title" …>
    …<button className="v2-icon-button" onClick={() => setTaskOpen(false)}><X/></button>…
```

Everything a dialog needs is missing, and the `aria-modal="true"` makes the absence
actively harmful rather than merely incomplete:

- **No initial focus.** Focus stays on the trigger (`.v2-new-task` at `:61`, or the FAB
  at `:99`), which is *outside* the dialog. `aria-modal="true"` instructs assistive
  tech to hide everything outside the dialog subtree — so the user's focus point is in
  a region the screen reader has been told does not exist. That is a stranded state,
  worse than no `aria-modal` at all.
- **No focus trap and no `inert`** on the background — Tab walks straight out into the
  page behind the overlay.
- **No Escape handler.** The only dismissal paths are a backdrop `onMouseDown` (pointer
  only) and the close button.
- **The close button has no accessible name.** `<button className="v2-icon-button">`
  wrapping a bare lucide `<X/>`; lucide-react emits an `<svg>` with no `title` and no
  `aria-label`, so the computed name is empty. Announced as "button". This is the same
  markup the settings dialog gets right at `PreviewSettingsDialog.tsx:660`
  (`aria-label="Close settings"`).
- **Focus order.** From the topbar trigger at `:61`, the sheet is rendered at `:101` —
  after `<main>` and the whole bottom nav — so Tab reaches it only after traversing the
  entire page.

**Fix.** Extract the focus-management effect at `PreviewSettingsDialog.tsx:341-376` into
a shared `useModalDialog(open, onClose)` hook and apply it here, to the rail (F3), to
the pinned description dialog (F16), and to `AntiBotChallengeModal` (F22). Add
`aria-label="Close"` to the close button.

---

### F5 — The acquisition search form has no labels at all
**SC 3.3.2 Labels or Instructions (A), 4.1.2 Name Role Value (A), 1.3.1 (A)**
`apps/frontend/src/features/librarian/components/AudiobookSearch.tsx:118-138`

```jsx
<input type="text" className="glass-input" placeholder="Search title, author..." … />
<select className="glass-input" … >
  <option value="">All Categories</option>
```

Neither control has a `<label>`, `aria-label`, or `aria-labelledby`. The text input is
placeholder-only — the canonical 3.3.2 failure, and the placeholder vanishes the moment
the user types, so there is no persistent label for anyone. **The `<select>` has no
accessible name whatsoever**; it is announced as "combo box, All Categories".

This is the search field on `/scout/search` *and* on `/scout/trends` — both halves of
the acquisition surface. It is also the destination of the F2 card action, so a
screen-reader user routed here by a bestseller card lands on an unnamed field
pre-populated with a query they were never told about.

The repo already knows how to do this: `PreviewSettingsDialog.tsx:110-116` wraps every
setting in a `<label className="v2-setting-field"><span>{label}</span>{children}</label>`.

**Fix.** Add real `<label htmlFor>` elements (a visually-hidden label is acceptable if
the design will not carry a visible one, but a visible one is better here). Give the
select a visible "Category" label.

---

## 2. Confirmed findings — high

### F6 — Focus is obscured by the fixed bottom nav and sticky topbar; no scroll padding anywhere
**SC 2.4.11 Focus Not Obscured, Minimum (AA — new in 2.2)**
`preview.css`: `.v2-bottom-nav{position:fixed;bottom:0;height:72px;z-index:50}`,
`.v2-mobile-fab{position:fixed;bottom:38px;width:58px;height:58px;z-index:55}`,
`.v2-topbar{height:64px;position:sticky;top:0;z-index:20}`

`grep -c "scroll-padding\|scroll-margin" preview.css` → **0**. Not one declaration in
the entire 65KB stylesheet.

Browsers scroll a newly focused element to the *nearest viewport edge*. With a 72px
fixed bar pinned to that edge and no `scroll-padding-bottom` on the scroll container, an
element focused while scrolling downward lands underneath it. Tabbing through the 43
bestseller cards Phase 0 measured — each card 362×90 — puts focused cards under the
bottom nav repeatedly. Shift+Tab produces the mirror problem against the 64px sticky
topbar. The centred FAB (`left:50%`, 58px) additionally overlaps card content, which
Phase 0 observed visually at 390px.

`.v2-app{padding-bottom:92px}` in the mobile block only stops the *end of the document*
from being trapped; it does nothing for any element mid-scroll.

**Fix.** `html{scroll-padding-bottom:calc(80px + env(safe-area-inset-bottom)); scroll-padding-top:72px;}`
at the mobile breakpoint. Cheap, one line, fixes the whole class of problem.

---

### F7 — The bestseller card's `aria-label` erases the badges, the rank, and the consensus signal
**SC 1.3.1 Info and Relationships (A), 2.5.3 Label in Name (A)**
`apps/frontend/src/features/librarian/components/BestsellerLists.tsx:316-397`

Per the brief, here is what the structure actually conveys per item.

The wrapping button carries `aria-label={`Search for ${book.title} by ${book.author}`}`
(`:323`). An `aria-label` on a button **replaces** the entire name-from-contents
computation. Everything inside is therefore inaudible:

| Rendered inside the card | Reaches a screen reader? |
|---|---|
| `span.__rank` `#1`…`#43` (`:316`) | No — `aria-hidden="true"` |
| `img.__cover` (`:356`) | Correctly excluded — `alt=""`, name is on the button |
| `__title` (`:372`) | Yes, via `aria-label` |
| `__author` (`:375`) | Yes, via `aria-label` |
| `__badges` — `Audible #3`, `Apple #7`, `ABN #12` (`:379-394`) | **No — swallowed by `aria-label`** |

So a screen-reader user hears, per card, exactly: *"Search for {title} by {author},
button."* Forty-three near-identical announcements with **no ordering information and
no source information**.

That is not a cosmetic loss. The badges are the entire point of the "All charts" tab:
`aggregateBestsellers` (`:112-147`) sorts by *how many charts a title appears on*, ties
broken by best single rank. The badges are the only rendering of that computation. A
non-visual user gets the sorted list with the sort key deleted — the list looks
arbitrary, and duplicate-author clustering (Phase 0: Matt Dinniman at #8, #10, #11,
#13, #14) makes it read as noise.

The rank being `aria-hidden` is partly mitigated by the `<ol>` at `:511` — screen
readers announce "3 of 43" from list position, which happens to match the rank. But see
F17: `list-style:none` may remove even that.

Under 2.5.3, the button's visible label text includes the badge strings while its
accessible name does not.

Also `:388`: `title={`#${rank} on ${sourceMeta?.label}`}` — `title` tooltips are
unavailable to touch and keyboard users, so the expansion of "ABN #12" is
mobile-inaccessible on the mobile-priority surface.

**Fix.** Drop `aria-label` from the button and build the name from contents instead —
keep the title and author as visible text, un-hide the rank or replace it with a
visually-hidden `Rank {n}`, and let the badges contribute real text
(`<span className="__badge">Audible #3</span>` already reads correctly). If a verb is
needed, add a visually-hidden `Search for` span as the button's first child. That
satisfies 2.5.3 by construction and restores the consensus signal.

---

### F8 — Search errors, results, scan progress, and toasts are all announced to nobody
**SC 4.1.3 Status Messages (AA), 3.3.1 Error Identification (A)**

Four separate silent channels, all on or adjacent to the acquisition surface:

1. **Search error** — `AudiobookSearch.tsx:161-165`. A plain `<div>` with inline colour
   styling, no `role="alert"`, no live region. A failed search is invisible to AT. The
   colour is also the only differentiator between this and ordinary text (1.4.1
   adjacent).
2. **Search results / busy state** — `AudiobookSearch.tsx:167-227`. No `aria-live`, no
   `aria-busy`. Results appear silently; `"No results found."` (`:225`) is silent too.
3. **Toasts** — `apps/frontend/src/features/curator/toast.tsx:22-30`. `.toast-wrap`
   holds plain `<div>`s with **no `role="status"` / `role="alert"` / `aria-live`**.
   This is the delivery mechanism for `"Successfully sent to qBittorrent!"` and for
   every download failure (`AudiobookSearch.tsx:105-109`) — i.e. the **terminal step of
   the acquisition funnel** and its error path are both unannounced. They also
   auto-dismiss after 4500ms (`toast.tsx:19`) with no way to pause or recall them.
4. **Intake scan progress** — `preview/components/IntakePanel.tsx:27-36`. A WebSocket
   -driven progress bar built from `<div>`s with an inline `width:%`. No
   `role="progressbar"`, no `aria-valuenow`/`min`/`max`, no live region. On
   `/scout/intake` a non-visual user cannot tell whether a scan is running, how far
   along it is, or that it finished.
   Same file, `ScanResultsReview.tsx:271-274`: `commitMessage` — which carries both
   success and error text (`commitMessage.includes('Error')`) — is a bare `<div>`,
   while `commitFailures` immediately below it at `:277` correctly uses `role="alert"`.
   The inconsistency is within one component.

**Fix.** Give `ToastProvider` a permanent `<div className="toast-wrap" role="status"
aria-live="polite" aria-atomic="false">` and render error toasts into a second
`role="alert"` region. Add `role="alert"` to `AudiobookSearch.tsx:161` and
`ScanResultsReview.tsx:271`. Announce result counts politely. Convert the intake bar to
`role="progressbar"` with `aria-valuenow`/`aria-valuetext`.

---

### F9 — dnd-kit keyboard reordering is wired up but unreachable
**SC 2.1.1 Keyboard (A), 2.5.7 Dragging Movements (AA — new in 2.2), 4.1.2 (A)**
`apps/frontend/src/features/curator/features/encoder/organisms/EncodeQueueList.tsx:131-144`, `:190-195`

The `KeyboardSensor` **is** registered with `sortableKeyboardCoordinates` (`:192-194`),
which normally makes dnd-kit sortables keyboard-operable out of the box. The wiring
defeats it:

```jsx
<div ref={setNodeRef} style={style} {...attributes}>        // :131  ← focusable, no listeners
  <div {...(isRunning ? {} : listeners)} … >☰</div>          // :134  ← listeners, not focusable
```

`attributes` (which supply `tabIndex={0}`, `role="button"`, `aria-roledescription`,
`aria-describedby`) go on the **outer** node; `listeners` (the `onKeyDown` that starts a
keyboard drag) go on the **inner** handle. The handle has no `tabIndex`, so it never
receives focus and never receives a `keydown`. Keydown on the focused outer div bubbles
*up*, never down to the handle. **The keyboard drag can never be initiated.** 2.1.1
fails.

Two consequences fall out of the same line:

- **4.1.2** — the outer `<div>` is announced as a `button` with role `sortable` that
  does nothing on Enter or Space. Every queue row is a lying button.
- **2.5.7** — the only single-pointer alternative is "Promote to Top" (`:156`,
  `handlePromote` at `:227-231`), which can only move an item to position 1. Arbitrary
  reordering is achievable by dragging alone.

Also in this component, three controls are named only by a glyph: `☰` (`:143`), `↑`
(`:158`), `✕` (`:168`, `:172`). Accessible-name computation takes contents over
`title`, so the names are the raw characters — announced as "upwards arrow button" or
skipped entirely depending on the screen reader's punctuation settings. The `title`
attributes ("Promote to Top", "Remove") do not rescue this and are unavailable on touch.

This is a `/curate/encode` (desktop) surface, so it ranks below the `/scout/*` findings
per the brief's weighting — but it is a complete keyboard lockout of a feature, which
keeps it in the high band.

**Fix.** Spread `{...attributes} {...listeners}` on the *same* element, and make that
element the handle: `<button ref={setActivatorNodeRef} {...attributes} {...listeners}>`
using dnd-kit's `setActivatorNodeRef` while `setNodeRef` stays on the row. Give the
glyph buttons `aria-label`s. Add a keyboard/pointer "Move up / Move down" pair to
satisfy 2.5.7 properly.

---

### F10 — Intake table checkboxes have no accessible name
**SC 4.1.2 Name Role Value (A), 1.3.1 (A)**
`apps/frontend/src/features/librarian/components/ScanResultsReview.tsx:305-315`, `:330-341`

Both the select-all checkbox in the `<th>` and every per-row checkbox in the `<td>` are
bare `<input type="checkbox">` with no `<label>`, no `aria-label`, and no
`aria-labelledby` pointing at the row's Book cell. A screen-reader user on
`/scout/intake` — part of the acquisition surface — hears "checkbox, not checked" N
times with no indication of which file each governs, and the select-all is
indistinguishable from a row checkbox.

`RealignPage.tsx:104` gets this exactly right on the equivalent control
(`aria-label={`Select ${item.title} for realignment`}`), so the pattern exists in-repo.

**Fix.** `aria-label={`Select ${action.book.title}`}` per row;
`aria-label="Select all actions"` on the header one. Add `scope="col"` to the `<th>`s
while there.

---

### F11 — Recording a recommendation verdict destroys focus
**SC 2.4.3 Focus Order (A), 4.1.3 Status Messages (AA)**
`apps/frontend/src/features/librarian/components/RecommendationFinder.tsx:151-157`

```jsx
{verdict
  ? <span className="v2-recommendation-verdict">Noted — more like this</span>
  : <><button aria-label={`More like ${book.title}`} …/><button aria-label={`Not interested in ${book.title}`} …/></>}
```

Activating either button unmounts **both** buttons and replaces them with a non-focusable
`<span>`. The focused element is removed from the DOM, so focus falls back to
`<body>`: the visible focus indicator vanishes, and the next Tab restarts from the top
of the document. The replacement text is not in a live region, so the confirmation is
also unannounced. A keyboard user rating three recommendations traverses the page from
the top three times.

**Fix.** Keep a focusable element in place — render the verdict as a disabled-looking
but focusable status element and move focus to it, or keep the two buttons mounted in a
pressed state (`aria-pressed`). Wrap the verdict text in `role="status"`.

---

### F12 — The recommendation prompt has no label; its suggestion list has no combobox semantics
**SC 3.3.2 Labels or Instructions (A), 4.1.2 (A), 4.1.3 (AA)**
`apps/frontend/src/features/librarian/components/RecommendationFinder.tsx:113`, `:119`

The primary `<textarea>` (`:113`) is placeholder-only — no label, exactly as F5. (The
seed-search input at `:118` *is* correctly wrapped in a `<label>`; the inconsistency is
within four lines of itself.)

The seed suggestion list (`:119`) is a bare `<div>` of `<button>`s that appears as the
user types, with no `role="combobox"`/`listbox`, no `aria-expanded`, no `aria-controls`,
no `aria-activedescendant`, and no live region announcing that N suggestions appeared.
A screen-reader user typing into "Inspired by" receives no indication that anything is
now below the field.

Results arrival (`:127`, `{result && …}`) is likewise silent — no focus move, no
announcement.

**Fix.** Label the textarea. Implement the suggestion field as an APG combobox with
listbox popup, or at minimum add `aria-expanded` + a polite
`"{n} matching books"` announcement. Announce and focus the results region on arrival.

---

## 3. Confirmed findings — medium and low

### F13 — `aria-current` is missing on most routes, and the mobile nav shows no active state at all
**SC 1.3.1 Info and Relationships (A)** · `PreviewApp.tsx:49`, `:96`

The rail sets its active class manually from `location.pathname.startsWith("/scout")`
(`:49`), overriding `NavLink`'s default className. But `aria-current="page"` still comes
from `NavLink`'s *own* match against `to="/scout/trends"` — which does not match
`/scout/search`. So on `/scout/search`, `/scout/recommendations`, `/scout/intake`,
`/curate/tags`, `/curate/encode`, `/curate/health`, `/curate/realign` and
`/activity/:id` the rail is **visibly highlighted with no programmatic equivalent**.

The bottom nav (`:96`) uses default `NavLink`s, so on those same routes it gets neither
`aria-current` **nor** the `.active` class — the mobile "you are here" cue is simply
absent on the majority of scout and curate routes. `.v2-bottom-nav a.active{color:#a78bfa}`
never fires there.

**Fix.** Pass a single predicate to both: `className={({isActive}) => …}` won't help
since the intent is prefix matching — instead compute `isActive` once from the group
prefix and set both `className` and `aria-current={isActive ? "page" : undefined}`
explicitly on both navs.

### F14 — Rail nav links lose their accessible name entirely between 801px and 1279px
**SC 2.4.4 Link Purpose (A), 4.1.2 (A)** · `preview.css`, inside
`@media(max-width:1279px) and (min-width:801px)`:
```css
.v2-brand>span:last-child,.v2-rail nav span,.v2-connection span:last-child{display:none}
```
At tablet/small-laptop widths the rail collapses to icons by `display:none`-ing the
label spans (`PreviewApp.tsx:49` renders `<Icon/><span>{label}</span>`). `display:none`
content is excluded from name computation, and lucide-react `<svg>`s carry no title.
**All four primary navigation links have an empty accessible name** in that range. The
connection status text disappears too.

**Fix.** Replace the label span with a visually-hidden class (clip-rect, not
`display:none`) at that breakpoint, or add `aria-label={label}` to the `NavLink`.

### F15 — The hover description tooltip cannot be hovered; `aria-describedby` announces the loading placeholder
**SC 1.4.13 Content on Hover or Focus (AA), 4.1.3 (AA)**
`BestsellerLists.css:269` (`pointer-events:none`), `BestsellerLists.tsx:324-326`, `:527`

Three defects in one mechanism:

1. **Not hoverable.** `.bestseller-description{pointer-events:none}` — the tooltip is
   literally unhoverable, and `onMouseLeave` on the card (`:353`) dismisses it. A user
   who needs to read a description that overflows its `max-height:400px` /
   `overflow-y:auto` box **cannot scroll it**, because the box rejects pointer events.
   1.4.13's "Hoverable" condition fails outright. (Dismissible is satisfied by the
   Escape handler at `:196-202`; Persistent is satisfied.)
2. **`aria-describedby` fires at the wrong moment.** `:324-326` sets
   `aria-describedby={DESCRIPTION_OVERLAY_ID}` when the overlay opens — but the overlay
   opens on `onFocus` (`:328-336`) containing `"Loading description…"`, and the real
   text arrives from a network round-trip afterwards. Screen readers compute the
   description at focus time, so the user hears the placeholder and **never the actual
   description**.
3. **The live region is removed exactly when the content arrives.**
   `aria-live={overlay.loading ? "polite" : undefined}` (`:527`) — when loading
   finishes, React removes `aria-live` *and* swaps the text in the same commit. The
   region is no longer live at the instant its content changes, so nothing is announced.
   The condition is inverted.

Bonus: focusing each of the 43 cards fires a cross-origin `fetch` to
`itunes.apple.com` (`:248-251`). Tabbing the list issues 43 third-party requests.

**Fix.** `pointer-events:auto` on the tooltip with a small dismiss delay. Make the
overlay a permanent polite live region (`aria-live="polite"` unconditionally on a
persistent node) and drop `aria-describedby`, or defer setting `aria-describedby` until
the text has loaded. Debounce the focus-triggered fetch.

### F16 — The pinned description dialog has no focus management, and its close button is up to 43 tab stops away
**SC 2.4.3 Focus Order (A)** · `BestsellerLists.tsx:519-542`, `:399-421`

`role="dialog"` (`:525`) with no `aria-modal`, no initial focus, no trap, and no
restoration. The overlay is rendered at the **end** of the `<section>`, after the entire
`<ol>` of 43 cards (`:511-516`). Pressing the info button on card #1 leaves focus on
that button; reaching the dialog's own close button (`:531`) requires tabbing through
every remaining card. Escape does close it (`:196-202`), which is the one thing that
works.

**Fix.** Move focus to the dialog on open and restore it to the info button on close —
the shared hook from F4 covers this.

### F17 — `list-style:none` on the card list may strip list semantics in Safari/VoiceOver
**SC 1.3.1 (A)** · `BestsellerLists.css:118` (`.bestseller-card{list-style:none}`),
`BestsellerLists.tsx:511` (`<ol className="bestseller-list__items">`)

Safari removes list role semantics when `list-style:none` is applied unless an explicit
`role="list"` is present. Because the rank is `aria-hidden` (F7), the `<ol>`'s implicit
"item 3 of 43" announcement is the **only** remaining ordering signal for a non-visual
user — and this is precisely the CSS that can remove it. The trigger is confirmed from
code; the announcement effect needs a live VoiceOver check (§4).

**Fix.** `role="list"` on the `<ol>` and `role="listitem"` on the `<li>`. One-line,
zero risk.

### F18 — Heading levels skip on `/scout/trends` and `/scout/search`
**SC 1.3.1 (A)** · `ScoutPage.tsx:10` → `AudiobookSearch.tsx:115` → `BestsellerLists.tsx:468`

Rendered order on `/scout/trends` is `h1` "Find what belongs next" → **`h3`** "Search
AudiobookBay" → `h2` "Top Bestsellers". The h1→h3 jump skips a level, and the document
then goes *back up* to h2, so heading-based navigation misrepresents the structure —
"Top Bestsellers" reads as a sibling of the page title rather than a peer of the search
panel. `/scout/search` renders `h1` → `h3` with nothing between.

**Fix.** `AudiobookSearch`'s heading should be `h2`. Ideally accept a `headingLevel`
prop, since the component is embedded at two different depths.

### F19 — No skip link; the topbar sits in no landmark
**SC 2.4.1 Bypass Blocks (A), 1.3.1 (A)** · `PreviewApp.tsx:42-63`

No skip-to-content link exists anywhere in the app (grepped). Combined with F1 (focus
never enters `<main>`) and F3 (a duplicated, always-focusable nav on mobile), every
keyboard user re-traverses the navigation on every page.

Landmark structure is also thin: `<header className="v2-topbar">` is nested inside
`<section className="v2-workspace">`, and `<header>` only maps to `banner` when it is
**not** a descendant of `section`/`article`/`aside`/`main`/`nav`. So the topbar — which
holds the command search, the active-job button, "New task", and the settings trigger —
belongs to **no landmark at all** and is unreachable by landmark navigation. There is no
`contentinfo`. Separately, `DeskPage.tsx:319` uses `<aside>` for a dashboard card,
creating a spurious second `complementary` landmark named nothing.

**Fix.** Add a visually-hidden skip link as the first focusable element targeting a
`tabIndex={-1}` `<main id="main">`. Change `.v2-workspace` from `<section>` to `<div>`
so `<header>` becomes a real banner. Change the DeskPage card `<aside>` to `<section>`
or `<div>`.

### F20 — Result cover links are all named "Cover"
**SC 2.4.4 Link Purpose (A)** · `AudiobookSearch.tsx:179-185`

`<a href={r.url} target="_blank"><img alt="Cover" …/></a>` — the anchor's only content
is the image, so every result link's accessible name is the literal string "Cover". A
screen-reader link list on a full page of results reads "Cover, Cover, Cover…". The
adjacent "Download via qBittorrent" buttons (`:209-221`) are similarly identical across
all cards with no per-item context, and the result title (`:188`) is a plain `<div>`
that never enters the tab order.

**Fix.** `alt=""` on the image and put the title in the link
(`aria-label={`${r.title} — open on AudiobookBay (opens in a new tab)`}`); add
`aria-label={`Download ${r.title} via qBittorrent`}` to the button.

### F21 — `AntiBotChallengeModal` is not a dialog
**SC 4.1.2 (A), 2.4.3 (A)** · `features/librarian/components/AntiBotChallengeModal.tsx:9-60`

A full-screen `position:fixed` overlay built from plain `<div>`s: no `role="dialog"`, no
`aria-modal`, no `aria-labelledby` pointing at the `<h3>` (`:36`), no focus move, no
trap, no Escape. The page behind stays fully focusable. The `<iframe>` does have a
correct `title="Cloudflare Challenge"` (`:55`). Lower priority only because it appears
solely on the anti-bot path.

### F22 — `EnhanceMetadataModal` labels are not associated with their inputs
**SC 1.3.1 (A), 4.1.2 (A)** · `features/librarian/components/EnhanceMetadataModal.tsx:68-133`

Five `<label>` elements rendered as *siblings* of their `<input>`s, with no `htmlFor`
and no `id` on the inputs (`:68`/`:69`, `:87`/`:88`, `:106`/`:107`, `:119`/`:120`,
`:130`/`:131`). Visually labelled, programmatically unlabelled. Curate surface, so low
weighting — but a one-attribute fix each.

### F23 — Cover `alt` duplicates the visible title on the desk
**SC 1.1.1 Non-text Content (A), low** · `DeskPage.tsx:328`

`<img src={item.coverUrl} alt={item.title} />` with the same `item.title` rendered as
visible text directly below (`:331`). Announced twice. The bestseller and
recommendation cards get this right (`alt=""` at `BestsellerLists.tsx:359` and
`RecommendationFinder.tsx:145`) — this is the outlier.

### F24 — Emoji as a data indicator
**SC 1.1.1 (A), low** · `ScanResultsReview.tsx:344` — `<span title="Cover image detected">🖼️</span>`.
Announced as "framed picture" with the meaning carried only in a `title` tooltip that
touch users never see.

---

## 4. Needs a live screen-reader pass to confirm

Everything above is confirmed from source or Phase 0 measurements. These are the claims
I could *not* settle without a browser and a screen reader, stated as open questions
rather than findings.

1. **The exact per-card announcement (F7).** The `aria-label` override is certain from
   the name-computation spec; what I could not verify is whether VoiceOver still
   announces list position ("3 of 43") given `list-style:none` (F17). Test on
   Safari + VoiceOver and Chrome + NVDA — the answer decides whether F17 is severe or
   merely tidy-up.
2. **Whether the `role="status"` Suspense fallback (F1) speaks at all.** Mount-time
   live-region behaviour differs materially between NVDA, JAWS and VoiceOver. My claim
   that it is unreliable is spec-reasoning, not observation.
3. **Whether `aria-modal="true"` on the un-trapped bottom sheet (F4) actually strands
   the virtual cursor.** NVDA and VoiceOver enforce `aria-modal` differently; the
   severity of F4 depends on how strictly the browsing context is confined.
4. **iOS VoiceOver and the transform-hidden rail (F3).** I am confident the links stay
   in the DOM tab order (confirmed from CSS), but whether iOS VO's swipe order includes
   an element translated fully off-canvas needs a device check.
5. **Whether the changing submit-button label ("Searching…", `AudiobookSearch.tsx:142`)
   is announced** while the button holds focus. If it is, it partially mitigates F8's
   busy-state gap; if not, the gap is total.
6. **Whether dnd-kit's built-in screen-reader announcements fire at all** given the
   `listeners`/`attributes` split in F9. My analysis says the drag can never start, so
   the announcements are moot — worth confirming by trying to reorder the encode queue
   with a keyboard.
7. **Real focus-obscuring geometry for F6.** The absence of `scroll-padding` is certain;
   the exact proportion of the 43 cards that land under the bottom nav is not.
8. **Reflow at 400% zoom on the description overlay.** I traced the arithmetic
   (`BestsellerLists.tsx:453-464`, clamped by `max()` and `min()` in
   `BestsellerLists.css:256-259`) and it appears to hold at 320px — but the
   `window.innerWidth - 334` / `window.innerHeight - 416` hardcoded dimensions are
   fragile enough to deserve a live check at 320×256.

---

## 5. What passes, and what the type data actually shows

Recorded so the next reviewer does not re-open settled ground.

**Genuinely good, and the pattern to copy elsewhere:**
- `PreviewSettingsDialog.tsx:341-376` — a complete and correct modal implementation:
  stores `document.activeElement`, locks body scroll, focuses the close button, traps
  Tab and Shift+Tab at both ends, handles Escape, and restores focus on unmount. This is
  the reference for F3, F4, F16 and F21.
- `PreviewSettingsDialog.tsx:110-116` — every setting wrapped in a real `<label>`.
- `BestsellerLists.tsx:291-303`, `:475-496` — a correct APG tablist: roving `tabIndex`,
  `aria-selected`, `aria-controls`, Arrow/Home/End with `preventDefault`.
- Cover art is correctly decorative (`alt=""`) on the bestseller and recommendation
  cards, with the name on the wrapping control — the standard failure mode, avoided.
- `RealignPage.tsx:104`, `RecommendationFinder.tsx:120,155-156`,
  `ScanResultsReview.tsx:277` — per-item `aria-label`s and `role="alert"` done right.

**Focus indicator — 1.4.11 passes.** `preview.css`:
`#ui-v2-root :focus-visible{outline:2px solid var(--v2-cyan);outline-offset:3px}`.
Phase 0 measured `--v2-cyan` = `rgb(34,211,238)` at 10.27:1 against the card background
— far above the 3:1 non-text minimum. Every route is inside `#ui-v2-root`
(`PreviewApp.tsx:119`), so coverage is total. The problem with focus in this app is
never that you cannot see the ring; it is where the ring ends up (F1, F2, F3, F6).

**Reduced motion — passes, with one JS hole.** The blanket rule
`@media(prefers-reduced-motion:reduce){#ui-v2-root *,…::before,…::after{…}}` covers
every descendant of the root, and `grep -rn createPortal` over the frontend returns
**nothing** — no component escapes the subtree, so the CSS in `theme.css` and
`features/curator/styles.css` (neither of which has any media query) is still governed
by it. The context doc's concern about "what falls outside" is largely unfounded. The
one real gap is the explicit `behavior:"smooth"` in `AudiobookSearch.tsx:67` (F2),
which by spec overrides CSS `scroll-behavior`.

**Type sizes — 1.4.4 passes on the letter; the finding is legibility, not conformance.**
I traced Phase 0's "75 leaf text elements below 12px" to source and they resolve almost
exactly:

| Measured | Count | Source |
|---|---|---|
| 10.88px | 65 | `.bestseller-card__badge{font-size:0.68rem}` — `BestsellerLists.css:212` |
| 9px | 5 | `.v2-bottom-nav a span{font-size:9px}` — 5 bottom-nav items |
| 11px | 3 | `.v2-eyebrow,.v2-kicker` and `.v2-section-divider span` |
| 10px, 11.67px | 2 | `.v2-bottom-nav{font-size:10px}`, one em-relative node |

65 + 5 + 3 + 2 = 75. Both `rem` and `px` text scales under browser page zoom, so 200%
resize without loss of content is achievable and **1.4.4 does not fail**. I will not
report it as a violation. But two things follow that do matter:

- **The 65 badges are the same elements as F7.** The consensus signal is rendered at
  10.88px *and* hidden from assistive technology. It is the least legible text on the
  page and the most information-dense. Fixing F7 fixes both.
- **9px bottom-nav labels** are below any practical legibility floor on a phone at
  arm's length and do not respond to the OS font-size preference (they are `px`, and
  there is no `text-size-adjust` or `rem` basis). Not a conformance failure; a real
  low-vision usability problem on the priority surface.

**1.4.10 Reflow — no finding.** Phase 0 noted the Trends/Recommendations tab strip is
"clipped at the right edge", but `.v2-section-tabs` sets `overflow-x:auto` — it is a
scrollable sub-region, not lost content, and 1.4.10 targets the page rather than
individual containers. The description overlay's positioning arithmetic is clamped by
`max()`/`min()` in CSS and holds at 320px (see §4.8 for the caveat).

**Contrast (1.4.3) and target size (2.5.8) — pass per Phase 0.** The two sub-threshold
nodes are `"Ctrl K"` at 4.35:1 and a disabled control at 1.44:1; disabled controls are
exempt from 1.4.3. `"Ctrl K"` is a 10px `<kbd>` inside the command button
(`PreviewApp.tsx:59`) — a 0.15-ratio miss on a decorative shortcut hint. Worth a
one-line token bump, not worth a finding.

---

## 6. Recommended order of work

Ordered by risk removed per unit of effort, mobile-weighted.

1. **F5, F10, F12 — add the missing labels.** Hours, not days. Removes three Level A
   failures on the acquisition surface.
2. **F6 — two lines of `scroll-padding`.** Removes an entire class of 2.4.11 failure.
3. **F17, F13, F18, F14, F20, F23 — the one-attribute fixes.** A single afternoon.
4. **F8 — make `ToastProvider` a live region and add `role="alert"` in two places.**
   Small, and it restores feedback to the end of the acquisition funnel.
5. **F1 + F2 — route focus management and post-search focus/announcement.** The two
   findings that most determine whether the mobile surface is usable non-visually. Do
   these together; they share the live-region infrastructure.
6. **F4, F3, F16, F21 — extract `useModalDialog` from `PreviewSettingsDialog.tsx:341-376`
   and apply it to all four overlays.** One refactor, four findings.
7. **F7 — rebuild the bestseller card's accessible name from contents.** The highest-value
   single change for screen-reader users, and it simultaneously fixes the 10.88px
   legibility problem if the badges are re-typed while the markup is open.
8. **F9, F11 — dnd-kit activator wiring and verdict focus retention.**
9. **F19 — skip link and landmark structure.**
10. **F15, F22, F24 — tooltip mechanics and the remaining low-severity items.**
