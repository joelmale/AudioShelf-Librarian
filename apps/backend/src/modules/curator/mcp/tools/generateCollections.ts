import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { generateCustom, generateFromTemplate, TEMPLATES } from '../../core/collectionEngine.js';
import { ValidationError } from '../../core/errors.js';
import { run } from '../result.js';
import type { McpServices } from '../services.js';

export function registerGenerateCollections(server: McpServer, services: McpServices): void {
  server.registerTool(
    'generate_collections',
    {
      title: 'Generate collection proposals',
      description:
        'Generate themed collection proposals (status: proposed). Use templateIds for the built-in templates (quick-listens, gateway-scifi, first-contact, …) which are deterministic SQL, and/or customPrompt for a natural-language theme that Claude curates over the tagged library. Proposals are NOT pushed to ABS — approve then push separately. List available template ids via the tool description or list_collections.',
      inputSchema: {
        templateIds: z
          .array(z.string())
          .optional()
          .describe(`Built-in template ids: ${TEMPLATES.filter((t) => !t.usesClaude).map((t) => t.id).join(', ')}`),
        customPrompt: z.string().optional().describe('Natural-language theme for Claude to curate'),
      },
    },
    async (args) =>
      run(async () => {
        if ((!args.templateIds || args.templateIds.length === 0) && !args.customPrompt) {
          throw new ValidationError('Provide templateIds and/or a customPrompt');
        }
        const created = [];
        for (const id of args.templateIds ?? []) {
          if (id === 'custom') continue;
          const r = generateFromTemplate(services.db, id, { logger: services.logger });
          created.push({ id: r.collection.id, name: r.collection.name, books: r.books.length });
        }
        let custom;
        if (args.customPrompt && args.customPrompt.trim() !== '') {
          const r = await generateCustom(services.llmClient, services.db, args.customPrompt, {
            logger: services.logger,
          });
          custom = {
            id: r.collection.id,
            name: r.collection.name,
            books: r.books.length,
            droppedBookIds: r.droppedBookIds ?? [],
          };
        }
        return { created, custom };
      })
  );
}
