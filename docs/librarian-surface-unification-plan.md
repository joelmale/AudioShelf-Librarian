# Librarian surface unification (UX recs 1 & 2)

One job — "tell me what to listen to next" — currently has two front doors
with different affordances, different failure modes, and different quality.
This plan merges them and removes the scope toggle that forces a choice before
the user has seen anything.

Written 2026-08-28 as a handoff. Read `docs/librarian-engine-plan.md` §5.3
(Surfaces) and §8 (The Librarian's Desk) before starting; this plan is
subordinate to both and does not change the retrieval engine at all.

---

## 1. Why this is worth doing

§10.L already recorded the underlying problem: the app shipped **two
recommendation engines and the weaker one owned the better UI.** The engines
were unified — Scout and the Desk both retrieve through the same five
registered tools now — but the *surfaces* were never merged. So:

- `/desk` (`LibrarianChatPanel`) — conversational, persisted, streams over
  SSE, has history and follow-ups. The model authors its own tool calls.
- `/scout` (`RecommendationFinder`) — a form: prompt, seed books, scope
  toggle. One shot, no persistence, no follow-up.

They answer the same question and a user has no way to know which will do
better. On 2026-08-28 the Desk returned "This librarian request did not
complete" for a query Scout answered well. That asymmetry is invisible from
the UI.

**Non-goal.** This is a surface change. Do not modify `core/librarian/tools.ts`,
`ranker.ts`, `tagResolution.ts`, or `recommendations.ts` retrieval behaviour.
If you find yourself editing retrieval to make the UI work, stop and raise it.

---

## 2. Rec 1 — one "Ask the Librarian" surface

### 2.1 Target shape

One surface, reachable from both `/desk` and Scout, built on the **Desk's**
conversational spine because it is strictly the more capable of the two: it
persists, it supports follow-ups, and it already has the §8.1 SSE event
contract behind it.

`RecommendationFinder`'s distinctive inputs do not disappear — they become
**structured openers** on that one surface:

| Today (Scout form) | Becomes |
|---|---|
| free-text prompt | the composer, unchanged |
| "Inspired by" seed books | a seed chip row above the composer, sent with the first turn |
| scope toggle | removed — see §3 |
| "Recommend books" submit | the composer's submit |

### 2.2 Sequencing — this is the risky part

Do NOT delete `RecommendationFinder` in the same change that moves its
features. The two surfaces call different backends (`POST /recommendations`
vs `POST /librarian/chat`) with different result shapes, and the chat path is
the one with the open reliability question. Land it in this order, each step
independently shippable and revertible:

1. **Seeds on the chat path.** Add optional seed book ids to
   `POST /librarian/chat`. The driver already accepts owned anchors via
   `get_book`/`find_similar` (§5.2 archetype 2); seeds become a prefixed
   instruction plus a pre-resolved id list, never free text the model must
   parse. Ship this with Scout untouched.
2. **Card parity on the Desk.** The Desk currently renders a minimal answer
   list. Bring it up to the Scout card: cover, duration, reason, matched tags,
   thumbs, and the retrieval audit line. All of that data already exists in
   the answer events — see §4.
3. **Point Scout's panel at the unified surface.** Replace
   `RecommendationFinder`'s form with a compact entry that deep-links to the
   Desk with the prompt and seeds prefilled. Keep the route working.
4. **Only then** consider removing `POST /recommendations`. It is still the
   more reliable path today, and it owns impression logging and the external
   (acquire) half. Removing it is a separate decision with its own evidence,
   **not part of this plan.**

### 2.3 The external half is a real obstacle — read this before designing

Scout returns `available` (iTunes-verified acquirable books). The Desk
**cannot**: §5.4 rule 3 and driver prompt rule 10 both state the chat loop
emits no external recommendations, and that is deliberate — the loop has no
verification path, so an external suggestion from it would be unverifiable
prose.

So a naive merge would silently drop Scout & Acquire's acquire half. Options,
in the order the implementer should consider them:

- **(a) Keep the acquire half on Scout**, fed by a separate call to the
  existing verified path, and let the unified surface own only owned-shelf
  answers. Least invasive, preserves §5.4 rule 3 exactly.
- **(b) Add a verified external step to the chat loop** — a real feature with
  its own verification contract, not a UI change. Out of scope here.

**Default to (a) unless Joel says otherwise.** Do not quietly drop the acquire
half; if you cannot preserve it, stop and report.

---

## 3. Rec 2 — remove the scope toggle

### 3.1 What is wrong with it

`both / shelf / discover` is implementation vocabulary on a control that
forces a decision *before any results exist*. Worse, `discover` structurally
returns zero shelf results (`recommendations.ts` returns `[]` for `onShelf`
under that scope) — §10.L defect 2 recorded this as a real user-facing bug
when `discover` was the default.

### 3.2 Target behaviour

- **Always retrieve the shelf.** Owned books are the point of the product.
- Render **"On your shelf"** first, always.
- Render **"Could be acquired"** as a clearly separated section below it,
  fetched lazily and only when the shelf section is thin or the user asks.
- Scope becomes a **filter on results already shown**, not a gate on the
  query — or disappears entirely if the two sections make it redundant.

### 3.3 Compatibility constraints

- `POST /recommendations` keeps accepting `scope`; this is a UI change. Do not
  break the API for the MCP surface or any saved client.
- `settings.recommendationScope` currently seeds the toggle's initial value
  (`RecommendationFinder` reads it on mount). If the toggle goes, decide
  deliberately whether the setting stays meaningful; if it does not, remove it
  from the settings dialog in the same change rather than leaving a dead
  control.
- The default when scope is omitted is already `both` — §10.L fixed that.
  Keep it.

---

## 4. What already exists — do not rebuild it

The implementer will be tempted to add backend fields that are already there:

| Need | Already available |
|---|---|
| why a book matched | `ShelfRecommendation.matchedTags` |
| model's sentence was wrong | `ShelfRecommendation.reasonReplaced` |
| how many books searched/considered | `RecommendationResult.retrieval.candidateCount` / `.evidenceCount` |
| query wording rewritten | `retrieval.tagResolution` |
| a required tag was softened | `retrieval.relaxation` |
| taste applied to ranking | `retrieval.personalized` |
| feedback capture | `POST /api/feedback`, and the thumbs in `RecommendationFinder` |
| slate identity for feedback | `RecommendationResult.slateId` |
| conversation persistence, history, follow-ups | `GET /api/librarian/conversations` |

The Desk's answer events carry book ids and reasons; card parity (§2.2 step 2)
is mostly a matter of hydrating those ids, not of new API surface.

---

## 5. Known open defects that touch this work

Do not treat these as caused by the change; they exist now.

1. **The Desk failed with "This librarian request did not complete"** on
   2026-08-28. That string only appears when a turn is replayed with no
   terminal event (`librarianChat.ts:247`), which points at the process dying
   mid-turn rather than a model or tool error — those persist cleanly as
   `error{stage}` events. Diagnose before building card parity on that path.
2. **The librarian path logs nothing.** Neither `routes/librarian.ts` nor
   `core/librarian/conversation.ts` references `actionLog` or `logger`, so
   nothing reaches `/api/system/logs` or the activity feed, and the loop's
   measured `tokensUsed` is discarded. Adding `librarian_turn_started` /
   `_tool_call` / `_finished` / `_failed` via the existing `ActionLog` is a
   small, separable prerequisite that makes step 1 diagnosable. **Do this
   first.**
3. **Q1 does not meet its §10.L exit criterion.** With embeddings backfilled,
   the Key West query returns plausible mysteries but rank 1 is not a Key West
   Capers title. That is a ranking/expectations question for Joel, not a UI
   one. Do not tune weights to make the UI look better.

---

## 6. Acceptance

- Both entry points reach one surface; asking the same question in either
  place produces the same answer from the same engine.
- No scope decision is required before results appear; owned books are always
  shown first.
- The acquire half still works, or its removal was explicitly approved.
- The retrieval audit, matched tags, and thumbs are present on the unified
  cards.
- A failed turn shows what was retrieved before it failed and offers a retry.
- `npm run typecheck`, `npm run lint` (0 errors), and both test suites pass.
- No change to files under `core/retrieval/` or `core/librarian/tools.ts`.

Per AGENTS.md every implementation slice gets an adversarial read-only
reviewer pass, and passing tests are not proof unless the test fails when the
behaviour is removed.

---

## 7. Implementation status (2026-08-29)

Implemented in the order §2.2 requires.

- **§5 item 2 — logging, first.** `POST /librarian/chat` now records
  `librarian_turn_started` / `_tool_call` / `_finished` / `_failed` through the
  existing `ActionLog`, keyed on the **turn** id, so
  `GET /api/system/logs?operationId=<turn>` is the whole story of one turn and
  the loop's measured `tokensUsed` is no longer discarded. Ids, counts,
  timings, and a failing tool's own error message — never the question, a
  tool's input, or a recommendation (see the trade-off note below).
  `runConversation` gained an optional `ConversationToolLog` seam for the
  per-call half; a logger that throws cannot cost the user an answer.
- **§2.2 step 1 — seeds.** `POST /librarian/chat` accepts `seedBookIds` (max
  8), resolves them against the library, and rejects an unknown id with a 400
  before the stream opens. The driver receives resolved anchors in a labelled
  prompt block. A seed is a pointer, not evidence: it does not enter the
  answer's evidence allowlist, so the model must still retrieve it.
- **§2.2 step 2 — card parity.** The answer event carries optional
  `durationSeconds` and `matchedTags`, hydrated from book cards that crossed
  the tool boundary. A new `retrieval` event carries `search_semantic`'s own
  measured `candidateCount` / `evidenceCount` / `semanticScored` /
  `personalized` / `tagResolution` / `relaxation`. Both are additive and
  optional, so turns persisted before them still replay.
- **§2.2 step 3 — one surface.** `LibrarianChatPanel` is the unified surface:
  seed chips beside the composer, Scout-anatomy shelf cards with thumbs, the
  retrieval audit, an "Ask again" retry that keeps the failed turn's research
  trail, and a `?q=`/`?seeds=` deep link. `RecommendationFinder` is now the
  compact Scout opener that hands both across; `/scout/recommendations` still
  works.
- **§2.3 option (a) — the acquire half is preserved.** "Could be acquired" is
  a separate section below the shelf answer on the unified surface, fetched
  from the existing verified `POST /recommendations` (`scope: 'discover'`)
  automatically when the shelf answer is empty and on request otherwise. The
  chat loop still emits nothing external, so §5.4 rule 3 is untouched.
- **§3 — the scope toggle is gone**, and with it the now-dead
  `recommendationScope` control in the settings dialog. The setting stays in
  the shared schema and `POST /recommendations` still accepts `scope`, so the
  MCP surface and saved clients are unaffected (§3.3).

Deliberately not done: §2.2 step 4 (removing `POST /recommendations`), which
this plan puts out of scope, and §5 defects 1 and 3, which are diagnosis and
ranking questions rather than surface work. Seeds are not persisted with a
turn, so a replayed turn does not show which anchors produced it.

### Known limits and deliberate trade-offs

- **The tool-call log records a failing tool's own error message.** A schema
  rejection quotes the offending value, so a fragment of the model's tool
  arguments — derived from the user's question — can reach
  `GET /api/system/logs`. Kept because it is the field that makes a failing
  turn diagnosable at all, which is the whole point of §5 item 2. Nothing
  secret passes through that seam. Stated in `ConversationToolLog`'s docblock
  rather than quietly done.
- **An unknown seed id is a 400 here and a silent drop on
  `POST /recommendations`.** Deliberate divergence: the composer only ever
  offers ids it just read back from the library, so this path can afford to
  fail loudly. A book deleted between picking and asking will hard-fail the
  turn rather than quietly answer a different question.
- **The Desk's SSE decoder throws on an event name it does not know.** The new
  `retrieval` frame is the first to exercise that: a stale cached bundle
  against a new backend would kill the stream. Backend and frontend ship in
  one image, so this only bites a browser tab that never reloaded.
- **The acquire section is live-turn only.** Scrolling back through history
  does not re-run an external lookup, which would spend an LLM call and an
  iTunes round trip on a question already answered.
- **`retrieval` events are emitted for `search_semantic` alone**, because it
  is the only tool that measures candidates, semantic coverage, and
  personalization. Every other tool produces no disclosure rather than a
  defaulted zero.
