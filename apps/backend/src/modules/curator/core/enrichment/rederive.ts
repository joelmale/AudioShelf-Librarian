/**
 * Re-derive cached enrichment payloads — the cheap half of the expensive/cheap
 * split that `external_metadata` was designed around.
 *
 * `EnrichmentPayload` stores three things: `raw` (the provider's response,
 * cached verbatim) plus `entities` and `subjects` (extracted from it). Only
 * `raw` costs a network call. When an extraction rule improves — a subject
 * splitter that missed comma-delimited MARC headings, an entity filter that
 * got smarter — the fix should cost nothing, because the input is already on
 * disk.
 *
 * Until this existed it cost a full re-fetch (`refresh: true`), which against
 * Google Books' 1000-requests-per-DAY free tier is not merely expensive but
 * spans multiple days for a ~950-book library. That is a bad reason to leave a
 * known-wrong extraction in place.
 *
 * What this does NOT do, deliberately:
 *  - **No network, ever.** There is no `fetchImpl` parameter, so this cannot
 *    silently start fetching if someone edits it later.
 *  - **Never touches `raw`.** It is the immutable record of what the provider
 *    said; only the derived fields are rewritten.
 *  - **Never moves `fetched_at`.** Re-deriving is not re-fetching, and
 *    advancing the timestamp would silently extend every row's cache TTL —
 *    making a library look freshly enriched when nothing was checked. Same
 *    invariant-5 shape as reporting a confident number for a check that never
 *    ran.
 *  - **Only 'ok' rows.** 'not-found' and 'error' rows carry no payload to
 *    re-derive from.
 */
import { toAppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { OperationController } from '../operations.js';
import type { CuratorDb } from '../db.js';
import type { ActionLog } from '../actionLog.js';
import type { ProgressCallback } from '../types.js';
import { rebuildBookEntities } from './rebuild.js';
import type { EnrichmentProvider } from './types.js';

export interface RederiveOptions {
  /** Report what would change, write nothing. */
  dryRun?: boolean;
  /** Restrict to specific books. */
  bookIds?: string[];
  controller?: OperationController;
  onProgress?: ProgressCallback;
  actionLog?: ActionLog;
  logger?: Logger;
  now?: () => number;
}

export interface RederiveResult {
  /** Books examined. */
  booksScanned: number;
  /** Cached 'ok' rows examined. */
  rowsScanned: number;
  /** Rows whose derived fields actually changed. */
  rowsChanged: number;
  /** Rows skipped because their provider has no `rederive`. */
  rowsUnsupported: number;
  entitiesWritten: number;
  dryRun: boolean;
  failed: number;
  errors: Array<{ id: string; code: string; message: string }>;
  /** Per-provider change counts, for eyeballing what a rule change did. */
  byProvider: Record<string, { scanned: number; changed: number }>;
  /** Up to 10 concrete before/after subject diffs. */
  examples: Array<{
    bookId: string;
    title: string;
    provider: string;
    subjectsBefore: string[];
    subjectsAfter: string[];
  }>;
  cancelled?: boolean;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Recompute `entities`/`subjects` for every cached 'ok' row whose provider
 * supports it, then rebuild each affected book's entity allowlist.
 *
 * Deliberately NOT a `p-limit` pool like `enricher.ts`: there is no network
 * here, so the work is CPU- and SQLite-bound and concurrency would only add
 * write contention. It runs in book order and checkpoints for pause/cancel
 * the same way.
 */
export async function rederiveFromCache(
  db: CuratorDb,
  providers: EnrichmentProvider[],
  options: RederiveOptions = {}
): Promise<RederiveResult> {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? Date.now;
  const opId = options.controller?.id;
  const action = options.actionLog;

  const byName = new Map(providers.map((p) => [p.name, p]));

  const result: RederiveResult = {
    booksScanned: 0,
    rowsScanned: 0,
    rowsChanged: 0,
    rowsUnsupported: 0,
    entitiesWritten: 0,
    dryRun: Boolean(options.dryRun),
    failed: 0,
    errors: [],
    byProvider: {},
    examples: [],
  };

  const bookIds = options.bookIds ?? db.getActiveBookIds();
  const logId = db.startLog('enrich', now());
  action?.record('info', 'rederive_started', `Re-derive started over ${bookIds.length} books (no network)`, {
    operationId: opId,
    detail: { books: bookIds.length, dryRun: result.dryRun },
  });

  // Snapshot once for the whole run, for the same reason enricher.ts does:
  // notability depends on library-wide frequency, and recomputing it mid-run
  // would make a book's score depend on how far the run had got.
  const libraryFrequency = db.getEntityBookCounts();
  const librarySize = db.countActiveBooks();

  let cancelled = false;

  for (const bookId of bookIds) {
    if (options.controller) {
      try {
        await options.controller.checkpoint();
      } catch (err) {
        cancelled = true;
        break;
      }
    }

    result.booksScanned += 1;

    try {
      const rows = db.getExternalMetadata(bookId).filter((r) => r.status === 'ok');
      let bookChanged = false;

      for (const row of rows) {
        const provider = byName.get(row.provider);
        if (!provider?.rederive) {
          result.rowsUnsupported += 1;
          continue;
        }

        result.rowsScanned += 1;
        const stats = (result.byProvider[row.provider] ??= { scanned: 0, changed: 0 });
        stats.scanned += 1;

        const payload = row.payload as { raw?: unknown; entities?: unknown; subjects?: unknown } | null;
        if (!payload || typeof payload !== 'object') continue;

        const derived = provider.rederive(payload.raw);
        if (!derived) continue;

        const before: string[] = Array.isArray(payload.subjects) ? (payload.subjects as string[]) : [];
        if (sameStrings(before, derived.subjects)) continue;

        stats.changed += 1;
        result.rowsChanged += 1;
        bookChanged = true;

        if (result.examples.length < 10) {
          result.examples.push({
            bookId,
            title: db.getBook(bookId)?.title ?? bookId,
            provider: row.provider,
            subjectsBefore: before.slice(0, 8),
            subjectsAfter: derived.subjects.slice(0, 8),
          });
        }

        if (!options.dryRun) {
          db.upsertExternalMetadata({
            bookId,
            provider: row.provider,
            // `raw` verbatim; only the derived fields move. `fetchedAt` is the
            // ORIGINAL — see the module docblock on why this must not advance.
            payload: { raw: payload.raw, entities: derived.entities, subjects: derived.subjects },
            fetchedAt: row.fetchedAt,
            status: 'ok',
          });
        }
      }

      if (bookChanged && !options.dryRun) {
        const book = db.getBook(bookId);
        result.entitiesWritten += rebuildBookEntities(
          db,
          bookId,
          book?.description ?? null,
          libraryFrequency,
          librarySize
        );
      }
    } catch (err) {
      // Per-book isolation, same as enrichment (A4): record and continue.
      const appErr = toAppError(err);
      result.failed += 1;
      result.errors.push({ id: bookId, code: appErr.code, message: appErr.message });
      logger.warn('Failed to re-derive book', { bookId, code: appErr.code });
    } finally {
      const progress = {
        phase: 'rederive',
        current: result.booksScanned,
        total: bookIds.length,
        message: bookId,
      };
      options.controller?.setProgress(progress);
      options.onProgress?.(progress);
    }
  }

  db.finishLog(logId, result.failed > 0 && result.rowsChanged === 0 ? 'error' : 'success', { ...result, cancelled }, now());

  if (cancelled) {
    result.cancelled = true;
    options.controller?.markCancelled(result);
    action?.record('warn', 'rederive_cancelled', `Re-derive cancelled after ${result.rowsChanged} rows changed`, {
      operationId: opId,
      detail: { rowsChanged: result.rowsChanged },
    });
  } else {
    options.controller?.markCompleted(result);
    action?.record('info', 'rederive_finished', `Re-derive finished: ${result.rowsChanged} of ${result.rowsScanned} rows changed`, {
      operationId: opId,
      detail: { rowsChanged: result.rowsChanged, rowsScanned: result.rowsScanned, dryRun: result.dryRun },
    });
  }

  return result;
}
