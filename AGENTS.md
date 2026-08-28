# Repository Guidelines

## Project Structure & Module Organization
- npm workspaces monorepo; Node 24, ESM throughout.
- `apps/backend/` — Express 5 + `ws`. Two modules under `src/modules/`:
  - `librarian/` — filesystem scanning, organizing (moves/renames real media),
    ingest job state machine, AudiobookBay/qBittorrent acquisition, realignment.
  - `curator/` — SQLite library mirror, LLM tagging, collections, encode queue,
    and an MCP server under `curator/mcp/`.
  - `src/security/` — `auth.ts` (OIDC), `paths.ts` (containment), `redact.ts`.
- `apps/frontend/` — Vite + React 18 + TanStack Query. The live UI is
  `src/preview/` (routes `/desk`, `/scout/*` including `/scout/intake`,
  `/curate/*` including `/curate/realign`, `/activity/*`, `/settings`);
  `src/features/` holds components it composes. Former `/process/*` bookmarks
  redirect to their new homes.
- `packages/shared/` — Zod schemas and types shared across the boundary. Note
  that the curator frontend deliberately keeps its own local API types instead.
- `scripts/` — release verification, bundle budget, controlled live validation.

## Build, Test, and Development Commands
- Install: `npm ci`
- Run both apps: `npm run dev`
- Typecheck all workspaces: `npm run typecheck`
- Lint: `npm run lint` (`npm run lint:fix` to autofix)
- Test: `npm test` (Vitest; backend `vitest run src`, frontend `vitest run`)
- Build: `npm run build`
- Bundle budget: `npm run verify:bundle` · Release metadata: `npm run release:check`
- Live smoke tests: `npm run smoke:live:readonly`, `npm run smoke:live:plan-scan`

## Multi-Agent Delivery
- The canonical collaboration protocol is `docs/agent-operating-model.md`.
  `docs/current-status.md` is the concise restart checkpoint; reconcile it
  against git and the implementation before relying on it.
- When the user explicitly requests multi-agent execution, parallel work, or a
  plan phase, use the `audioshelf-work-order` skill and the project roles in
  `.codex/agents/`: `tech_lead`, `explorer`, `ic_implementer`, and
  `ic_reviewer`.
- The main task remains the orchestrator and owns scope, sequencing, integration,
  human decision gates, and final acceptance. Do not create a second persistent
  orchestrator role.
- Parallelize read-heavy investigation when useful. Parallel writes require
  disjoint file ownership and isolated worktrees; otherwise serialize them.
  Never let two agents edit a shared schema, migration, contract, registry, or
  safety-critical file concurrently.
- Every implementation slice receives an adversarial, read-only
  `ic_reviewer` pass. Findings go back to the original implementer, followed by
  re-review. Passing tests alone are not proof unless the test fails when the
  claimed behavior is removed or neutralized.
- Update `docs/current-status.md` only when milestone state materially changes
  or before a long handoff. Keep design rationale in the plan or architecture
  decisions instead of growing the checkpoint into a second plan.

## Coding Style & Naming Conventions
- TypeScript, `strict: true`. Prefer explicit types at module boundaries.
- Naming: functions/variables `camelCase`, types/classes `PascalCase`,
  constants `UPPER_SNAKE_CASE`, files `camelCase.ts` / `PascalCase.tsx`.
- ESLint flat config at the repo root covers every workspace. Real-defect rules
  are errors; the existing `any`/unused/hook-dependency debt is warnings. Do not
  add new warnings casually — the baseline is meant to shrink.
- There is no formatter configured; match surrounding style.

## Testing Guidelines
- Vitest, colocated as `*.test.ts` / `*.test.tsx` beside the code under test.
- Filesystem tests must use `fs.mkdtempSync(os.tmpdir())` sandboxes and clean up
  in `afterEach`. Never touch a real library or inbox path.
- Tests must not hit the network. Inject dependencies instead — see
  `llmClient.ts`'s `MessageCreator` for the established pattern.
- Anything that moves, renames, or deletes files needs a failure-path test, not
  just a happy-path one. `rollback.test.ts` and `organizer.test.ts` are the
  reference cases.

## Safety Notes for Agents
- **This application mutates a real audiobook library.** Any change to
  `organizer.ts`, `rollback.ts`, `scanner.ts`, or the commit/rollback routes can
  destroy user data. Route every filesystem write through
  `security/paths.ts` containment helpers.
- Secrets live in `/app/data/secrets.json`, separate from settings, and are
  never returned by the settings API. Never interpolate a secret into a log
  line: `index.ts` buffers all console output into `GET /api/system/logs` and
  broadcasts it over the WebSocket. `security/redact.ts` is a backstop, not a
  licence.
- Auth is off by default. The backend enforces roles, but the frontend does not
  yet send a token, so `AUTH_ENABLED=true` currently breaks the UI.
- SQLite migrations run at startup against a mounted volume. Assume every
  schema change ships to a live database with no manual step.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative, and sentence case (e.g., `Add CI/CD setup guide`).
- PRs should include a clear title/description, linked issues, and screenshots for UI changes.
- Before opening a PR: run `npm run typecheck`, `npm run lint`, and `npm test`.

## Configuration & Data Notes
- Every environment variable is documented in `apps/backend/.env.example`.
- Runtime state lives in `DATA_DIR` (`/app/data`): `settings.json`,
  `secrets.json`, `settings-history.json`, `history.json`, `curator.db`.
  Back it up before upgrades; never delete it during a rollback.
- The inbox and library should share a filesystem so finalization is atomic.
  The cross-device path is handled but copies and verifies instead of renaming.

## Scraping & External Integrations

### AudiobookBay (ABB)
- **Search Queries:** All search strings sent to ABB's `?s=` parameter MUST be converted to lowercase (`.toLowerCase()`). Uppercase characters trigger a server-side redirect to the homepage, dropping the search entirely.
- **Anti-Bot Challenge:** When the system intercepts an anti-bot challenge redirect (e.g. `?ch=1`), the scraping service must solve the challenge to capture the `cf_clearance` cookie, and then **re-fetch the original query URL**. Do not fetch the redirect URL, as it strips the search query parameters.

### AudiobooksNow (ABN)
- **Cover Images (Nuxt Hydration):** ABN list pages lazy-load their images. The `img.jacketSmall` tags only contain SVG placeholders in the raw HTML. To scrape the real cover URLs, you must extract them from the `window.__NUXT__` JSON state payload injected at the bottom of the HTML document.
- **Descriptions:** ABN list pages do not contain book descriptions. 

### Metadata Enrichment
- **iTunes Search API:** Prefer the iTunes API (`https://itunes.apple.com/search?term={title+author}&media=audiobook&limit=1`) for fetching missing metadata (like descriptions) on the fly. It is completely free, does not require an API key, handles CORS natively for frontend fetches, and provides high-quality HTML blurbs. Avoid Google Books API or OpenLibrary, as they are strictly rate-limited or lack reliable descriptions.
