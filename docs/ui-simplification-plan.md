# UI simplification delivery plan

Status: **P0 in progress; see ui-simplification-status.md for current execution evidence and acceptance.**  
Prepared: 2026-09-05. Baseline inspected: 865b22e on main.  
Owner: the main AI project-manager task. Human product/deployment reviewer: the user.

## 1. Mandate and working agreement

Build the agreed navigation and acquisition simplification as small, deployable phases. Optimize **accepted work per unit of quota**, not the number of agents or the speed of producing unchecked code.

The user has authorized committing and pushing code between phases. The user will pull the resulting container into Dockhand for testing and review. Do not ask again for routine commits/pushes within this scope. This is not authorization to deploy through Dockhand, change production settings/secrets, mutate a real library, or perform one-way Audiobookshelf writes.

- Application: https://audioshelf.home.reach-back.net/
- User-operated deployment: https://dockhand.home.reach-back.net/
- Repository: https://github.com/joelmale/AudioShelf-Librarian
- Current image repository: ghcr.io/joelmale/audioshelf-librarian
- Planned integration branch: **codex/ui-simplification**
- Planned convenience image tag: **ui-preview**
- Acceptance always refers to an exact commit and image digest, never only a moving tag.

This document is the execution specification. Use [agent-operating-model.md](agent-operating-model.md), [AGENTS.md](../AGENTS.md) and the audioshelf-work-order skill for repository procedure. The user's current instructions remain authoritative. Reconcile [current-status.md](current-status.md), [primary-ui.md](primary-ui.md) and actual code at restart; the engine checkpoint is not a UI completion record.

The source review and live browsing established the major problems: duplicated navigation, source search above ready charts, an in-page search jump that cannot be reversed with Back, no durable acquisition intent, mixed maintenance/browsing surfaces, and Activity starting with technical history rather than actionable work. Reviews under docs/ui-review, if present, are supporting evidence; they were untracked user work when this plan was prepared and must not be silently added to a commit. This plan does not depend on those files being present in a fresh checkout.

### Scope boundaries

In scope: information architecture, accessible navigation/overlays, retained browsing context, explicit Want/Later/Pass, source freshness/status, durable acquisition acknowledgement, useful Activity, card readability/recovery and measured performance.

Preserve: recommendation verification and hard constraints; distinct owned-shelf chat versus external acquisition requests; current ingestion/containment/rollback guarantees; collection approval semantics; metadata/encode capabilities; settings/history; all useful deep links.

Do not add: a second ingestion engine, a general catalog identity project, automatic downloads from preference actions, a new LLM ranking algorithm, transcript work, mandatory swipe navigation, a new UI framework, SSR migration or decorative animation. PWA/share target is a separately gated optional phase.

## 2. Product decisions and navigation contract

### Primary destinations

| Context | Navigation | Utilities |
|---|---|---|
| Desktop final | Discover · Library · Activity | Ask your librarian; Settings |
| Mobile final | Discover · Saved · Activity · More | More exposes Library, Ask and Settings |
| Transitional P1–P3 | Keep Desk reachable in the existing shell; rename Scout/Curate to Discover/Library | Add Ask; expose Saved within Discover only when P3 ships; final shell cutover is P4 |

Discover defaults to **Charts**, so a return visit does not require an LLM request. **For you** is the other browsing view, with explicit generation/refresh. Search is a prominent affordance and standalone deep-linkable continuation, not a competing main tab. Saved contains Wanted and Later; Passed stays recoverable through a filter.

Library has **Books, Collections, Manage library**. Manage library groups **Metadata, File organization, Audio conversion, Library health**. Contextual book actions may link into these tools without duplicating their implementation.

Activity defaults to **Needs attention**, followed by **In progress** and **Completed**. Intake exceptions belong here. Organization history, curator logs and system console remain reachable under **Diagnostics / history**; preserve undo and its existing protections.

Ask is a first-class utility with its own route and saved conversation history. “From my library” and “Something new” are clear user choices that retain separate backend requests. Do not merge their evidence/authorization rules or automatically regenerate external suggestions when reopening history.

Retire Desk as primary navigation in P4 only after every useful component has a new home. P1 creates the destinations without forcing a risky all-at-once cutover. Remove the global New task FAB only after Acquire, Intake, Realign and Convert are reachable from their contextual destinations. A badge may report work needing attention; it must not claim health from a failed request.

### Proposed canonical routes

These are new route decisions, not claims about existing files or endpoints. Introduce aliases first; retain old bookmarks indefinitely unless the user explicitly approves removal.

| New canonical route | Destination | Old routes to retain |
|---|---|---|
| /discover/charts | Chart browsing, default landing | /scout/trends |
| /discover/for-you | Verified external recommendations | /scout/recommendations |
| /discover/search | Prefilled or direct source search | /scout/search, /acquire/downloads |
| /discover/saved | Wanted/Later with recoverable Passed filter | New in P3 |
| /discover/candidates/:id | Identified candidate detail; responsive sheet/panel | New in P3 after server identity exists |
| /ask | Librarian and conversation history | /desk after Desk relocation checklist passes |
| /library/books and /library/books/:id | Existing library browser/detail | /curate/review, /curate/books/:id |
| /library/collections and /library/collections/:id | Collections | /curate/collections and detail |
| /library/manage/metadata | Metadata/vocabulary | /curate/tags |
| /library/manage/files | File organization | /curate/realign, /process/realign |
| /library/manage/audio and /library/manage/audio/jobs | Conversion/history | /curate/encode and jobs, /process/encode and jobs |
| /library/manage/health | Library diagnostics | /curate/health |
| /activity | Attention/progress/completed overview | /activity |
| /activity/intake | Intake exceptions and explicit scan access | /scout/intake, /acquire/intake, /process/scan, /process/review, /process/organize |
| /activity/operations/:id | Selected curator operation | /activity/:id for legacy operation links |
| /activity/acquisitions/:id | Correlated acquisition after P5 | New; do not fabricate links before implementation |
| /activity/diagnostics | Organization history, curator logs, console | /logs and /logs/* through existing compatibility mapping |
| /settings | Settings dialog over a deterministic fallback | Existing route; remove its dependency on Desk |

Preserve encoded IDs, query strings, hashes, active-navigation state, direct loading and Back/Forward. Register static Activity routes before validating dynamic entity routes, and use explicit entity types so torrent, encode, curator and ingest IDs cannot collide. Unknown IDs get a real not-found/retry state, not the generic Activity screen.

Do not mechanically rename every source directory. Existing preview/features modules can implement the new routes; change the user-facing architecture without an unrelated file-move diff.

### Desk relocation checklist — required before removing its nav item

- [ ] Chat, live stream, history, pagination, new conversation, follow-up and empty-result external continuation → Ask.
- [ ] Health score/report, Audiobookshelf connection and explicit sync → Library/Manage.
- [ ] Metadata/collection review shortcuts → Library with relevant badges.
- [ ] Download/ingest progress, active work, queue and audit → Activity.
- [ ] Directory organization and conversion shortcuts → Library/Manage.
- [ ] Recently added → Library/Books, preserving a useful acquisition-completion link.
- [ ] Every former New task action has an obvious contextual entry.
- [ ] /desk and /settings fallback behavior verified after migration.

## 3. Roles and model allocation

Official OpenAI guidance differentiates Luna for clear repeatable work, Terra for everyday work, Sol for complex judgment, and Astra for the hardest multi-step work. Higher reasoning/context can increase consumption. The table below is a **project policy**, not a benchmark or a guarantee of subscription savings. Revalidate availability and current quota rules at phase start. Sources: [model selection](https://learn.chatgpt.com/docs/models), [usage and pricing](https://learn.chatgpt.com/docs/pricing), checked 2026-09-05.

The current host exposes gpt-5.6-luna, gpt-5.6-terra, gpt-5.6-sol and gpt-6-astra for subagents. Repository roles fix explorer/implementer reasoning to medium and tech_lead/reviewer to high. Respect those role settings; do not silently override them to lower effort.

| Responsibility / lens | Repository role | Default model and effort | Escalate when |
|---|---|---|---|
| Main project manager: tickets, sequencing, integration, handoffs | Main task; no second persistent orchestrator | gpt-5.6-terra, medium for a newly launched execution task | Unresolved cross-phase architecture or repeated integration failure → Sol |
| Phase decomposition / shared-contract design | tech_lead | gpt-5.6-sol, high; bounded kickoff/dispute only | Irreconcilable design/safety tradeoff → Astra high |
| File/route inventory, test output summaries, copy inventory | explorer | gpt-5.6-luna, medium | Trace spans asynchronous state or ambiguous contracts → Terra |
| UX/mobile/accessibility investigation | explorer | gpt-5.6-terra, medium | Competing flow models or difficult interaction design → Sol via bounded lead |
| Small, explicitly specified copy/token/label edits | ic_implementer | gpt-5.6-luna, medium | Task reveals shared state, accessibility semantics or more than local edits → Terra |
| Routine React routes/components, fixtures and tests | ic_implementer | gpt-5.6-terra, medium | Cross-service persistence or ambiguous invariants → Sol |
| SQLite/API identity/intent/acquisition changes | ic_implementer | gpt-5.6-sol, medium | Escalate architecture to lead; do not brute-force repeated attempts |
| Independent ordinary UI review, including a11y | ic_reviewer | gpt-5.6-terra, high | Migrations, auth, ingestion, idempotency, release workflow → Sol |
| Security/data/release-contract review | ic_reviewer | gpt-5.6-sol, high | Unresolved consequential defect → Astra high |
| Performance measurement / deterministic browser QA | explorer | gpt-5.6-terra, medium | Only escalate interpretation of an unexplained bottleneck |
| Highest-risk unresolved issue | tech_lead or ic_reviewer | gpt-6-astra, high, one bounded question | Return to ordinary models after decision |

“UX Architect”, “Mobile Designer”, “Content Designer”, “Accessibility Specialist” and “Performance Engineer” are **lenses assigned within these roles**, not eight permanent extra agents. Each ticket names the relevant lens. Every implementation slice still receives an independent ic_reviewer pass. High-risk review is never downgraded to save quota.

### Dispatch rules that make model selection real

1. Specify the model on every child dispatch; otherwise project agents inherit the main task model. Do not accidentally run routine agents on Astra because the PM started there.
2. For model overrides in this host, use fork_turns: "none" with a self-contained work order. Full-history forks inherit the parent model and do not accept overrides.
3. Example conceptual dispatch, using the actual collaboration tool:

~~~json
{
  "task_name": "p1_navigation",
  "agent_type": "ic_implementer",
  "model": "gpt-5.6-terra",
  "fork_turns": "none",
  "message": "Work order P1-A. Read AGENTS.md and docs/ui-simplification-plan.md sections 1–4. Own only [allocated files] in [isolated worktree]. You are not alone in the codebase; preserve sibling/user edits. Implement [contract], verify [tests], and return [handoff]."
}
~~~

4. Do not assume a role/model override succeeded: record the requested model and effective model if exposed; otherwise mark the effective value unavailable. If a model is unavailable, pick the nearest supported tier deliberately and record why.
5. Do not modify global user settings, buy credits, consume reset credits or change application LLM providers to implement this policy. These are coding-agent choices only.
6. Main-task model changes may require the user/client to select a new model. A PM cannot claim it changed its own model using a child override. A root already running on a stronger model should delegate bounded execution rather than pretending to switch.

### Quota governor

- Default to one active implementer. Use at most two parallel implementers plus one reviewer/explorer when work is genuinely independent; maximum three children/four active agents total.
- Parallel writes require separate worktrees and disjoint ownership. Shared contracts, migrations, routes, CSS token roots, registries and workflow YAML are serialized.
- Give a ticket only relevant paths, interfaces, excerpts and acceptance checks; do not fork the complete review into each child. Return concise findings, changed paths, test outcomes and unresolved decisions.
- One targeted exploration establishes a fact for the phase. Share that evidence; do not pay four agents to rediscover the route tree.
- Run narrow tests during implementation, then the release gate once on the integrated candidate. Repeat only after relevant changes/failures.
- At most two unsuccessful repair cycles on the same root cause at a tier; then escalate with a reproduction, not a fresh broad prompt. A safety issue escalates immediately.
- Read available account usage at phase start/end and before an expensive escalation. Limits are account-wide and may include other tasks; never attribute all percentage changes to this project.
- Track actual tokens/usage by model only if tooling exposes them. Otherwise record model, task duration, review cycles and acceptance outcome; mark unavailable data as unknown.
- Optional experiments and parallel exploration stop first when quota is tight. Checkpoint the work and preserve the review gate; do not pass weaker review or declare completion to fit a budget.
- Avoid background wakeups/polling while awaiting Dockhand review. Save status and end the turn. Resume on the user's review message.
- Service tier/speed controls may be host-enforced. Do not promise savings from a mode the runtime cannot change.

## 4. Execution protocol and acceptance states

Every phase follows:

~~~text
Reconcile baseline → bounded work orders → implementation + focused checks
→ independent adversarial review → repair/re-review
→ integrate → full release checks → commit/push → verify image publication
→ user pulls exact image into Dockhand → user tests/reviews
→ accept that digest OR issue repair tickets → next phase
~~~

Use these states in the delivery ledger:

**planned → implementing → in_review → locally_verified → published → awaiting_user_review → accepted**

“Code complete”, green CI, published image, running container and user-accepted phase are different states. Do not begin the next phase's writes until the preceding user review is accepted. Read-only preparation may continue only if useful and not likely to be invalidated. A new user correction reopens the current phase; it does not authorize skipping its gate.

### Work order template

~~~text
ID / phase / lens:
Outcome and user-visible example:
Role / requested model / effective effort:
Why this tier is sufficient; escalation condition:
Baseline SHA and dependencies:
Owned paths and isolated worktree:
Shared contracts owned by another ticket:
Exemplar files and exact interface:
Required behavior:
Out of scope:
Safety constraints:
Named tests and failure paths:
Browser/visual evidence required:
Done when:
Handoff: changed paths, commit SHA if any, checks, review risks, exact next action.
~~~

Every implementer must be told: **You are not alone in the codebase. Preserve others' changes and adapt to integrated contracts.** The reviewer sees the actual diff and acceptance conditions, not merely the implementer's summary. Where behavior is claimed, require a check that fails when that behavior is neutralized; do not accept source-string assertions alone for routing, focus or scrolling.

### Shared release gate — all code phases

Run on the final integrated candidate using Node 24 (matching CI/container):

~~~text
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:bundle
npm run release:check
~~~

Add relevant contract/migration/restart/container and browser checks per phase. Existing baseline warnings must be distinguished from new warnings. Do not raise the 300,000-byte initial-JS budget or remove deferred-route checks to get a pass. If source paths change, update the graph checks while preserving their intent. See [bundle verifier](../scripts/verify-frontend-bundle.mjs) and [route contracts](../apps/frontend/src/preview/preview.contract.test.ts).

Unit tests never hit the network or a real library. Use disposable temporary databases/filesystem fixtures, dependency injection, captured/synthetic provider responses and cleanup. Browser fixture evidence is labelled as such. Live validation follows an endpoint side-effect inventory: a GET is not automatically read-only; the current downloads/pipeline GET reconciles ingest state.

## 5. Phases and work packages

All paths below are existing ownership boundaries unless explicitly labelled new. The lead refines exact files per ticket before dispatch. The numbered phase is the release unit; lettered tickets are reviewable implementation slices.

### P0 — Baseline, acceptance fixtures and pullable preview delivery

**User outcome:** a known baseline and an immutable UI preview image you can pull without changing latest.  
**Dependencies:** none. **Risk:** medium (publication workflow).

| Ticket | Role/model | Ownership and work |
|---|---|---|
| P0-A Baseline and test contract | explorer/Terra | Read-only routes, APIs, current live behavior, Node/version/build SHA; inventory entrypoint side effects and capture 390×844, 768×1024, 1440×1000 baseline. Prepare labelled 40-candidate/empty/error fixtures |
| P0-B Preview publication | ic_implementer/Terra | .github/workflows/docker-publish.yml, .github/workflows/ci.yml, release documentation/tests as needed. Sole workflow writer |
| P0-C Release review | ic_reviewer/Sol | Inspect workflow/tag policy, test coverage, digest handoff and rollback instructions |

Current publisher triggers only main, feat/librarian-engine, semver tags and PRs; PR builds do not push. Add explicit push support for codex/ui-simplification and a ui-preview tag enabled only on that branch. Preserve main→latest, engine→beta and existing long-SHA tags. Ensure all release checks, including lint, gate preview publication; do not depend on a CI workflow that never runs on the new branch. Do not add semver tags for every review phase.

**Verification:** event/ref matrix covers main, UI branch, engine branch, PR and release tag; UI push cannot publish latest/beta; PR cannot push. Build unchanged application and verify workflow success plus actual image digest. If the bootstrap workflow cannot run from the branch, establish the smallest reviewed bootstrap change rather than claiming the image exists.

**User review:** pull the baseline digest, confirm application startup and current key routes. Capture prior production image digest and a consistent DATA_DIR backup procedure before later migrations.

**Exit:** baseline, CI links, image/digest and rollout instructions recorded.  
**Rollback:** prior image with unchanged data. No business-schema changes.

### P1 — Destination foundations, Ask, and accessible shared shell

**User outcome:** Ask and Library have real destinations, with clearer labels and accessible navigation; Desk remains available during migration.  
**Dependencies:** P0 accepted. **Risk:** medium (wide UI composition, no new business schema).

| Ticket | Role/model | Ownership and work |
|---|---|---|
| P1-A Navigation contract | tech_lead/Sol | Bounded UX/architecture pass: final route map, staged Desk relocation checklist, interaction/focus rules; no parallel shell edits |
| P1-B Shell and route aliases | ic_implementer/Terra | PreviewApp.tsx, App.tsx, legacyRedirects.ts and tests; shell-owned sections of preview.css. Add canonical destinations and clearer labels, Settings fallback and real Ask action; keep Desk nav until P4 |
| P1-C Ask/Library extraction | ic_implementer/Terra | DeskPage.tsx, CuratePage.tsx and new Ask/Library composition files allocated by lead. Reuse LibrarianChatPanel and feature pages; keep Desk composition intact until P4 |
| P1-D Focus/copy fixes | ic_implementer/Terra; Luna only for separately bounded copy | Shared dialog/navigation primitives, search labels/contrast, contextual action names; serialize shared CSS/shell work |
| P1-E Independent review | ic_reviewer/Terra | UX/a11y/data-loading regressions; elevate any settings/auth change to Sol |

Library initially reuses existing Books/Collections/Manage content; move health/recently-added via shared composition without deleting the Desk entry yet. Ask reuses chat/history; two separate routes must not create duplicate mounted chat consumers or requests. Activity retains its present behavior until P4. Keep the existing mobile shell with updated labels and reachable Ask; no empty Saved tab or premature final More layout. Source directories and minified-style CSS need not be mechanically reformatted as a prerequisite.

**Required tests:** old and new deep links including encoded IDs/query/hash; Settings open/close without lost route; Ask history/follow-up/reopen without extra LLM request; navigation selected state; hidden nav not focusable; dialog focus transfer, Escape and return; primary control accessible names and measured contrast. Preserve lazy management chunks.

**Browser acceptance:** new /ask works and existing /desk remains intact; Library destinations and their old aliases work; all four New task operations remain findable; one-handed mobile navigation and desktop Library tools work. Mark completed relocation items but do not claim Desk retired. User can browse charts, ask a shelf question, find collections, locate intake and open logs without a missing workflow.

**Exit:** no lost capability; screenshots and journey checklist approved.  
**Rollback:** previous image; no destructive state migration.

### P2 — Discover browsing continuity and a clear source-search continuation

**User outcome:** seeing a book, investigating it and going Back no longer loses the list.  
**Dependencies:** P1 accepted. **Risk:** medium (client state/async races).

| Ticket | Role/model | Ownership and work |
|---|---|---|
| P2-A Browse/session state | ic_implementer/Terra | ScoutPage.tsx, BestsellerLists.tsx and tests, new browse-context module; owns chart/return state |
| P2-B Search/recommendation handoff | ic_implementer/Terra | AudiobookSearch.tsx, RecommendationFinder.tsx and tests; existing query contract plus explicit safe return context |
| P2-C Card readability | ic_implementer/Terra | BestsellerLists.css and assigned recommendation/card CSS after token agreement; source-supported cover fallback and two-line titles |
| P2-D Independent review | ic_reviewer/Terra | Mobile/UX/a11y lenses, history/scroll restoration, race handling and recommendation trust |

Remove the always-open ABB panel from chart browsing. Keep source search a direct route with q, and make a chart/recommendation handoff a real navigation. Preserve source tab, filters, selected candidate, result snapshot and return anchor across details/search/back. In this phase, a source-specific session reference can identify a row; **do not invent a globally durable ID before P3**. Reload with a missing snapshot must give a clear return/recovery path, not fabricated book data.

Use a session snapshot/cache policy that does not retain secrets and is invalidated on relevant actor change. Preserve prior verified recommendation results without regenerating on Back. Reject untrusted external returnTo URLs; only route to allowed internal destinations.

Keep description preview accessible. Add abort/stale-response protection and explicit idle/searching/empty/error states. A transient description failure is retryable. Present existing source/rank badges; do not invent freshness data before P3.

Treat “For you” as a destination label, not evidence of personalized ranking. Only describe results as personalized when the backend reports that capability for the returned results. Taste feedback may acknowledge “Preference saved”; do not claim it changed ranking without supporting behavior and tests.

**Required tests:** candidate 30 → search/detail → Back restores same tab and anchor; route remount and reload recovery; search response B arrives before A and remains visible; unsubmitted query does not claim no results; description close restores focus; malformed return path cannot navigate off-site; no extra LLM call on returning to results.

**Browser acceptance:** first candidate is visible without initial scrolling at 390×844 with the standard fixture; no page-top search panel on Charts; evaluate item 30 and return without manual searching; desktop book list retains filters/page on detail Back.

**Exit:** verified navigation continuity and revised card screenshots accepted.  
**Rollback:** prior image; version/ignore incompatible ephemeral snapshots.

### P3 — Source identity, honest freshness and durable Want/Later/Pass

**User outcome:** triage 40 candidates, refresh or reopen, and find the decisions still there.  
**Dependencies:** P2 accepted. **Risk:** high (new persistent contract/migration).

| Ticket | Role/model | Ownership and work |
|---|---|---|
| P3-A Intent/identity contract | tech_lead/Sol | Sole design owner: schemas, source IDs, actor policy, revisions/idempotency, migration and compatibility tests |
| P3-B Backend persistence and source status | ic_implementer/Sol | curator/core/db.ts, assigned new candidate/intent routes, librarian bestsellers service/index boundary, shared schemas if used; one writer per registry/migration |
| P3-C Intent UI and Saved | ic_implementer/Terra | Candidate detail, Want/Later/Pass, Saved view, state cache and API adapters; start only after contract stabilizes |
| P3-D Independent data review | ic_reviewer/Sol | Migration, identity, authorization, idempotency/undo, failure/restart coverage |
| P3-E UX acceptance | explorer/Terra | Triage stability, labels, pending/error/undo feedback, no gesture-only action |

**Contract decisions to record before writes:**

- Stable opaque server candidate ID, retaining source-native IDs/URLs when available. Where a source offers neither, use a versioned source-specific surrogate with explicit uncertainty. Keep work and edition separate.
- Existing normalized-title/author-surname consensus is a display heuristic only. It cannot authorize exact ownership, permanent cross-source suppression or automatic acquisition.
- Inventory existing external recommendation, impression and frontend key conventions before defining candidate adapters. Keep new candidate identity separate from legacy feedback keys; migrating historical taste feedback is outside this phase. Test punctuation, non-Latin titles, shared surnames and multiple editions without silently merging candidates.
- Persist canonical candidate metadata needed to render Saved even if the source later removes the chart entry. Validate/sanitize external metadata and URLs.
- Intent is **want / later / pass**, separate from accepted/rejected taste feedback. Want does not call download and Pass does not silently train taste.
- Actor comes from trusted principal, not a submitted user ID. With auth off, use the existing internal shared actor; disclose that decisions are shared. Do not promise private per-person state when the app cannot identify people. Test actor scoping when auth is on without enabling/changing production auth.
- Idempotent mutation with request ID, expected revision and canonical returned state; reversible undo/change and server-readable current decisions. Define duplicate request, stale revision and competing-device behavior.
- Per-source ready/stale/failed/not-configured/empty status, last successful fetch, chart publication date only when known, attribution URL and previous snapshot. Never let one provider failure erase successful sources.
- Ownership/finished badges only from reliable batch matching; unresolved matches remain unknown/possible. An identity-confidence overhaul is not a prerequisite for saving a source-specific candidate.
- Additive transactional SQLite migration; old data preserved; repeated startup safe. Record reader/writer compatibility with previous image.

**Required tests:** new/existing database migration and second startup; 40 intents survive restart; duplicate request changes state once; lost response can be resolved; stale revision does not clobber newer choice; undo reverts intended revision; cross-actor isolation; candidate title collisions do not silently merge; missing source persists Saved item; failure versus empty/config absence; last-success snapshot retained; Want/Pass never enqueue downloads or write taste feedback.

**Browser acceptance:** Want/Later/Pass each takes one decision tap after evaluation; confirmation remains visible without rows shifting under the thumb; refresh and second session show saved choices; Change/Undo is usable; Passed items are recoverable. Saved is reachable inside Discover and directly by route; final mobile navigation waits for P4's complete Desk relocation.

**Exit:** durable triage and migration/recovery evidence accepted.  
**Rollback:** prior image only if proven safe against additive schema. New intent tables/data remain; do not drop them or restore a stale database over later writes.

### P4 — Actionable Activity and final navigation cutover

**User outcome:** see what needs a decision, open the exact affected item, and use the final simplified navigation with no lost Desk capability.  
**Dependencies:** P3 accepted (phase ordering for review; existing-entity work may be designed earlier). **Risk:** medium–high (status truth and route/entity association).

| Ticket | Role/model | Ownership and work |
|---|---|---|
| P4-A Read model/status mapping | tech_lead/Sol then ic_implementer/Terra | Explicit mapping of current curator operations, encode jobs, ingest exceptions and acquisitions; API adapters, new read model if needed |
| P4-B Activity UI | ic_implementer/Terra | Activity overview/detail, IntakePanel entry points, diagnostics navigation, reusable status cards |
| P4-C Independent review | ic_reviewer/Sol for backend changes; Terra for isolated UI | No invented completion, correct selected entity, existing mutation protections retained |
| P4-D Final shell integration | ic_implementer/Terra then ic_reviewer/Sol | After Activity is reviewed, sole writer for PreviewApp.tsx/DeskPage.tsx/legacyRedirects.ts/shell CSS. Finish Desk relocations, replace desktop/mobile nav, remove redundant FAB and preserve aliases |

Group Needs attention/In progress/Completed from actual entity states. Use typed entity IDs and open the matching curator operation/encode job/ingest item. Fix legacy /activity/:id links to resolve the operation they name. Preserve organization history/undo and all technical diagnostics under an explicit secondary destination.

Inventory each source's persistence and retention window. Label bounded or in-memory history honestly; Completed must not imply a complete permanent audit. Missing or expired records need an explicit unavailable state. Expanding retention is a separate scoped decision if the required journey cannot work with existing records.

Until P5, show reliable existing per-entity status without implying an unproven connection from a chart candidate to a torrent or shelved book. Distinguish “could not load work” from “nothing running”. Resolve actions invoke existing protected flows; merely opening Activity must not initiate a scan, retry or conversion.

After Activity is reviewed, complete the Desk relocation checklist and cut over to desktop Discover/Library/Activity plus Ask/Settings, and mobile Discover/Saved/Activity/More. More includes Library/Ask/Settings. Root lands on Charts; /desk redirects to Ask to preserve conversation intent, while former dashboard functions are reachable in Library/Activity. Update settings fallback and compatibility chains. Keep a deliberate source-search affordance and all former New task operations before removing the FAB. Do not leave unused duplicate dashboard implementations mounted.

**Required tests:** each active/terminal/failure state mapping; unknown/missing ID; same raw ID across entity types; provider outage not zero-work success; intake deep link; old operation link selects actual operation; terminal progress and stale events not shown as current; opening diagnostics preserves context. Add the complete old/new route matrix and capability checks for all Desk relocations, mobile More focus/Escape, Settings return, active-nav state and deferred management chunks.

**User review:** find a held intake item, a running job and completed work; open correct details; locate history/undo without losing the main queue; verify every relocated Desk capability and the final desktop/mobile nav. Mutating live validation remains user-operated unless separately authorized.

**Exit:** actionable Activity and preserved diagnostics accepted.  
**Rollback:** previous UI/read model; do not erase job history.

### P5 — Trace an explicit acquisition from Wanted to the shelf

**User outcome:** Download acknowledgement survives refresh and the originating candidate shows real progress.  
**Dependencies:** P3 identity/intent + P4 Activity accepted. **Risk:** high (external side effects, partial failure).

| Ticket | Role/model | Ownership and work |
|---|---|---|
| P5-A Correlation/idempotency design | tech_lead/Sol | Exact source edition → acquisition ID → torrent hash → ingest item → ABS item contract; partial-failure state machine |
| P5-B Backend implementation | ic_implementer/Sol | librarian download endpoint, acquisitionPipeline and related ingest/torrent adapters, new persistence; serialize safety-critical modules |
| P5-C Candidate/progress UI | ic_implementer/Terra | Explicit source choice/Download, durable acknowledgement, candidate badge, Activity acquisition detail |
| P5-D Adversarial review | ic_reviewer/Sol | Ambiguous acceptance, duplicate execution, restart reconciliation, containment/authorization and trustworthy state labels |

Want only records interest. Find a source performs search; the user selects an edition/result and explicitly chooses Download. Persist acquisition/request identity around external submission, but **do not claim atomic exactly-once behavior across SQLite and qBittorrent**. If the downstream result is uncertain, reconcile by supported torrent identity/status before retry; if it cannot be proven, surface “Needs confirmation” rather than blindly repeating. Keep retry safe for repeated browser requests and process restarts.

Reuse the existing ingest engine and filesystem guards. Do not infer “In library” from torrent completion or a successful send toast; it requires resolved final library evidence. Keep unresolved associations explicit. Older uncorrelated work still appears as legacy Activity items.

**Required failure tests:** duplicate request; response lost after external acceptance; crash before/after send; qBittorrent timeout with uncertain result; repeat reload/retry; torrent-to-ingest association ambiguity; failed finalization/ABS resolution; missing files; authentication/role denial. Filesystem tests use temporary sandboxes and injected services only. Prove non-destructive compatibility with existing jobs.

**User review:** user selects a harmless intended acquisition, observes acknowledgement/reload/progress through completion or an exception, confirms correct Activity linkage. The PM supplies exact expected stages and reads approved evidence; it does not trigger an unapproved real download.

**Exit:** restart/lost-response tests pass and user accepts the traced flow.  
**Rollback:** stop new submission before rollback; reconcile in-flight external actions. Use only an image compatible with new acquisition state. Never delete runtime data to “reset” the queue.

### P6 — Integrated accessibility, resilience and measured performance

**User outcome:** the consolidated experience works across devices and poor connections without regressions.  
**Dependencies:** P5 accepted. **Risk:** medium. Important a11y fixes are already required in P1–P5; this is the integrated audit.

| Ticket | Role/model | Ownership and work |
|---|---|---|
| P6-A Accessibility/flow verification | explorer/Terra | Browser and assistive-technology evidence; all core journeys, keyboard, focus, headings, form errors and reflow |
| P6-B Performance measurements | explorer/Terra | Production build, real/captured chart data, named CPU/network profile, cold/warm runs and interaction traces |
| P6-C Focused fixes | ic_implementer/Terra; Luna for proven local copy | Only evidence-backed changes, independently reviewed; backend risk escalates |
| P6-D Final adversarial pass | ic_reviewer/Sol | Challenge scope creep, desktop regression, unsupported metadata and performance claims |

Capture 390×844, 768×1024, 1024×900 and desktop; also test landscape, 200% zoom and real mobile keyboard/safe-area behavior where tooling permits. Check reduced-motion behavior in JavaScript as well as CSS. Measure contrast with actual computed backgrounds. 44 px is a product comfort target; do not misstate WCAG 2.2 AA’s 24 px minimum/exceptions.

Measure LCP/CLS and actual interaction latency/INP with a supported instrumented tool. Define discovery meaningful content as the first visible usable candidate, separate from shell paint; record first-screen and all-40 cover bytes. Suggested reproducible starting lab profile: 4× CPU slowdown, 1.6 Mbps down / 750 Kbps up, 150 ms latency, cold/warm cache, three runs with median/range and tool version. Label simulation as simulation; it is not a physical mid-tier phone or field p75.

Keep the existing JS budget. Investigate measured regressions before changing markup/frameworks. Responsive cover derivatives must actually exist; URL rewriting guesses are not optimizations. Keep dominant-color extraction, virtualized lists and decorative scroll animation out unless a measured problem establishes the need.

**Exit:** all core acceptance checks green, no unresolved high-risk/a11y blocker, performance evidence reproducible. Unsupported measurements remain unknown with a concrete follow-up; the PM must not claim full WCAG/CWV certification. User explicitly accepts remaining limitations or they remain open.

**Final promotion:** after acceptance, prepare PR/normal integration to main under repository policy. User phase acceptance is not automatically permission to promote latest; request/record the explicit final promotion decision with the exact candidate. Never force-push.

### P7 — Optional installable offline shortlist / share-in experiment

**Not part of the default delivery commitment. Start only after user opts in following P6.**

Use tech_lead/Sol for the offline/actor/outbox contract, ic_implementer/Terra for UI/service worker, ic_reviewer/Sol for caching/sync/security.

First prove offline reading of Saved and a bounded artwork cache. Offline interest capture must say “Saved on this device; waiting to sync” and reconcile revisions. Do not queue downloads offline. Handle actor changes/sign-out, cache eviction, data-version migration and stale app bundles. Cache allowlisted read resources only; never all API GETs.

The actual site is HTTPS; do not assume the container's internal HTTP makes PWA impossible. Verify browser secure context and target-phone support. Web Share Target remains conditional on platform support and a validated URL-to-candidate resolver; offer Paste a link fallback. Sharing never executes a download. No polling/notifications or new AI dependency without a demonstrated need.

## 6. Publication, Dockhand review and rollback runbook

### Before each phase push

1. Reconcile git and remote refs. Preserve the pre-existing .claude/launch.json changes and untracked user reports. Use an isolated worktree for implementation if the shared checkout is dirty; stage only ticket-owned files.
2. Integrate reviewed slices into codex/ui-simplification, run the release gate, inspect final diff and record SHA. Use short imperative commits; never bundle unrelated engine work.
3. Push the branch. CI must publish ui-preview and its immutable SHA tag/digest; do not claim a feature-branch push automatically publishes under the pre-P0 workflow.
4. Wait for CI/build/signing completion and verify the image exists. If CI fails, fix within the current phase; it is not “ready for Dockhand”.
5. Produce the handoff below. Do not change the Dockhand stack or press deploy.

### Handoff to the user — mandatory format

~~~text
Phase / status:
What changed (3–5 user-visible points):
Git commit and branch:
CI run and check results:
Image: ghcr.io/joelmale/audioshelf-librarian@sha256:<verified digest>
Convenience tag: ui-preview (moves; use digest for reproducible review)
Previous accepted image digest:
Database/migration compatibility:
Backup/preflight requirement:
5–8 phase-specific review steps with expected outcomes:
Known limitations:
Rollback procedure:
Decision requested: accept this digest, or report issues.
~~~

Fill actual values; never give placeholder digests as pullable instructions. Prefer a digest over moving latest/ui-preview for review. Verify application revision using published image metadata and, if needed, a small non-secret build-revision display added under P0; package version alone may not distinguish multiple phase builds.

### User-controlled testing

The user pulls/recreates the service in Dockhand and reports the running candidate and observations. No need to re-request commit/push permission between repairs. A user-confirmed deploy may be followed by safe browser inspection of the provided application URL. Do not infer that “please review the page” authorizes arbitrary mutation endpoints.

Do not run two production workers against the same writable DATA_DIR/inbox/library while testing. A separate test stack needs isolated data and external integrations; otherwise the user replaces the existing instance. Back up runtime state before migration using a consistent SQLite-aware procedure, including WAL considerations; do not promise a live file copy is a consistent DB backup.

Rollback uses the previous verified digest and preserved runtime data. Additive migrations should remain readable by the rollback image; prove this in P3/P5. If backward compatibility cannot be guaranteed, document the maintenance/recovery plan before publication. Restoring a backup may discard subsequent user actions; that requires an explicit user decision. Never delete /app/data, settings/secrets/history/curator.db or the library during rollback.

### Between-phase checkpoint

Update docs/current-status.md only with a short UI milestone pointer and material phase state; do not overwrite the unrelated engine checkpoint or move this full plan there. Maintain the detailed ledger at docs/ui-simplification-status.md using the format below.

Update docs/primary-ui.md in each phase that changes routes or navigation so it describes the shipped transitional state. Record the final Desk retirement there only when P4 ships. Assign these documentation edits to the phase integrator.

~~~text
Phase | state | source SHA | image digest | CI | reviewer verdict | user decision/date
P0    | planned | — | — | — | — | —
...
~~~

For the active phase record owned worktrees/files, open findings, model assignments/escalations, available usage evidence and exact next action. On quota exhaustion or interruption, leave this checkpoint and stop. No auto-resume automation is required.

## 7. Acceptance checklist shared by the project manager

- [ ] Discover exposes ready books before source-search machinery on mobile.
- [ ] Chart/recommendation → investigate → Back restores the right snapshot, row and focus.
- [ ] Want/Later/Pass persists, is reversible, and is distinct from taste/downloading.
- [ ] Source failure/configuration/staleness cannot masquerade as editorial emptiness.
- [ ] Ask preserves owned/external trust boundaries, history and bounded generation.
- [ ] Books/Collections/Manage retain the full desktop workflow and return context.
- [ ] Activity opens the exact entity and reports unknown/error honestly.
- [ ] Download acknowledgement and completion reflect persisted evidence; no unsafe automatic replay.
- [ ] Navigation, overlays and primary controls have names, usable focus, contrast and touch targets.
- [ ] Existing settings, auth/roles, path containment, ingestion and rollback protections remain.
- [ ] Old routes remain valid and management code stays deferred.
- [ ] Every phase has independent review, CI/image evidence and explicit user acceptance.
- [ ] Model selection is recorded per ticket; no inherited premium-model fleet.
- [ ] No unknown benchmark, real-device behavior or external state is presented as verified.

## 8. Start/resume prompt for the AI project manager

Copy this into a new execution task when ready. Recommended PM model: **gpt-5.6-terra / medium**; choose stronger only if the work actually requires it.

> Use the audioshelf-work-order skill to execute docs/ui-simplification-plan.md, one accepted phase at a time. Remain the main orchestrator; use the repository tech_lead, explorer, ic_implementer and ic_reviewer roles with the explicit model policy in section 3. Inspect git, current code and the delivery ledger before acting. Use bounded self-contained dispatches with explicit models and no full-history inheritance. Preserve unrelated work, isolate parallel writers and serialize shared contracts. Start at the first unaccepted phase; if it is awaiting my Dockhand review, summarize the exact digest and review steps and wait. Every implementation slice requires independent adversarial review and re-review after material fixes. Commit and push verified phase candidates to codex/ui-simplification; establish ui-preview image publication in P0, verify CI and the exact image digest, and give me the pull/review/rollback handoff. I will deploy through Dockhand and test; do not deploy or mutate the live library yourself. Do not advance phase writes until I accept the running candidate. Keep quota use efficient with Luna/Terra for bounded routine work, Sol for architecture/high-risk implementation/review, and Astra only for documented escalations. Record actual evidence, distinguish published from accepted, and update the checkpoint before stopping.
