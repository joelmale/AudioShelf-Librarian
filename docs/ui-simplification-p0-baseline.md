# P0 baseline and review runbook

Baseline application: `865b22ec1a9e3d64e28e9635df6310fae490b8b2`, inspected 2026-09-05.
P0 changes publication and test artifacts; application source, routes, schemas,
Docker runtime and package versions remain unchanged. Publication evidence and
the immutable candidate are recorded in [the ledger](ui-simplification-status.md).

## Reconciled source and live baseline

- `main` and `origin/main` were both `865b22e`. The original checkout's
  `.claude/launch.json`, `.claude/agents/`, `.claude/commands/`, `.claude/ui-review/`
  and `docs/ui-review/` are unrelated user work and were excluded.
- The UI plan and ledger were untracked task inputs, copied into the isolated
  integration worktree and explicitly included in this phase.
- `docs/current-status.md` is an engine checkpoint. Its references to uncommitted
  Desk/Phase 6 implementation are stale: application paths are clean and that
  implementation is on the baseline. Its remaining human retrieval gates remain.
- Current routes and lazy boundaries match `docs/primary-ui.md`: root → Desk,
  Scout, Curate, Activity and Settings. Discover/Library/Ask are future phases.
- Live `GET /health` returned `status:ok`, version `1.1.0`, ABS connected. Package
  version does not identify the running commit. OCI revision identifies a built
  image; Dockhand/container metadata is needed to identify the deployed image.
- The existing read-only smoke ran against the live URL: **19 passed, zero
  warnings/failures**. It fetched eight SPA shells and eleven allowlisted read
  endpoints. It did not execute browser JavaScript, download, scan, sync, tag,
  enqueue, change settings or reconcile the downloads pipeline.
- Registry `latest` at baseline resolved to
  `sha256:4218e018b87251a950b2f9d68aaf37e287ddfc555af1220b5a929e861dec2244`.
  OCI revision is `865b22ec1a9e3d64e28e9635df6310fae490b8b2`. The user confirmed
  Dockhand deployed the latest version from git within the last hour. This digest
  is the rollback reference based on that confirmation plus registry evidence;
  the agent did not inspect the running container's metadata directly.

## Entrypoint side-effect inventory

This inventory applies to the baseline source; recheck changed entrypoints in
later phases. Never infer read-only behavior from HTTP GET alone.

| Surface | Source contract | Effect and QA rule |
|---|---|---|
| Every browser route | `PreviewApp.tsx`, `WebSocketProvider.tsx` | Health/operation polling and WebSocket connection; block or fixture these for local QA. |
| Desk | `DeskPage.tsx`, curator `api.ts` | Mounts health, recent books, tags, collections, operations, encode queue, log and acquisition pipeline reads. |
| Downloads pipeline GET | librarian `index.ts`, `discardMissingAcquisitionInputs` | Reconciles/discards missing ingest inputs; **exclude from live baseline calls**. |
| `/health` | backend `index.ts` | Reads settings and probes ABS `/api/users`; no local write identified. |
| Books, tags, collections, operations, history, jobs, encode queue/config/history | curator route modules, librarian `index.ts` | Read handlers used by existing `live-readonly-smoke.mjs`; no queue or library writes. |
| Charts GET | librarian `index.ts`, `bestsellers.ts` | External provider reads and process cache updates; browser fixture replaces these. A 200 failure with empty results can appear empty. |
| Search / description | `AudiobookSearch.tsx`, `BestsellerLists.tsx` | ABB/iTunes network reads; query `q` can auto-search. Fixtures must block outside requests. |
| Library health/recent books/status | librarian `index.ts` | External integration reads; health also measures filesystem structure. |
| Realign scan GET | `RealignService.scanLibrary` | Filesystem/ABS inspection; potentially expensive; excluded from baseline. |
| Conversations GET / chat POST | curator `routes/librarian.ts` | History reads versus persisted, cost-bearing LLM request; do not submit a chat for baseline. |
| Settings | `settingsClient.ts`, system module | Read is redacted; field editing autosaves. Do not edit settings during inspection. |
| Database snapshot GET | curator database route | `VACUUM INTO` writes a temporary backup; not a pure read. Not called by this phase. |
| Backend startup | curator DB and service initialization | Opens/migrates/seeds DB and starts workers. Never start against real DATA_DIR for QA. |
| Explicit action controls | scan/download/sync/realign/encode/tag/collection routes | Can write data or external systems; all excluded from agent live validation. |

Baseline screenshots and reusable fixture instructions are linked in the ledger.
Fixture browser evidence is synthetic, not a measurement of live provider data,
physical phones, field performance or accessibility certification.

## Dockhand preflight, backup and rollback

1. Before replacing the service, record its actual image repository digest and
   stack/environment/mount configuration in Dockhand. A moving tag is insufficient.
2. Stop the AudioShelf service and every other writer to its DATA_DIR. Do not run
   two workers against the same writable data/inbox/library.
3. With writers stopped, archive the **entire mounted DATA_DIR** to a separate,
   protected backup destination: `curator.db`, any `curator.db-wal`/`-shm`,
   settings, secrets, settings history, organization history and other runtime
   files. Preserve ownership/permissions. Check the archive can be listed/read.
   This stopped-writer procedure makes the SQLite/JSON backup consistent; a live
   copy of only `curator.db` does not. Keep secrets out of reports and git.
4. Pull the exact candidate digest from the ledger and recreate the one service
   in Dockhand using existing mounts/settings. The user performs this operation.
5. P0 adds no schema or business-data migration. Roll back by stopping the candidate
   and recreating the service from the recorded prior digest with preserved data.
   Do not delete runtime data or library files. Do not restore an older backup over
   subsequent actions automatically; recovery from backup requires a deliberate
   user decision because it can discard newer state.

## P0 user review

1. Pull/recreate using the exact digest. Expect startup and health version `1.1.0`;
   verify the image's OCI revision matches the candidate commit.
2. Open `/desk`. Expect the existing dashboard/chat and current navigation; P0
   intentionally retains the baseline layout and behavior.
3. Open `/scout/trends`, then `/scout/search`. Expect existing charts and source
   search. Do not submit a download merely to validate this phase.
4. Open `/curate/review` and an existing book; use Back. Expect existing library
   content and detail navigation.
5. Open `/curate/collections` and `/curate/encode`. Expect existing collections
   and conversion tools; do not push collections or start conversion for P0.
6. Open `/scout/intake` and `/curate/realign`. Expect existing review/scan controls;
   no scan or execution is required for baseline acceptance.
7. Open `/activity` and Settings, then close Settings without editing. Expect
   history/log access and current settings behavior.
8. Confirm desktop and mobile layouts are no worse than the baseline. Accept the
   exact digest or report issues; P1 remains blocked until acceptance.

Opening the deployed application runs its existing pollers, including the Desk
pipeline reconciliation described above. These review steps are user-operated;
the agent has not deployed or exercised that live browser path.
