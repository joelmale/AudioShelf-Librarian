/**
 * Enrichment runner (librarian engine plan §2, "Enrichment runner").
 *
 * Clones the `tagger.ts` operational shape exactly: `p-limit` worker pool,
 * `OperationController` checkpoint per book (pause/cancel), `dryRun` planning,
 * per-book failure isolation (A4), action-log events, and a `sync_log` entry
 * (kind 'enrich'). The difference from tagging is that each book runs against
 * *multiple* providers sequentially (providers are fast network calls; the
 * pool parallelizes across books, not providers within a book).
 *
 * Per book, for every provider that is due (per `db.getEnrichmentCandidates`
 * TTL logic):
 *   - a payload upserts `external_metadata` with status 'ok'. The value
 *     stored is the **entire `EnrichmentPayload` object** (`{ raw, entities,
 *     subjects }`), not the bare provider response — this memoizes entity
 *     extraction so a future re-run of the extractor never needs to re-fetch;
 *   - `null` upserts status 'not-found', payload null;
 *   - a thrown error upserts status 'error', payload null, and is recorded —
 *     the book's remaining providers still run (one provider failing must
 *     never lose another provider's result for the same book).
 *
 * After the provider loop, the book's `book_entities` allowlist is rebuilt
 * from ALL cached 'ok' rows for that book (not just the ones fetched this
 * run), unioning entities case-insensitively per (normalized entity, kind)
 * and merging `sources` (provider names, sorted). This keeps `book_entities`
 * consistent even when only one of several cached providers was due today.
 */
import pLimit from 'p-limit';

import { OperationCancelledError, toAppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { OperationController } from '../operations.js';
import type { Book, ProgressCallback } from '../types.js';
import type { CuratorDb } from '../db.js';
import type { ActionLog } from '../actionLog.js';
import type {
  EnrichedEntity,
  EnrichmentPayload,
  EnrichmentPlanEntry,
  EnrichmentProvider,
  EnrichmentResult,
  EntityKind,
  ProviderStats,
} from './types.js';

export interface EnrichmentOptions {
  /** No fetches — just report the books/providers that would be looked up. */
  dryRun?: boolean;
  /** Restrict to specific books (still filtered to due-for-lookup ones). */
  bookIds?: string[];
  concurrency: number;
  controller?: OperationController;
  onProgress?: ProgressCallback;
  actionLog?: ActionLog;
  logger?: Logger;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/** A cached 'ok' row is trusted for 90 days before being re-fetched. */
export const OK_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** A cached 'not-found' answer is retried sooner — sources add new books. */
export const NOT_FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface RunBookEntry {
  book: Book;
  providers: EnrichmentProvider[];
}

const VALID_KINDS: ReadonlySet<EntityKind> = new Set(['person', 'place', 'time']);

function isEnrichmentPayload(value: unknown): value is EnrichmentPayload {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as { entities?: unknown }).entities);
}

/**
 * Rebuild a book's grounded-entity allowlist from every cached 'ok'
 * `external_metadata` row (not just the providers fetched this run).
 * Defensive against malformed/legacy stored payloads: rows whose payload
 * isn't a well-shaped `EnrichmentPayload` (or lacks an `entities` array) are
 * skipped rather than throwing.
 */
function rebuildBookEntities(db: CuratorDb, bookId: string): number {
  const okRows = db.getExternalMetadata(bookId).filter((row) => row.status === 'ok');

  const merged = new Map<string, { entity: string; kind: EntityKind; sources: Set<string> }>();
  for (const row of okRows) {
    if (!isEnrichmentPayload(row.payload)) continue;
    for (const candidate of row.payload.entities as EnrichedEntity[]) {
      const entity = candidate?.entity?.trim();
      if (!entity || !VALID_KINDS.has(candidate.kind)) continue;
      const key = `${candidate.kind}:${entity.toLowerCase()}`;
      const existing = merged.get(key);
      if (existing) {
        existing.sources.add(row.provider);
      } else {
        merged.set(key, { entity, kind: candidate.kind, sources: new Set([row.provider]) });
      }
    }
  }

  const entities = [...merged.values()].map((v) => ({
    entity: v.entity,
    kind: v.kind,
    sources: [...v.sources].sort(),
  }));
  db.replaceBookEntities(bookId, entities);
  return entities.length;
}

export async function enrichBooks(
  db: CuratorDb,
  providers: EnrichmentProvider[],
  options: EnrichmentOptions
): Promise<EnrichmentResult> {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const opId = options.controller?.id;
  const action = options.actionLog;

  // Union of every provider's due candidates, keeping track of which
  // provider(s) are actually due per book.
  const bookMap = new Map<string, RunBookEntry>();
  for (const provider of providers) {
    const opts: Parameters<CuratorDb['getEnrichmentCandidates']>[1] = {
      okTtlMs: OK_TTL_MS,
      notFoundTtlMs: NOT_FOUND_TTL_MS,
      now: now(),
    };
    if (options.bookIds) opts.bookIds = options.bookIds;
    const candidates = db.getEnrichmentCandidates(provider.name, opts);
    for (const book of candidates) {
      const entry = bookMap.get(book.id);
      if (entry) entry.providers.push(provider);
      else bookMap.set(book.id, { book, providers: [provider] });
    }
  }
  const runBooks = [...bookMap.values()];

  const providerStats: Record<string, ProviderStats> = {};
  for (const provider of providers) providerStats[provider.name] = { fetched: 0, ok: 0, notFound: 0, errors: 0 };

  const result: EnrichmentResult = {
    processed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    dryRun: Boolean(options.dryRun),
    entitiesWritten: 0,
    providerStats,
  };

  const logId = db.startLog('enrich', now());
  action?.record('info', 'enrich_started', `Enrichment run started (${runBooks.length} candidates)`, {
    operationId: opId,
    detail: { candidates: runBooks.length, dryRun: result.dryRun },
  });

  // ── Dry run: report the plan, make no fetches. ───────────────────────────
  if (options.dryRun) {
    const plan: EnrichmentPlanEntry[] = runBooks.map(({ book, providers: due }) => ({
      bookId: book.id,
      title: book.title,
      providers: due.map((p) => p.name),
    }));
    result.plan = plan;
    result.skipped = plan.length;
    db.finishLog(logId, 'success', { dryRun: true, planned: plan.length }, now());
    action?.record('info', 'enrich_dry_run', `Dry run: ${plan.length} books would be enriched`, {
      operationId: opId,
      detail: { planned: plan.length },
    });
    options.controller?.markCompleted(result);
    return result;
  }

  if (runBooks.length === 0) {
    db.finishLog(logId, 'success', { processed: 0, note: 'no books due for enrichment' }, now());
    options.controller?.markCompleted(result);
    return result;
  }

  const limit = pLimit(Math.max(1, options.concurrency));
  let done = 0;
  let cancelled = false;

  const tasks = runBooks.map(({ book, providers: due }) =>
    limit(async () => {
      // Cooperative pause/cancel checkpoint before spending any lookups.
      if (options.controller) {
        try {
          await options.controller.checkpoint();
        } catch (err) {
          if (err instanceof OperationCancelledError) {
            cancelled = true;
            result.skipped += 1;
            return;
          }
          throw err; // unexpected — don't swallow (D2)
        }
      }

      try {
        // Providers run sequentially per book (cheap network calls); one
        // provider failing must not lose another provider's result (A4-style
        // isolation, applied at provider granularity within the book).
        for (const provider of due) {
          const stats = providerStats[provider.name];
          stats.fetched += 1;
          try {
            const payload = await provider.lookup(book, fetchImpl);
            if (payload) {
              db.upsertExternalMetadata({ bookId: book.id, provider: provider.name, payload, fetchedAt: now(), status: 'ok' });
              stats.ok += 1;
            } else {
              db.upsertExternalMetadata({ bookId: book.id, provider: provider.name, payload: null, fetchedAt: now(), status: 'not-found' });
              stats.notFound += 1;
            }
          } catch (err) {
            const appErr = toAppError(err);
            db.upsertExternalMetadata({ bookId: book.id, provider: provider.name, payload: null, fetchedAt: now(), status: 'error' });
            stats.errors += 1;
            action?.record('warn', 'provider_failed', `Provider "${provider.name}" failed for "${book.title}": ${appErr.message}`, {
              operationId: opId,
              detail: { bookId: book.id, provider: provider.name, code: appErr.code },
            });
            logger.warn('Enrichment provider failed', { bookId: book.id, provider: provider.name, code: appErr.code });
          }
        }

        const written = rebuildBookEntities(db, book.id);
        result.entitiesWritten += written;
        result.processed += 1;
        action?.record('info', 'book_enriched', `Enriched "${book.title}"`, {
          operationId: opId,
          detail: { bookId: book.id, providers: due.map((p) => p.name), entities: written },
        });
      } catch (err) {
        // A4: record + continue; do NOT roll back books that already succeeded.
        const appErr = toAppError(err);
        result.failed += 1;
        result.errors.push({ id: book.id, code: appErr.code, message: appErr.message });
        action?.record('error', 'book_failed', `Failed to enrich "${book.title}": ${appErr.message}`, {
          operationId: opId,
          detail: { bookId: book.id, code: appErr.code },
        });
        logger.warn('Failed to enrich book', { bookId: book.id, code: appErr.code });
      } finally {
        done += 1;
        const progress = {
          phase: 'enrich',
          current: done,
          total: runBooks.length,
          message: book.title,
        };
        options.controller?.setProgress(progress);
        options.onProgress?.(progress);
      }
    })
  );

  await Promise.all(tasks);

  const status = result.processed === 0 && result.failed > 0 ? 'error' : 'success';
  db.finishLog(logId, status, { ...result, cancelled }, now());

  if (cancelled) {
    result.cancelled = true;
    options.controller?.markCancelled(result);
    action?.record('warn', 'enrich_cancelled', `Enrichment cancelled after ${result.processed} enriched`, {
      operationId: opId,
      detail: { processed: result.processed, failed: result.failed },
    });
  } else {
    options.controller?.markCompleted(result);
    action?.record('info', 'enrich_finished', `Enrichment finished: ${result.processed} enriched, ${result.failed} failed`, {
      operationId: opId,
      detail: { processed: result.processed, failed: result.failed },
    });
  }

  return result;
}
