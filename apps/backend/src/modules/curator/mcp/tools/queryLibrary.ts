import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { BookQueryFilters } from '../../core/db.js';
import { tagCategorySchema, type Book } from '../../core/types.js';
import { run } from '../result.js';
import { resolveBook } from '../resolve.js';
import type { McpServices } from '../services.js';

export function registerQueryTools(server: McpServer, services: McpServices): void {
  server.registerTool(
    'query_library',
    {
      title: 'Query the library',
      description:
        'Search the tagged library by title/author/tag/category/confidence, duration range (hours), series membership, and published-year range. Returns matching books with their tags. Use this to find books for a collection before generating or to answer questions about the library.',
      inputSchema: {
        title: z.string().optional(),
        author: z.string().optional(),
        tag: z.string().optional(),
        category: tagCategorySchema.optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        minDurationHours: z.number().optional(),
        maxDurationHours: z.number().optional(),
        series: z.enum(['any', 'standalone', 'in-series']).optional().describe('Filter by series membership'),
        publishedFrom: z.number().optional(),
        publishedTo: z.number().optional(),
        limit: z.number().optional(),
      },
    },
    async (args) =>
      run(() => {
        const filters: BookQueryFilters = { limit: 500 };
        if (args.title) filters.search = args.title;
        if (args.author) filters.author = args.author;
        if (args.tag) filters.tag = args.tag;
        if (args.category) filters.category = args.category;
        if (args.minConfidence !== undefined) filters.minConfidence = args.minConfidence;

        let books = services.db.queryBooks(filters).books;
        const minSec = args.minDurationHours !== undefined ? args.minDurationHours * 3600 : undefined;
        const maxSec = args.maxDurationHours !== undefined ? args.maxDurationHours * 3600 : undefined;
        books = books.filter((b: Book) => {
          if (minSec !== undefined && (b.durationSeconds === null || b.durationSeconds < minSec)) return false;
          if (maxSec !== undefined && (b.durationSeconds === null || b.durationSeconds > maxSec)) return false;
          if (args.series === 'standalone' && b.series !== null) return false;
          if (args.series === 'in-series' && b.series === null) return false;
          if (args.publishedFrom !== undefined && (b.publishedYear === null || b.publishedYear < args.publishedFrom)) return false;
          if (args.publishedTo !== undefined && (b.publishedYear === null || b.publishedYear > args.publishedTo)) return false;
          return true;
        });
        const limit = args.limit ?? 100;
        return {
          total: books.length,
          books: books.slice(0, limit).map((b) => ({ ...b, tags: services.db.getTagsForBook(b.id) })),
        };
      })
  );

  server.registerTool(
    'get_book_tags',
    {
      title: 'Get a book’s tags',
      description: 'Return the tags for a single book, identified by ABS id or by title (ambiguous titles return candidates).',
      inputSchema: { id: z.string().optional(), title: z.string().optional() },
    },
    async (args) =>
      run(() => {
        const book = resolveBook(services.db, args);
        return { book: { id: book.id, title: book.title }, tags: services.db.getTagsForBook(book.id) };
      })
  );

  server.registerTool(
    'retag_book',
    {
      title: 'Re-tag one book',
      description:
        'Re-run Claude tagging for a SINGLE book (identified by ABS id or title), replacing its existing tags. Use this to fix one book’s tags. To tag many untagged books at once, use tag_books instead.',
      inputSchema: { id: z.string().optional(), title: z.string().optional() },
    },
    async (args) =>
      run(async () => {
        const book = resolveBook(services.db, args);
        const result = await services.claudeClient.tagBook(book);
        services.db.replaceBookTags(book.id, result.tags, Date.now());
        return { book: { id: book.id, title: book.title }, tags: result.tags, usage: result.usage };
      })
  );
}
