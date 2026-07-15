import { Router } from 'express';
import { z } from 'zod';
import { SettingsStore } from '../../../../config/settings.js';
import { recommendBooks } from '../../core/recommendations.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

const requestSchema = z.object({
  prompt: z.string().max(1000).default(''),
  seedBookIds: z.array(z.string().min(1)).max(8).default([]),
  scope: z.enum(['both', 'shelf', 'discover']).optional(),
}).refine((value) => value.prompt.trim().length > 0 || value.seedBookIds.length > 0, {
  message: 'Enter a request or select at least one reference book',
});

export function createRecommendationsRouter(services: ApiServices): Router {
  const router = Router();
  router.post('/recommendations', asyncHandler(async (req, res) => {
    const request = requestSchema.parse(req.body);
    const scope = request.scope ?? SettingsStore.getInstance().getSettings().recommendationScope;
    const result = await recommendBooks({
      db: services.db,
      llmClient: services.llmClient,
      prompt: request.prompt.trim(),
      seedBookIds: Array.from(new Set(request.seedBookIds)),
      scope,
    });
    res.json(result);
  }));
  return router;
}
