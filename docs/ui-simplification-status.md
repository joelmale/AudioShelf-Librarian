# UI simplification delivery checkpoint

Updated: 2026-09-05. Plan: [ui-simplification-plan.md](ui-simplification-plan.md).

**P0 awaiting_user_review; published and verified. P1 has not started.** The user deploys
and reviews through Dockhand; agents do not deploy or mutate the live library.

| Phase | State | Source SHA | Image digest | CI | Review | User acceptance |
|---|---|---|---|---|---|---|
| P0 Baseline/preview publication | awaiting_user_review | fdbf0d4a5ecae210c79e7aa014aa53fc8308d8f5 | sha256:76b11fb896a6e4c0c53ec7caf13e39e840b2a2a7e8ae66b3f1ba349f3651f3c5 | both green; links below | accept; R1 closed | pending |
| P1 Ask/Library foundations/shared shell | planned | — | — | — | — | — |
| P2 Discover continuity | planned | — | — | — | — | — |
| P3 Durable intent/source status | planned | — | — | — | — | — |
| P4 Activity/final navigation cutover | planned | — | — | — | — | — |
| P5 Acquisition correlation | planned | — | — | — | — | — |
| P6 Integrated acceptance | planned | — | — | — | — | — |
| P7 Offline/share-in | optional; not authorized | — | — | — | — | — |

## Exact next action

Wait for the user to deploy/review the exact P0 digest below in Dockhand and
accept it or report issues. No P1 implementation until explicit acceptance;
reported issues remain P0 repair work. P7 still requires a separate opt-in.

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
execution; actual GitHub publication was independently verified below.

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

## Published P0 handoff

- Source commit: `fdbf0d4a5ecae210c79e7aa014aa53fc8308d8f5`, branch `codex/ui-simplification`.
- Pull: `ghcr.io/joelmale/audioshelf-librarian@sha256:76b11fb896a6e4c0c53ec7caf13e39e840b2a2a7e8ae66b3f1ba349f3651f3c5`.
- Convenience tag: `ui-preview` (moving). Actual emitted tags also include
  `codex-ui-simplification` and `sha-fdbf0d4a5ecae210c79e7aa014aa53fc8308d8f5`.
- [CI run 33985157130](https://github.com/joelmale/AudioShelf-Librarian/actions/runs/33985157130): success, Node24.20.0, all required checks green.
- [Publisher run 33985157110](https://github.com/joelmale/AudioShelf-Librarian/actions/runs/33985157110): success, all six pre-image gates plus build/push/summary/signing. No main bootstrap or semver tag needed.
- `ui-preview` and long-SHA references resolve to the same index digest above.
  OCI revision exactly matches the source commit. Platform: linux/amd64 (plus
  attestation manifest). Actual build output tags and digest checked against registry.
- Cosign2.2.4 verification passed for the exact digest, restricted to this workflow
  on `refs/heads/codex/ui-simplification` and GitHub Actions OIDC issuer. Claims,
  certificate chain and bundled transparency-log evidence verified.
- `latest` and `beta` remained at both rollback-reference digests above after publication.
- Exact digest pulled successfully and booted in a disposable local container,
  `--network none`, no host mounts, tmpfs DATA_DIR/logs, Node24.4.1. Health1.1.0 plus
  all eight SPA-shell routes passed (9 checks). No integrations were configured;
  ABS correctly reported disconnected. Smoke/gate containers removed afterward.
- This ledger-only publication-evidence follow-up uses `[skip ci]` so it does not
  move the reviewed image. The image source is the exact commit above, not the
  later documentation-only branch tip. No application difference in that follow-up.
- Final account usage snapshot: five-hour11%, weekly49%; shared account values,
  not attributed to this phase. No reset credit consumed.

User review and expected results: follow the eight steps in the
[Dockhand runbook](ui-simplification-p0-baseline.md#p0-user-review). P0 preserves
existing UI behavior; verify startup, Desk, Scout charts/search, library/details,
collections/conversion, intake/realignment controls, Activity and unchanged
Settings. Use the backup/rollback procedure above. Decision requested: accept this
exact digest or report issues. No agent deployment or live-library mutation.
