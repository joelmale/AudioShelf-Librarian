/**
 * Backfill `books.narrator` from CACHED Audnexus payloads — R3
 * (docs/enrichment-sources-review.md §3). The cheap half of a two-part
 * source: ABS's own `narratorName` is written on every sync by
 * `sync.ts#mapItemToBook` already (via `upsertBook`'s
 * `COALESCE`-protected column, see its docblock); this module is the second
 * writer, populating the same column from Audnexus's structured
 * `narrators[]` with no network call at all.
 *
 * **Why Audnexus overwrites on THIS pass, and why that is not durable.**
 * ABS's `narratorName` is one free-text string, naively comma-split by
 * `sync.ts#parseNarrators` — a name written "Bray, R.C." (surname first)
 * splits into two bogus entries instead of one. Audnexus returns narrators
 * as distinct objects, so it has no such failure mode, and this pass
 * overwrites with Audnexus's cleaner list whenever one is available, rather
 * than only filling an empty column — genuinely useful for the books this
 * pass touches, right up until the next sync.
 *
 * That "right up until" matters: `CuratorDb#setNarrator`'s own docblock
 * documents the column's contract as "whichever writes last wins" (no
 * separate provenance column, same as `genres`), and `upsertBook` runs this
 * same COALESCE-protected write on every sync (cron/webhook/manual) whenever
 * ABS itself reports a `narratorName` — which for a book this pass just
 * fixed, it will, every time, with the same shredded value. So this pass's
 * correction is durable ONLY for books where ABS reports no narrator at all
 * (the COALESCE then has nothing to overwrite with, and Audnexus's value
 * survives indefinitely); for a book where the two sources disagree, the
 * very next sync reverts to ABS's value and this pass must be re-run to
 * restore Audnexus's. This is not a bug in this module or in `upsertBook` —
 * both honor the documented "last write wins" contract correctly — it is a
 * real limitation of that contract with no provenance column to arbitrate
 * it, and re-running this cache-only, zero-network pass after each sync
 * (e.g. chained onto the same schedule) is the operational workaround until
 * one exists.
 *
 * **Why this never clears a narrator.** A cached Audnexus row with no usable
 * `narrators[]` (absent field, empty array, or every entry missing a name)
 * is "Audnexus had nothing to add", not "there is no narrator" — ABS's own
 * value (or a name a previous run of this pass already wrote) must survive
 * untouched. This mirrors `upsertBook`'s own COALESCE guard against the
 * exact clobbering bug fixed on `main` for the ABS side; the same bug is not
 * reintroduced here for the Audnexus side. Concretely: this pass calls
 * `setNarrator` only when it has a non-empty extracted list, never with
 * `null` or `[]`.
 *
 * Modeled directly on `rederive.ts` — the established pattern for a
 * cache-only pass — but deliberately its own module rather than a case
 * added there: `rederive.ts` recomputes a provider's OWN `entities`/
 * `subjects` fields and writes back into `external_metadata`; this instead
 * reads one provider's cache to populate a column on `books`, an unrelated
 * table and unrelated write path (`setNarrator`, not
 * `upsertExternalMetadata`). Folding the two would have made `rederive.ts`
 * reach outside the table it otherwise owns.
 *
 *  - **No network, ever.** No `fetchImpl` parameter, so this cannot silently
 *    start fetching if someone edits it later.
 *  - **Only 'ok' Audnexus rows.** 'not-found' and 'error' rows carry no
 *    payload to extract from.
 *  - **Never touches `raw`.** Read-only against the cached payload.
 */
import { toAppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { OperationController } from '../operations.js';
import type { CuratorDb } from '../db.js';
import type { ActionLog } from '../actionLog.js';
import type { ProgressCallback } from '../types.js';

export interface NarratorBackfillOptions {
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

export interface NarratorBackfillResult {
  /** Books examined. */
  booksScanned: number;
  /** Cached 'ok' Audnexus rows carrying at least one usable narrator name. */
  rowsWithNarrators: number;
  /** Books whose `narrator` column actually changed (or, on a dry run, would have). */
  booksChanged: number;
  dryRun: boolean;
  failed: number;
  errors: Array<{ id: string; code: string; message: string }>;
  /** Ids of books whose narrator column changed — lets a caller scope a
   *  follow-up re-embed to exactly the books this pass touched, the same
   *  way `EnrichmentResult.processedBookIds` does. */
  changedBookIds: string[];
  /** Up to 10 concrete before/after diffs, for eyeballing. */
  examples: Array<{
    bookId: string;
    title: string;
    before: string[] | null;
    after: string[];
  }>;
  cancelled?: boolean;
}

interface AudnexusNarratorRaw {
  narrators?: Array<{ name?: string }>;
}

/** Plain codepoint comparison would be wrong here — order is meaningful
 *  (billing/casting order), so equality must be positional, not set-based. */
function sameNarrators(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Extract usable narrator names from a cached Audnexus `raw` payload, in the
 * order Audnexus returned them (billing order is itself a signal — see the
 * module docblock and `bookCard.ts`'s "Narrator line" section — so this
 * deliberately does NOT sort). Blank/missing names are dropped; exact
 * duplicate names (case-insensitive) are deduped, mirroring the idiom
 * `audnexus.ts#extractSubjects` already uses for the same raw shape.
 */
function extractNarrators(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const narrators = (raw as AudnexusNarratorRaw).narrators;
  if (!Array.isArray(narrators)) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of narrators) {
    const name = entry?.name?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * Populate `books.narrator` from cached 'ok' Audnexus rows, for every active
 * book (or `options.bookIds`). See the module docblock for the precedence
 * and never-clobber rules. Runs in book order and checkpoints for
 * pause/cancel the same way `rederive.ts` does; no `p-limit` pool, since
 * there is no network here and the work is SQLite-bound.
 */
export async function backfillNarratorsFromCache(
  db: CuratorDb,
  options: NarratorBackfillOptions = {}
): Promise<NarratorBackfillResult> {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? Date.now;
  const opId = options.controller?.id;
  const action = options.actionLog;

  const result: NarratorBackfillResult = {
    booksScanned: 0,
    rowsWithNarrators: 0,
    booksChanged: 0,
    dryRun: Boolean(options.dryRun),
    failed: 0,
    errors: [],
    changedBookIds: [],
    examples: [],
  };

  const bookIds = options.bookIds ?? db.getActiveBookIds();
  const logId = db.startLog('enrich', now());
  action?.record(
    'info',
    'narrator_backfill_started',
    `Narrator backfill started over ${bookIds.length} books (no network)`,
    { operationId: opId, detail: { books: bookIds.length, dryRun: result.dryRun } }
  );

  let cancelled = false;

  for (const bookId of bookIds) {
    if (options.controller) {
      try {
        await options.controller.checkpoint();
      } catch {
        cancelled = true;
        break;
      }
    }

    result.booksScanned += 1;

    try {
      const row = db.getExternalMetadataForProvider(bookId, 'audnexus');
      if (!row || row.status !== 'ok') continue;

      const payload = row.payload as { raw?: unknown } | null;
      const narrators = extractNarrators(payload?.raw);
      // Nothing usable in this cached row — leave whatever is already stored
      // alone. See the module docblock's "never clears a narrator" section.
      if (narrators.length === 0) continue;

      result.rowsWithNarrators += 1;

      const book = db.getBook(bookId);
      // A cached external_metadata row (or a caller-supplied bookId) can
      // outlive its books row — e.g. the book was removed from the library
      // after the row was written. There is nothing to update, and
      // `setNarrator`'s UPDATE would match zero rows, so this must not be
      // counted as a change or scheduled for re-embedding.
      if (!book) continue;
      const before = book.narrator ?? null;
      if (before !== null && sameNarrators(before, narrators)) continue;

      result.booksChanged += 1;
      result.changedBookIds.push(bookId);

      if (result.examples.length < 10) {
        result.examples.push({ bookId, title: book?.title ?? bookId, before, after: narrators });
      }

      if (!options.dryRun) {
        db.setNarrator(bookId, narrators);
      }
    } catch (err) {
      // Per-book isolation, same as rederive.ts / enricher.ts (A4): record and continue.
      const appErr = toAppError(err);
      result.failed += 1;
      result.errors.push({ id: bookId, code: appErr.code, message: appErr.message });
      logger.warn('Failed to backfill narrator for book', { bookId, code: appErr.code });
    } finally {
      const progress = {
        phase: 'narrator-backfill',
        current: result.booksScanned,
        total: bookIds.length,
        message: bookId,
      };
      options.controller?.setProgress(progress);
      options.onProgress?.(progress);
    }
  }

  db.finishLog(
    logId,
    result.failed > 0 && result.booksChanged === 0 ? 'error' : 'success',
    { ...result, cancelled },
    now()
  );

  if (cancelled) {
    result.cancelled = true;
    options.controller?.markCancelled(result);
    action?.record(
      'warn',
      'narrator_backfill_cancelled',
      `Narrator backfill cancelled after ${result.booksChanged} books changed`,
      { operationId: opId, detail: { booksChanged: result.booksChanged } }
    );
  } else {
    options.controller?.markCompleted(result);
    action?.record(
      'info',
      'narrator_backfill_finished',
      `Narrator backfill finished: ${result.booksChanged} of ${result.rowsWithNarrators} narrator rows changed`,
      { operationId: opId, detail: { booksChanged: result.booksChanged, rowsWithNarrators: result.rowsWithNarrators, dryRun: result.dryRun } }
    );
  }

  return result;
}
