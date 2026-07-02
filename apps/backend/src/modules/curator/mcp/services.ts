/**
 * Dependency bundle for MCP tools.
 *
 * ARCHITECTURAL BOUNDARY: `src/mcp/` imports ONLY from `src/core/` — never from
 * `src/api/`. This file mirrors the deps the tools need, all sourced from core.
 * (The composition root `src/index.ts` may import both api and mcp; the two
 * sibling layers never import each other.)
 */
import type { ActionLog } from '../core/actionLog.js';
import type { ABSClient } from '../core/absClient.js';
import type { LlmClient } from '../core/llmClient.js';
import type { Config } from '../core/config.js';
import type { CuratorDb } from '../core/db.js';
import type { Logger } from '../core/logger.js';
import type { OperationRegistry } from '../core/operations.js';

export interface McpServices {
  config: Config;
  db: CuratorDb;
  absClient: ABSClient;
  llmClient: LlmClient;
  logger: Logger;
  actionLog: ActionLog;
  operations: OperationRegistry;
}
