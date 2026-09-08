/**
 * Recompute the persisted tag set from stored LLM proposals — the cheap half
 * of the expensive/cheap split that `tag_runs.proposals` was added for, and
 * the direct analogue of `enrichment/rederive.ts` one stage later in the
 * pipeline.
 *
 * A tagging run does two very different things: it pays a model to propose
 * raw tags, then it turns those proposals into stored tags using purely
 * local state — the grounding allowlist, the vocabulary, aliases, derived
 * metadata. Only the first costs anything. When the second improves — a
 * re-derive that strips MARC qualifiers off 710 books' entities, a promoted
 * vocab term, a new alias — the fix should cost nothing, because the model's
 * answer is already on disk.
 *
 * Until proposals were kept, it cost a full `retagAll`: ~950 LLM calls to
 * apply a change no model was needed for. That is the same bad trade
 * `rederive.ts` exists to refuse, one stage later.
 *
 * What this does NOT do, deliberately:
 *  - **No LLM, ever.** There is no `LlmClient` parameter, so this cannot
 *    silently start calling the model if someone edits it later. A book that
 *    genuinely needs the model is reported, never quietly fixed.
 *  - **Never invents proposals.** A book whose newest run stored none is
 *    skipped and counted, not recomposed from an empty list — which would
 *    strip it back to derived tags only and look like a successful refresh.
 *  - **Never writes an unchanged book.** Recomposing is cheap enough to run
 *    over the whole library on any vocab edit, which is only safe because a
 *    no-op recompose writes nothing: no `tagged_at` churn, and no spurious
 *    re-embed for a card that did not move.
 */
import type { ActionLog } from '../actionLog.js';
import type { CuratorDb } from '../db.js';
import { toAppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { OperationController } from '../operations.js';
import { TAG_SCHEMA_VERSION, type ProgressCallback } from '../types.js';
import { composeBookTags, evaluableTagCategories } from './compose.js';
import {
  parseProposals,
  serializeProposals,
  tagComposeHash,
  tagPromptHash,
  vocabularyFingerprint,
} from './tagInputs.js';
import { judgeTagFreshness, type TagStaleReason } from './staleness.js';

export interface RegroundOptions {
  /** Report what would change, write nothing. */
  dryRun?: boolean;
  /** Restrict to specific books. */
  bookIds?: string[];
  /** The tagging model whose output the stored proposals are; part of `promptHash`. */
  taggingModel: string;
  controller?: OperationController;
  onProgress?: ProgressCallback;
  actionLog?: ActionLog;
  logger?: Logger;
  now?: () => number;
}

export interface RegroundResult {
  booksScanned: number;
  /** Books whose only drift was in compose inputs AND which kept proposals. */
  regroundable: number;
  /** Of those, the ones whose composed tag set actually moved and was written. */
  changed: number;
  /**
   * Books that need the model. Reported, never acted on — the whole point is
   * that this pass is free, so it must not quietly become expensive.
   */
  needsRetag: number;
  /** Per-reason counts across every stale book, free and paid alike. */
  byReason: Record<TagStaleReason, number>;
  /** Ids whose tags were rewritten — the scope for a follow-up re-embed. */
  changedBookIds: string[];
  dryRun: boolean;
  failed: number;
  errors: Array<{ id: string; code: string; message: string }>;
  /** Up to 10 concrete before/after tag diffs. */
  examples: Array<{ bookId: string; title: string; before: string[]; after: string[] }>;
  cancelled?: boolean;
}

function emptyReasons(): Record<TagStaleReason, number> {
  return { 'never-tagged': 0, 'never-recorded': 0, 'schema-changed': 0, 'prompt-changed': 0, 'compose-changed': 0 };
}

/** Stable `category:tag@source` key set, for deciding whether a recompose actually moved anything. */
function tagKeys(tags: ReadonlyArray<{ category: string; tag: string; source: string }>): string[] {
  return tags.map((t) => `${t.category}:${t.tag}@${t.source}`).sort();
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Recompose every book that is compose-stale and has stored proposals.
 *
 * Runs in book order with no concurrency pool, for the same reason
 * `rederive.ts` does not have one: there is no network here, so the work is
 * CPU- and SQLite-bound and parallelism would only add write contention.
 */
export async function regroundBooks(db: CuratorDb, options: RegroundOptions): Promise<RegroundResult> {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? Date.now;
  const opId = options.controller?.id;
  const action = options.actionLog;

  const result: RegroundResult = {
    booksScanned: 0,
    regroundable: 0,
    changed: 0,
    needsRetag: 0,
    byReason: emptyReasons(),
    changedBookIds: [],
    dryRun: Boolean(options.dryRun),
    failed: 0,
    errors: [],
    examples: [],
  };

  // Snapshot the vocabulary ONCE for the whole run, the same way rederive.ts
  // snapshots library-wide entity frequency: canonicalization is library
  // state, and recomputing it mid-run would make a book's verdict depend on
  // how far the run had got.
  const fingerprint = vocabularyFingerprint(db.getVocabFingerprintRows());
  const candidates = db.getTagStaleCandidates(options.bookIds);

  const logId = db.startLog('tag', now());
  action?.record('info', 'reground_started', `Re-ground started over ${candidates.length} books (no LLM)`, {
    operationId: opId,
    detail: { books: candidates.length, dryRun: result.dryRun },
  });

  let cancelled = false;

  for (const candidate of candidates) {
    if (options.controller) {
      try {
        await options.controller.checkpoint();
      } catch {
        cancelled = true;
        break;
      }
    }

    result.booksScanned += 1;
    const book = candidate.book;

    try {
      const entities = db.getEntitiesForBook(book.id);
      const promptHash = tagPromptHash(book, options.taggingModel, TAG_SCHEMA_VERSION);
      const composeHash = tagComposeHash(book, entities, fingerprint);
      const verdict = judgeTagFreshness(candidate, promptHash, composeHash, TAG_SCHEMA_VERSION);

      if (verdict === null) continue;
      result.byReason[verdict.reason] += 1;

      if (verdict.kind === 'retag') {
        result.needsRetag += 1;
        continue;
      }

      const proposals = parseProposals(db.getLatestTagProposals(book.id));
      if (proposals === null) {
        // `hasProposals` said there were some, so this is a corrupt payload,
        // not an old run. Count it as needing the model rather than
        // recomposing from nothing — see the module docblock.
        result.needsRetag += 1;
        logger.warn('Stored tag proposals unreadable; book needs a re-tag', { bookId: book.id });
        continue;
      }

      result.regroundable += 1;

      const before = tagKeys(db.getTagsForBook(book.id));
      const composed = composeBookTags(book, proposals, db);
      const after = tagKeys(composed);
      if (sameTags(before, after)) {
        // The inputs moved but this book's tags did not. Recording a run
        // anyway is what stops the next pass re-examining it forever — it
        // proves the book was checked at these hashes — but only when we
        // actually wrote, so a dry run stays a dry run.
        if (!options.dryRun) {
          db.recordTagRun(book.id, evaluableTagCategories(book, entities), TAG_SCHEMA_VERSION, now(), {
            proposals: serializeProposals(proposals),
            promptHash,
            composeHash,
          });
        }
        continue;
      }

      result.changed += 1;
      result.changedBookIds.push(book.id);
      if (result.examples.length < 10) {
        result.examples.push({
          bookId: book.id,
          title: book.title,
          before: before.slice(0, 12),
          after: after.slice(0, 12),
        });
      }

      if (!options.dryRun) {
        db.replaceBookTags(book.id, composed, now());
        // The proposals are carried forward verbatim: they are still exactly
        // what the model said, and this pass did not ask it anything.
        db.recordTagRun(book.id, evaluableTagCategories(book, entities), TAG_SCHEMA_VERSION, now(), {
          proposals: serializeProposals(proposals),
          promptHash,
          composeHash,
        });
      }
    } catch (err) {
      // Per-book isolation, same as tagging and enrichment (A4).
      const appErr = toAppError(err);
      result.failed += 1;
      result.errors.push({ id: book.id, code: appErr.code, message: appErr.message });
      logger.warn('Failed to re-ground book', { bookId: book.id, code: appErr.code });
    } finally {
      const progress = { phase: 'reground', current: result.booksScanned, total: candidates.length, message: book.id };
      options.controller?.setProgress(progress);
      options.onProgress?.(progress);
    }
  }

  db.finishLog(logId, result.failed > 0 && result.changed === 0 ? 'error' : 'success', { ...result, cancelled }, now());

  if (cancelled) {
    result.cancelled = true;
    options.controller?.markCancelled(result);
    action?.record('warn', 'reground_cancelled', `Re-ground cancelled after ${result.changed} books changed`, {
      operationId: opId,
      detail: { changed: result.changed },
    });
  } else {
    options.controller?.markCompleted(result);
    action?.record(
      'info',
      'reground_finished',
      `Re-ground finished: ${result.changed} of ${result.regroundable} recomposed books changed; ${result.needsRetag} still need the model`,
      {
        operationId: opId,
        detail: {
          changed: result.changed,
          regroundable: result.regroundable,
          needsRetag: result.needsRetag,
          dryRun: result.dryRun,
        },
      }
    );
  }

  return result;
}
