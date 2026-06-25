/**
 * MCP server setup (SSE transport).
 *
 * Exposes all core functionality as MCP tools so Claude can drive the curator
 * from any session. ARCHITECTURAL BOUNDARY (the headline rule of the project):
 * `src/mcp/` imports ONLY from `src/core/` and sibling `src/mcp/` modules —
 * NEVER from `src/api/`. (Verified: this file imports express + the MCP SDK +
 * core, and the tool/services/result/resolve modules, none of which touch api.)
 *
 * A fresh McpServer is built per SSE connection so multiple clients each get an
 * isolated session over the shared core services.
 */
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { nullLogger, type Logger } from '../core/logger.js';
import { registerEncodeTools } from './tools/encodeAudio.js';
import { registerGenerateCollections } from './tools/generateCollections.js';
import { registerCollectionTools } from './tools/pushCollections.js';
import { registerQueryTools } from './tools/queryLibrary.js';
import { registerSyncLibrary } from './tools/syncLibrary.js';
import { registerTagBooks } from './tools/tagBooks.js';
import type { McpServices } from './services.js';

const VERSION = process.env.npm_package_version ?? '0.1.0';

/** Build a fully-registered MCP server over the given core services. */
export function buildMcpServer(services: McpServices): McpServer {
  const server = new McpServer(
    { name: 'abs-curator', version: VERSION },
    { capabilities: { tools: {} } }
  );
  registerSyncLibrary(server, services);
  registerTagBooks(server, services);
  registerGenerateCollections(server, services);
  registerCollectionTools(server, services);
  registerQueryTools(server, services);
  registerEncodeTools(server, services);
  return server;
}

export interface McpServerHandle {
  close(): Promise<void>;
}

/** Boot the MCP server on its own port using SSE transport. */
export function startMcpServer(services: McpServices, port: number, logger: Logger = nullLogger): McpServerHandle {
  const app = express(); // intentionally no json() — SSEServerTransport parses /messages itself
  const transports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (_req, res) => {
    const server = buildMcpServer(services);
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);
    res.on('close', () => {
      transports.delete(transport.sessionId);
      void server.close();
    });
    await server.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = String(req.query.sessionId ?? '');
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: 'No active MCP session for this sessionId', code: 'NOT_FOUND' });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  const httpServer = app.listen(port, () => logger.info('MCP server listening (SSE)', { port }));

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of transports.values()) void t.close();
        httpServer.close(() => resolve());
      }),
  };
}
