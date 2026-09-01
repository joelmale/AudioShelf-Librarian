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
 *
 * Extra capability (user requirement, mirrors `tagger.ts`'s `sample` mode):
 * `sample` runs a representative sample (min(40, 5% of candidates), via the
 * tagger's `computeSampleSize`/`selectSample`) so a user can QC provider hit
 * rates and entity coverage against the live providers before committing to
 * a full-library run. A sample IS a real run over fewer books — pool,
 * checkpoints, caching, and the entity rebuild all run exactly as normal.
 * Every non-dry run (sample or full) also produces a cheap `qualityReport`
 * on the result, so the same QC view is available after a full run too.
 */
import pLimit from 'p-limit';

import { OperationCancelledError, toAppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { OperationController } from '../operations.js';
import { computeSampleSize, selectSample } from '../tagger.js';
import type { Book, ExternalMetadataStatus, ProgressCallback } from '../types.js';
import type { CuratorDb } from '../db.js';
import type { ActionLog } from '../actionLog.js';
import { isQuotaExhausted, isRateLimited } from './providers/throttle.js';
import { isEnrichmentPayload, rebuildBookEntities } from './rebuild.js';
import type {
  EnrichedEntity,
  EnrichmentPayload,
  EnrichmentPlanEntry,
  EnrichmentProvider,
  EnrichmentQualityReport,
  EnrichmentResult,
  EntityKind,
  ProviderStats,
} from './types.js';

export interface EnrichmentOptions {
  /** No fetches — just report the books/providers that would be looked up. */
  dryRun?: boolean;
  /** Actually enrich a representative sample (min(40, 5% of candidates)). */
  sample?: boolean;
  /** Override the sample size. */
  sampleSize?: number;
  /** Restrict to specific books (still filtered to due-for-lookup ones). */
  bookIds?: string[];
  /**
   * Ignore the cache TTLs and re-look-up every active book. Needed whenever the
   * *query* improves rather than the data ageing — after a title fix, every
   * cached 'not-found' is stale in a way no timestamp captures, and a normal
   * run finds zero candidates.
   *
   * Starts a new re-check CAMPAIGN, stamped `refreshBefore = now`. Pass
   * `refreshBefore` instead to continue one already in progress.
   */
  refresh?: boolean;
  /**
   * Continue the re-check campaign that began at this timestamp: books whose
   * row for a provider was written at or after it are treated as already
   * re-checked and are not asked again.
   *
   * This is what makes a library-sized re-check survive a run that does not
   * finish. Google Books' free tier is 1000 queries/day against ~2-6 queries
   * per book, so a 961-book re-check cannot complete in one day no matter how
   * it is scheduled — without an epoch each attempt re-listed the same books
   * `ORDER BY title` and burned the day's quota on the same alphabetical head.
   *
   * Implies `refresh`; it does not need to be set alongside it.
   */
  refreshBefore?: number;
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

/** Union of `subjects` across every cached 'ok' `external_metadata` row for a
 *  book (not just the ones fetched this run — same cache-wide scope as
 *  {@link rebuildBookEntities}), case-insensitively deduped, capped at 8. */
function collectSubjects(db: CuratorDb, bookId: string): string[] {
  const okRows = db.getExternalMetadata(bookId).filter((row) => row.status === 'ok');
  const seen = new Set<string>();
  const subjects: string[] = [];
  for (const row of okRows) {
    if (!isEnrichmentPayload(row.payload)) continue;
    for (const subject of row.payload.subjects) {
      const key = subject.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      subjects.push(subject);
    }
  }
  return subjects.slice(0, 8);
}

/**
 * QC summary for one enrichment run. Cheap: reads back rows this run already
 * wrote (or found fresh in cache) rather than re-fetching anything.
 * `bookProviderStatus` is THIS run's per-book, per-provider outcome — only
 * providers that were actually due appear for a given book.
 */
function buildQualityReport(
  db: CuratorDb,
  runBooks: RunBookEntry[],
  candidatesTotal: number,
  providerStats: Record<string, ProviderStats>,
  bookProviderStatus: Map<string, Record<string, ExternalMetadataStatus>>
): EnrichmentQualityReport {
  const providers: Record<string, ProviderStats & { hitRate: number | null }> = {};
  for (const [name, stats] of Object.entries(providerStats)) {
    // null, never 0, when nothing was fetched. A provider whose rows were all
    // still within TTL was never ASKED, and reporting that as "0% hit rate"
    // is a confident claim of total failure — the same null-vs-zero honesty
    // rule the readiness signal follows (invariant 5). On a live run this made
    // Open Library and Audnexus look dead when they had simply been skipped.
    providers[name] = { ...stats, hitRate: stats.fetched > 0 ? stats.ok / stats.fetched : null };
  }

  let withEntities = 0;
  let withoutEntities = 0;
  let withNotableEntities = 0;
  let totalEntities = 0;
  let totalNotable = 0;
  for (const { book } of runBooks) {
    const entities = db.getEntitiesForBook(book.id);
    const notable = entities.filter((e) => e.notable).length;
    if (entities.length > 0) withEntities += 1;
    else withoutEntities += 1;
    if (notable > 0) withNotableEntities += 1;
    totalEntities += entities.length;
    totalNotable += notable;
  }

  const examples = runBooks.slice(0, Math.min(10, runBooks.length)).map(({ book }) => {
    const all = db.getEntitiesForBook(book.id);
    // Notable first. `getEntitiesForBook` returns `ORDER BY kind, entity`, so
    // slicing that directly shows a concordance's A-names and nothing else —
    // see the docblock on EnrichmentQualityReport.examples.entities. Stable
    // within each group: the DB ordering is preserved by a boolean-only sort.
    const ordered = [...all].sort((a, b) => Number(b.notable) - Number(a.notable));
    return {
      bookId: book.id,
      title: book.title,
      providers: bookProviderStatus.get(book.id) ?? {},
      entities: ordered.slice(0, 8).map((e) => ({ entity: e.entity, kind: e.kind, notable: e.notable })),
      entityCounts: { total: all.length, notable: all.filter((e) => e.notable).length },
      subjects: collectSubjects(db, book.id),
    };
  });

  return {
    sampled: runBooks.length,
    candidatesTotal,
    providers,
    entityCoverage: {
      withEntities,
      withoutEntities,
      avgEntitiesPerBook: runBooks.length > 0 ? totalEntities / runBooks.length : 0,
      withNotableEntities,
      avgNotablePerBook: runBooks.length > 0 ? totalNotable / runBooks.length : 0,
    },
    examples,
  };
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

  // A re-check is scoped by a campaign epoch rather than a boolean, so a
  // re-check too large for one run can be continued instead of restarted —
  // see `EnrichmentOptions.refreshBefore`. An explicit epoch continues that
  // campaign; a bare `refresh` starts a new one at now().
  const refreshBefore = options.refreshBefore ?? (options.refresh ? now() : undefined);

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
    if (refreshBefore !== undefined) opts.refreshBefore = refreshBefore;
    const candidates = db.getEnrichmentCandidates(provider.name, opts);
    for (const book of candidates) {
      const entry = bookMap.get(book.id);
      if (entry) entry.providers.push(provider);
      else bookMap.set(book.id, { book, providers: [provider] });
    }
  }
  const allRunBooks = [...bookMap.values()];
  const candidatesTotal = allRunBooks.length;
  const isSampling = Boolean(options.sample) || options.sampleSize !== undefined;

  // Sample mode: reduce the union pool to a representative, deterministic
  // subset — everything downstream (pool, checkpoints, caching, entity
  // rebuild) runs exactly as it would for a real run over the full pool.
  let runBooks = allRunBooks;
  if (isSampling) {
    const sampledBooks = selectSample(
      allRunBooks.map((e) => e.book),
      computeSampleSize(allRunBooks.length, options.sampleSize)
    );
    const sampledIds = new Set(sampledBooks.map((b) => b.id));
    runBooks = allRunBooks.filter((e) => sampledIds.has(e.book.id));
  }

  const providerStats: Record<string, ProviderStats> = {};
  for (const provider of providers) providerStats[provider.name] = { fetched: 0, ok: 0, notFound: 0, errors: 0, throttled: 0 };

  const result: EnrichmentResult = {
    processed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    dryRun: Boolean(options.dryRun),
    entitiesWritten: 0,
    providerStats,
    processedBookIds: [],
    ...(isSampling ? { sample: true } : {}),
    // Echoed back — and persisted into `sync_log` by `finishLog` below — so a
    // later run can continue this campaign rather than start a fresh one.
    ...(refreshBefore !== undefined ? { refreshBefore } : {}),
  };

  const logId = db.startLog('enrich', now());
  action?.record('info', 'enrich_started', `Enrichment run started (${runBooks.length} candidates)`, {
    operationId: opId,
    detail: {
      candidates: runBooks.length,
      dryRun: result.dryRun,
      ...(isSampling ? { sample: true, sampled: runBooks.length, candidatesTotal } : {}),
    },
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
    // The epoch is persisted even for a dry run: planning a re-check is how a
    // user previews one, and the real run that follows must join THAT campaign
    // rather than silently start a second one. A dry run writes no rows, so
    // continuing it is identical to starting fresh — the point is only that
    // the panel keeps offering one campaign instead of two.
    db.finishLog(
      logId,
      'success',
      { dryRun: true, planned: plan.length, ...(refreshBefore !== undefined ? { refreshBefore } : {}) },
      now()
    );
    action?.record('info', 'enrich_dry_run', `Dry run: ${plan.length} books would be enriched`, {
      operationId: opId,
      detail: { planned: plan.length },
    });
    options.controller?.markCompleted(result);
    return result;
  }

  if (runBooks.length === 0) {
    result.qualityReport = buildQualityReport(db, [], candidatesTotal, providerStats, new Map());
    db.finishLog(logId, 'success', { processed: 0, note: 'no books due for enrichment' }, now());
    options.controller?.markCompleted(result);
    return result;
  }

  // Snapshot once for the whole run — see rebuildBookEntities's docblock for
  // why this must not be recomputed per book under the concurrent pool.
  const libraryFrequency = db.getEntityBookCounts();
  const librarySize = db.countActiveBooks();

  const limit = pLimit(Math.max(1, options.concurrency));
  let done = 0;
  let cancelled = false;
  /**
   * Providers that reported a per-DAY quota rather than a transient limit (see
   * `throttle.ts#QUOTA_EXHAUSTED`). Such a provider is RETIRED for the rest of
   * the run — every further request to it is guaranteed to fail until the
   * quota resets — but the run continues against the providers that still have
   * budget.
   *
   * This used to stop the whole run, which threw away work the other providers
   * could still do. On a live 961-book run Google Books' daily quota was
   * already spent before the first call: the run enriched 4 books (the ones
   * already in flight under `concurrency`) and skipped 957, including the Open
   * Library, Audnexus and Wikidata lookups those books were due for and that
   * had their full budget available.
   *
   * Retiring writes no row for the retired provider, and that absence is what
   * makes a later run resume for free: a book with no row is still a candidate,
   * whereas 'error' would claim we asked and were refused. Books enriched today
   * have a cached row and are not due next run. The cache IS the cursor.
   */
  const quotaExhausted = new Set<string>();
  const bookProviderStatus = new Map<string, Record<string, ExternalMetadataStatus>>();

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
        // Providers retired on a daily quota are dropped from this book's plan
        // rather than asked and failed. When that leaves nothing to ask, write
        // nothing at all: an absent row keeps the book a candidate for the next
        // run, which is the truth — it was never checked. This sits inside the
        // `try` so the `finally` still advances progress for it.
        const live = due.filter((provider) => !quotaExhausted.has(provider.name));
        if (live.length === 0) {
          result.skipped += 1;
          return;
        }

        // Providers run sequentially per book (cheap network calls); one
        // provider failing must not lose another provider's result (A4-style
        // isolation, applied at provider granularity within the book).
        const statusThisRun: Record<string, ExternalMetadataStatus> = {};
        bookProviderStatus.set(book.id, statusThisRun);
        for (const provider of live) {
          const stats = providerStats[provider.name];
          stats.fetched += 1;
          try {
            const payload = await provider.lookup(book, fetchImpl);
            if (payload) {
              db.upsertExternalMetadata({ bookId: book.id, provider: provider.name, payload, fetchedAt: now(), status: 'ok' });
              stats.ok += 1;
              statusThisRun[provider.name] = 'ok';
            } else {
              db.upsertExternalMetadata({ bookId: book.id, provider: provider.name, payload: null, fetchedAt: now(), status: 'not-found' });
              stats.notFound += 1;
              statusThisRun[provider.name] = 'not-found';
            }
          } catch (err) {
            const appErr = toAppError(err);

            // Daily quota: NOT this book's failure. Write no row — 'error'
            // would claim we asked and were refused, when the honest state is
            // that this book was never checked. Retires the provider for the
            // rest of the run; see `quotaExhausted`.
            if (isQuotaExhausted(err)) {
              if (!quotaExhausted.has(provider.name)) {
                quotaExhausted.add(provider.name);
                action?.record('warn', 'enrich_quota_exhausted', `Provider "${provider.name}" hit its daily quota — retiring it for the rest of this run. The other providers carry on, and books it never answered keep no row, so a later run re-checks them.`, {
                  operationId: opId,
                  detail: { provider: provider.name, processedSoFar: result.processed },
                });
                logger.warn('Enrichment provider retired: daily quota exhausted', { provider: provider.name });
              }
              delete statusThisRun[provider.name];
              stats.fetched -= 1;
              // `continue`, not `break`: the remaining providers for this book
              // have their own quotas and are unaffected by this one's.
              continue;
            }

            // A THROTTLE IS NOT THIS BOOK'S FAILURE either — same reasoning as
            // the daily quota above, but transient rather than terminal. The
            // provider's module-scoped limiter has already pushed every
            // in-flight book's next slot out (honouring Retry-After when it
            // was sent), so the run continues at the slower rate instead of
            // stopping. Writing 'error' here would leave a row claiming we
            // asked about this book and were refused, and would report our own
            // request rate as the provider's failure rate: on a live run that
            // rendered Wikidata as "20 errors / 39 — 13% hit rate" when the
            // provider had never actually been asked about most of them.
            if (isRateLimited(err)) {
              delete statusThisRun[provider.name];
              stats.fetched -= 1;
              stats.throttled += 1;
              continue;
            }

            db.upsertExternalMetadata({ bookId: book.id, provider: provider.name, payload: null, fetchedAt: now(), status: 'error' });
            stats.errors += 1;
            statusThisRun[provider.name] = 'error';
            action?.record('warn', 'provider_failed', `Provider "${provider.name}" failed for "${book.title}": ${appErr.message}`, {
              operationId: opId,
              detail: { bookId: book.id, provider: provider.name, code: appErr.code },
            });
            logger.warn('Enrichment provider failed', { bookId: book.id, provider: provider.name, code: appErr.code });
          }
        }

        if (quotaExhausted.size > 0 && Object.keys(statusThisRun).length === 0) {
          // Every provider due for this book was retired mid-loop, so nothing
          // was written and nothing is worth rebuilding — same reasoning as the
          // `live.length === 0` skip above.
          result.skipped += 1;
          return;
        }

        const written = rebuildBookEntities(db, book.id, book.description, libraryFrequency, librarySize);
        result.entitiesWritten += written;
        result.processed += 1;
        result.processedBookIds.push(book.id);
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

  // Cheap enough to compute on every non-dry run, not just samples — gives a
  // full run the same QC view a sample run gets, distinguished only by `sample`.
  result.qualityReport = buildQualityReport(db, runBooks, candidatesTotal, providerStats, bookProviderStatus);

  const status = result.processed === 0 && result.failed > 0 ? 'error' : 'success';
  if (quotaExhausted.size > 0) result.quotaExhausted = [...quotaExhausted];

  db.finishLog(logId, status, { ...result, cancelled }, now());

  if (cancelled) {
    result.cancelled = true;
    options.controller?.markCancelled(result);
    action?.record('warn', 'enrich_cancelled', `Enrichment cancelled after ${result.processed} enriched`, {
      operationId: opId,
      detail: {
        processed: result.processed,
        failed: result.failed,
        ...(isSampling ? { sample: true, sampled: runBooks.length } : {}),
      },
    });
  } else {
    options.controller?.markCompleted(result);
    // A quota-retired provider is named in the finishing line, at 'warn', so
    // the run does not read as a clean sweep in the log. A live run finished as
    // "COMPLETED" with `quotaExhausted` visible only in the raw result JSON,
    // which is how a run that checked 4 of 961 books passed for a full one.
    const retired = result.quotaExhausted ?? [];
    const shortfall = retired.length > 0 ? ` — ${retired.join(', ')} hit a daily quota and stopped being asked, leaving ${result.skipped} books unchecked` : '';
    action?.record(retired.length > 0 ? 'warn' : 'info', 'enrich_finished', `Enrichment finished: ${result.processed} enriched, ${result.failed} failed${shortfall}`, {
      operationId: opId,
      detail: {
        processed: result.processed,
        failed: result.failed,
        ...(retired.length > 0 ? { quotaExhausted: retired, skipped: result.skipped } : {}),
        ...(isSampling ? { sample: true, sampled: runBooks.length } : {}),
      },
    });
  }

  return result;
}
