# P2 work orders

Baseline: accepted P1 application source `e033392db031a2a05d22b372f34e0e568ec5fb47`, published as `ghcr.io/joelmale/audioshelf-librarian@sha256:f12d1208bd83c542e88c3933d0359189cda50f83155a04d4d12488a3a28f913c`. Root owns sequencing, integration, publication, and the user gate. No live writes.

## Contract and sequence

Sol/high tech_lead completed P2 architectural planning and requirements reconciliation against `docs/ui-simplification-plan.md`, `docs/primary-ui.md`, and `docs/current-status.md`.

1. **P2-A, Terra/medium ic_implementer:**
   - Files: `apps/frontend/src/features/librarian/utils/safeNavigation.ts`, `apps/frontend/src/features/librarian/context/browseContext.ts`.
   - Outcome: `sanitizeReturnTo` preventing open redirects / javascript protocol attacks, enforcing internal prefix allowlist (`/discover`, `/library`, `/ask`, `/desk`, `/activity`, `/settings`, `/scout`, `/curate`). Created `browseContext` session storage manager for `bestsellersSnapshot`, `recommendationsSnapshot`, and `bookListSnapshot`.
2. **P2-B, Terra/medium ic_implementer:**
   - Files: `apps/frontend/src/preview/pages/ScoutPage.tsx`, `apps/frontend/src/features/librarian/components/BestsellerLists.tsx`, `apps/frontend/src/features/librarian/components/BestsellerLists.css`, `apps/frontend/src/features/librarian/components/BestsellerLists.test.tsx`.
   - Outcome: Removed always-open search panel and divider from Charts (`mode === "trends"`). Preserved active source tab and candidate anchor across navigation. Restored scroll and focus on Back. Implemented accessible pinned description overlay with Escape handling and focus return to trigger button, transient failure retry, and broken cover fallback. Added CSS two-line title clamping and mobile fold optimization (candidate #1 visible without initial scroll at 390x844).
3. **P2-C, Terra/medium ic_implementer:**
   - Files: `apps/frontend/src/features/librarian/components/AudiobookSearch.tsx`, `apps/frontend/src/features/librarian/components/AudiobookSearch.test.tsx`, `apps/frontend/src/features/librarian/components/RecommendationFinder.tsx`, `apps/frontend/src/features/librarian/components/RecommendationFinder.test.tsx`, `apps/frontend/src/features/curator/pages/Books.tsx`, `apps/frontend/src/features/curator/pages/BookDetail.tsx`, `apps/frontend/src/features/curator/pages/Books.test.tsx`.
   - Outcome: Direct source search route with `q`, query sync, safe back link using `sanitizeReturnTo`, AbortController and request sequence ID protection against stale responses (response B before A remains visible), explicit `idle`/`searching`/`empty`/`error`/`results` states, unsubmitted query guard. Recommendation Finder restores prior verified results from session snapshot without re-issuing LLM/external fetch calls on Back; honest "For you" labeling. Desktop Book list syncs search params and snapshot state, preserving filters (`search`, `category`, `tag`, `untagged`) and page across detail views and Back navigation.
4. **Independent P2-D Review and Browser Acceptance Harness, Terra/high ic_reviewer:**
   - Files: `scripts/ui-p2-browser.mjs`.
   - Outcome: Created synthetic browser acceptance harness serving prebuilt dist without live backend, verifying 390x844, 768x1024, and 1440x1000 viewports. Identified and repaired infinite refetch loop in `BestsellerLists` on mount/activeTab change. Verified mobile fold (candidate #1 visible without initial scroll at 390x844), absence of top search panel on Charts, candidate handoff and anchor/tab restoration on Back, rejection of malformed external/protocol-relative return URLs, idle/unsubmitted search state protection, description overlay focus restoration, and desktop book list filter retention.
5. **Root integration and gate:**
   - Verified local release gate: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run verify:bundle`, `npm run release:check`.
   - Published synthetic browser evidence in `temp/ui-p2-browser/`.
   - Prepared checkpoint and handoff documentation.

No global durable candidate IDs before P3; no P3 intent persistence, P4 activity cutover, or P7 work performed in P2.
