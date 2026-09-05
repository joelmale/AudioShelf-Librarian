# UI simplification delivery checkpoint

Updated: 2026-09-05. Plan: [ui-simplification-plan.md](ui-simplification-plan.md).

**P0 locally_verified; publication pending. P1 has not started.** The user deploys
and reviews through Dockhand; agents do not deploy or mutate the live library.

| Phase | State | Source SHA | Image digest | CI | Review | User acceptance |
|---|---|---|---|---|---|---|
| P0 Baseline/preview publication | locally_verified | pending commit | pending publication | pending | accept; R1 closed | pending |
| P1 Ask/Library foundations/shared shell | planned | — | — | — | — | — |
| P2 Discover continuity | planned | — | — | — | — | — |
| P3 Durable intent/source status | planned | — | — | — | — | — |
| P4 Activity/final navigation cutover | planned | — | — | — | — | — |
| P5 Acquisition correlation | planned | — | — | — | — | — |
| P6 Integrated acceptance | planned | — | — | — | — | — |
| P7 Offline/share-in | optional; not authorized | — | — | — | — | — |

## Exact next action

Commit/push the reviewed P0 candidate to `codex/ui-simplification`, verify both
GitHub workflows, actual tags/OCI revision/digest/signing and isolated startup.
Record the immutable handoff here, then stop for user acceptance. No P1 writes
until the user accepts the P0 digest; reported issues remain P0 repair work.

## Outcome and evidence

- Application source, runtime Dockerfile, package versions and business schemas
  unchanged from `865b22ec1a9e3d64e28e9635df6310fae490b8b2`.
- UI branch publishes `ui-preview`, sanitized branch tag and long SHA; `latest`
  remains main-only, `beta` engine-only, PRs never push. Publisher itself runs all
  six release gates; CI now also runs UI pushes. OCI revision/digest summary added.
- [Baseline/runbook](ui-simplification-p0-baseline.md): routes, endpoint side
  effects, current live baseline, consistent backup, rollback and eight review steps.
- [Synthetic browser evidence](ui-simplification-evidence/p0/README.md): 40
  aggregate candidates/48 appearances; ready, empty, HTTP503 and HTTP200 failure;
  390×844, 768×1024, 1440×1000. API/WebSocket/outside traffic intercepted; no backend.
- Node24.4.1/Linux: typecheck, lint, full tests, build, bundle and release check
  passed. Backend **1563 tests/107 files**, frontend **213 tests/22 files**.
  Lint **0 errors/133 existing warnings**. Initial JS **282154/300000 bytes**;
  deferred-route graph retained. Final guard changes received focused reruns.
- Node24.4.1 exposed a baseline sandbox symlink-removal failure on Windows and
  Linux. Test-only `rmSync(link)` → `unlinkSync(link)` repair preserves and reaches
  the rebound-root rejection assertion; independent safety review accepted it.
  The documented ABB timeout passed isolated retry and the Linux full run.
- Live allowlisted smoke: **19 passed, 0 warnings/failures**. `/health` version
  1.1.0 with ABS connected. No agent deployment, download, scan, sync or live write.

## Review disposition

Independent ic_reviewer Sol/high accepted workflows/tag policy, fixture isolation,
evidence, backup/rollback and test-only junction repair. R1 found that guards did
not fail when required commands were removed or neutralized. Two Terra repair
cycles led to a bounded Sol implementation of exact approved scalar/literal run
bodies with a six-gate × seven-mutation test matrix. Independent final Sol/high
review accepted R1 with no material finding remaining.

The host then prevented reopening/spawning reviewer sessions (`agent thread limit
reached`). Final R1 review used an ephemeral read-only local Codex process with
repository ic_reviewer instructions; CLI reported Sol/high. Its policy blocked
running the focused test, so its verdict is source/diff inspection; implementer
and root separately ran the tests successfully on Windows/Linux. No review gate
was waived. The helper models the checked-in YAML subset, not upstream Actions
execution; actual CI/publication remains a separate verification requirement.

## Rollback reference and preflight

Previous latest: `ghcr.io/joelmale/audioshelf-librarian@sha256:4218e018b87251a950b2f9d68aaf37e287ddfc555af1220b5a929e861dec2244`,
OCI revision `865b22ec1a9e3d64e28e9635df6310fae490b8b2`. User confirmed Dockhand
had deployed the latest version from git within the preceding hour; agent did
not directly inspect running-container metadata. Rechecked unchanged before push.
Previous beta: `sha256:83c57a1fa28320471f061ffcbd20205dbf57927ab1719490bfafd846ad973136`.

P0 adds no migration. Stop all writers and archive the entire DATA_DIR, including
DB/WAL/SHM and JSON/secrets, preserving permissions. Use one worker with existing
mounts. Rollback uses the previous digest and preserved data; never delete data
or automatically restore a stale backup over later actions. See the runbook.

## Ownership, models and restart state

- Main PM owns scope, integration, docs, publication and acceptance.
- Integration checkout: `C:/Users/nelso/Documents/Coding/AudioShelf-UI-P0`, branch
  `codex/ui-simplification`, baseline `865b22e`.
- Separate fixture checkout: `C:/Users/nelso/Documents/Coding/AudioShelf-UI-P0-Fixtures`,
  branch `codex/ui-p0-fixtures`; reviewed owned files copied into integration.
- Requested assignments: tech_lead Sol/high; source inventory explorer Luna/medium;
  publisher and fixture/browser ic_implementers Terra/medium; bounded release-guard
  escalation ic_implementer Sol/medium; independent ic_reviewers Sol/high.
- Child effective model/per-model usage unavailable; CLI reviewer reports Sol/high
  and **30302 tokens**. No Astra child, global model/config change, purchased credit,
  consumed reset or live application provider change.
- Account-wide usage snapshots (not project accounting): phase start 5h24%/week4%;
  after two quota interruptions/resumes 5h0%/week16%, then 5h0%/week32%. Exact agent
  active durations and other token totals unavailable. User explicitly continued.
- Original checkout and unrelated `.claude/launch.json`, `.claude/agents/`,
  `.claude/commands/`, `.claude/ui-review/`, `docs/ui-review/` preserved, never staged.
  Plan/status were authorized untracked task inputs explicitly included in P0.
- Engine checkpoint's uncommitted-work references were stale; only a short UI
  pointer added to current-status. No engine human acceptance decision changed.

## Known baseline limitations

At 390×844 the first candidate remains below the fold (P2). HTTP200 provider
failure can appear empty (P3). No physical-device/performance certification is
claimed. Existing lint warnings and dependency audit findings were not expanded
into an unrelated upgrade. Production deployment/review remains user-operated.
