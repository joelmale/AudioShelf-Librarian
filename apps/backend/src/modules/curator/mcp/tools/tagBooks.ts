import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { tagUntaggedBooks } from '../../core/tagger.js';
import { validateTagQuality } from '../../core/tagQuality.js';
import { run } from '../result.js';
import type { McpServices } from '../services.js';

export function registerTagBooks(server: McpServer, services: McpServices): void {
  server.registerTool(
    'tag_books',
    {
      title: 'Tag books with Claude',
      description:
        'Tag untagged books across standardized categories (genre, mood, theme, era, pacing, length, audience). Use dryRun to preview the plan without spending tokens, or sample to tag only a representative subset (max 20 or 5%) first. Optionally restrict to specific bookIds. This is the high-volume, cost-incurring step — prefer sample/dryRun before a full run. Distinct from retag_book, which re-tags ONE already-tagged book.',
      inputSchema: {
        dryRun: z.boolean().optional().describe('Report the plan without making any API calls'),
        sample: z.boolean().optional().describe('Tag only a representative sample (max 20 or 5% of candidates)'),
        bookIds: z.array(z.string()).optional().describe('Restrict tagging to these ABS book ids'),
      },
    },
    async (args) =>
      run(async () => {
        const controller = services.operations.create('tag');
        const result = await tagUntaggedBooks(services.claudeClient, services.db, {
          concurrency: services.config.taggingConcurrency,
          controller,
          actionLog: services.actionLog,
          logger: services.logger,
          ...(args.dryRun ? { dryRun: true } : {}),
          ...(args.sample ? { sample: true } : {}),
          ...(args.bookIds ? { bookIds: args.bookIds } : {}),
        });
        return { operationId: controller.id, ...result };
      })
  );

  server.registerTool(
    'get_tagging_status',
    {
      title: 'Get tagging status',
      description:
        'Report tagging progress: counts of tagged/untagged books, a tag-quality summary, the most recent tagging run, and any in-progress tagging operations.',
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const total = services.db.countBooks();
        const tagged = services.db.countTaggedBooks();
        return {
          totalBooks: total,
          taggedBooks: tagged,
          untaggedBooks: total - tagged,
          quality: validateTagQuality(services.db),
          lastRun: services.db.getLastLog('tag') ?? null,
          activeOperations: services.operations
            .list()
            .filter((o) => o.type === 'tag' && !['completed', 'cancelled', 'error'].includes(o.status)),
        };
      })
  );
}
