/**
 * Promote cached provider `subjects`/facet strings into the vocabulary
 * promotion queue (R1, docs/enrichment-sources-review.md §3, "Wire `subjects`
 * into the canonicalizer").
 *
 * Five enrichment providers already harvest genre/mood/theme-shaped strings
 * into `external_metadata` and nothing ever reads them beyond an 8-term
 * eyeball union in the enrichment quality report. This walks every active
 * book's cached `'ok'` rows, routes each provider's stored strings through the
 * facet table (`subjectFacets.ts`) and the existing tag canonicalizer
 * (`tagging/canonicalize.ts`), and writes ONLY the genuinely-unknown misses
 * (`source: 'llm-open'`) into `vocab_terms` as `status='proposed'`,
 * `origin='enrichment'` — the same promotion queue the LLM tagger's llm-open
 * output already feeds, distinguished by `origin` so the two producers can
 * never stomp each other's rows (see `CuratorDb#refreshEnrichmentVocabProposals`
 * and the scoping added to `#refreshProposedVocabCounts`).
 *
 * Mirrors `rederive.ts`'s cache-only shape exactly, and for the same reason:
 *  - **No network, ever.** There is no `fetchImpl` parameter anywhere in this
 *    file's public surface, so it cannot silently start fetching if someone
 *    edits it later.
 *  - **Never touches `raw`, `entities`, or stored `subjects`.** This pass only
 *    READS `external_metadata`; `db.upsertExternalMetadata` is never called.
 *  - **Never advances `fetched_at`.** Not applicable here in the way it is to
 *    `rederive.ts` (nothing on `external_metadata` is written at all), stated
 *    for the same invariant-5 reason: this pass must never look like a check
 *    that ran when it did not.
 *  - **Only `'ok'` rows.** `'not-found'`/`'error'` rows carry no payload.
 *  - Unlike `rederive.ts`, this takes NO `providers` array — the facet table
 *    is keyed on the provider NAME STRING stored in `external_metadata`, so
 *    this still works for a provider currently disabled for lack of a
 *    credential (e.g. Google Books/Hardcover with no key configured): their
 *    already-cached rows from when they WERE configured are still read.
 *
 * WHAT THIS DELIBERATELY DOES NOT WRITE (see the R1 design decision for the
 * full rationale — every alternative below was considered and rejected):
 *  - **No `book_tags` rows, ever.** `composeBookCard` includes tags of every
 *    category and every `TagSource`, and `book_embeddings.card_hash` drives
 *    re-embedding — writing a tag here would invalidate the hash of nearly
 *    every book in the library, breaking the plan §5 promise that R1 "does
 *    not touch card text" and can land in parallel with the blocked embedding
 *    backfill. `promoteSubjects.test.ts` asserts `composeBookCardFromDb`'s
 *    hash is unchanged by a full run, for exactly this reason.
 *  - **No `tag_aliases` rows, ever.** No provider here asserts that two
 *    labels name the same concept the way OCLC FAST's `skos:altLabel` does
 *    (the authority `fastImport.ts` relies on to write aliases); inventing an
 *    alias from a provider subject would permanently redirect every future
 *    LLM tag of that category on the strength of a guess. `POST /vocab/alias`
 *    already exists for a human to make that call.
 *
 * A non-dry run is ALWAYS library-wide: passing `bookIds` together with
 * `dryRun: false` throws a `ValidationError`. Both the library-share ceiling
 * (a term seen on over 40% of ACTIVE books is dropped as boilerplate) and the
 * prune step (an `origin='enrichment'` proposal no longer evidenced by the
 * cache is deleted) are library-wide facts a partial walk cannot measure
 * honestly — the same invariant-5 posture as `rederive.ts`'s refusal to
 * advance `fetched_at`.
 */
import { ValidationError, toAppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { OperationController } from '../operations.js';
import type { CuratorDb } from '../db.js';
import type { ActionLog } from '../actionLog.js';
import { canonicalizeTags, type CanonicalTag } from '../tagging/canonicalize.js';
import type { ProgressCallback, TagCategory } from '../types.js';
import {
  MAX_LIBRARY_SHARE,
  facetsForProvider,
  normalizeSubjectCandidate,
  surfaceFacetTerms,
} from './subjectFacets.js';

export interface PromoteSubjectsOptions {
  /** Report what would be proposed, write nothing. */
  dryRun?: boolean;
  /** Restrict the scan to specific books. Valid ONLY when `dryRun` is true —
   *  see the module docblock. */
  bookIds?: string[];
  controller?: OperationController;
  onProgress?: ProgressCallback;
  actionLog?: ActionLog;
  logger?: Logger;
  now?: () => number;
}

export interface PromoteSubjectsResult {
  /** Books examined. */
  booksScanned: number;
  /** Cached 'ok' rows examined whose provider has a facet-table entry and
   *  whose payload parsed as an object. */
  rowsScanned: number;
  /** 'ok' rows skipped: unparseable payload, or a provider absent from the
   *  facet table. */
  rowsSkipped: number;
  /** Distinct (term, category) pairs newly proposed this run. */
  termsProposed: number;
  /** Distinct (term, category) pairs that already resolved to a vocab/alias
   *  hit — evidence of a term the tagger already knows, so nothing is written. */
  termsAlreadyKnown: number;
  /** Distinct (category, raw segment) pairs dropped by the stoplist (RULE 7). */
  termsDroppedStoplist: number;
  /** Distinct (term, category) pairs dropped by the library-share ceiling. */
  termsDroppedCeiling: number;
  /** `origin='enrichment'` proposals removed because the cache no longer
   *  evidences them. Always 0 on a dry run (nothing is written on a dry run,
   *  so nothing is pruned either). */
  termsPruned: number;
  dryRun: boolean;
  failed: number;
  errors: Array<{ id: string; code: string; message: string }>;
  /** Per-provider scan volume, for eyeballing what a routing-table change did. */
  byProvider: Record<string, { rows: number; terms: number }>;
  /** Top 20 surviving (proposed) terms by book count. */
  examples: Array<{ term: string; category: TagCategory; bookCount: number; providers: string[] }>;
  cancelled?: boolean;
}

interface Evidence {
  bookIds: Set<string>;
  providers: Set<string>;
}

/** Plain codepoint comparator, same convention as `bookCard.ts` — never
 *  `localeCompare`, whose ICU collation can differ across environments. */
function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Promote cached provider subjects into the vocab promotion queue. See the
 * module docblock for the full contract.
 */
export async function promoteSubjectsFromCache(
  db: CuratorDb,
  options: PromoteSubjectsOptions = {}
): Promise<PromoteSubjectsResult> {
  if (options.bookIds && !options.dryRun) {
    throw new ValidationError(
      'promoteSubjectsFromCache: bookIds is only valid on a dry run — a non-dry run is always library-wide, ' +
        'because the library-share ceiling and the prune step are both library-wide facts a partial walk cannot measure honestly'
    );
  }

  const logger = options.logger ?? nullLogger;
  const now = options.now ?? Date.now;
  const opId = options.controller?.id;
  const action = options.actionLog;

  const result: PromoteSubjectsResult = {
    booksScanned: 0,
    rowsScanned: 0,
    rowsSkipped: 0,
    termsProposed: 0,
    termsAlreadyKnown: 0,
    termsDroppedStoplist: 0,
    termsDroppedCeiling: 0,
    termsPruned: 0,
    dryRun: Boolean(options.dryRun),
    failed: 0,
    errors: [],
    byProvider: {},
    examples: [],
  };

  const bookIds = options.bookIds ?? db.getActiveBookIds();
  const logId = db.startLog('enrich', now());
  action?.record(
    'info',
    'promote_subjects_started',
    `Subject promotion started over ${bookIds.length} books (no network)`,
    { operationId: opId, detail: { books: bookIds.length, dryRun: result.dryRun } }
  );

  // (category + normalized term) -> evidence, accumulated across the whole
  // walk. The library-share ceiling and the vocab/canonicalize step both need
  // the full-library picture, so nothing is decided per book — only gathered.
  const evidence = new Map<string, Evidence>();
  const stoplisted = new Set<string>();

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
      const rows = db.getExternalMetadata(bookId).filter((r) => r.status === 'ok');

      for (const row of rows) {
        const facets = facetsForProvider(row.provider);
        if (facets.length === 0) {
          // Unknown provider — fail closed, never guess a category.
          result.rowsSkipped += 1;
          continue;
        }
        const payload = row.payload;
        if (!payload || typeof payload !== 'object') {
          result.rowsSkipped += 1;
          continue;
        }

        result.rowsScanned += 1;
        const stats = (result.byProvider[row.provider] ??= { rows: 0, terms: 0 });
        stats.rows += 1;

        for (const facet of facets) {
          const rawTerms = facet.extract(payload as Record<string, unknown>);
          const seenNorm = new Set<string>();
          for (const segment of surfaceFacetTerms(rawTerms)) {
            const norm = normalizeSubjectCandidate(segment);
            if (norm === null) {
              // Stoplisted (RULE 7) — never reaches `evidence`; tracked
              // separately, keyed on the raw segment rather than a
              // normalized form that was never computed for a dropped term.
              stoplisted.add(`${facet.category} ${segment.toLowerCase()}`);
              continue;
            }
            if (seenNorm.has(norm)) continue;
            seenNorm.add(norm);
            stats.terms += 1;
            const key = `${facet.category} ${norm}`;
            let entry = evidence.get(key);
            if (!entry) {
              entry = { bookIds: new Set(), providers: new Set() };
              evidence.set(key, entry);
            }
            entry.bookIds.add(bookId);
            entry.providers.add(row.provider);
          }
        }
      }
    } catch (err) {
      // Per-book isolation, same as enrichment/rederive: record and continue.
      const appErr = toAppError(err);
      result.failed += 1;
      result.errors.push({ id: bookId, code: appErr.code, message: appErr.message });
      logger.warn('Failed to scan book for subject promotion', { bookId, code: appErr.code });
    } finally {
      const progress = {
        phase: 'promote-subjects',
        current: result.booksScanned,
        total: bookIds.length,
        message: bookId,
      };
      options.controller?.setProgress(progress);
      options.onProgress?.(progress);
    }
  }

  result.termsDroppedStoplist = stoplisted.size;

  // ── Canonicalize + the library-share ceiling — both library-wide facts,
  // computed once after the walk (never per book: recomputing mid-walk would
  // make a term's fate depend on how far the concurrent-free, but still
  // order-dependent, scan had gotten). ──────────────────────────────────────
  const librarySize = db.countActiveBooks();
  const proposals: Array<{ term: string; category: TagCategory; bookCount: number; providers: string[] }> = [];

  for (const [key, entry] of evidence) {
    const sep = key.indexOf(' ');
    const category = key.slice(0, sep) as TagCategory;
    const term = key.slice(sep + 1);

    const [canonical] = canonicalizeTags([{ tag: term, category, confidence: 1 }], db) as [CanonicalTag];

    if (canonical.source === 'vocab') {
      result.termsAlreadyKnown += 1;
      continue;
    }

    if (librarySize > 0 && entry.bookIds.size / librarySize > MAX_LIBRARY_SHARE) {
      result.termsDroppedCeiling += 1;
      continue;
    }

    result.termsProposed += 1;
    proposals.push({
      term: canonical.tag,
      category,
      bookCount: entry.bookIds.size,
      providers: [...entry.providers].sort(compareCodepoint),
    });
  }

  proposals.sort((a, b) => b.bookCount - a.bookCount || compareCodepoint(a.term, b.term));
  result.examples = proposals.slice(0, 20);

  // Writing (and pruning) is skipped on a dry run, and also on a cancelled
  // run: a cancelled walk saw only part of the library, and both the ceiling
  // and the prune are library-wide facts a partial walk cannot honestly
  // report — writing from it would delete `origin='enrichment'` rows the
  // unscanned remainder of the library still evidences.
  if (!options.dryRun && !cancelled) {
    result.termsPruned = db.refreshEnrichmentVocabProposals(
      proposals.map((p) => ({ term: p.term, category: p.category, bookCount: p.bookCount })),
      now()
    );
  }

  db.finishLog(
    logId,
    result.failed > 0 && result.rowsScanned === 0 ? 'error' : 'success',
    { ...result, cancelled },
    now()
  );

  if (cancelled) {
    result.cancelled = true;
    options.controller?.markCancelled(result);
    action?.record(
      'warn',
      'promote_subjects_cancelled',
      `Subject promotion cancelled after scanning ${result.booksScanned} of ${bookIds.length} books`,
      { operationId: opId, detail: { booksScanned: result.booksScanned } }
    );
  } else {
    options.controller?.markCompleted(result);
    action?.record(
      'info',
      'promote_subjects_finished',
      `Subject promotion finished: ${result.termsProposed} proposed, ${result.termsAlreadyKnown} already known, ${result.termsPruned} pruned`,
      {
        operationId: opId,
        detail: { termsProposed: result.termsProposed, termsAlreadyKnown: result.termsAlreadyKnown, dryRun: result.dryRun },
      }
    );
  }

  return result;
}
