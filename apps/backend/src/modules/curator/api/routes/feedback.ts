import { Router } from 'express';
import { z } from 'zod';

import { AppError } from '../../core/errors.js';
import { syncListeningHistory } from '../../core/feedback/listeningSync.js';
import { buildTasteProfile, tasteScoreFor } from '../../core/feedback/tasteProfile.js';
import { EmbeddingStore } from '../../core/retrieval/embeddings.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

/**
 * Phase 5 feedback surfaces.
 *
 * `POST /feedback` records an explicit verdict; `POST /feedback/impressions`
 * records a whole displayed slate. Both are cheap writes with no LLM cost.
 * `POST /listening/sync` pulls Audiobookshelf progress — a read against ABS,
 * never a write to it. `GET /taste` reports the profile shape without
 * exposing raw vectors.
 */

const explicitVerdicts = ['accepted', 'rejected'] as const;

const feedbackSchema = z
  .object({
    bookId: z.string().trim().min(1).max(512).optional(),
    externalKey: z.string().trim().min(1).max(512).optional(),
    queryText: z.string().trim().max(1000).default(''),
    // Only explicit verdicts are accepted over HTTP. `finished`/`abandoned`
    // are derived from listening data and must not be forgeable by a client,
    // or the taste profile could be shaped by something other than behaviour.
    verdict: z.enum(explicitVerdicts),
  })
  .refine((value) => Boolean(value.bookId) !== Boolean(value.externalKey), {
    message: 'Provide exactly one of bookId or externalKey',
  });

const impressionsSchema = z.object({
  slateId: z.string().trim().min(1).max(128),
  queryText: z.string().trim().max(1000).default(''),
  items: z
    .array(
      z.object({
        bookId: z.string().trim().min(1).max(512).nullable().optional(),
        externalKey: z.string().trim().min(1).max(512).nullable().optional(),
        rank: z.number().int().min(0).max(10_000),
        score: z.number().finite().nullable().optional(),
      })
    )
    .min(1)
    .max(200),
});

const listSchema = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

export function createFeedbackRouter(services: ApiServices): Router {
  const router = Router();
  const { db, config } = services;

  router.post(
    '/feedback',
    asyncHandler(async (req, res) => {
      const parsed = feedbackSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION', 'Provide a verdict and exactly one of bookId or externalKey');
      }
      const input = parsed.data;
      if (input.bookId && !db.getBook(input.bookId)) {
        throw new AppError('VALIDATION', `No book with id ${input.bookId}`);
      }
      const id = db.insertRecFeedback({
        bookId: input.bookId ?? null,
        externalKey: input.externalKey ?? null,
        queryText: input.queryText,
        verdict: input.verdict,
        source: 'explicit',
        weight: 1,
        createdAt: Date.now(),
      });
      res.status(201).json({ id });
    })
  );

  router.get(
    '/feedback',
    asyncHandler(async (req, res) => {
      const parsed = listSchema.safeParse(req.query);
      if (!parsed.success) throw new AppError('VALIDATION', 'Invalid since/limit');
      res.json(db.getRecFeedback(parsed.data));
    })
  );

  router.post(
    '/feedback/impressions',
    asyncHandler(async (req, res) => {
      const parsed = impressionsSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError('VALIDATION', 'Invalid impression slate');
      const { slateId, queryText, items } = parsed.data;
      db.insertRecImpressions(
        slateId,
        queryText,
        items.map((item) => ({
          bookId: item.bookId ?? null,
          externalKey: item.externalKey ?? null,
          rank: item.rank,
          score: item.score ?? null,
        })),
        Date.now()
      );
      res.status(201).json({ slateId, recorded: items.length });
    })
  );

  router.post(
    '/listening/sync',
    asyncHandler(async (_req, res) => {
      const result = await syncListeningHistory({
        source: services.absClient,
        db,
        now: Date.now(),
      });
      res.json(result);
    })
  );

  router.get(
    '/taste',
    asyncHandler(async (_req, res) => {
      const store = EmbeddingStore.fromDb(db, config.embeddingModel || undefined);
      const profile = buildTasteProfile({
        feedback: db.getRecFeedback({ limit: 1000 }),
        progress: db.getAllListeningProgress(),
        store,
        now: Date.now(),
      });
      if (!profile) {
        // Honest cold start (§10.J): say there is no profile rather than
        // returning empty modes that read as "we know you like nothing".
        res.json({ available: false, reason: 'Not enough listening or feedback signal yet', modes: [] });
        return;
      }
      res.json({
        available: true,
        // Centroid vectors are deliberately not serialized — they are an
        // internal representation, and a mode is legible through its members.
        modes: profile.modes.map((mode, index) => ({
          index,
          memberCount: mode.memberIds.length,
          members: db.getBooksByIds(mode.memberIds.slice(0, 12)).map((book) => ({
            id: book.id,
            title: book.title,
            author: book.author,
            affinity: tasteScoreFor(profile, store, book.id),
          })),
        })),
        positiveCount: profile.positiveIds.length,
        negativeCount: profile.negativeIds.length,
      });
    })
  );

  return router;
}
