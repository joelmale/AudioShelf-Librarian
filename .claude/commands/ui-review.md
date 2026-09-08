---
description: Run the nine-role UI/UX expert review of the app, mobile-acquisition weighted
---

Orchestrate the full UI/UX expert review. You are the lead; the nine role agents in
`.claude/agents/ux-*.md` do the reviewing. You do not review — you ground them,
schedule them, and synthesize.

Scope note: `$ARGUMENTS` — if empty, review the whole app with mobile acquisition
weighted highest. If it names a route or surface, narrow every role brief to that.

## Phase 0 — Ground truth (you do this, before spawning anything)

1. Re-verify `.claude/ui-review/context.md` against the current code. Correct
   anything stale — route table, file sizes, dependency versions. The agents trust
   this file, so it must be right.
2. Capture runtime evidence into `docs/ui-review/phase0/`. Start the app with
   `preview_start {name: "audioshelf-dev"}` and for each of `/desk`, `/scout/trends`,
   `/scout/search`, `/scout/recommendations`, `/curate/review`, and one book detail:
   - screenshots at 390×844, 768×1024, and desktop
   - a `read_page` accessibility-tree dump at 390×844
   - console errors and the network waterfall on cold load
   - computed contrast ratios for body text, muted text, and the focus ring, via
     `javascript_tool`
   Write an index at `docs/ui-review/phase0/index.md` listing every artifact by path
   and what it shows.
3. Close the browser work cleanly — the runtime agents need the pane.

If the app will not start, stop and report why. Do not run the review against
assumptions.

## Wave A — Six static reviewers, in parallel, backgrounded

Spawn all six in one message so they run concurrently. None of them touch the browser.

`ux-flow-architect`, `ux-discovery-strategist`, `ux-visual-designer`,
`ux-frontend-platform`, `ux-accessibility`, `ux-content-designer`

Each brief must contain: the scope from `$ARGUMENTS`, the path
`.claude/ui-review/context.md`, the path `docs/ui-review/phase0/index.md`, and a
reminder that mobile acquisition on `scout/*` is the weighted priority.

## Wave B — Two runtime reviewers, strictly sequential

Both need exclusive control of the browser pane, so run them one after the other,
never together and never alongside a Wave A agent that could grab the pane:

1. `ux-mobile-interaction`
2. `ux-performance` — only after the first has finished

Wave B can start while Wave A is still running, since Wave A is browser-free.

## Wave C — The critic

Once all eight reports exist in `docs/ui-review/`, spawn `ux-adversarial-critic`.
Do not skip this even if the reports look good; it is the pass that catches invented
line numbers and fashion-driven recommendations.

## Synthesis — you write this

Read all nine reports and write `docs/ui-review/REVIEW.md`:

1. **Verdict** — 5–8 sentences. What the interface is, what it needs to become, and
   the single highest-leverage change.
2. **Findings** — merged and de-duplicated across roles, ranked
   Critical/High/Medium/Polish, each carrying its role, evidence, consequence, and
   fix. Drop anything the critic marked UNVERIFIED and unconfirmable.
3. **Mobile acquisition spec** — the deepest section, built from the discovery
   strategist's spec as amended by mobile-interaction and the critic.
4. **Flow redesigns** — before/after for the two or three flows worth restructuring.
5. **Modern web adoption table** — capability, benefit here, cost, verdict.
6. **Sequenced plan** — Quick wins / Structural / Speculative, with dependencies.
7. **Open questions** — decisions that are the user's, each with your recommendation.

Then send `docs/ui-review/REVIEW.md` with SendUserFile and give a short summary in
chat: the verdict, the top three findings, and the cheap win. Do not paste the whole
report into chat.

Nothing in this review edits application code. If the user wants fixes applied, that
is a separate follow-up.
