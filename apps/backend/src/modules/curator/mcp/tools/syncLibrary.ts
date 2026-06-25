import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { syncLibrary } from '../../core/sync.js';
import { run } from '../result.js';
import type { McpServices } from '../services.js';

export function registerSyncLibrary(server: McpServer, services: McpServices): void {
  server.registerTool(
    'sync_abs_library',
    {
      title: 'Sync ABS library',
      description:
        'Pull the full Audiobookshelf library into the local mirror (upsert). Run this before tagging or generating collections. Returns counts of added/updated/unchanged books.',
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const result = await syncLibrary(services.absClient, services.db, { logger: services.logger });
        return result;
      })
  );
}
