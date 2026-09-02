/**
 * Backfill `books.narrator` from CACHED Audnexus payloads — R3
 * (docs/enrichment-sources-review.md §3). The cheap half of a two-part
 * source: ABS's own `narratorName` is written on every sync by
 * `sync.ts#mapItemToBook` already (via `upsertBook`'s
 * `COALESCE`-protected column, see its docblock); this module is the second
 * writer, populating the same column from Audnexus's structured
 * `narrators[]` with no network call at all.
 *
 * **Fill absences only — this never overwrites an existing narrator.**
 * `docs/enrichment-sources-review.md`'s R2 "Watch for" states the governing
 * principle for every field ABS itself can supply: "ABS is the user's own
 * library metadata and should stay authoritative; only fill absences, never
 * overwrite." This module holds to that for `narrator` specifically because
 * `upsertBook` re-applies ABS's own `narratorName` to the column on EVERY
 * sync (cron/webhook/manual) whenever ABS reports one, via the
 * `COALESCE`-protected write `db.ts#bookContentEqual`'s docblock describes.
 * An earlier version of this module instead overwrote whatever was already
 * stored with Audnexus's cleaner list — e.g. correcting ABS's naive
 * comma-split "Bray, R.C." to "R.C. Bray" — and that correction was reverted
 * by the very next sync: ABS's COALESCE write has nothing to guard against
 * because, from ABS's point of view, nothing changed. The two writers would
 * then alternate forever — the book reported "updated" by every sync even
 * though nothing in ABS changed, and `card_hash` flipping on every cycle,
 * queuing the book for re-embedding indefinitely (see `bookCard.ts`'s
 * Narrator-line docblock — `narrator` is part of the card). Restricting the
 * write to a currently-`null` `books.narrator` sidesteps this entirely: once
 * ABS or a prior run of this pass has written a value, later runs leave it
 * untouched, so the pass is idempotent and safe to chain onto every sync
 * with zero oscillation. The cost is that a book where ABS's own parse is
 * already wrong (but non-empty) is not corrected by this automated pass —
 * an acceptable trade given the principle above; nothing stops a human (or a
 * future targeted tool) from calling `CuratorDb#setNarrator` directly for
 * such a book.
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
 *  - **Never overwrites.** Writes only when `books.narrator` is currently
 *    `null` — see "Fill absences only" above.
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
  /** Books whose `narrator` column actually changed (or, on a dry run, would
   *  have) — always a fill of a previously-absent narrator; see the module
   *  docblock's "Fill absences only" section. */
  booksChanged: number;
  dryRun: boolean;
  failed: number;
  errors: Array<{ id: string; code: string; message: string }>;
  /** Ids of books whose narrator column changed — lets a caller scope a
   *  follow-up re-embed to exactly the books this pass touched, the same
   *  way `EnrichmentResult.processedBookIds` does. */
  changedBookIds: string[];
  /** Up to 10 concrete fills, for eyeballing. `before` is always `null` —
   *  this pass only ever fills an absent narrator, never overwrites one. */
  examples: Array<{
    bookId: string;
    title: string;
    before: string[] | null;
    after: string[];
  }>;
  cancelled?: boolean;
}

interface AudnexusNarratorRaw {
  // `unknown`, not `string`: this is a cached third-party JSON payload, so
  // `name` can be any JSON type. `extractNarrators` below is the one place
  // that narrows it — see its "typeof entry?.name" guard.
  narrators?: Array<{ name?: unknown }>;
}

/**
 * Extract usable narrator names from a cached Audnexus `raw` payload, in the
 * order Audnexus returned them (billing order is itself a signal — see the
 * module docblock and `bookCard.ts`'s "Narrator line" section — so this
 * deliberately does NOT sort). Blank/missing/non-string names are dropped;
 * exact duplicate names (case-insensitive) are deduped, mirroring the idiom
 * `audnexus.ts#extractSubjects` already uses for the same raw shape.
 */
function extractNarrators(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const narrators = (raw as AudnexusNarratorRaw).narrators;
  if (!Array.isArray(narrators)) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of narrators) {
    // A cached payload is untrusted external data — `entry?.name` can be
    // any JSON type (number, object, array, ...), not just a string or
    // `undefined`. Narrow with `typeof` rather than assuming the shape and
    // calling `.trim()` straight through, which throws on anything but a
    // string and would fail the whole book; mirrors the repo's own
    // defensive-decode idiom (`db.ts`'s Row -> Book mapping filters
    // `typeof s === 'string'` on JSON-decoded arrays the same way).
    if (typeof entry?.name !== 'string') continue;
    // Collapse internal whitespace too, not just leading/trailing, so the
    // value stored here always equals what `bookCard.ts`'s own
    // `collapseWhitespace` renders on the card for the same name.
    const name = entry.name.replace(/\s+/g, ' ').trim();
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

      // Fill absences only — never overwrite a narrator ABS (or a previous
      // run of this same pass) already wrote. See the module docblock's
      // "Fill absences only" section for why: `upsertBook` re-applies ABS's
      // own value on every sync regardless of what this pass writes, so an
      // overwrite here would only be reverted by the next sync, and the two
      // writers would alternate forever.
      if (book.narrator !== null && book.narrator !== undefined) continue;

      result.booksChanged += 1;
      result.changedBookIds.push(bookId);

      if (result.examples.length < 10) {
        result.examples.push({ bookId, title: book.title, before: null, after: narrators });
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
