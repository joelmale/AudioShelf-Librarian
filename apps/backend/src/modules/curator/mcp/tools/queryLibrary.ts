import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { BookQueryFilters } from '../../core/db.js';
import { computeLibraryReadiness } from '../../core/readiness.js';
import { reembedAffectedBooks } from '../../core/retrieval/reembedTrigger.js';
import { composeBookTags, evaluableTagCategories } from '../../core/tagging/compose.js';
import { tagCategorySchema, TAG_SCHEMA_VERSION, type Book } from '../../core/types.js';
import { run } from '../result.js';
import { resolveBook } from '../resolve.js';
import type { McpServices } from '../services.js';

/**
 * Readiness item D, part 3 — "the librarian states materially low coverage in
 * its answer", the §8.6 honesty posture applied at library level.
 *
 * The rule is attached to the retrieval result rather than offered as a
 * separate `library_readiness` tool on purpose: a tool the model may or may
 * not call is not a rule. Every answer about the library is built from a
 * `query_library` result, so putting the disclosure there means the model
 * cannot answer without having seen it.
 *
 * `libraryCoverage` is OMITTED entirely when coverage is good enough that a
 * caveat would be noise (`disclosure === null`) — a caveat present on every
 * answer stops being read, which would defeat the feature.
 */
function libraryCoverage(services: McpServices): { libraryCoverage: unknown } | Record<string, never> {
  const readiness = computeLibraryReadiness(services.db, {
    schemaVersion: TAG_SCHEMA_VERSION,
    // Empty string means EMBEDDING_MODEL was set but blank; null makes the
    // embedded metric report Unknown instead of a confident 0% (invariant 5).
    embeddingModel: services.config.embeddingModel || null,
  });
  if (readiness.disclosure === null) return {};
  return {
    libraryCoverage: {
      disclosure: readiness.disclosure,
      totalBooks: readiness.totalBooks,
      unmeasured: readiness.unmeasured,
      metrics: readiness.metrics.map((m) => ({
        key: m.key,
        // `null` means Unknown — the check could not succeed. Do NOT read it
        // as zero.
        pct: m.pct,
        covered: m.covered,
        unknown: m.unknown,
        // Covered-but-out-of-date. Distinct from `unknown` (we cannot tell)
        // and from uncovered (never done): these books have data that is
        // actively wrong. `null` means staleness itself is unknowable here.
        ...(m.stale !== undefined ? { stale: m.stale } : {}),
        total: m.total,
        status: m.status,
        ...(m.note ? { note: m.note } : {}),
      })),
    },
  };
}

export function registerQueryTools(server: McpServer, services: McpServices): void {
  server.registerTool(
    'query_library',
    {
      title: 'Query the library',
      description:
        'Search the tagged library by title/author/tag/category/confidence, duration range (hours), series membership, and published-year range. Returns matching books with their tags. Use this to find books for a collection before generating or to answer questions about the library. ' +
        'IF the result carries `libraryCoverage`, this library is materially under-covered: you MUST state its `disclosure` sentence in your answer before recommending anything, and must not present the result as a complete view of the shelf. A `pct` of null means Unknown — the check could not run — and must never be reported as 0%. A metric\'s `stale` count is books whose data EXISTS but is out of date, which is a different problem from never having been covered: report it as such, and never as a shortfall in `pct`.',
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
          ...libraryCoverage(services),
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
        const result = await services.llmClient.tagBook(book);
        // Same canonicalize -> ground -> derive pipeline as tagger.ts (both call
        // sites share composeBookTags so a single-book re-tag matches a bulk run).
        const merged = composeBookTags(book, result.tags, services.db);
        services.db.replaceBookTags(book.id, merged, Date.now());
        // Record what this run attempted, same as tagger.ts's bulk retag path —
        // otherwise a librarian-driven single-book retag never counts as an
        // audit for getTagCoverage (librarian engine plan §10.A).
        services.db.recordTagRun(
          book.id,
          evaluableTagCategories(book, services.db.getEntitiesForBook(book.id)),
          TAG_SCHEMA_VERSION,
          Date.now()
        );
        // Readiness plan item B: re-embed this one book now that its tags
        // changed. Never throws (see reembedTrigger.ts) — a failed or
        // unreachable embedder cannot fail a retag that actually succeeded;
        // the book simply stays stale and the response says so rather than
        // implying it's fresh (invariant 5).
        const reembed = await reembedAffectedBooks(services.db, services.embeddingCreator, [book.id], {
          model: services.config.embeddingModel,
          concurrency: services.config.taggingConcurrency,
          actionLog: services.actionLog,
          logger: services.logger,
        });
        return { book: { id: book.id, title: book.title }, tags: merged, usage: result.usage, reembed };
      })
  );
}
