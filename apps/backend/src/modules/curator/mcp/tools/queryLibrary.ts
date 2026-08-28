import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { reembedAffectedBooks } from '../../core/retrieval/reembedTrigger.js';
import { composeBookTags, evaluableTagCategories } from '../../core/tagging/compose.js';
import { TAG_SCHEMA_VERSION } from '../../core/types.js';
import { run } from '../result.js';
import { resolveBook } from '../resolve.js';
import type { McpServices } from '../services.js';
import { librarianMcpInputSchema, librarianToolEntry, runLibrarianTool } from './librarian.js';

export function registerQueryTools(server: McpServer, services: McpServices): void {
  const searchLibrary = librarianToolEntry('search_library');
  server.registerTool(
    'query_library',
    {
      title: 'Query the library',
      description:
        `Deprecated compatibility alias for \`search_library\`. Use \`search_library\` for new clients. ${searchLibrary.description} ` +
        'If coverage is present, you MUST state its `disclosure` sentence in your answer.',
      inputSchema: librarianMcpInputSchema(searchLibrary.inputSchema),
      annotations: { readOnlyHint: true },
    },
    async (args) => runLibrarianTool('search_library', services, args)
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
