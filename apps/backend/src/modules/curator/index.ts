import { loadConfig } from "./core/config.js";
import { CuratorDb } from "./core/db.js";
import { createLogger } from "./core/logger.js";
import { ABSClient } from "./core/absClient.js";
import { AbsSocketClient } from "./core/absSocketClient.js";
import { LlmClient, FallbackMessageCreator, createAnthropicMessageCreator, createOllamaMessageCreator, MessageCreator } from "./core/llmClient.js";
import { TokenBucketRateLimiter } from "./core/rateLimiter.js";
import { ActionLog } from "./core/actionLog.js";
import { OperationRegistry } from "./core/operations.js";
import { createOllamaEmbeddingCreator } from "./core/retrieval/embeddings.js";
import { EncodeHub } from "./api/encodeHub.js";
import { createCuratorApiRouter } from "./api/server.js";
import { Router } from "express";
import { EncodeQueueWorker } from "./core/encoder/encodeEngine.js";
import { SettingsStore } from "../../config/settings.js";
import type { ApiServices } from "./api/services.js";

/**
 * Build the curator service bundle: config, database, ABS clients, LLM client,
 * action log, operation registry, encode hub, and a started encode worker.
 *
 * Call this ONCE per process. It opens a SQLite connection and starts a polling
 * encode worker, so a second bundle would mean two writers against the same
 * database file and two workers racing for the same queue. Both the REST router
 * and the MCP router take the bundle as an argument rather than building their
 * own — see createCuratorRouter and createMcpRouter.
 */
export function createCuratorServices(): ApiServices {
  const settingsStore = SettingsStore.getInstance();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = new CuratorDb(config.dbPath);
  const absClient = new ABSClient(config.absUrl, config.absToken);
  
  const rateLimiter = new TokenBucketRateLimiter({
    rpm: config.anthropicRpm,
    tpm: config.anthropicTpm,
    logger,
  });
  const creators: MessageCreator[] = [];
  
  const cloudCreator = config.anthropicApiKey ? createAnthropicMessageCreator(config.anthropicApiKey) : null;
  const localCreator = config.ollamaUrl ? createOllamaMessageCreator(config.ollamaUrl, logger, config.ollamaChatModel) : null;
  
  if (config.llmPriority === 'local-first') {
    if (localCreator) creators.push(localCreator);
    if (cloudCreator) creators.push(cloudCreator);
  } else {
    if (cloudCreator) creators.push(cloudCreator);
    if (localCreator) creators.push(localCreator);
  }
  if (creators.length === 0) {
    logger.warn('No LLM providers configured, fallback to default Ollama');
    creators.push(createOllamaMessageCreator('http://ollama:11434', logger, config.ollamaChatModel));
  }
  const creator = new FallbackMessageCreator(creators, logger);
  
  const llmClient = new LlmClient({ 
    taggingModel: config.taggingModel,
    collectionModel: config.collectionModel,
    rateLimiter,
    creator,
    logger
  });
  
  const absSocketClient = new AbsSocketClient({
    absUrl: config.absUrl,
    token: config.absToken,
    logger,
    enabled: process.env.ABS_SOCKET_ENABLED?.toLowerCase() === 'true'
  });

  const actionLog = new ActionLog({
    logger,
    bufferThreshold: settingsStore.getSettings().actionLogLevel,
  });
  settingsStore.subscribe((settings, changedKeys) => {
    if (changedKeys.includes("actionLogLevel")) {
      actionLog.setBufferThreshold(settings.actionLogLevel);
    }
  });
  const operations = new OperationRegistry();
  const encodeHub = new EncodeHub();
  // Shared across every route/tool that re-embeds books right after a
  // tag-mutating operation completes (readiness plan item B) — see
  // core/retrieval/reembedTrigger.ts.
  const embeddingCreator = createOllamaEmbeddingCreator({ ollamaUrl: config.ollamaUrl, logger });

  const encodeWorker = new EncodeQueueWorker({
    config, db, absClient, absSocketClient, actionLog, logger, encodeHub, operations
  });
  encodeWorker.start();

  return {
    config,
    logger,
    db,
    absClient,
    absSocketClient,
    llmClient,
    actionLog,
    operations,
    encodeHub,
    encodeWorker,
    embeddingCreator
  };
}

/** Mount the curator REST API over an existing service bundle. */
export function createCuratorRouter(services: ApiServices): Router {
  return createCuratorApiRouter(services);
}
