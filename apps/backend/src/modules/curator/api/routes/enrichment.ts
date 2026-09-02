/**
 * Enrichment routes: launch an operation that populates `external_metadata`
 * (Open Library + Audnexus + Google Books + Wikidata) and rebuilds
 * `book_entities`. Long runs are launched as cancellable operations (see
 * routes/operations.ts for pause/resume/cancel + SSE) — same launch shape as
 * routes/tags.ts.
 *
 * Recommended flow: dry-run (plan the candidate pool and due providers, no
 * fetches) -> sample (a real run over min(40, 5%) of candidates, cheap
 * enough to QC provider hit rates and entity coverage against the live
 * providers via the operation's `qualityReport`) -> full run, once the
 * sample's report looks right.
 */
import { Router } from 'express';

import { enrichBooks, NOT_FOUND_TTL_MS, OK_TTL_MS, type EnrichmentOptions } from '../../core/enrichment/enricher.js';
import { promoteSubjectsFromCache, type PromoteSubjectsOptions } from '../../core/enrichment/promoteSubjects.js';
import { rederiveFromCache, type RederiveOptions } from '../../core/enrichment/rederive.js';
import { audnexusProvider } from '../../core/enrichment/providers/audnexus.js';
import { createGoogleBooksProvider } from '../../core/enrichment/providers/googleBooks.js';
import { createHardcoverProvider } from '../../core/enrichment/providers/hardcover.js';
import { openLibraryProvider } from '../../core/enrichment/providers/openLibrary.js';
import { wikidataProvider } from '../../core/enrichment/providers/wikidata.js';
import { toAppError } from '../../core/errors.js';
import { reembedAffectedBooks } from '../../core/retrieval/reembedTrigger.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';
import { backfillDescriptions, type DescriptionBackfillOptions } from '../../core/enrichment/descriptionBackfill.js';
import { backfillNarratorsFromCache, type NarratorBackfillOptions } from '../../core/enrichment/narratorBackfill.js';

interface RederiveBody {
  dryRun?: boolean;
  bookIds?: string[];
}

interface NarratorBackfillBody {
  dryRun?: boolean;
  bookIds?: string[];
}

interface PromoteSubjectsBody {
  dryRun?: boolean;
  /** Valid only alongside `dryRun: true` — see promoteSubjects.ts's docblock. */
  bookIds?: string[];
}

interface RunBody {
  dryRun?: boolean;
  sample?: boolean;
  sampleSize?: number;
  bookIds?: string[];
  /** Ignore cache TTLs — needed after the lookup query itself improves. Starts
   *  a new re-check campaign unless `refreshBefore` continues an existing one. */
  refresh?: boolean;
  /** Continue the re-check campaign that began at this epoch (ms). */
  refreshBefore?: number;
  concurrency?: number;
}

export function createEnrichmentRouter(services: ApiServices): Router {
  const router = Router();
  const { db, operations, actionLog, logger, config, embeddingCreator } = services;

  /**
   * Providers run per-book in sequence (librarian engine plan §2, build
   * order). Google Books is appended only when a key is configured — an
   * absent provider writes no `external_metadata` rows, so the day a key is
   * added every book becomes a fresh candidate with no `refresh` run needed.
   *
   * Wikidata is keyless and last. It is a CONFIRMER, not a primary: expect it
   * to resolve a minority of the library and to be right when it does. It is
   * the only provider of the four that returns a curated character list (P674),
   * which is what `tagging/ground.ts` needs before it will keep a character
   * tag at all.
   */
  const googleBooks = createGoogleBooksProvider(config.googleBooksApiKey);
  // Hardcover is last and is the only provider here that contributes no
  // entities — it exists for the reception prior (§4.3's `w_rec`, unpopulated
  // since Phase 3). See its module docblock.
  const hardcover = createHardcoverProvider({ token: config.hardcoverToken });
  const PROVIDERS = [
    openLibraryProvider,
    audnexusProvider,
    ...(googleBooks ? [googleBooks] : []),
    wikidataProvider,
    ...(hardcover ? [hardcover] : []),
  ];
  if (!googleBooks) {
    logger.info('Google Books enrichment provider disabled (GOOGLE_BOOKS_API_KEY not set)');
  }
  if (!hardcover) {
    logger.info('Hardcover enrichment provider disabled (HARDCOVER_TOKEN not set)');
  }

  /** Launch an enrichment operation in the background; return its id immediately. */
  function launch(body: RunBody): { operationId: string; status: string } {
    const controller = operations.create('enrich');
    const options: EnrichmentOptions = {
      // No dedicated env var (AGENTS.md: don't add config surface without need) —
      // reuse the tagging concurrency knob, which governs the same class of
      // work (a p-limit pool of per-book network calls).
      concurrency: body.concurrency ?? config.taggingConcurrency,
      controller,
      actionLog,
      logger,
    };
    if (body.dryRun) options.dryRun = true;
    if (body.sample) options.sample = true;
    if (body.sampleSize !== undefined) options.sampleSize = body.sampleSize;
    if (body.bookIds) options.bookIds = body.bookIds;
    if (body.refresh) options.refresh = true;
    // Only a finite number continues a campaign; anything else would silently
    // become `undefined` inside the candidate query and quietly restart the
    // sweep from the top of the library, which is the bug this exists to fix.
    if (Number.isFinite(body.refreshBefore)) options.refreshBefore = Number(body.refreshBefore);

    logger.info('Enrichment operation launched', { operationId: controller.id });
    // Fire-and-forget; the controller captures terminal state. Never leave the
    // rejection unhandled (D1).
    void enrichBooks(db, PROVIDERS, options)
      .then((result) => {
        // Readiness plan item B: enrichment rewrites grounded entities, which
        // are part of the composed card, so re-embed exactly the books this
        // run touched. reembedAffectedBooks never throws, so a failed or
        // unreachable embedder cannot turn into an enrich_aborted error for
        // an enrichment run that actually succeeded.
        void reembedAffectedBooks(db, embeddingCreator, result.processedBookIds, {
          model: config.embeddingModel,
          concurrency: config.taggingConcurrency,
          actionLog,
          logger,
        });
      })
      .catch((err: unknown) => {
        const appErr = toAppError(err);
        controller.markError({ code: appErr.code, message: appErr.message });
        actionLog.record('error', 'enrich_aborted', `Enrichment aborted: ${appErr.message}`, {
          operationId: controller.id,
          detail: { code: appErr.code },
        });
      });

    return { operationId: controller.id, status: controller.status };
  }

  /**
   * Re-run extraction over already-cached payloads. No network, so no quota:
   * this is how an improved subject splitter or entity filter reaches the
   * whole library without re-fetching it. See `core/enrichment/rederive.ts`.
   */
  function launchRederive(body: RederiveBody): { operationId: string; status: string } {
    const controller = operations.create('enrich');
    const options: RederiveOptions = { controller, actionLog, logger };
    if (body.dryRun) options.dryRun = true;
    if (body.bookIds) options.bookIds = body.bookIds;

    logger.info('Enrichment re-derive launched', { operationId: controller.id });
    void rederiveFromCache(db, PROVIDERS, options)
      .then((result) => {
        // Re-deriving rewrites grounded entities, which are part of the
        // composed card — same reason the enrichment run re-embeds. Only
        // books whose rows actually changed need it.
        const touched = [...new Set(result.examples.map((e) => e.bookId))];
        if (touched.length > 0 && !result.dryRun) {
          void reembedAffectedBooks(db, embeddingCreator, touched, {
            model: config.embeddingModel,
            concurrency: config.taggingConcurrency,
            actionLog,
            logger,
          });
        }
      })
      .catch((err: unknown) => {
        const appErr = toAppError(err);
        controller.markError({ code: appErr.code, message: appErr.message });
        actionLog.record('error', 'rederive_aborted', `Re-derive aborted: ${appErr.message}`, {
          operationId: controller.id,
          detail: { code: appErr.code },
        });
      });

    return { operationId: controller.id, status: controller.status };
  }

  /**
   * Promote cached provider `subjects` into the vocab promotion queue (R1).
   * No network, no quota, and deliberately given no `providers` array — see
   * `core/enrichment/promoteSubjects.ts`'s module docblock — so this still
   * reads a provider's already-cached rows even when that provider is
   * currently disabled for lack of a credential.
   */
  function launchPromoteSubjects(body: PromoteSubjectsBody): { operationId: string; status: string } {
    const controller = operations.create('enrich');
    const options: PromoteSubjectsOptions = { controller, actionLog, logger };
    if (body.dryRun) options.dryRun = true;
    if (body.bookIds) options.bookIds = body.bookIds;

    logger.info('Subject promotion launched', { operationId: controller.id });
    // R1 writes no book_tags/book_entities and never touches card text (see
    // the module docblock), so unlike `launch`/`launchRederive` there is no
    // follow-up re-embed to trigger here.
    void promoteSubjectsFromCache(db, options).catch((err: unknown) => {
      const appErr = toAppError(err);
      controller.markError({ code: appErr.code, message: appErr.message });
      actionLog.record('error', 'promote_subjects_aborted', `Subject promotion aborted: ${appErr.message}`, {
        operationId: controller.id,
        detail: { code: appErr.code },
      });
    });

    return { operationId: controller.id, status: controller.status };
  }

  /**
   * The re-check campaign still in progress, if any, and how much of it is
   * left. Read from `sync_log` rather than the operation registry, which is
   * in-memory and does not survive a restart — a campaign routinely spans days
   * because Google Books' free tier (1000 queries/day, ~2-6 per book) cannot
   * re-check a library this size in one.
   *
   * `remaining` is the union across providers, matching what a run would
   * actually pick up; `null` when no campaign has ever been started.
   */
  router.get(
    '/enrichment/refresh-campaign',
    asyncHandler(async (_req, res) => {
      const campaign = db.getLatestRefreshCampaign();
      if (!campaign) {
        res.json({ campaign: null });
        return;
      }
      const remaining = new Set<string>();
      for (const provider of PROVIDERS) {
        for (const book of db.getEnrichmentCandidates(provider.name, {
          okTtlMs: OK_TTL_MS,
          notFoundTtlMs: NOT_FOUND_TTL_MS,
          now: Date.now(),
          refreshBefore: campaign.refreshBefore,
        })) {
          remaining.add(book.id);
        }
      }
      res.json({ campaign: { ...campaign, remaining: remaining.size } });
    })
  );

  router.post(
    '/enrichment/run',
    asyncHandler(async (req, res) => {
      res.status(202).json(launch((req.body as RunBody) ?? {}));
    })
  );

  router.post(
    '/enrichment/rederive',
    asyncHandler(async (req, res) => {
      res.status(202).json(launchRederive((req.body as RederiveBody) ?? {}));
    })
  );

  router.post(
    '/enrichment/subjects',
    asyncHandler(async (req, res) => {
      res.status(202).json(launchPromoteSubjects((req.body as PromoteSubjectsBody) ?? {}));
    })
  );

  interface DescriptionBackfillBody {
    dryRun?: boolean;
    bookIds?: string[];
  }

  /**
   * Backfill `books.description_enriched`/`description_source` from
   * already-cached payloads. See `core/enrichment/descriptionBackfill.ts`.
   */
  function launchDescriptionBackfill(body: DescriptionBackfillBody): { operationId: string; status: string } {
    const controller = operations.create('enrich');
    const options: DescriptionBackfillOptions = { controller, actionLog, logger };
    if (body.dryRun) options.dryRun = true;
    if (body.bookIds) options.bookIds = body.bookIds;

    logger.info('Description backfill launched', { operationId: controller.id });
    void backfillDescriptions(db, PROVIDERS, options)
      .then((result) => {
        // A harvested description can change both the card's Description:
        // line and, via a newly-scoreable character mention, its People:
        // line — re-embed exactly the books whose stored pair changed.
        if (result.changedBookIds.length > 0 && !result.dryRun) {
          void reembedAffectedBooks(db, embeddingCreator, result.changedBookIds, {
            model: config.embeddingModel,
            concurrency: config.taggingConcurrency,
            actionLog,
            logger,
          });
        }
      })
      .catch((err: unknown) => {
        const appErr = toAppError(err);
        controller.markError({ code: appErr.code, message: appErr.message });
        actionLog.record('error', 'description_backfill_aborted', `Description backfill aborted: ${appErr.message}`, {
          operationId: controller.id,
          detail: { code: appErr.code },
        });
      });

    return { operationId: controller.id, status: controller.status };
  }

  router.post(
    '/enrichment/backfill-descriptions',
    asyncHandler(async (req, res) => {
      res.status(202).json(launchDescriptionBackfill((req.body as DescriptionBackfillBody) ?? {}));
    })
  );

  /**
   * Populate `books.narrator` from cached Audnexus payloads only — no
   * network. See `core/enrichment/narratorBackfill.ts` (R3,
   * docs/enrichment-sources-review.md §3).
   */
  function launchNarratorBackfill(body: NarratorBackfillBody): { operationId: string; status: string } {
    const controller = operations.create('enrich');
    const options: NarratorBackfillOptions = { controller, actionLog, logger };
    if (body.dryRun) options.dryRun = true;
    if (body.bookIds) options.bookIds = body.bookIds;

    logger.info('Narrator backfill launched', { operationId: controller.id });
    void backfillNarratorsFromCache(db, options)
      .then((result) => {
        // A changed narrator changes the composed card (bookCard.ts's
        // Narrator line) — same reason enrichment/rederive re-embed. This is
        // a SCOPED re-embed covering only the books this pass changed, not
        // the whole library: deploying R3 itself invalidates the card_hash
        // of every book that already had a narrator (e.g. from ABS, with no
        // cached Audnexus row to change it here), and those are picked up by
        // the normal stale-embedding sweep (`getStaleEmbeddings`), not by
        // this route.
        if (result.changedBookIds.length > 0 && !result.dryRun) {
          void reembedAffectedBooks(db, embeddingCreator, result.changedBookIds, {
            model: config.embeddingModel,
            concurrency: config.taggingConcurrency,
            actionLog,
            logger,
          });
        }
      })
      .catch((err: unknown) => {
        const appErr = toAppError(err);
        controller.markError({ code: appErr.code, message: appErr.message });
        actionLog.record('error', 'narrator_backfill_aborted', `Narrator backfill aborted: ${appErr.message}`, {
          operationId: controller.id,
          detail: { code: appErr.code },
        });
      });

    return { operationId: controller.id, status: controller.status };
  }

  router.post(
    '/enrichment/narrator-backfill',
    asyncHandler(async (req, res) => {
      res.status(202).json(launchNarratorBackfill((req.body as NarratorBackfillBody) ?? {}));
    })
  );

  return router;
}
