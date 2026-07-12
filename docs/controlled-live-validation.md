# Controlled Live Validation

## Safety model

Use three gates in order. Stop when a gate fails.

1. **Read-only deployment smoke:** GET requests only; no service or filesystem mutation.
2. **Plan-only scan:** reads one controlled directory and records proposed actions, while both the UI and backend lock every scan-session mutation endpoint.
3. **Disposable mutation stack:** dedicated data, inbox, library, Audiobookshelf library, and qBittorrent category. Never use the production library for automated mutation validation.

Before the third gate, back up `/app/data` and the controlled library directory. Confirm the inbox and library mounts are on the same filesystem.

## Gate 1: read-only smoke

```bash
AUDIOSHELF_BASE_URL=https://audioshelf.example.test \
AUDIOSHELF_TOKEN=optional-oidc-token \
npm run smoke:live:readonly -- --expected-version 1.1.0
```

The suite verifies the canonical SPA routes, exact deployed version, public settings redaction, ingest history, operations, books, tags, collections, and encoding state. Without `--expected-version`, it expects the version in the local root `package.json` (or `AUDIOSHELF_EXPECTED_VERSION`). Add `--include-integrations` to probe ABS, qBittorrent, ABB, and proxy status; unavailable optional integrations are warnings. Use `--require-abs` and `--require-qbit` when those connections must be release-blocking. Add `--search-query "Known Title"` for one lowercase search; it never submits a download.

## Gate 2: plan-only filesystem scan

Place one copied or synthetic test book in a dedicated subdirectory of the configured inbox, then run:

```bash
AUDIOSHELF_BASE_URL=https://audioshelf.example.test \
AUDIOSHELF_TOKEN=optional-oidc-token \
npm run smoke:live:plan-scan -- \
  --target-dir /inbox/controlled-test \
  --confirm-plan-only
```

The request always includes `planOnly: true`. Successful output includes the correlated ingest job ID, scanned count, and proposed-item count. Verify in Process that current and proposed paths are correct. Commit and other mutation controls are disabled in the UI, and the backend rejects direct mutation requests for that plan-only session.

## Gate 3: disposable mutation sequence

Run these manually against a disposable stack:

| Workflow | Controlled action | Required evidence |
|---|---|---|
| Settings | Change one harmless value, wait for Saved, restore the prior revision | Current value, history entry, successful restore |
| Scout | Search a known title without downloading | Lowercase request, results or explicit anti-bot recovery state |
| Acquire | Send one user-selected lawful test item to an isolated qBittorrent category | One handoff, duplicate prevention, Activity record; remove it in qBittorrent afterward |
| Scan/organize | Scan one copied test book, review paths, commit only that item, then rollback | Before/after paths, affected count, audit entry, restored source |
| Tags | Run dry-run + sample on the disposable ABS library | No ABS tag writes, operation progress, terminal status |
| Collections | Generate and approve locally; push one disposable collection | Proposal diff, confirmation, ABS deep link, cleanup result |
| M4B | Queue one copied non-M4B book | Candidate, preset, ABS task, output validation; note that removing AudioShelf tracking cannot stop an ABS encode already running |

Record the release tag, container digest, timestamp, operator, browser size, and pass/fail result for every workflow. A failed or ambiguous destructive-action result blocks production promotion.
