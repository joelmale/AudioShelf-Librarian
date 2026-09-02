/**
 * Backfill `books.description_enriched`/`description_source` from cached
 * enrichment payloads — R2 (`docs/enrichment-sources-review.md` §3, and the
 * R2 errata block there for the exact column shape). Modelled directly on
 * `rederive.ts`, including its four prohibitions, which this pass repeats
 * verbatim:
 *
 *  - **No network, ever.** There is no `fetchImpl` parameter anywhere in
 *    this module's signature or call graph, so it cannot silently start
 *    fetching if someone edits it later.
 *  - **Never mutates `raw`.** `external_metadata.payload.raw` is the
 *    immutable record of what a provider said; this pass only ever reads it.
 *  - **Never advances `fetched_at`.** Backfilling is not re-fetching, and
 *    touching the timestamp would silently extend a row's cache TTL.
 *  - **Only 'ok' rows.** 'not-found' and 'error' rows carry no payload.
 *
 * `books.description` (the ABS mirror) is never written by this pass, and
 * never read by it either — the winner computation and the resulting
 * before/after comparisons all go through
 * `descriptionText.ts#resolveDescription`, which is what decides whether ABS
 * or a harvested value is the book's effective description.
 *
 * The winner for a book is a PURE FUNCTION of its currently-cached 'ok' rows,
 * recomputed from scratch on every run — never "first write wins". For each
 * provider in `DESCRIPTION_SOURCE_PRECEDENCE`, in order, this reads that
 * provider's cached row (if any), extracts + cleans its description, and
 * takes the first result that clears the length floor and stays under the
 * ceiling. If that differs from what is currently stored, it is written (or,
 * if there is no eligible candidate at all, the stored pair is cleared). This
 * makes a backfilled description re-replaceable by precedence alone: a book
 * backfilled from `googlebooks` is promoted to `audnexus` the moment an
 * `audnexus` row appears, and demoted back if that row later stops being
 * 'ok'.
 *
 * Every active book is scanned, including books with a perfectly good ABS
 * description — `resolveDescription` still prefers ABS for those, so their
 * cards never change, but it means the short-ABS-description question (see
 * the R2 decision doc's rejected alternatives) stays answerable later from
 * SQL alone, with no second full run.
 */
import { toAppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { OperationController } from '../operations.js';
import type { CuratorDb } from '../db.js';
import type { ActionLog } from '../actionLog.js';
import type { Book, ProgressCallback } from '../types.js';
import type { DescriptionSource } from '../types.js';
import {
  cleanHarvestedDescription,
  DESCRIPTION_SOURCE_PRECEDENCE,
  MAX_HARVESTED_DESCRIPTION_CHARS,
  MIN_HARVESTED_DESCRIPTION_CHARS,
  resolveDescription,
} from './descriptionText.js';
import { rebuildBookEntities } from './rebuild.js';
import type { EnrichmentProvider } from './types.js';

export interface DescriptionBackfillOptions {
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

export interface DescriptionBackfillResult {
  /** Books examined. */
  booksScanned: number;
  /** Cached 'ok' rows from a precedence-listed provider examined. */
  rowsScanned: number;
  /** Books whose description_enriched/description_source pair was written. */
  descriptionsWritten: number;
  /** Books whose pair was cleared (previously set, now no eligible candidate). */
  descriptionsCleared: number;
  /** Books where the highest-precedence available candidate was too short to store. */
  skippedTooShort: number;
  /** Books where the highest-precedence available candidate was too long to store. */
  skippedTooLong: number;
  /** Per-provider: how many books had an extractable candidate from it, and
   *  how many of those the provider actually won (per precedence). */
  byProvider: Record<string, { candidates: number; won: number }>;
  /** Every book whose stored pair actually changed this run (written or cleared). */
  changedBookIds: string[];
  /** Of `changedBookIds`, how many have a DIFFERENT effective (resolved)
   *  description text after this run than before — the true
   *  card-hash-invalidation count (see `resolveDescription`). Deliberately
   *  not narrowed to "went from null to non-null": a book already
   *  backfilled from `googlebooks` that this run promotes to a newly-cached
   *  `audnexus` row goes non-null-to-non-null, but its card text and
   *  `card_hash` genuinely change too, so it must count here as well. */
  cardTextChanged: number;
  /** Of the `cardTextChanged` books, how many have no `person` row in
   *  `book_entities` — the population whose `ground.ts#groundCharacter`
   *  fallback substring gate this run just widened. */
  groundingGateWidened: number;
  dryRun: boolean;
  failed: number;
  errors: Array<{ id: string; code: string; message: string }>;
  /** Up to 10 concrete before/after examples. */
  examples: Array<{
    bookId: string;
    title: string;
    before: { source: string | null; text: string | null };
    after: { source: string | null; text: string | null };
  }>;
  cancelled?: boolean;
}

interface Winner {
  text: string;
  source: DescriptionSource;
}

type RejectionReason = 'short' | 'long';

interface WinnerComputation {
  winner: Winner | null;
  /** Reason the highest-precedence candidate that had SOME text failed, when
   *  no candidate ultimately won. */
  rejectionReason: RejectionReason | null;
  /** Per-provider candidate/won increments produced by this book, folded into
   *  the run's `byProvider` totals by the caller. */
  byProvider: Partial<Record<DescriptionSource, { candidates: number; won: number }>>;
  rowsConsidered: number;
}

/**
 * Pure winner computation for one book's cached rows — no DB writes. Exported
 * mainly so the precedence/eligibility rules are unit-testable in isolation
 * from the DB-facing loop below.
 */
export function computeDescriptionWinner(
  rows: ReadonlyArray<{ provider: string; payload: unknown }>,
  providers: ReadonlyMap<string, EnrichmentProvider>
): WinnerComputation {
  const byProvider: Partial<Record<DescriptionSource, { candidates: number; won: number }>> = {};
  let winner: Winner | null = null;
  let rejectionReason: RejectionReason | null = null;
  let rowsConsidered = 0;

  for (const source of DESCRIPTION_SOURCE_PRECEDENCE) {
    const row = rows.find((r) => r.provider === source);
    if (!row) continue;
    rowsConsidered += 1;

    const provider = providers.get(source);
    if (!provider?.extractDescription) continue;

    const payload = row.payload as { raw?: unknown } | null;
    if (!payload || typeof payload !== 'object') continue;

    const rawText = provider.extractDescription(payload.raw);
    if (!rawText) continue;

    const cleaned = cleanHarvestedDescription(rawText);
    if (!cleaned) continue;

    const stats = (byProvider[source] ??= { candidates: 0, won: 0 });
    stats.candidates += 1;

    if (cleaned.length < MIN_HARVESTED_DESCRIPTION_CHARS) {
      rejectionReason ??= 'short';
      continue;
    }
    if (cleaned.length > MAX_HARVESTED_DESCRIPTION_CHARS) {
      rejectionReason ??= 'long';
      continue;
    }

    winner = { text: cleaned, source };
    stats.won += 1;
    break; // First eligible result in precedence order wins — see module docblock.
  }

  return { winner, rejectionReason, byProvider, rowsConsidered };
}

function truthy(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Backfill every active book's harvested description from cache, then rebuild
 * grounded entities for every book whose stored pair changed (a harvested
 * description can promote a `character` candidate that the description-match
 * score, see `entityNotability.ts`, now sees for the first time — one write
 * here can change both the card's `Description:` line and its `People:` /
 * `Places:` / `Times:` lines).
 */
export async function backfillDescriptions(
  db: CuratorDb,
  providers: EnrichmentProvider[],
  options: DescriptionBackfillOptions = {}
): Promise<DescriptionBackfillResult> {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? Date.now;
  const opId = options.controller?.id;
  const action = options.actionLog;

  const byName = new Map(providers.map((p) => [p.name, p]));

  const result: DescriptionBackfillResult = {
    booksScanned: 0,
    rowsScanned: 0,
    descriptionsWritten: 0,
    descriptionsCleared: 0,
    skippedTooShort: 0,
    skippedTooLong: 0,
    byProvider: {},
    changedBookIds: [],
    cardTextChanged: 0,
    groundingGateWidened: 0,
    dryRun: Boolean(options.dryRun),
    failed: 0,
    errors: [],
    examples: [],
  };

  const bookIds = options.bookIds ?? db.getActiveBookIds();
  const logId = db.startLog('enrich', now());
  action?.record(
    'info',
    'description_backfill_started',
    `Description backfill started over ${bookIds.length} books (no network)`,
    { operationId: opId, detail: { books: bookIds.length, dryRun: result.dryRun } }
  );

  // Snapshot once for the whole run — same reasoning as rederive.ts/enricher.ts:
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
      const book = db.getBook(bookId);
      if (!book) continue;

      const okRows = db.getExternalMetadata(bookId).filter((r) => r.status === 'ok');
      const { winner, rejectionReason, byProvider, rowsConsidered } = computeDescriptionWinner(okRows, byName);
      result.rowsScanned += rowsConsidered;
      for (const [source, stats] of Object.entries(byProvider) as Array<
        [DescriptionSource, { candidates: number; won: number }]
      >) {
        const totals = (result.byProvider[source] ??= { candidates: 0, won: 0 });
        totals.candidates += stats.candidates;
        totals.won += stats.won;
      }

      const existingText = book.descriptionEnriched ?? null;
      const existingSource = book.descriptionSource ?? null;

      let changed = false;
      if (winner) {
        if (existingText !== winner.text || existingSource !== winner.source) {
          changed = true;
          result.descriptionsWritten += 1;
        }
      } else {
        if (rejectionReason === 'short') result.skippedTooShort += 1;
        if (rejectionReason === 'long') result.skippedTooLong += 1;
        if (truthy(existingText)) {
          changed = true;
          result.descriptionsCleared += 1;
        }
      }

      if (!changed) continue;

      const before = resolveDescription(book);
      const afterBook: Book = {
        ...book,
        descriptionEnriched: winner?.text ?? null,
        descriptionSource: winner?.source ?? null,
      };
      const after = resolveDescription(afterBook);

      result.changedBookIds.push(bookId);
      if (before.text !== after.text) {
        result.cardTextChanged += 1;
      }
      // groundingGateWidened is narrower than cardTextChanged on purpose: the
      // fallback gate (`ground.ts#groundCharacter`) only cares whether a
      // description was PRESENT at all, so a book that already had one (e.g.
      // promoted from googlebooks to audnexus text) had its gate open
      // already — this run didn't widen anything for it, even though its
      // card text did change.
      if (before.text === null && after.text !== null) {
        const hasPersonAllowlist = db.getEntitiesForBook(bookId).some((e) => e.kind === 'person');
        if (!hasPersonAllowlist) result.groundingGateWidened += 1;
      }

      if (result.examples.length < 10) {
        result.examples.push({
          bookId,
          title: book.title,
          before: { source: before.source, text: before.text },
          after: { source: after.source, text: after.text },
        });
      }

      if (!options.dryRun) {
        db.setEnrichedDescription(bookId, winner);
        rebuildBookEntities(db, bookId, after.text, libraryFrequency, librarySize);
      }
    } catch (err) {
      // Per-book isolation, same as rederive/enrichment (A4): record and continue.
      const appErr = toAppError(err);
      result.failed += 1;
      result.errors.push({ id: bookId, code: appErr.code, message: appErr.message });
      logger.warn('Failed to backfill description for book', { bookId, code: appErr.code });
    } finally {
      const progress = {
        phase: 'description-backfill',
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
    result.failed > 0 && result.changedBookIds.length === 0 ? 'error' : 'success',
    { ...result, cancelled },
    now()
  );

  if (cancelled) {
    result.cancelled = true;
    options.controller?.markCancelled(result);
    action?.record(
      'warn',
      'description_backfill_cancelled',
      `Description backfill cancelled after ${result.changedBookIds.length} books changed`,
      { operationId: opId, detail: { changed: result.changedBookIds.length } }
    );
  } else {
    options.controller?.markCompleted(result);
    action?.record(
      'info',
      'description_backfill_finished',
      `Description backfill finished: ${result.changedBookIds.length} of ${result.booksScanned} books changed`,
      { operationId: opId, detail: { changed: result.changedBookIds.length, scanned: result.booksScanned, dryRun: result.dryRun } }
    );
  }

  return result;
}
