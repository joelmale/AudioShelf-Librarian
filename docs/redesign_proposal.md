# AudioShelf Librarian — Product Experience Redesign

**Status:** implementation proposal  
**Scope:** `apps/frontend` React/Vite application  
**North star:** give an Audiobookshelf owner an expert librarian sidecar that can scout, acquire, curate, repair, and process a collection—without duplicating Audiobookshelf's listening or everyday browsing experience.

![AudioShelf-Librarian desktop and mobile sidecar redesign](./audioshelf-sidecar-mockup-v2.png)

## Executive recommendation

AudioShelf-Librarian should stop presenting “Librarian” and “Curator” as two products nested inside one another. It is an expert back-office companion to Audiobookshelf, which remains the system of record and the place for browsing and listening. Reframe this sidecar around specialist jobs:

- **Desk** — an expert briefing: trends, exceptions, active work, and recommended next actions.
- **Scout** — trends, bestseller intelligence, external search, and candidate evaluation.
- **Acquire** — download handoff, qBittorrent status, intake, and duplicate safeguards.
- **Curate** — metadata repair, tagging, collection design, and push-to-Audiobookshelf review.
- **Process** — directory cleanup, organization, preferred-M4B conversion, and job queues.
- **Activity** — unified operations, progress, history, errors, and logs.

On desktop these live in a persistent rail and command surface. On mobile, Desk, Scout, Curate, Activity, and More become a five-item bottom bar; a central **New task** action opens Acquire, Scan, Organize, and Convert shortcuts. Advanced controls open as sheets.

### Product boundary

AudioShelf-Librarian must **not** recreate Audiobookshelf's catalog home, playback, listening progress, user libraries, podcasts, shelves, or general book browsing. Covers and book lists appear only when they support a librarian task: a search candidate, metadata exception, collection proposal, duplicate, conversion candidate, or operation.

- **Audiobookshelf:** consume, browse, listen, and hold the canonical library.
- **AudioShelf-Librarian:** research, acquire, diagnose, modify, organize, convert, and audit.
- Changes are previewed locally, then applied to the filesystem and/or pushed to Audiobookshelf with a visible destination and outcome.
- A persistent Audiobookshelf connection badge provides health, sync state, and **Open in Audiobookshelf** deep links.

The recommended visual language is **Midnight Editorial**: ink-black foundations, legible cool-white type, restrained spectral accents, dimensional book art, and glass only on transient or elevated layers. “Premium” should come from hierarchy, pacing, motion, and material discipline—not indiscriminate blur or neon.

## 1. Current-state UX audit

### What exists today

The root app mounts one global fixed sidebar and routes to Librarian, Curator, logs, status, and settings. Curator then mounts its own `220px` sidebar and nested routes. Librarian is a single vertically stacked page containing search, bestsellers, scan controls, progress, and review.

| Area | Current model | UX consequence |
|---|---|---|
| Root shell | `/`, `/curator/*`, `/logs/*`, `/status`, `/settings` | Product architecture mirrors backend ownership rather than user goals. |
| Librarian | One `maxWidth: 800px` feed | Discovery and destructive/long-running work compete in one scroll. |
| Curator | Second app shell inside root shell | Duplicate navigation, lost horizontal space, inconsistent identity. |
| Curator routes | Dashboard, books, tagging, collections, encoding | Books is routable but absent from the Curator `NAV` array; discovery depends on indirect links. |
| State feedback | Toasts, page-local progress, logs | Long-running jobs are fragmented and can disappear when navigating. |
| Styling | `theme.css`, a 527-line Curator stylesheet, and extensive inline styles | Tokens and breakpoints cannot govern behavior consistently. |

### Evidence from the implementation

- Neither `apps/frontend/src/styles/theme.css` nor `features/curator/styles.css` contains an `@media` query.
- The root sidebar is `250px` plus `48px` horizontal padding; Curator adds a second `220px` column. On a `768px` viewport, navigation alone can consume roughly 518px before content padding.
- The root `.content` adds `40px` padding regardless of viewport.
- More than 400 JSX `style={...}` declarations are distributed across the frontend. The highest concentrations are Settings (56), System Status (36), Scan Results Review (30), metadata modal (26), search (20), and encoder pages/components.
- Librarian hard-codes `gridTemplateColumns: '1fr 1fr'` for scan inputs and `'1fr auto auto'` for search controls.
- Curator uses `.app { grid-template-columns: 220px 1fr; height: 100vh; }`, `.layout-row { grid-template-columns: 220px 1fr; }`, and minimum-width grids without mobile fallbacks.
- Global class names such as `.sidebar`, `.main`, `.card`, `.row`, and `.btn` cross feature boundaries; both shells use `.sidebar`, making cascade ownership ambiguous.
- Mojibake appears in rendered strings (`â€¦`, `Â·`, `â€”`, `âœ¨`), visibly reducing perceived quality.
- `GenerateModal` in Collections references `discover` even though that mutation is declared inside the parent `Collections` component; this control is a functional dead end/type failure, not only a styling defect.

### Critical friction points

#### 1. Discovery and operations are interleaved

Search and bestsellers invite browsing, while scan, parse, metadata enhancement, and organize are consequential jobs. Stacking them creates mode switching and makes the page’s primary action unclear. A user who wants to scan must move past discovery content; a user browsing results is exposed to infrastructure controls.

#### 2. The product uses system vocabulary as navigation

“Librarian” and “Curator” are implementation domains. Users think “find a book,” “fix metadata,” “organize my library,” and “see what is running.” Navigation should use those verbs and objects.

#### 3. Long-running work lacks a persistent home

Scan, tagging, collection generation, and encoding each expose progress differently. Navigating away can remove context. Pause, resume, retry, cancellation, errors, and audit output need one durable Activity model plus compact global job status.

#### 4. Dense review interfaces lack triage

Scan review, book filtering, tag analytics, and encode queues place many controls at equal emphasis. There is little separation between “needs attention,” “safe automatic fix,” and “inspect later.” Bulk selection, saved filters, and a review queue should reduce repeated decisions.

#### 5. Empty, loading, and failure states are inconsistent

Some views show plain muted text, others use toasts, and operations may expose raw errors. Empty states rarely teach the next action. Skeletons, recoverable inline errors, retry actions, and job completion links should be standardized.

#### 6. Navigation contains hidden paths and dead ends

Books has routes but no Curator navigation item. Nested shells obscure location. External search results send users to a new tab, while acquisition status is only locally marked. Collection generation contains an out-of-scope action reference. Back-navigation and breadcrumbs are not consistently modeled in detail pages.

### Exact mobile breakdowns

| Component/layout | Failure at narrow width | Required behavior |
|---|---|---|
| Root `.layout` + `.sidebar` | Remains a horizontal flex row; sidebar never collapses. | Replace with responsive `AppShell`; bottom bar below `768px`. |
| Nested Curator `.app` | Adds another fixed grid/sidebar within remaining width. | Delete feature shell; render routes in the single app shell. |
| `.content { padding: 40px }` | Leaves too little content width and causes compressed cards. | Fluid gutters: 16 / 24 / 32px. |
| Librarian search form | `1fr auto auto`, `minWidth: 150px`, and paired buttons overflow or crush input. | Search first row; filters in sheet; full-width submit on mobile. |
| Scanner controls | Two hard-coded columns; long directory labels and select collide. | One-column form in bottom sheet with sticky submit. |
| Bestseller rows/cards | Inline fixed card geometry and controls make horizontal overflow/very narrow tiles. | Scroll-snap media rail with 72–80% card width. |
| Search-result grid | `minmax(200px, 1fr)` plus panel padding can overflow small devices. | One-column compact media cards; cover + metadata row. |
| Books `.layout-row` | Fixed 220px filter column plus results grid. | Filter/sort button opens modal sheet; active filters become removable chips. |
| Tagging action row | Checkboxes, spacer, and CTA assume horizontal space. | Stacked option group; sticky bottom job CTA. |
| Tagging progress hero | Circular chart, detail block, and vertical controls remain one flex row. | Compact progress card; controls in overflow menu/sheet. |
| Tables/encode queues | Dense columns do not establish priority or horizontal affordance. | Mobile job cards; desktop data table; no hidden critical state. |
| Modals | `92vw` helps width, but desktop grid/actions remain dense and viewport height handling is partial. | Mobile bottom sheets with safe-area padding, focus trap, and sticky actions. |

## 2. Experience principles

1. **Sidecar, not substitute.** Every surface must justify itself as research, curation, repair, processing, or audit—not listening or catalog browsing.
2. **Local first, visibly.** Show local-data boundaries, storage health, filesystem impact, and Audiobookshelf connection state.
3. **One action, one consequence.** Risky workflows get previews, counts, destinations, estimates, and reversible checkpoints.
4. **Jobs travel with the user.** Active work remains visible globally and resumes context with one tap.
5. **Evidence before modification.** Recommendations explain why metadata, collection, directory, or encoding changes are proposed.
6. **Progressive disclosure.** Default views answer “what needs me?” Advanced options live one layer deeper.
7. **Motion explains.** Animation confirms origin, state, and hierarchy; it never delays work.
8. **Mobile is a different composition, not a shrunken desktop.** The same specialist capabilities are reorganized for one-handed use.

## 3. Reimagined information architecture

### Proposed route map

```text
/
├── /desk
├── /scout
│   ├── /trends
│   ├── /search
│   └── /lists/:source/:list
├── /acquire
│   ├── /downloads
│   └── /intake
├── /curate
│   ├── /review
│   ├── /books/:id
│   ├── /collections
│   ├── /collections/:id
│   └── /tags
├── /process
│   ├── /scan
│   ├── /review/:scanId
│   ├── /organize
│   ├── /encode
│   └── /encode/jobs/:jobId
├── /activity
│   └── /:operationId
└── /settings
    ├── /connections
    ├── /storage
    └── /appearance
```

Legacy paths should redirect to their new destinations for bookmarks and in-flight development links.

### Desktop shell

- **72px rail** at medium widths; **240px expanded navigation** on large screens.
- **Command bar** with universal book/job search, `⌘/Ctrl K`, active-job indicator, connectivity, and profile/settings menu.
- **Content canvas** capped around `1600px`, using a 12-column grid.
- **Context rail** only when useful: selected book, filters, or job queue. It must not be permanently nested navigation.
- **Route-aware breadcrumbs** on detail and workflow pages.

### Mobile shell

- Sticky 56px top bar for context and global status.
- Five destinations: Desk, Scout, Curate, Activity, More.
- Central elevated **New task** action opens Acquire, Scan, Organize, and Convert; the tool opens as a full-height sheet or focused route.
- `env(safe-area-inset-bottom)` padding and minimum 44px targets.
- Full-screen route transitions for details; bottom sheets for filters, sort, job controls, and quick actions.
- Persistent active-job mini-card above the bottom bar; collapses to a progress pill.

### Primary workflow redesigns

#### Scout → acquire

1. Enter a title/author from a hero search field or select an editorial list.
2. Browse scroll-snap covers on mobile or responsive editorial grid on desktop.
3. Open a quick-look drawer with source, size, date, category, and availability.
4. Choose **Add to downloads**; show destination and qBittorrent status in a confirmation sheet.
5. Persist the handoff as an Activity item. Offer **View job** instead of a transient-only toast.

Search filters move into a drawer/sheet; query, category, sort, and page live in URL search parameters so states are shareable and browser navigation works.

#### Scan → review → organize

1. Launch Scan globally.
2. Choose a recent/default directory or browse; advanced scan strategy is collapsed.
3. Show a preflight summary: path, estimated files, exclusions, and output behavior.
4. Start a background job. Leave the screen safely while a persistent progress capsule remains.
5. Completion opens a triage summary: **Ready**, **Needs review**, **Skipped**, **Failed**.
6. Review by exception, with keyboard shortcuts on desktop and swipe actions on mobile.
7. Preview proposed file changes before organizing; confirm with a clear count and undo/restore guidance.

#### Curate and push

- Curate defaults to actionable queues: Missing Metadata, Untagged, Duplicates, Collection Proposals, and Failed Pushes—not a general catalog.
- Desktop filters use a collapsible rail; mobile filters use a bottom sheet.
- Task-focused book detail uses Diagnosis, Proposed Changes, Files, and Activity, plus **Open in Audiobookshelf**. It is not a playback page.
- Tagging starts from a reviewable batch definition, shows cost/impact, and stores the result as a job.
- Collection generation becomes a guided composer: source rules → templates/prompt → preview → approve → push.

#### Organize → convert → publish

1. Scan an intake or library directory and classify files without moving anything.
2. Present current path → proposed path, collisions, unmatched files, and estimated disk impact.
3. Adjust rules and rerun a dry run before applying changes.
4. Apply organization with an audit manifest and recovery guidance.
5. Detect titles outside the preferred M4B profile; show codec, chapters, cover, duration, and size implications.
6. Queue conversion with named presets, bounded concurrency, and pause/resume/cancel controls.
7. Validate output before replacing or archiving sources, then trigger an Audiobookshelf rescan and report the result.

## 4. Design system: Midnight Editorial

### Typography

Use self-hosted variable fonts to preserve local-first behavior and eliminate third-party font requests.

- **Display:** Outfit Variable, 600–750. Friendly geometry gives headings a recognizable editorial voice.
- **Interface/body:** Inter Variable, 400–650. Excellent small-size clarity for metadata and controls.
- **Technical/paths/logs:** JetBrains Mono Variable, 400–600.

Type scale (mobile / desktop):

| Token | Size | Use |
|---|---:|---|
| `display-lg` | 40/56px, 1.02 | Home statement / major empty state |
| `display-sm` | 32/40px, 1.08 | Page title |
| `heading-lg` | 24/28px, 1.2 | Section title |
| `heading-sm` | 18/20px, 1.3 | Card title |
| `body-lg` | 16/17px, 1.55 | Introductory copy |
| `body` | 14/15px, 1.5 | Default UI copy |
| `label` | 12/13px, 1.3 | Metadata; never below 12px |

### Semantic color tokens

```css
:root {
  --ink-950: #080a10;
  --ink-900: #0d111b;
  --ink-850: #101522;
  --ink-800: #171d2c;
  --line-subtle: rgba(185, 198, 230, 0.12);
  --line-strong: rgba(185, 198, 230, 0.24);
  --text-primary: #f5f7ff;
  --text-secondary: #a8b0c3;
  --text-tertiary: #737e96;
  --accent-violet: #8b5cf6;
  --accent-cyan: #22d3ee;
  --accent-coral: #fb7185;
  --success: #34d399;
  --warning: #fbbf24;
  --danger: #fb7185;
  --focus: #67e8f9;
}
```

Accents are semantic: violet for primary/product actions, cyan for active automation, mint for healthy/completed, amber for review, coral for errors/destructive actions. Avoid using gradients behind body text. Provide a light theme later from semantic aliases rather than duplicating component CSS.

### Spacing, radii, elevation

- Spacing follows a 4px base: `1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24` → `4–96px`.
- Page gutters: 16px mobile, 24px tablet, 32–48px desktop.
- Radii: 8px controls, 12px compact cards, 16px standard cards/sheets, 24px hero surfaces, pill only for chips/status.
- Shadows: two restrained elevation levels; borders carry more hierarchy than drop shadows.
- Touch targets: 44px minimum; desktop compact mode may use 36px where pointer input is detected.

### Component inventory

Build primitives before pages:

- AppShell, NavigationRail, MobileTabBar, TopCommandBar
- Button, IconButton, LinkButton, SplitButton
- Field, Select, Combobox, Checkbox, Switch, PathPicker
- Surface, BentoCard, MediaCard, StatCard, JobCard
- Badge, StatusDot, ProgressBar/Ring, Skeleton
- Tabs, SegmentedControl, Tooltip, Popover, DropdownMenu
- Dialog, AlertDialog, Sheet, Drawer, Toast
- DataTable desktop + RecordCard mobile
- EmptyState, InlineError, ConnectivityBanner

Every component needs default, hover, focus-visible, active, disabled, loading, error, and reduced-motion behavior in Storybook.

### Glass, glow, and bento discipline

- Glass is reserved for command bar, sheets, floating job capsule, and overlays. Content cards use opaque surfaces for contrast and rendering performance.
- Use one ambient radial glow per view, at 6–12% opacity. Active operations may add a small cyan edge glow; never glow every card.
- Bento layouts communicate priority: one dominant “next action,” one current operation, then supporting health/recency cards. Avoid arbitrary card sizes.
- Book covers provide chromatic energy. The shell stays quiet so artwork can lead.

### Motion language

Use Motion (`motion/react`, formerly Framer Motion) for orchestrated transitions and CSS for simple state changes.

- 120–160ms: hover, press, tooltip.
- 180–240ms: sheet/card transitions.
- 300–420ms: route/shared-element transitions.
- Curves: `cubic-bezier(.2,.8,.2,1)` standard; spring only for direct manipulation.
- Scroll-triggered entrance is limited to first exposure of editorial rails and bento groups; stagger 30–50ms, translate no more than 12px.
- Cover → detail uses shared layout animation where supported.
- Progress changes animate continuously, but status text remains stable for screen readers.
- `prefers-reduced-motion` removes translation, parallax, continuous glow, and stagger.

## 5. Tooling and frontend architecture

### Recommended stack

| Concern | Choice | Rationale |
|---|---|---|
| Styling | **Tailwind CSS v4** with CSS custom-property tokens | Fast composition, enforceable responsive variants, co-located styles without ungoverned inline objects. |
| Accessible primitives | **Radix UI** selectively | Robust dialogs, sheets, menus, tooltips, tabs, focus management, and keyboard behavior. |
| Components | Internal `ui/` layer inspired by shadcn patterns, not wholesale theme adoption | Own the visual system while retaining composable primitives. |
| Motion | **Motion for React** | Shared layout, presence, gestures, and reduced-motion APIs. |
| Icons | Continue **Lucide React** | Already installed and visually compatible; standardize sizes/strokes. |
| Data/state | Continue TanStack Query; add URL search params for browse/filter state | Existing server-state model is appropriate. |
| Routing | Continue React Router; introduce route objects, lazy loading, handles/breadcrumbs | Removes nested feature shell and clarifies hierarchy. |
| Forms | React Hook Form + Zod for consequential workflows | Validation, typed payloads, and explicit preflight steps. |
| Component QA | Storybook + axe addon + visual regression | Makes states and breakpoints reviewable outside live backend flows. |
| Testing | Vitest/RTL plus Playwright at 390, 768, 1440px | Covers interaction, focus, mobile layout, and critical jobs. |

Tailwind should replace layout and presentation inline styles. Runtime-calculated values—progress-ring offsets, chart coordinates, cover-derived accent colors—may remain CSS custom properties set inline. Do not mix a large utility layer with a second bespoke global component stylesheet.

### Suggested source structure

```text
apps/frontend/src/
├── app/              # router, providers, responsive shell
├── design-system/    # tokens, primitives, patterns, icons
├── features/
│   ├── discovery/
│   ├── library/
│   ├── automation/
│   ├── activity/
│   └── settings/
├── hooks/
├── lib/
└── styles/
    ├── tokens.css
    ├── fonts.css
    └── globals.css
```

Use feature names that match user concepts. API modules can retain backend naming internally.

## 6. Implementation plan

### Phase 0 — baseline and risk removal (2–3 days)

- Capture screenshots at 390×844, 768×1024, 1280×800, and 1440×900.
- Instrument top tasks: search → download, scan → review → organize, tag batch, create/push collection, encode job.
- Fix collection modal scope error and visible encoding/mojibake.
- Add smoke tests for every existing route and record baseline Lighthouse/axe results.
- Freeze new inline styling except calculated CSS variables.

**Exit:** all routes render; critical workflows have baseline tests and screenshots.

### Phase 1 — foundations (4–6 days)

- Install Tailwind v4, Motion, Radix primitives, Storybook, axe, and Playwright.
- Add self-hosted Outfit, Inter, and JetBrains Mono variable subsets.
- Implement tokens, dark theme, focus ring, typography, icons, reduced motion, and safe-area helpers.
- Build Button, Field, Surface, Badge, Progress, Skeleton, EmptyState, Sheet, Dialog, Toast.

**Exit:** primitives pass keyboard/axe checks and render across all target widths.

### Phase 2 — unified shell and routes (4–6 days)

- Replace root and Curator shells with one route-aware AppShell.
- Add desktop rail, command bar, mobile tab bar, job capsule, and connectivity menu.
- Move routes to the new IA and add legacy redirects.
- Lazy-load feature bundles and introduce route error boundaries.

**Exit:** every current capability is reachable through one navigation system; no nested sidebar remains.

### Phase 3 — Scout and Acquire vertical slice (5–7 days)

- Rebuild external search with URL-owned query/filter/page state.
- Build editorial bestseller rails, media cards, quick-look drawer, and download confirmation.
- Connect handoffs to Activity and add useful empty/error/retry states.
- Verify ABB query lowercasing and anti-bot resume behavior remain intact.

**Exit:** search → inspect → download is responsive, keyboard accessible, and persistent in Activity.

### Phase 4 — Scan and review workflow (7–10 days)

- Build scanner sheet/wizard, recent paths, directory picker, advanced options, and preflight.
- Normalize scan progress into the global job model.
- Rebuild review as exception-based triage with bulk actions and proposed-change preview.
- Provide desktop shortcuts and mobile swipe alternatives with visible button equivalents.

**Exit:** scan can start on mobile, survive navigation, complete, and lead directly to actionable review.

### Phase 5 — Curation and Audiobookshelf handoff (7–10 days)

- Rebuild actionable review queues, task-focused book detail, filters, and metadata quality states; do not build a parallel catalog.
- Rebuild tagging around batch preview and job lifecycle.
- Rebuild collections as composer → preview → approve → push.
- Use table/card responsive pairs for high-density views.

**Exit:** metadata, tags, and collections have complete mobile and desktop review/push paths, and modified items deep-link to Audiobookshelf.

### Phase 6 — Automation, Activity, and system surfaces (7–10 days)

- Consolidate scan, directory organization, tagging, collection generation, Audiobookshelf sync, and M4B conversion operations.
- Rebuild encoder queue/detail with progressive disclosure.
- Merge logs, history, and operation status into Activity; keep raw console as an expert view.
- Rebuild status/settings with responsive form sections and connection diagnostics.

**Exit:** every long-running action has consistent pause/resume/cancel/retry semantics and durable history.

### Phase 7 — polish, performance, and release (4–6 days)

- Add shared-element transitions and restrained scroll choreography.
- Optimize covers, lazy loading, content visibility, and route chunks.
- Complete visual regression, device, keyboard, screen reader, reduced-motion, and contrast passes.
- Release behind `ui_v2`; support route-level fallback during staged migration, then remove legacy CSS/components.

**Exit:** acceptance targets pass and legacy shell/styles are deleted.

## 7. Migration mechanics

Do not “rip out” the UI in one merge. Use a strangler migration:

1. Introduce tokens and primitives without changing routes.
2. Mount the new shell behind `ui_v2`.
3. Migrate one complete journey at a time, starting with Discovery, then Scan.
4. Redirect old routes only after parity tests pass.
5. Delete old component styles as each feature reaches parity; track inline-style count in CI.
6. Remove the flag after two stable releases, then delete legacy routes and global selectors.

Add lint rules that reject raw hex values outside token files and non-calculated JSX `style` props. Prefer feature-scoped composition and `data-state` attributes over global class collisions.

## 8. Acceptance criteria

### Responsive and usability

- No horizontal page scroll at 320px through 1920px, excluding intentional media rails/data scrollers.
- Primary mobile actions are reachable with one hand and have ≥44×44px targets.
- All workflows work at 200% zoom and landscape mobile.
- Bottom sheets respect safe areas and onscreen keyboards.
- Navigation, filters, dialogs, and job controls are fully keyboard operable.

### Accessibility

- WCAG 2.2 AA contrast; focus never obscured.
- Automated axe reports zero critical/serious violations on primary routes.
- Dialog focus trap/restore, semantic headings, live regions for job updates, and non-color status cues.
- Reduced-motion mode retains state clarity without decorative movement.

### Performance

- Target Lighthouse mobile: Performance ≥90, Accessibility ≥95, Best Practices ≥95.
- LCP ≤2.5s on a representative local library; CLS ≤0.05; INP ≤200ms.
- Route-level lazy loading; cover dimensions reserved; offscreen grids virtualized or content-visibility optimized where collection size warrants it.
- Blur is removed or reduced on lower-power devices and large scrolling surfaces.

### Product success measures

- Median time to start a scan under 20 seconds.
- Search-to-download handoff under 3 meaningful actions after result selection.
- 100% of long-running jobs discoverable from Activity.
- Reduce review decisions per clean scan by grouping safe items and prioritizing exceptions.
- No hidden navigation destinations or toast-only success/failure outcomes.

## 9. Concept mockup notes

The companion image, `audioshelf-sidecar-mockup-v2.png`, is the revised visual north star. It replaces the earlier consumer-library concept with the specialist sidecar roles: Desk, Scout, Acquire, Curate, Process, and Activity. It demonstrates:

- editorial cover-first trend research and acquisition;
- a quiet midnight shell with focused spectral accents;
- bento hierarchy for current work and library health;
- persistent job context;
- distinct desktop and mobile compositions;
- mobile task access, candidate rails, compact job cards, and bottom navigation.

Generated with the built-in image-generation workflow using the `ui-mockup` use case. Final implementation must use real application content, accessible HTML, the token system above, and responsive components—not the rendered image as UI.

### Reusable generation prompt

> Create an Awwwards-caliber desktop and mobile UI showcase for AudioShelf-Librarian, an expert sidecar to Audiobookshelf. Do not reproduce playback, listening progress, consumer shelves, or general catalog browsing. Its jobs are to research trends and bestseller lists, search external sources, evaluate and download candidates, diagnose and modify metadata, propose and push collections to Audiobookshelf, safely reorganize directories, and convert source audio to preferred chaptered M4B. Use a premium midnight interface with cool-white type, restrained violet/cyan/coral accents, fictional covers only in trend/search candidate cards, subtle glass on elevated layers, and a purposeful bento grid. Desktop navigation: Desk, Scout, Acquire, Curate, Process, Activity. Show an expert briefing, trend intelligence, metadata exceptions, current scan/conversion, filesystem-change preview, and Audiobookshelf push status. Mobile: candidate rails, compact job cards, bottom navigation Desk, Scout, Curate, Activity, More, and a central New Task action for Acquire, Scan, Organize, and Convert. Include Open in Audiobookshelf and Push changes handoffs. Avoid playback controls, listening UI, catalog navigation, generic admin dashboards, excessive neon/blur, tiny text, watermarks, and browser chrome.

## Final direction

The redesign succeeds if AudioShelf-Librarian feels like the trusted expert beside Audiobookshelf: informed when scouting, cautious when changing metadata or files, precise when processing audio, transparent while work is running, and clear about what remains local versus what will be pushed to the canonical library.
