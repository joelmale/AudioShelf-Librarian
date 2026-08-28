/**
 * MCP server setup (Streamable HTTP transport).
 *
 * Exposes all core functionality as MCP tools so Claude can drive the curator
 * from any session. ARCHITECTURAL BOUNDARY (the headline rule of the project):
 * `src/mcp/` imports ONLY from `src/core/`, sibling `src/mcp/` modules, and the
 * app-level `src/security/` role model — NEVER from `src/api/`.
 *
 * TRANSPORT: this used to run `SSEServerTransport` on its own `express()` app
 * with no authentication middleware of any kind. The SDK marks that transport
 * deprecated, and a second unauthenticated listener carrying `sync_abs_library`,
 * `push_all_approved` and the encode tools was not something to keep. It is now
 * a mountable `express.Router` speaking Streamable HTTP, so it inherits whatever
 * authentication the host application applies at the mount point, and every tool
 * is individually role-checked (see ./authorization.ts).
 *
 * SESSIONS: stateful. A client initializes, receives an `Mcp-Session-Id`, and
 * sends it on subsequent requests. Each session gets its own McpServer instance
 * over the shared core services, matching the previous per-connection model.
 */
import { randomUUID } from 'node:crypto';

import express, { type Request, type Response, type Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { Role } from '../../../security/auth.js';
import { nullLogger, type Logger } from '../core/logger.js';
import { withToolAuthorization } from './authorization.js';
import { registerEncodeTools } from './tools/encodeAudio.js';
import { registerGenerateCollections } from './tools/generateCollections.js';
import { registerLibrarianTools } from './tools/librarian.js';
import { registerCollectionTools } from './tools/pushCollections.js';
import { registerQueryTools } from './tools/queryLibrary.js';
import { registerSyncLibrary } from './tools/syncLibrary.js';
import { registerTagBooks } from './tools/tagBooks.js';
import type { McpServices } from './services.js';

const VERSION = process.env.npm_package_version ?? '0.1.0';

const SESSION_HEADER = 'mcp-session-id';

/**
 * Build a fully-registered MCP server over the given core services.
 *
 * Registration goes through {@link withToolAuthorization}, so there is no path
 * that registers an unguarded tool.
 */
export function buildMcpServer(services: McpServices): McpServer {
  const server = new McpServer({ name: 'abs-curator', version: VERSION }, { capabilities: { tools: {} } });
  const guarded = withToolAuthorization(server);

  registerSyncLibrary(guarded, services);
  registerTagBooks(guarded, services);
  registerGenerateCollections(guarded, services);
  registerCollectionTools(guarded, services);
  registerLibrarianTools(guarded, services);
  registerQueryTools(guarded, services);
  registerEncodeTools(guarded, services);

  return server;
}

export interface McpRouterHandle {
  router: Router;
  /** Number of live MCP sessions. Exposed for logging and tests. */
  sessionCount(): number;
  /** Close every open transport. Called from the app's shutdown handler. */
  close(): Promise<void>;
}

/** Resolve the caller's role from whatever the host authentication attached. */
function principalRole(req: Request): Role | undefined {
  return req.principal?.role;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Build the MCP router. Mount it on the host application under a path that is
 * already covered by authentication — it performs no authentication itself.
 */
export function createMcpRouter(services: McpServices, logger: Logger = nullLogger): McpRouterHandle {
  const router = express.Router();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  /**
   * The host app installs `express.json()` globally, which consumes the request
   * stream before the transport sees it. Re-parsing here would fail on an
   * already-drained stream, so the parsed body is handed to `handleRequest`
   * instead. This local parser only covers the case where the router is mounted
   * on an app that has no global parser (as the tests do).
   */
  router.use(express.json({ limit: '4mb' }));

  /** Attach the authenticated role so the per-tool guard can read it. */
  const attachAuth = (req: Request): void => {
    const role = principalRole(req);
    if (!role) return;
    (req as Request & { auth?: AuthInfo }).auth = {
      token: '',
      clientId: req.principal?.subject ?? 'mcp',
      scopes: [],
      extra: { role },
    };
  };

  router.post('/', async (req, res) => {
    try {
      attachAuth(req);
      const sessionId = req.headers[SESSION_HEADER] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        if (sessionId) {
          jsonRpcError(res, 404, -32001, 'Unknown or expired MCP session');
          return;
        }
        if (!isInitializeRequest(req.body)) {
          jsonRpcError(res, 400, -32000, 'First MCP request must be an initialize request');
          return;
        }

        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, created);
            logger.debug('MCP session initialized', { sessionId: id, sessions: transports.size });
          },
          onsessionclosed: (id) => {
            transports.delete(id);
            logger.debug('MCP session closed', { sessionId: id, sessions: transports.size });
          },
        });

        // Only drop the session from the map here. Do NOT call server.close():
        // Protocol.connect() chains this handler ahead of its own _onclose(),
        // which already tears the server down, and McpServer.close() is
        // implemented as transport.close() — so closing the server from the
        // transport's own close handler recurses until the stack overflows.
        created.onclose = () => {
          if (created.sessionId) transports.delete(created.sessionId);
        };

        const server = buildMcpServer(services);
        await server.connect(created);
        transport = created;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error('MCP request failed', { message: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal MCP transport error');
    }
  });

  /** GET opens the server→client notification stream; DELETE ends a session. */
  const bySession = async (req: Request, res: Response): Promise<void> => {
    attachAuth(req);
    const sessionId = req.headers[SESSION_HEADER] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      jsonRpcError(res, 404, -32001, 'Unknown or expired MCP session');
      return;
    }
    await transport.handleRequest(req, res);
  };

  router.get('/', bySession);
  router.delete('/', bySession);

  return {
    router,
    sessionCount: () => transports.size,
    close: async () => {
      const open = [...transports.values()];
      transports.clear();
      await Promise.all(open.map((transport) => transport.close().catch(() => undefined)));
    },
  };
}
