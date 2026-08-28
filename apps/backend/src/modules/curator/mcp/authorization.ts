/**
 * Per-tool authorization for the MCP surface.
 *
 * WHY PER-TOOL RATHER THAN ONE GATE ON THE MOUNT
 * ----------------------------------------------
 * `authorizeApi` derives a role from HTTP path + method. Every MCP call is a
 * POST to a single path, so that logic would classify the entire tool surface as
 * `curator` — turning MCP into a lower-privilege route to `sync_abs_library`
 * (librarian over REST) and the encode tools (administrator over REST).
 *
 * Gating the whole mount at `administrator` would close that hole, but it would
 * also make the five read-only tools unusable for viewer- and curator-level
 * clients, which is the main reason to expose MCP at all — letting an assistant
 * answer questions about the library.
 *
 * So each tool carries the role its REST equivalent requires. The table below is
 * derived by applying `authorizeApi`'s rules to the route each tool corresponds
 * to; the comment on each line records that route so the mapping can be audited
 * rather than trusted.
 *
 * FAIL-CLOSED: a tool with no entry is denied outright. During this work a grep
 * miscounted the tool surface as 13 when it is 14, and `queue_m4b_encode` — the
 * single most privileged tool here — was the one missing. A permissive default
 * would have silently exposed it.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { ROLE_RANK, type Role } from '../../../security/auth.js';
import { ForbiddenError } from '../core/errors.js';
import { fail, type ToolResult } from './result.js';

/**
 * Minimum role required to invoke each tool, mirroring the REST route it wraps.
 */
export const TOOL_MINIMUM_ROLE = {
  // Reads — GET equivalents, viewer.
  search_library: 'viewer', // internal librarian registry: read-only retrieval
  get_book: 'viewer', // internal librarian registry: read-only retrieval
  find_similar: 'viewer', // internal librarian registry: read-only retrieval
  search_semantic: 'viewer', // internal librarian registry: read-only retrieval
  tag_coverage: 'viewer', // internal librarian registry: read-only retrieval
  query_library: 'viewer', // GET /books
  get_book_tags: 'viewer', // GET /books/:id/tags
  list_collections: 'viewer', // GET /collections
  get_tagging_status: 'viewer', // GET /tags/stats
  get_encode_status: 'viewer', // GET /encode/status

  // Local mutations — POST that is neither /sync, /encode, /admin nor /librarian.
  tag_books: 'curator', // POST /tags/run
  retag_book: 'curator', // POST /tags/retag
  generate_collections: 'curator', // POST /collections/generate
  approve_collection: 'curator', // POST /collections/:id/approve
  push_collection: 'curator', // POST /collections/:id/push
  push_all_approved: 'curator', // POST /collections/push-all

  // Writes back to Audiobookshelf — path contains '/sync'.
  sync_abs_library: 'librarian', // POST /sync

  // Encode surface — path contains '/encode'.
  scan_encodable: 'administrator', // POST /encode/scan
  queue_m4b_encode: 'administrator', // POST /encode/queue
} as const satisfies Record<string, Role>;

export type GuardedToolName = keyof typeof TOOL_MINIMUM_ROLE;

/** Every tool name the policy covers. Used by tests to detect drift. */
export const AUTHORIZED_TOOL_NAMES = Object.keys(TOOL_MINIMUM_ROLE) as GuardedToolName[];

/** Read the caller's role out of the AuthInfo the router attached. */
export function roleFromAuthInfo(authInfo: AuthInfo | undefined): Role | null {
  const role = authInfo?.extra?.role;
  return typeof role === 'string' && role in ROLE_RANK ? (role as Role) : null;
}

export interface AuthorizationDecision {
  allowed: boolean;
  required?: Role;
  actual?: Role;
  reason?: string;
}

/**
 * Decide whether `authInfo` may invoke `toolName`. Denies when the tool has no
 * policy entry and when no recognizable role is present.
 */
export function authorizeTool(toolName: string, authInfo: AuthInfo | undefined): AuthorizationDecision {
  const required = (TOOL_MINIMUM_ROLE as Record<string, Role>)[toolName];
  if (!required) {
    return { allowed: false, reason: `Tool "${toolName}" has no authorization policy and is denied by default` };
  }

  const actual = roleFromAuthInfo(authInfo);
  if (!actual) {
    return { allowed: false, required, reason: 'No authenticated role was supplied with this MCP request' };
  }

  if (ROLE_RANK[actual] < ROLE_RANK[required]) {
    return {
      allowed: false,
      required,
      actual,
      reason: `Tool "${toolName}" requires the ${required} role; this session holds ${actual}`,
    };
  }

  return { allowed: true, required, actual };
}

/** The shape McpServer passes as the final argument to a tool callback. */
type ToolExtra = { authInfo?: AuthInfo };

/**
 * Wrap an McpServer so every tool registered through it is authorization-checked.
 *
 * Interception happens at registration rather than in each tool file: the policy
 * stays in one auditable table, and enforcement sits at the actual invocation
 * point, so it holds regardless of how the call arrived (single request, JSON-RPC
 * batch, or a resumed stream).
 */
export function withToolAuthorization(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property) {
      if (property !== 'registerTool') {
        // Bind to the real server rather than the proxy: forwarding `this` as a
        // Proxy would break any SDK method that relies on true private fields.
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }

      return (name: string, config: unknown, handler: (...args: unknown[]) => Promise<ToolResult>) => {
        const guarded = async (...args: unknown[]): Promise<ToolResult> => {
          // The extra/context object is always the final positional argument,
          // whether or not the tool declares an input schema.
          const extra = args[args.length - 1] as ToolExtra | undefined;
          const decision = authorizeTool(name, extra?.authInfo);
          if (!decision.allowed) {
            return fail(
              new ForbiddenError(decision.reason ?? 'Not permitted', {
                tool: name,
                requiredRole: decision.required ?? null,
                actualRole: decision.actual ?? null,
              })
            );
          }
          return handler(...args);
        };

        return (target.registerTool as (...a: unknown[]) => unknown)(name, config, guarded);
      };
    },
  });
}
