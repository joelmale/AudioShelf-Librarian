# Content & Editorial Review

Role: UX content designer. Read-only pass over every user-facing string in
`apps/frontend/src`, weighted toward `/scout/*` (the mobile acquisition surface).
Ground truth: `.claude/ui-review/context.md` and `docs/ui-review/phase0/index.md`.

---

## Verdict

**This app has two voices, and the good one is losing.**

A real content standard exists in this codebase and it is unusually high. The Desk
readiness strip, `RealignPage`, and the librarian chat's retrieval audit are written by
someone who understands that a system which admits what it doesn't know is more
trustworthy than one that guesses. `readiness.ts:89-96` refuses to print `0%` for a
check that never ran. `RealignPage.tsx:100` refuses to call an unmeasured library
"clean". `LibrarianChatPanel.tsx:86` volunteers that ranking isn't personalized yet.
That is librarian voice: knowledgeable, opinionated, brief, honest.

Everywhere else — and **especially on `/scout/*`, the priority surface** — the app is a
database admin panel with a book theme. Backend error strings print verbatim behind a
severity prefix (`Error:`, `Enhance Error:`, `Rollback Error:`). Nav carries internal
module names. Half the empty states don't exist, and the most important one on the Desk
renders a *server failure* as a calm, reassuring "nothing here" message.

The single most damaging finding is not a bad string; it is an absent one. The stated
job of the mobile surface is capturing intent — "get this" / "not this" / "maybe later"
— in seconds. **A grep of every `.tsx` file in the app finds none of those concepts.**
There is no save, no dismiss, no shortlist, no "already on your shelf" marker, no
vocabulary of any kind for triage. The bestseller card's entire, only, invisible action
is "search a torrent site" (`BestsellerLists.tsx:322-327`, confirmed by Phase 0's
markup capture). The acquisition surface has no language for acquisition.

Second-order but close behind: the empty-state advantage this review had — ABS
disconnected — exposed that **the app cannot tell "empty" apart from "broken"** in three
separate places, and in the worst of them it actively reassures the user that the
failure is normal.

---

## Ranked findings

Ranked by damage to the reader's ability to act and to trust the system. "Loc" is
`file:line` in `apps/frontend/src` unless prefixed `backend/`.

| # | Current string | Loc | Problem | Proposed replacement |
|---|---|---|---|---|
| 1 | *(nothing)* | `BestsellerLists.tsx:314-424` | The card has **no triage action at all** — the whole card is a hidden "search AudiobookBay" button; no save, no dismiss, no maybe-later, no owned marker. No such string exists anywhere in the app. | Card needs three visible controls with real words: **`Find a copy`** (primary), **`Save for later`**, **`Not for me`**. Reuse the verdict vocabulary already proven at `RecommendationFinder.tsx:153-156` ("Noted — more like this" / "Not for me") instead of inventing a fourth dialect. |
| 2 | `No recently added books found.` | `DeskPage.tsx:338` | **An error rendered as an empty state.** `/api/librarian/recently-added` returns 503 `{"error":"ABS not configured"}` (`backend/.../librarian/index.ts:973`), but `DeskPage` never reads `recentlyAdded.isError` — it falls through to the `length === 0` branch. The reader is calmly told their library has no recent additions when in fact the app cannot reach their library. `useRecentlyAdded` (`api.ts:817`) also refetches every 60s, so the lie is refreshed forever. | Branch on `isError` first: **"Can't reach Audiobookshelf, so recent additions are unavailable. → Check the connection in Settings."** Keep `No books have been added in the last 30 days.` for the genuinely-empty case. |
| 3 | `NYT Fiction 0`, `NYT Nonfiction 0` | `BestsellerLists.tsx:283-296`, `:492-494` | A source that is **not configured** renders identically to a source that is *configured and returned nothing*, and identically to a working chart — same chip, same count style, no disabled state. The one honest sentence that explains it (`:507`, "NYT charts need a Books API key in Settings → Discovery" — accurate; that section exists at `PreviewSettingsDialog.tsx:897-912`) is buried behind clicking the very tab whose zero already told you not to bother. | Where the count would be `0` **and** the key is unset, replace the count with the word **`Set up`** and make the chip a link to Settings → Discovery. A zero must never be a silent dead chip. |
| 4 | `Error: {data.error}` · `Enhance Error: …` · `Rollback Error: …` · `Delete Error: …` · `Integration Error: …` | `ScanResultsReview.tsx:114, 122, 135, 140, 158, 161, 186, 189, 214, 217` | **Raw backend text with a log-severity prefix, printed to a human.** Ten sites. Worse: the copy is load-bearing on control flow — `:230` tests `commitMessage.startsWith('Success')` and `:272` tests `.includes('Error')` to pick a colour, so nobody can reword these without breaking the UI. | Separate state from prose: keep a `status: 'ok' \| 'error'` field, and write human sentences — **"Couldn't move 3 files. They're still where they were."** Never prefix a user-facing string with a log level. |
| 5 | `Download via qBittorrent` · `Successfully sent to qBittorrent!` · (toast) `ENOTFOUND qbittorrent` | `AudiobookSearch.tsx:219`, `:105`, `:108` | The primary CTA on the acquisition surface names a piece of the user's **infrastructure**, not the outcome. The success message adds an exclamation mark the librarian voice never uses anywhere else. The failure path toasts a raw Node DNS error. | **`Send to downloads`** / **"Sent to downloads. Track it on the Desk."** / on failure: **"Couldn't reach your download client. → Check qBittorrent in Settings."** |
| 6 | `Scout & Acquire` | `PreviewApp.tsx:18`, `:96`, `ScoutPage.tsx:10` | An **internal name that escaped**, and it is the label on the mobile priority tab. `preview.css` renders bottom-nav labels at **9px with `max-width:64px`** across 5 columns — "Scout & Acquire" cannot fit on one line at that size and wraps or clips. Ampersand-pair labels are a desktop-IA habit; a phone tab needs one word. | **`Discover`** (or `Find`). One word, fits 64px, says what the reader does. "Acquire" survives as the verb on the action, not the tab. |
| 7 | `Librarian History` / `Curator Logs` | `UnifiedLogsPage.tsx:22-23` | **Two backend module names promoted to tabs**, and one of them collides head-on with the product's central metaphor. "Librarian" means the assistant everywhere else ("Ask your librarian", `PreviewApp.tsx:59`); here it means bulk folder moves. A user who clicks "Librarian History" expecting their conversations gets a file-move audit log. | **`File moves`** and **`Background jobs`**. Then free "Librarian" to mean only the assistant. (Note: the assistant's *actual* conversation history is a `<select>` at `LibrarianChatPanel.tsx:381`, findable nowhere from this page.) |
| 8 | `Evidence-backed recommendations and live work across your sidecar.` | `DeskPage.tsx:200` | The **second line a first-time user reads** contains a deployment-topology word. "Sidecar" also appears in Settings (`PreviewSettingsDialog.tsx:743`, "Sidecar connection"). No listener knows what a sidecar is. | **"Recommendations you can check, and every job running right now."** |
| 9 | `External metadata found` · `Grounded entities` · `Tagged at current schema` · `Embedded` · `Enrichment attempted` | `backend/.../curator/core/readiness.ts:343-390`; rendered `DeskPage.tsx:94-102` | Under the heading **"What I know about your shelf"** — perfect librarian voice — sit five chips written in engine-schema vocabulary. "Tagged at current schema" and "Embedded" are meaningless to the person being asked to trust them. The hover detail is worse: `readiness.ts:89` surfaces `note`, which in the empty state reads **"No books have been synced into the mirror yet"** — "mirror" appears nowhere else in the reader's UI except `DeskPage.tsx:318`. | Chip labels: **`Extra details found`**, **`Characters & places`**, **`Tagged`**, **`Ready for mood search`**, **`Lookups run`**. Keep the counts and the honest `Unknown`. |
| 10 | `Loading bestsellers…` | `BestsellerLists.tsx:429` | Phase 0 measured **several seconds** of a single centred line of text on the priority route, with no skeleton and no sense of what is happening. Three external charts are being fetched; the user is told none of that. | Narrate: **"Checking Audible, AudiobooksNow and Apple Books…"** — and render the tab strip and 8 card skeletons immediately so the page has shape. |
| 11 | `ABN #1` | `BestsellerLists.tsx:38`, rendered `:390` | An **unexplained abbreviation** on the priority mobile surface. The only place "ABN" is expanded is the `title=` attribute at `:388` (`#1 on AudiobooksNow`) — **a hover tooltip, which does not exist on touch.** So on the exact device this surface is for, "ABN" is unexpandable. Phase 0 measured these badges at `#9aa6bd`, ~10.88px. | Drop `shortLabel` entirely; the badge has room for **`AudiobooksNow #1`** at 43 cards × one row. If it doesn't, cut the rank number before you cut the source name — the source is the signal, the exact rank is not. |
| 12 | `Top Bestsellers` (twice, stacked) | `ScoutPage.tsx:17` (section divider) immediately followed by `BestsellerLists.tsx:468` (`<h2>`) | The **same heading renders twice in a row**, ~8px apart. Also Title Case, against sentence case everywhere else on the v2 shell. | Delete the `v2-section-divider` at `ScoutPage.tsx:17`; keep the component's own `<h2>` and lowercase it to **`Bestseller charts`** (matching the tablist's own "All charts"). |
| 13 | `Find what belongs next` (trends) · `Find what to add next` (recs) · `What should you add to the shelf?` (recs card) · `What should you listen to next?` (desk chat) | `ScoutPage.tsx:10`, `RecommendationFinder.tsx:110`, `LibrarianChatPanel.tsx:381` | **Four near-identical questions for three different jobs.** "Find what belongs next" and "Find what to add next" are one word apart and sit on adjacent tabs; nothing in the words tells the reader which one searches their shelf and which one searches the world — even though that distinction is the app's whole architecture (documented at length in `RecommendationFinder.tsx:6-33`). | Make the split legible in the heading: trends → **`What the charts are pushing`**; recommendations → **`Books you don't own yet`**; desk chat → keep **`What should you listen to next?`** (it is the only one of the four that is good, and it correctly owns the owned-shelf question). |
| 14 | `Search acquisition sources` (h1) over `Search AudiobookBay` (h3) | `ScoutPage.tsx:10`, `AudiobookSearch.tsx:115` | The page heading **euphemises** what the panel eight pixels below states plainly. Corporate hedging directly above the plain truth reads as evasive, not discreet. | Say it once: h1 **`Search AudiobookBay`**, and delete the h3. If the source set later grows, plural it then. |
| 15 | `Commit {n} Changes` · `Committing...` · `Undo Last Run` · `Rolling back...` · `Plan Only — Changes Locked` | `ScanResultsReview.tsx:240, 255-257` | **Git vocabulary in an audiobook app.** "Commit", "rollback", "run" describe the implementation, not the user's intent (moving files into the right folders). Title Case on `Undo Last Run` / `Commit … Changes` breaks the shell's sentence case. | **`Move {n} books`** · `Moving…` · **`Undo these moves`** · `Undoing…` · **`Preview only — nothing will move`**. |
| 16 | `Quarters Chunking` · `Build Safe Plan` · `Start New Scan` · `Recent ingest jobs` | `ScannerControl.tsx:70, 94, 42, 96` | **Raw internal vocabulary in a user-facing `<select>` and buttons.** "Quarters Chunking" is a scheduling strategy name with no reader-facing meaning; "ingest" is pipeline vocabulary. | `Quarters Chunking` → **`Spread across the folder`** (or cut the option); `Build Safe Plan` → **`Preview the plan`**; `Start New Scan` → **`Scan a folder`**; `Recent ingest jobs` → **`Recent scans`**. |
| 17 | `Library book` + a raw ABS UUID | `LibrarianChatPanel.tsx:101` | Under the heading "Candidates found", each candidate renders the literal words **"Library book"** followed by its **database id**. The reader is shown a primary key and told nothing about the book. | Resolve the title, or cut the section. A pile of UUIDs is worse than no disclosure — it reads as debug output that shipped. |
| 18 | `{score} Duplicates` next to `Metadata ({score}%)` and `Files ({score}%)` | `HealthReportPage.tsx:99` vs `:49, :63` | The **same field name renders as a percentage in two adjacent cards and as a raw count in the third** (`backend/.../librarian/index.ts:1054` stores a count in `duplicates.score`). The reader has no way to know which they're looking at. The page is also the app's Title Case outlier throughout — `Diagnostic Report`, `Overall Health Score`, `Open Encoder`. | **`{n} possible duplicates`**, and sentence-case the page (`Health report`, `Overall score`, `Open the encoder`). |
| 19 | `action.label.replaceAll('_', ' ')` | `LibrarianChatPanel.tsx:28` | The fallback for the research trail prints the **raw backend tool name** with underscores swapped for spaces. `ACTION_LABELS` (`:26`) maps only five tools; any sixth ships its internal identifier to the reader mid-conversation. | Keep the map as the only source, and fall back to a neutral **`Checked the library`** rather than to an identifier. |
| 20 | Toasts auto-dismiss after 4500ms, no `role` | `toast.tsx:18, 23-30` | **Every failure whose only channel is a toast disappears in 4.5 seconds** and is announced to nobody: the download failure (`AudiobookSearch.tsx:108`), the realign failure (`RealignPage.tsx:45`), the re-tag failure (`BookDetail.tsx:20`), scan warnings (`IntakePanel.tsx:24`). | Error and warning toasts must persist until dismissed and carry `role="alert"`; only `success`/`info` should auto-expire. |
| 21 | `Searching...` `Sending...` `Starting...` `Committing...` `Analyzing files...` `Rolling back...` `Loading health report...` `Scanning library for mismatches...` vs `Loading bestsellers…` `Researching` `Checking your library…` | 8 sites in `AudiobookSearch.tsx` / `ScanResultsReview.tsx` / `ScannerControl.tsx` / `HealthReportPage.tsx:20` / `RealignPage.tsx:78` vs the v2 files | **Three-dot ASCII vs the `…` character, split cleanly along the old-surface / new-surface line.** Visible as different letter-spacing on the same screen (`/scout/trends` renders both). | One character: `…` everywhere. Mechanical fix, and it makes the two eras stop advertising themselves. |

---

## Empty & error state inventory

**Legend:** ✅ present and actionable · ⚠️ present but no next action, or wrong tone
· ❌ missing, or misrepresents the situation.

### Empty states

| Surface | State | Current copy | Loc | |
|---|---|---|---|---|
| Desk — recently added | No books | `No recently added books found.` | `DeskPage.tsx:338` | ❌ **also renders on a 503.** See finding #2 |
| Desk — active work | Nothing running | `Everything is quiet` / "No scan, curation, or conversion job is currently running." / link → M4B candidates | `DeskPage.tsx:279` | ✅ best empty state in the app: names the state, offers a next step |
| Desk — task queue | No jobs | `No conversion jobs queued.` | `DeskPage.tsx:319` | ⚠️ no next action |
| Desk — recent audit | No entries | *(nothing renders; the `<h3>Recent audit</h3>` stays, orphaned)* | `DeskPage.tsx:319` | ❌ a bare heading over blank space |
| Desk — acquisition pipeline | Each of 4 stages | "No transfers in progress" / "Inbox is caught up" / "Nothing needs attention" / "Nothing shelved today", all under "Waiting for the next book" | `DeskPage.tsx:183-186, 304` | ✅ four distinct, well-judged strings — no generic reuse |
| Desk — readiness strip | Query errors or no chips | *component returns `null`* | `DeskPage.tsx:88` | ⚠️ silent disappearance; the reader can't tell it failed from it not existing |
| Scout/trends — a chart | Source returned nothing | "No titles are currently available from this source." | `BestsellerLists.tsx:508` | ⚠️ no cause, no next action |
| Scout/trends — NYT charts | Key not configured | "No titles available. NYT charts need a Books API key in Settings → Discovery." | `BestsellerLists.tsx:507` | ✅ copy is right — but unreachable until you click a chip that says `0`. See #3 |
| Scout/search | **First run, no query** | *(nothing — bare form over an empty grid)* | `AudiobookSearch.tsx:167-227` | ❌ **missing entirely.** The primary acquisition route opens with no guidance |
| Scout/search | Query returned nothing | `No results found.` | `AudiobookSearch.tsx:225` | ⚠️ no next action (try fewer words / drop the subtitle / change category) |
| Scout/recommendations | **First run** | *(composer only)* | `RecommendationFinder.tsx:107` | ⚠️ the three example chips at `:37-41` do most of the work; acceptable |
| Scout/recommendations | Nothing cleared verification | "Nothing new cleared verification… an empty result means 'not proven' rather than 'nothing exists'." | `RecommendationFinder.tsx:164` | ✅ excellent — honest about *why*, distinguishes absence from failure |
| Scout/intake | **Nothing to review** | *(`return null` — the whole panel vanishes; page shows only a collapsed accordion)* | `ScanResultsReview.tsx:223` | ❌ **the app's worst dead end.** The page heading promises "Review intake conflicts" and then shows nothing at all. Needs: "Nothing needs a decision. New files are shelved automatically." |
| Desk chat | **First run, no history** | *(composer only; the `<select>` reads "No saved conversations yet")* | `LibrarianChatPanel.tsx:381` | ⚠️ no example prompts, unlike the Scout composer which has three (`RecommendationFinder.tsx:37`). The better surface has the worse onboarding |
| Desk chat | Answered, no shelf match | "I couldn't find a shelf match I could support from the available evidence." | `LibrarianChatPanel.tsx:169` | ✅ voice is right; and `:328-332` auto-loads the acquire section, so there is a next step |
| Desk chat | Acquire returned nothing | "No external candidates could be verified against your request." | `LibrarianChatPanel.tsx:217` | ✅ |
| Curate/books | No results | `No books match these filters.` | `Books.tsx:149` | ❌ **wrong in the zero-book case** — with ABS unconnected there are no filters to blame. Needs a first-run branch: "Nothing synced yet. → Sync from Audiobookshelf" |
| Curate/collections | No collections | `No {tab} collections.` | `Collections.tsx:225` | ⚠️ string-interpolated ("No proposed collections."), no next action |
| Curate/realign | Aligned | "Measured and aligned" / "Every measured, eligible book follows its confirmed library convention." | `RealignPage.tsx:99` | ✅ |
| Curate/realign | Aligned but coverage-gated | "No moves can be proposed yet" / "At least one library was not measured, so this is not an 'all clean' result." | `RealignPage.tsx:100` | ✅ **the best-written string in the app.** Refuses a false all-clear |
| Book detail | No tags | `No tags yet.` | `BookDetail.tsx:82` | ⚠️ the "Re-tag" button exists but the empty state doesn't point at it |
| Bestseller description | No description found | `No description available.` | `BestsellerLists.tsx:62` | ⚠️ acceptable |

### Error states

| Surface | Current copy | Loc | |
|---|---|---|---|
| Desk — library health | "Couldn't read library health." + `(error as Error).message` | `DeskPage.tsx:231-235` | ⚠️ good headline, then prints the raw backend string underneath. No retry control |
| Desk — grounding residual | "The grounding report could not be loaded." | `DeskPage.tsx:115` | ⚠️ no retry, no cause |
| Desk — sync | `toast(e.message)` | `DeskPage.tsx:177` | ❌ raw backend text, auto-dismissed in 4.5s |
| Desk chat — stream failed | `state.error` verbatim, with an **`Ask again`** button and the research trail preserved | `LibrarianChatPanel.tsx:161-167` | ✅ **model error handling** — the retry, and keeping the partial work visible, are exactly right. Only the message text is unfiltered |
| Desk chat — history load | "Could not load conversation history." + `Retry` | `LibrarianChatPanel.tsx:270, 381` | ✅ |
| Desk chat — acquire failed | `acquire.error` + `Retry` | `LibrarianChatPanel.tsx:205` | ✅ shape right, message raw |
| Scout/trends — chart fetch | `Error loading bestsellers: {error}` | `BestsellerLists.tsx:440` | ❌ "Error loading X: Failed to fetch bestsellers" — a severity prefix, a restatement, and no retry. On the priority route |
| Scout/trends — description | `Failed to load description.` | `BestsellerLists.tsx:268` | ⚠️ minor |
| Scout/search — search | raw `err.message` | `AudiobookSearch.tsx:161-165` | ❌ unstyled div, no retry |
| Scout/search — download | `toast(err.message)` → `ENOTFOUND qbittorrent` | `AudiobookSearch.tsx:108` | ❌ raw DNS error, gone in 4.5s. See #5 |
| Scout/intake — 10 error paths | `Error:` / `Enhance Error:` / `Rollback Error:` / `Delete Error:` / `Integration Error:` + raw text | `ScanResultsReview.tsx:114-217` | ❌ See #4 |
| Scout/intake — partial commit | "{n} of {m} actions failed and were left in place." + per-file list + "These files were not moved and remain selected so you can retry them." | `ScanResultsReview.tsx:87, 276-296` | ✅ excellent — states the blast radius and preserves the retry selection. "actions" should be "files" |
| Curate/realign — scan/execute | `AlertTriangle` + message, expiry warning, coverage-gate explanation naming the libraries and the fix | `RealignPage.tsx:79-81, 97` | ✅ best error copy in the app; `:97` names the blocked libraries *and* where to fix it |
| Book detail — not found | `Book not found.` | `BookDetail.tsx:24` | ❌ dead end — the guard returns before the back link renders, so there is no way out but browser-back |
| Route chunk load fails | *(nothing — `Suspense` has no error boundary at this level)* | `PreviewApp.tsx:24` | ❌ `PreviewErrorBoundary.tsx` exists; verify it wraps these |
| Global connection lost | rail shows `Audiobookshelf / Unavailable`; topbar always shows `Live system` regardless | `PreviewApp.tsx:52` vs `:58` | ❌ **contradictory.** The mobile topbar hardcodes `<span className="v2-dot ok"/> Live system` with no state binding, so on a phone the app claims to be live while the backend is unreachable |

### Loading states

| Surface | Copy | Loc | |
|---|---|---|---|
| Route transition | `Loading Scout…` / `Loading recommendations…` / `Loading M4B candidates…` | `PreviewApp.tsx:24, 66-80` | ⚠️ **the labels are inconsistently cased** — `"Scout"`, `"Curate"` capitalised; `"recommendations"`, `"intake"`, `"book details"`, `"library health"` lowercase. Same sentence, two conventions |
| Bestsellers | `Loading bestsellers…` (several seconds, no skeleton) | `BestsellerLists.tsx:429` | ❌ See #10 |
| Librarian turn | "Following the evidence through your shelf…" + live research trail | `LibrarianChatPanel.tsx:160, 96` | ✅ **the standard the rest of the app should meet.** The long wait is narrated by a growing list of what the engine actually did |
| Acquire lookup | "Checking what could be pulled in…" | `LibrarianChatPanel.tsx:204` | ✅ |
| Recommendation submit | "Looking beyond your shelf…" | `RecommendationFinder.tsx:123` | ✅ |
| Library health | "Checking your library…" | `DeskPage.tsx:223` | ✅ |
| Grounding residual | "Measuring the ungrounded remainder…" | `DeskPage.tsx:114` | ⚠️ "ungrounded remainder" is engine vocabulary |
| Scan commit | `Moving {n} of {m}: {filename}` | `ScanResultsReview.tsx:256` | ✅ specific and honest |
| Intake progress | `Status: Discovering` / `...` / `Ready…` | `IntakePanel.tsx:31-34` | ⚠️ "Status:" prefix is admin-panel; and `'...'` vs `'Ready…'` mixes both ellipsis forms *in the same component* |

---

## Terminology drift

One concept, five words. This is the clearest evidence that no content owner exists.

| Concept | Words in use | Locations |
|---|---|---|
| The user's book collection | **shelf** · **library** · **catalog** · **mirror** · **canonical library** | `LibrarianChatPanel.tsx:172` / `DeskPage.tsx:223` / `LibrarianChatPanel.tsx:26` / `DeskPage.tsx:318` + `backend/readiness.ts:236` (surfaces as chip hover) / `HealthReportPage.tsx:16` |
| Converting to M4B | **Needs M4B** · **M4B conversion** · **M4B candidates** · **Convert** · **Open Encoder** · **Task queue** | `CuratePage.tsx:15` / `:45` / `PreviewApp.tsx:74` / `PreviewApp.tsx:105` / `HealthReportPage.tsx:70` / `DeskPage.tsx:319` |
| Fixing folder structure | **Realign** · **Directory organization** · **Review proposed changes** · **Proposed moves** · **Review alignment** · **Execute moves** | `CuratePage.tsx:17` / `DeskPage.tsx:281` / `DeskPage.tsx:284` / `RealignPage.tsx:64` / `HealthReportPage.tsx:88` / `RealignPage.tsx:73` |
| Reviewing new files | **Intake** · **Intake review** · **Action Required / Conflicts** · **Scan** · **ingest** | `PreviewApp.tsx:103` / `ScoutPage.tsx:15` / `ScanResultsReview.tsx:228` / `ScannerControl.tsx:42` / `ScannerControl.tsx:96` |
| The assistant | **Librarian** (assistant) · **Librarian** (folder-move module) · **Curator** (background jobs) | `PreviewApp.tsx:59` / `UnifiedLogsPage.tsx:22` / `UnifiedLogsPage.tsx:23` |

Casing is drifting on the same axis: the v2 shell is sentence case (`Find what belongs next`, `Needs review`), the older surfaces are Title Case (`Top Bestsellers`, `Diagnostic Report`, `Start New Scan`, `Undo Last Run`, `All Categories`, `Overall Health Score`, `Librarian History`).

---

## Nav & heading verdict, as asked

| Label | Loc | Verdict |
|---|---|---|
| **Desk** | `PreviewApp.tsx:18` | ⚠️ **Borderline.** It is a coherent metaphor (the at-the-desk job in `context.md`) and it is short enough for the 9px mobile slot. But nothing on the page uses the word again, so it is a metaphor with no support. Keep it only if the Desk page starts saying "desk"; otherwise `Home`. |
| **Scout & Acquire** | `PreviewApp.tsx:18, 96` | ❌ **Escaped internal name.** Both halves are project vocabulary; the ampersand pair is a desktop IA habit; and it will not fit a 9px/64px mobile tab. → **`Discover`**. |
| **Curate** | `PreviewApp.tsx:19` | ⚠️ **Meaningful but wrong register.** "Curate" is what a librarian does, so the voice is right — but as a *navigation destination* it doesn't say what's behind it. The page's own h1 ("Shape and refine the library") is clearer than the tab. → **`Library`**. |
| **Activity** | `PreviewApp.tsx:20` | ✅ **Fine.** Standard, short, honest. Its sub-tabs are the problem (#7), not the label. |
| **Find what belongs next** (`/scout/trends`) | `ScoutPage.tsx:10` | ⚠️ **Nicely written, wrong page.** "Belongs" implies fit with the shelf — an owned-library judgement the trends page cannot make; it shows raw external charts with no library-awareness at all. The promise is one the surface can't keep. → **`What the charts are pushing`**. |
| **Search acquisition sources** (`/scout/search`) | `ScoutPage.tsx:10` | ❌ **Euphemism, and a plural that isn't true** — there is exactly one source, named plainly eight pixels below (#14). → **`Search AudiobookBay`**. |
| **Find what to add next** (`/scout/recommendations`) | `ScoutPage.tsx:10` | ❌ One word from the trends heading; carries no information about which surface does what (#13). |
| **Review intake conflicts** (`/scout/intake`) | `ScoutPage.tsx:10` | ✅ Clear and specific; the supporting line ("New files are shelved automatically. Only duplicates, ambiguous matches and errors land here") is genuinely good. Undermined only by the missing empty state (inventory ❌). |

---

## The bestseller card: what to keep, what to cut

Per Phase 0: card is 362×90 at 390px, one per row, 43 of them, no virtualization.

| Field | Loc | Verdict |
|---|---|---|
| Cover, 52×52 square | `BestsellerLists.tsx:356-361` | **Keep, fix the shape.** A square crop of book art is the one visual that says "book"; square says "app icon". Phase 0: ~1008 KB of 500×500 images to fill 52×52. |
| Title | `:372-374` | **Keep.** Phase 0 records mid-word truncation ("The Dungeon Anarchist's Coo…") — allow two lines; a title is the whole decision. |
| Author | `:375-377` | **Keep.** |
| List rank `#1` | `:316-318` | **Cut.** It is `aria-hidden`, it duplicates the ordered-list position, and on the "All charts" tab it is a *consensus* rank the user has no model for — while the badges below already carry the real per-chart ranks. Two competing rank systems on a 90px card. |
| Source badges | `:378-395` | **Keep the sources, cut the ranks.** "On Audible and Apple" is the signal that survives a glance; "#1 / #7" is precision the reader can't act on. And expand ABN (#11). |
| Description | `:519-541` | **Keep as the info button** (44×44, correctly sized). But it fetches iTunes from the browser on hover/focus — noted for the performance reviewer, not this one. |
| **Series / "book 3 of 7"** | *absent* | **Add.** Phase 0: Matt Dinniman occupies #8, #10, #11, #13, #14 with no dedupe and no series marker. Five cards of one series with nothing saying so is the densest waste on the surface. |
| **"Already on your shelf"** | *absent* | **Add** (not observable locally — trace in code). The single highest-value field for an acquisition surface, and it does not exist. |
| **Length** | *absent* | **Add if cheap.** `duration()` already exists in two components; hours is a real acquisition constraint for a listener. |

---

## Open questions

1. **Is "Desk" load-bearing?** Nothing on `/desk` uses the word. If the metaphor isn't going to be developed, `Home` costs nothing and explains itself. Product call, not a content call.
2. **Does the bestseller card have a library-state marker in the data?** Not observable locally (ABS disconnected). If `/api/librarian/bestsellers` doesn't carry an owned flag, finding #1's "already on your shelf" is a backend change, not a copy change — worth knowing before it lands on a roadmap as microcopy.
3. **Are NYT charts unconfigured or broken?** Phase 0 shows `0` for both. `BestsellerLists.tsx:507` assumes "no API key". If the charts can also return zero *with* a valid key, finding #3 needs a third state, and the frontend has no way to tell them apart from the current response shape.
4. **Is `commitMessage` string-matching (`ScanResultsReview.tsx:230, 272`) load-bearing anywhere else?** Any rewrite of those ten strings silently changes UI behaviour. This should be flagged to whoever owns that component before copy work starts.
5. **Where should conversation history live?** It is a `<select>` inside the Desk chat panel (`LibrarianChatPanel.tsx:381`) while "Activity" owns a tab called "Librarian History" that means something else entirely. Resolving #7 probably means moving one of them.
6. **Does the app ever intend to sound like a librarian to a *first-time* user?** Every genuinely good string in this app (`RealignPage.tsx:100`, `RecommendationFinder.tsx:164`, `LibrarianChatPanel.tsx:86`) is about **admitting uncertainty**. That is a strong, coherent, unusual voice. Nothing in the onboarding, nav, or acquisition surface carries it. The voice exists; it just hasn't been applied to the surfaces a new user meets first.
