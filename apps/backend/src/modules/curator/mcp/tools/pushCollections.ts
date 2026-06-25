import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { pushCollection } from '../../core/collectionEngine.js';
import { run } from '../result.js';
import { resolveCollection } from '../resolve.js';
import type { McpServices } from '../services.js';

const policySchema = z
  .enum(['skip', 'overwrite', 'rename'])
  .optional()
  .describe('On an ABS name conflict: skip (default), overwrite, or rename');

export function registerCollectionTools(server: McpServer, services: McpServices): void {
  server.registerTool(
    'list_collections',
    {
      title: 'List collections',
      description: 'List proposed/approved/pushed/rejected collections. Filter by status.',
      inputSchema: {
        status: z.enum(['proposed', 'approved', 'pushed', 'rejected']).optional(),
      },
    },
    async (args) => run(() => services.db.listCollections(args.status))
  );

  server.registerTool(
    'approve_collection',
    {
      title: 'Approve a collection',
      description:
        'Approve a proposed collection so it can be pushed to ABS. Identify it by id or by exact name (an ambiguous name returns the candidate ids instead of guessing).',
      inputSchema: {
        id: z.number().optional(),
        name: z.string().optional(),
      },
    },
    async (args) =>
      run(() => {
        const c = resolveCollection(services.db, args);
        services.db.updateCollectionStatus(c.id, 'approved');
        return services.db.getCollection(c.id);
      })
  );

  server.registerTool(
    'push_collection',
    {
      title: 'Push a collection to ABS',
      description:
        'Push an APPROVED collection to Audiobookshelf, creating or updating the shelf there. Refuses to push a collection that has not been approved. Identify it by id or exact name; an ambiguous name returns candidates. Honors the conflict policy on a name clash.',
      inputSchema: {
        id: z.number().optional(),
        name: z.string().optional(),
        policy: policySchema,
      },
    },
    async (args) =>
      run(async () => {
        const c = resolveCollection(services.db, args);
        return pushCollection(services.absClient, services.db, c.id, {
          policy: args.policy ?? 'skip',
          logger: services.logger,
        });
      })
  );

  server.registerTool(
    'push_all_approved',
    {
      title: 'Push all approved collections',
      description: 'Push every approved collection to ABS. Returns per-collection results and any errors.',
      inputSchema: { policy: policySchema },
    },
    async (args) =>
      run(async () => {
        const approved = services.db.listCollections('approved');
        const results = [];
        const errors = [];
        for (const c of approved) {
          try {
            results.push(
              await pushCollection(services.absClient, services.db, c.id, {
                policy: args.policy ?? 'skip',
                logger: services.logger,
              })
            );
          } catch (err) {
            errors.push({ collectionId: c.id, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return { results, errors };
      })
  );
}
