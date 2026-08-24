/**
 * Vocabulary promotion queue routes (librarian engine plan §3 "Promotion
 * loop", §8.7). Proposed llm-open tags accumulate a book_count via
 * refreshProposedVocabCounts; this router surfaces them for review and lets
 * a curator promote, reject, or fold one term into another as an alias.
 * Thin client over core/db — no business logic beyond request shaping.
 */
import { Router } from 'express';
import { z } from 'zod';

import { NotFoundError, ValidationError } from '../../core/errors.js';
import { tagCategorySchema } from '../../core/types.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

const termBodySchema = z.object({
  term: z.string().min(1),
  category: tagCategorySchema,
});

const aliasBodySchema = z.object({
  alias: z.string().min(1),
  canonical: z.string().min(1),
  category: tagCategorySchema,
});

/**
 * Reject additionally accepts `purge`. Rejecting alone only marks a term
 * non-promotable — its rows stay on their books as `llm-open`, and
 * `excludeTags` ignores `trustedOnly` by design, so a term that is simply
 * wrong keeps poisoning negative filters. `purge: true` deletes it outright.
 * Off by default: "not canonical" and "not true" are different claims.
 */
const rejectBodySchema = termBodySchema.extend({
  purge: z.boolean().optional(),
});

export function createVocabRouter(services: ApiServices): Router {
  const router = Router();
  const { db } = services;

  router.get(
    '/vocab/proposed',
    asyncHandler(async (_req, res) => {
      db.refreshProposedVocabCounts(Date.now());
      res.json(db.getProposedVocabTerms(3));
    })
  );

  router.post(
    '/vocab/promote',
    asyncHandler(async (req, res) => {
      const parsed = termBodySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid promote request', parsed.error.issues);
      const { term, category } = parsed.data;

      const existing = db.getVocabTerms(['proposed']).find((t) => t.term === term && t.category === category);
      if (!existing) throw new NotFoundError(`No proposed vocab term ${term}/${category}`);

      db.setVocabTermStatus(term, category, 'promoted', Date.now());
      // Same tag string, category unchanged — this just flips existing
      // llm-open rows to source='vocab' now that the term is canonical.
      const retagged = db.retagLlmOpenTags(term, category, term);
      res.json({ term, category, status: 'promoted', retagged });
    })
  );

  router.post(
    '/vocab/reject',
    asyncHandler(async (req, res) => {
      const parsed = rejectBodySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid reject request', parsed.error.issues);
      const { term, category, purge } = parsed.data;

      const existing = db.getVocabTerms(['proposed']).find((t) => t.term === term && t.category === category);
      if (!existing) throw new NotFoundError(`No proposed vocab term ${term}/${category}`);

      db.setVocabTermStatus(term, category, 'rejected', Date.now());
      const removed = purge ? db.deleteTagTerm(term, category) : 0;
      res.json({ ...existing, status: 'rejected', purged: Boolean(purge), removed });
    })
  );

  router.post(
    '/vocab/alias',
    asyncHandler(async (req, res) => {
      const parsed = aliasBodySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid alias request', parsed.error.issues);
      const { alias, canonical, category } = parsed.data;

      if (!db.isVocabTerm(canonical, category)) {
        throw new ValidationError(`${canonical}/${category} is not a seed or promoted vocab term`, {
          canonical,
          category,
        });
      }

      db.upsertTagAlias(alias, canonical, category);
      const retagged = db.retagLlmOpenTags(alias, category, canonical);

      // The alias term is now folded into `canonical` — if it was sitting in
      // the promotion queue itself, it's resolved, not merely ignored.
      const proposedAlias = db.getVocabTerms(['proposed']).find((t) => t.term === alias && t.category === category);
      if (proposedAlias) db.setVocabTermStatus(alias, category, 'rejected', Date.now());

      res.json({ alias, canonical, category, retagged });
    })
  );

  return router;
}
