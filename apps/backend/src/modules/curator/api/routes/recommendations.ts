import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { recommendBooks } from '../../core/recommendations.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

const requestSchema = z.object({
  prompt: z.string().max(1000).default(''),
  seedBookIds: z.array(z.string()).max(8).default([])
    .transform((ids) => ids.map((id) => id.trim()).filter(Boolean)),
  scope: z.enum(['both', 'shelf', 'discover']).optional(),
}).refine((value) => value.prompt.trim().length > 0 || value.seedBookIds.length > 0, {
  message: 'Enter a request or select at least one reference book',
});

export function createRecommendationsRouter(services: ApiServices): Router {
  const router = Router();
  router.post('/recommendations', asyncHandler(async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION', 'Enter a request or select at least one reference book');
    }
    const request = parsed.data;
    const scope = request.scope ?? 'both';
    const result = await recommendBooks({
      db: services.db,
      interpreter: services.llmClient,
      embeddingModel: services.config.embeddingModel,
      embeddingCreator: services.embeddingCreator,
      prompt: request.prompt.trim(),
      seedBookIds: Array.from(new Set(request.seedBookIds)),
      scope,
    });
    res.json(result);
  }));
  return router;
}
