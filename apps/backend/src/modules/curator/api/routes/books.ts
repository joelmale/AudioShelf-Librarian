/**
 * Book browsing routes. Thin clients over core/db query helpers.
 */
import { Router } from 'express';

import { NotFoundError } from '../../core/errors.js';
import { TAG_CATEGORIES, type TagCategory } from '../../core/types.js';
import type { BookQueryFilters } from '../../core/db.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

function parseIntOr(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatOpt(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : undefined;
}

function parseCategory(value: unknown): TagCategory | undefined {
  return TAG_CATEGORIES.find((c) => c === value);
}

export function createBooksRouter(services: ApiServices): Router {
  const router = Router();
  const { db } = services;

  router.get(
    '/books',
    asyncHandler(async (req, res) => {
      const q = req.query;
      const limit = parseIntOr(q.limit, 50);
      const offset = q.offset !== undefined ? parseIntOr(q.offset, 0) : parseIntOr(q.page, 0) * limit;

      const filters: BookQueryFilters = { limit, offset };
      if (typeof q.libraryId === 'string') filters.libraryId = q.libraryId;
      if (typeof q.search === 'string') filters.search = q.search;
      if (typeof q.author === 'string') filters.author = q.author;
      if (q.untagged === 'true' || q.untagged === '1') filters.untagged = true;
      if (typeof q.tag === 'string') filters.tag = q.tag;
      const category = parseCategory(q.category);
      if (category) filters.category = category;
      const minConfidence = parseFloatOpt(q.minConfidence);
      if (minConfidence !== undefined) filters.minConfidence = minConfidence;

      const result = db.queryBooks(filters);
      const books = result.books.map((book) => ({ ...book, tags: db.getTagsForBook(book.id) }));
      res.json({ ...result, books });
    })
  );

  router.get(
    '/books/titles',
    asyncHandler(async (_req, res) => {
      // Just fetch all books (with a ridiculously high limit) to get titles
      const result = db.queryBooks({ limit: 1000000, offset: 0 });
      const titles = result.books.map(b => b.title);
      res.json(titles);
    })
  );

  router.get(
    '/books/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const book = db.getBook(id);
      if (!book) throw new NotFoundError(`No book with id ${id}`);
      res.json({ ...book, tags: db.getTagsForBook(book.id) });
    })
  );

  return router;
}
