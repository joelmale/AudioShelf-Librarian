# P2 publication and handoff

Status: published, awaiting user review. P1 remains accepted.
Phase: P2 — Discover browsing continuity and source-search continuation.

## P2 Delivered Changes

1. **Charts Browsing Continuity & Clean Layout:**
   - Removed the always-open ABB/source search panel and divider from `/discover/charts`.
   - Chart browsing now focuses exclusively on chart candidate evaluation.
   - Selected candidate index, tab (`?tab=...`), and return anchor (`#bestseller-item-N`) are preserved across search and Back navigation.
   - Restores scroll position and focuses the return anchor button on Back.
   - Compact mobile header layout ensures candidate #1 is visible without initial scrolling at 390x844 (measured top at 443px).
   - Clamped card titles to two lines with ellipsis to maintain predictable card heights.

2. **Source Search Continuation & Safe Navigation:**
   - Dedicated direct route `/discover/search?q=...&returnTo=...`.
   - `sanitizeReturnTo` strictly validates internal path allowlist (`/discover`, `/library`, `/ask`, `/desk`, `/activity`, `/settings`, `/scout`, `/curate`). Rejects untrusted external URLs (`https://...`), protocol-relative URLs (`//...`), and script injection (`javascript:`).
   - "Back to chart" (or "Back to suggestions") link displayed when valid `returnTo` is provided.
   - Search lifecycle guard: AbortController and request sequence IDs ensure out-of-order responses do not overwrite newer results.
   - Clear explicit states: `idle` (unsubmitted query does not show empty results or error), `searching`, `empty` (distinct empty message with submitted query), `error` (retryable), and `results`.

3. **Recommendation Finder ("For you") Continuity:**
   - Results snapshot cached in session storage; returning via Back restores verified suggestions without triggering redundant LLM recommendations or store fetches.
   - Clear recovery link to retry/generate fresh recommendations if snapshot is missing.
   - Explicit "For you" destination label without fabricated personalization promises.
   - "Search sources" link carries safe `returnTo=/discover/for-you` handoff.

4. **Accessible Description Preview:**
   - Accessible pinned overlay / modal with Escape key handling and explicit close button.
   - Focus is restored to the trigger button upon closing.
   - iTunes metadata enrichment with retry button on transient failure (does not cache failures).
   - Broken cover fallback styling for missing artwork.

5. **Desktop Book List Filter & Page Retention:**
   - `/library/books` synchronizes `search`, `category`, `tag`, `untagged`, and `page` parameters with URL search params and session storage.
   - Navigating to `/library/books/:id` and clicking `← Books` (or browser Back) restores exact search filters and pagination.

## Synthetic Browser Verification Evidence

Executed via `scripts/ui-p2-browser.mjs` against prebuilt frontend distribution across 3 viewports:

- **390x844 (Mobile):** PASS — Candidate #1 top at 443px (visible above fold without scrolling); 39 fixture calls, 0 blocked/leaked requests, 7 assertions passed.
- **768x1024 (Tablet):** PASS — 36 fixture calls, 0 blocked/leaked requests, 6 assertions passed.
- **1440x1000 (Desktop):** PASS — 36 fixture calls, 0 blocked/leaked requests, 6 assertions passed.

Full evidence reports and screenshots captured in `temp/ui-p2-browser/`:
- `p2-charts-390x844.png`, `p2-search-390x844.png`, `p2-books-390x844.png`
- `p2-charts-768x1024.png`, `p2-search-768x1024.png`, `p2-books-768x1024.png`
- `p2-charts-1440x1000.png`, `p2-search-1440x1000.png`, `p2-books-1440x1000.png`

## Release Verification Gates

Integration worktree, Node 24:
- `npm run typecheck` — 0 errors across shared, backend, frontend.
- `npm run lint` — 0 errors, 130 baseline warnings (down from 131).
- `npm test` — 26 frontend test files (234 tests) + full backend test suite passed.
- `npm run build` — Shared, backend, and frontend Vite bundles built cleanly.
- `npm run verify:bundle` — 289555/300000 initial JS bytes (under budget); deferred chunks verified.
- `npm run release:check` — Release 1.1.0 metadata consistent.

## Regression & Manual Acceptance Checklist (Dockhand)

Deploy the published container image in Dockhand and verify the following on mobile and desktop:

1. **Charts (/discover/charts):**
   - Verify there is no inline search panel at the top of the Charts tab.
   - At mobile width (e.g. 390px), verify candidate #1 is visible without initial scrolling.
   - Switch to another chart source tab (e.g. Apple or AudiobooksNow); verify tab persists in URL `?tab=...`.
   - Scroll down to candidate #5 or #10, click its search button to navigate to `/discover/search?q=...&returnTo=...`.
   - Click "← Back to chart" link (or browser Back); verify the chart returns to the same tab and scrolls back to the candidate card.
2. **Source Search (/discover/search):**
   - Open `/discover/search`. Verify initial idle state prompts for a search query and does NOT say "No results found".
   - Type a query without submitting; verify it stays in idle state without flashing empty results.
   - Submit a search; verify results appear. Click Clear; verify input and results reset cleanly.
   - Test malformed `returnTo`: navigate to `/discover/search?q=test&returnTo=https://evil.com`. Verify no "Back" link to evil.com is rendered.
3. **For You Recommendations (/discover/for-you):**
   - Click "For you" tab. Generate suggestions or view existing recommendations.
   - Click "Search sources" on a suggestion to navigate to `/discover/search`.
   - Click "← Back to chart" (or browser Back); verify prior verified suggestions are restored immediately without regenerating or making new LLM calls.
4. **Description Preview:**
   - On Charts, click the info icon on any card to view description modal/sheet.
   - Press `Escape` or click the `X` button; verify modal closes and focus returns to the info button.
5. **Library Books (/library/books):**
   - Filter by a category or search term, navigate to page 2 if multiple pages exist.
   - Click a book to view its detail page (`/library/books/:id`).
   - Click `← Books` at the top; verify search query, category filter, and page number remain intact.

## Migration & Rollback

- **Migration:** None. P2 is a purely frontend continuity and navigation enhancement. No backend database schema changes or migrations.
- **Rollback image:** Accepted P1 image `ghcr.io/joelmale/audioshelf-librarian@sha256:f12d1208bd83c542e88c3933d0359189cda50f83155a04d4d12488a3a28f913c`.
