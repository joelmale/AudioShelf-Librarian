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
import { resolveDescription } from '../../core/enrichment/descriptionText.js';
import { reembedAffectedBooks, type ReembedOutcome } from '../../core/retrieval/reembedTrigger.js';
import {
  categoryCollisionTerms,
  enrichmentProposalBookIds,
  suggestVocabAliases,
} from '../../core/tagging/vocabReview.js';
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

const batchBodySchema = z.object({
  action: z.enum(['promote', 'reject']),
  terms: z.array(termBodySchema).min(1).max(200),
});

const termBooksQuerySchema = termBodySchema;

export function createVocabRouter(services: ApiServices): Router {
  const router = Router();
  const { db, config, actionLog, logger, embeddingCreator } = services;

  /**
   * Re-embed exactly the books a promote/alias just retagged (readiness plan
   * item B). Isolated from the mutation above it: `reembedAffectedBooks`
   * never throws, so a failed or unreachable embedder cannot fail this
   * request — the affected books simply stay stale until the next embed run
   * picks them up. Always reported back on the response so a caller never
   * has to guess whether "promoted" also means "fresh" (invariant 5).
   */
  function reembed(bookIds: string[]): Promise<ReembedOutcome> {
    return reembedAffectedBooks(db, embeddingCreator, bookIds, {
      model: config.embeddingModel,
      concurrency: config.taggingConcurrency,
      actionLog,
      logger,
    });
  }

  router.get(
    '/vocab/proposed',
    asyncHandler(async (_req, res) => {
      db.refreshProposedVocabCounts(Date.now());
      const vocabulary = db.getVocabTerms();
      const collisions = categoryCollisionTerms(vocabulary);
      res.json(db.getProposedVocabTerms(3).map((term) => ({
        ...term,
        categoryCollision: collisions.has(term.term),
        aliasSuggestions: suggestVocabAliases(term.term, term.category, vocabulary),
      })));
    })
  );

  router.get(
    '/vocab/proposed/books',
    asyncHandler(async (req, res) => {
      const parsed = termBooksQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError('Invalid proposed-term book query', parsed.error.issues);
      const { term, category } = parsed.data;
      const proposal = db.getVocabTerms(['proposed']).find((row) => row.term === term && row.category === category);
      if (!proposal) throw new NotFoundError(`No proposed vocab term ${term}/${category}`);
      // A proposal may have evidence from both producers even though `origin`
      // records only which producer created the queue row. Show the union so
      // "all books" never hides tagger or provider-cache support.
      const bookIds = new Set([
        ...db.getBooksForProposedTerm(term, category).map((book) => book.id),
        ...enrichmentProposalBookIds(db, term, category),
      ]);
      const matched = db.getBooksByIds([...bookIds]).sort((a, b) => a.title.localeCompare(b.title));
      const books = matched.map((book) => {
        const description = resolveDescription(book);
        return {
          id: book.id,
          title: book.title,
          author: book.author,
          description: description.text,
          descriptionSource: description.source,
        };
      });
      res.json({ term, category, total: books.length, books });
    })
  );

  router.post(
    '/vocab/batch',
    asyncHandler(async (req, res) => {
      const parsed = batchBodySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid vocabulary batch request', parsed.error.issues);
      const unique = [...new Map(parsed.data.terms.map((item) => [`${item.category}:${item.term}`, item])).values()];
      const result = db.reviewVocabTerms(unique, parsed.data.action);
      if (result.missing.length > 0 || result.collisions.length > 0) {
        throw new ValidationError('Vocabulary batch was not applied', {
          missing: result.missing,
          categoryCollisions: result.collisions,
        });
      }
      const reembedResult = result.action === 'promote' ? await reembed(result.bookIds) : null;
      res.json({
        action: result.action,
        reviewed: result.reviewed,
        retagged: result.retagged,
        affectedBooks: result.bookIds.length,
        reembed: reembedResult,
      });
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
      const { changed: retagged, bookIds } = db.retagLlmOpenTags(term, category, term);
      const reembedResult = await reembed(bookIds);
      res.json({ term, category, status: 'promoted', retagged, reembed: reembedResult });
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
      const { changed: retagged, bookIds } = db.retagLlmOpenTags(alias, category, canonical);

      // The alias term is now folded into `canonical` — if it was sitting in
      // the promotion queue itself, it's resolved, not merely ignored.
      const proposedAlias = db.getVocabTerms(['proposed']).find((t) => t.term === alias && t.category === category);
      if (proposedAlias) db.setVocabTermStatus(alias, category, 'rejected', Date.now());

      const reembedResult = await reembed(bookIds);
      res.json({ alias, canonical, category, retagged, reembed: reembedResult });
    })
  );

  return router;
}
