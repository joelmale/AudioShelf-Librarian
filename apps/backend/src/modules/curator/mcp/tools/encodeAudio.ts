import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { run } from '../result.js';
import type { McpServices } from '../services.js';

export function registerEncodeTools(server: McpServer, services: McpServices): void {
  const { absClient, config, logger } = services;

  server.registerTool(
    'scan_encodable',
    {
      title: 'Find Books that need Encoding',
      description: 'Finds all books in the ABS library that are not single .m4b files (e.g., mp3s or multiple audio files) and can be queued for encoding.',
      inputSchema: {},
    },
    async () =>
      run(async () => {
        if (!config.absLibraryId) {
          throw new Error('ABS_LIBRARY_ID is not configured in the environment.');
        }

        const items = await absClient.getLibraryItems(config.absLibraryId);
        
        // Filter items that have multiple audio files OR where the file is not .m4b
        const candidates = items.filter(item => {
          if (!item.media || !item.media.audioFiles) return false;
          const files = item.media.audioFiles;
          if (files.length > 1) return true; // Multiple files, should be merged
          if (files.length === 1) {
            const ext = files[0].metadata?.ext || files[0].filename?.split('.').pop();
            return ext?.toLowerCase() !== 'm4b'; // Single file but not m4b
          }
          return false;
        });

        return {
          total: candidates.length,
          candidates: candidates.map(c => ({
            id: c.id,
            title: c.media?.metadata?.title || 'Unknown Title',
            author: c.media?.metadata?.authorName || 'Unknown Author',
            filesCount: c.media?.audioFiles?.length || 0,
            path: c.path
          }))
        };
      })
  );

  server.registerTool(
    'queue_m4b_encode',
    {
      title: 'Queue Books for M4B Encoding via ABS',
      description: 'Triggers the native Audiobookshelf M4B encoder for a list of book IDs. The heavy lifting is handled natively by the ABS server in the background.',
      inputSchema: {
        bookIds: z.array(z.string()).min(1).describe('List of ABS book IDs to queue for encoding'),
      },
    },
    async (args) =>
      run(async () => {
        const results = {
          success: [] as string[],
          failed: [] as { id: string; error: string }[]
        };

        for (const bookId of args.bookIds) {
          try {
            await absClient.encodeBookToM4b(bookId);
            results.success.push(bookId);
          } catch (err: any) {
            logger.error(`Failed to queue encode for ${bookId}`, { error: err.message });
            results.failed.push({ id: bookId, error: err.message || String(err) });
          }
        }

        return {
          message: `Queued ${results.success.length} books for M4B encoding via Audiobookshelf.`,
          queuedIds: results.success,
          failed: results.failed,
          note: 'You can monitor the encoding progress directly in the Audiobookshelf UI tasks dashboard.'
        };
      })
  );

  // We keep stub methods for the old pause/resume/status so existing AI agents don't crash,
  // but they simply point the user to the ABS UI since ABS natively manages the encode queue now.
  server.registerTool(
    'get_encode_status',
    {
      title: 'Get encode status',
      description: 'Check encode status. Note: Encodings are now managed natively by Audiobookshelf.',
      inputSchema: {},
    },
    async () =>
      run(() => ({
        message: 'Encodings are now natively handled by the Audiobookshelf server. Please check the ABS Tasks dashboard for live progress.',
        activeOperations: [],
        recentJobs: [],
      }))
  );
}
