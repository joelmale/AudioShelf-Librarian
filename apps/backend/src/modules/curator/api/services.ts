/**
 * Dependency bundle shared by all API routes.
 *
 * Routes are thin clients over `core/`: they receive this container and call into
 * it. The API layer NEVER imports from `src/mcp/` (and vice-versa) — both only
 * import from `src/core/`.
 */
import type { ActionLog } from '../core/actionLog.js';
import type { ABSClient } from '../core/absClient.js';
import type { ClaudeClient } from '../core/claudeClient.js';
import type { Config } from '../core/config.js';
import type { CuratorDb } from '../core/db.js';
import type { Logger } from '../core/logger.js';
import type { OperationRegistry } from '../core/operations.js';
import type { EncodeHub } from './encodeHub.js';

import type { AbsSocketClient } from '../core/absSocketClient.js';

export interface ApiServices {
  config: Config;
  db: CuratorDb;
  absClient: ABSClient;
  absSocketClient: AbsSocketClient;
  claudeClient: ClaudeClient;
  logger: Logger;
  actionLog: ActionLog;
  operations: OperationRegistry;
  /** Live encode log/progress pub-sub for the WebSocket console (api-only). */
  encodeHub: EncodeHub;
  encodeWorker: import('../core/encoder/encodeEngine.js').EncodeQueueWorker;
}
