/**
 * Library sync: pull every library + book from ABS and upsert into SQLite.
 *
 * Adversarial cases (MADP-FULL):
 *  - B2 (ABS down mid-sync): a library that fails to fetch is recorded as an
 *    OperationError and the run continues; already-synced libraries persist
 *    (A4-style partial-failure resilience).
 *  - B3: pagination is handled inside ABSClient.getLibraryItems.
 *  - C2 (idempotency): upsert is keyed on the ABS id, so re-running produces no
 *    duplicate rows — books are classified added/updated/unchanged.
 *  - D1–D3: every await is inside try/catch; failures become typed AppErrors and
 *    are reflected in the structured sync_log detail.
 */
import type { ABSClient } from './absClient.js';
import type { CuratorDb } from './db.js';
import { toAppError } from './errors.js';
import { nullLogger, type Logger } from './logger.js';
import type { ABSLibraryItem, Book, ProgressCallback, SyncResult } from './types.js';

export interface SyncOptions {
  onProgress?: ProgressCallback;
  logger?: Logger;
  now?: () => number;
}

/** Parse a "Series Name #3" string into its name and numeric sequence. */
function parseSeriesName(seriesName: string): { name: string; sequence: number | null } {
  const match = seriesName.match(/^(.*?)\s*#\s*([\d.]+)\s*$/);
  if (match && match[1] !== undefined && match[2] !== undefined) {
    const seq = Number.parseFloat(match[2]);
    return { name: match[1].trim(), sequence: Number.isFinite(seq) ? seq : null };
  }
  return { name: seriesName.trim(), sequence: null };
}

function coerceSequence(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function coerceYear(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** Map an ABS library item onto our Book row. */
export function mapItemToBook(item: ABSLibraryItem, now: number): Book {
  const meta = item.media.metadata;

  let series: string | null = null;
  let seriesSequence: number | null = null;
  if (meta.series && meta.series.length > 0 && meta.series[0]) {
    series = meta.series[0].name;
    seriesSequence = coerceSequence(meta.series[0].sequence);
  } else if (meta.seriesName) {
    const parsed = parseSeriesName(meta.seriesName);
    series = parsed.name || null;
    seriesSequence = parsed.sequence;
  }

  const duration =
    item.media.duration !== null && item.media.duration !== undefined
      ? Math.round(item.media.duration)
      : null;

  return {
    id: item.id,
    title: meta.title?.trim() || 'Untitled',
    author: meta.authorName?.trim() || null,
    series,
    seriesSequence,
    durationSeconds: duration,
    publishedYear: coerceYear(meta.publishedYear),
    genres: meta.genres ?? [],
    description: meta.description?.trim() || null,
    coverPath: item.media.coverPath ?? null,
    absAddedAt: item.addedAt ?? null,
    lastSyncedAt: now,
  };
}

export async function syncLibrary(
  absClient: ABSClient,
  db: CuratorDb,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const logId = db.startLog('sync', startedAt);

  const result: SyncResult = { added: 0, updated: 0, unchanged: 0, total: 0, errors: [] };

  try {
    const libraries = await absClient.getLibraries();
    logger.info('Sync started', { libraries: libraries.length });

    let processedLibraries = 0;
    for (const library of libraries) {
      try {
        const items = await absClient.getLibraryItems(library.id);
        for (const item of items) {
          // Tolerate a single malformed item without aborting the whole library.
          try {
            const book = mapItemToBook(item, now());
            const outcome = db.upsertBook(book);
            result[outcome] += 1;
            result.total += 1;
          } catch (err) {
            const appErr = toAppError(err);
            result.errors.push({ id: item.id, code: appErr.code, message: appErr.message });
            logger.warn('Failed to upsert book', { bookId: item.id, code: appErr.code });
          }
        }
      } catch (err) {
        // B2/A4: this library failed, but others should still persist.
        const appErr = toAppError(err);
        result.errors.push({ id: library.id, code: appErr.code, message: appErr.message });
        logger.error('Failed to sync library', { libraryId: library.id, code: appErr.code });
      }
      processedLibraries += 1;
      options.onProgress?.({
        phase: 'sync',
        current: processedLibraries,
        total: libraries.length,
        message: `Synced ${library.name}`,
      });
    }

    // Overall failure only when nothing at all could be synced.
    const status = result.total === 0 && result.errors.length > 0 ? 'error' : 'success';
    db.finishLog(logId, status, result, now());
    logger.info('Sync finished', { ...result, errors: result.errors.length });
    return result;
  } catch (err) {
    // Top-level failure (e.g. could not even list libraries).
    const appErr = toAppError(err);
    db.finishLog(logId, 'error', appErr.toPayload(), now());
    logger.error('Sync aborted', { code: appErr.code, message: appErr.message });
    throw appErr;
  }
}
