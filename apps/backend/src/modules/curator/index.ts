import { loadConfig } from "./core/config.js";
import { CuratorDb } from "./core/db.js";
import { createLogger } from "./core/logger.js";
import { ABSClient } from "./core/absClient.js";
import { AbsSocketClient } from "./core/absSocketClient.js";
import { LlmClient, FallbackMessageCreator, createAnthropicMessageCreator, createOllamaMessageCreator, MessageCreator } from "./core/llmClient.js";
import { TokenBucketRateLimiter } from "./core/rateLimiter.js";
import { ActionLog } from "./core/actionLog.js";
import { OperationRegistry } from "./core/operations.js";
import { EncodeHub } from "./api/encodeHub.js";
import { createCuratorApiRouter } from "./api/server.js";
import { Router } from "express";
import { EncodeQueueWorker } from "./core/encoder/encodeEngine.js";
import { SettingsStore } from "../../config/settings.js";

export function createCuratorRouter(): Router {
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
  const localCreator = config.ollamaUrl ? createOllamaMessageCreator(config.ollamaUrl, logger) : null;
  
  if (config.llmPriority === 'local-first') {
    if (localCreator) creators.push(localCreator);
    if (cloudCreator) creators.push(cloudCreator);
  } else {
    if (cloudCreator) creators.push(cloudCreator);
    if (localCreator) creators.push(localCreator);
  }
  if (creators.length === 0) {
    logger.warn('No LLM providers configured, fallback to default Ollama');
    creators.push(createOllamaMessageCreator('http://ollama:11434', logger));
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

  const encodeWorker = new EncodeQueueWorker({
    config, db, absClient, absSocketClient, actionLog, logger, encodeHub, operations
  });
  encodeWorker.start();

  const services = {
    config,
    logger,
    db,
    absClient,
    absSocketClient,
    llmClient,
    actionLog,
    operations,
    encodeHub,
    encodeWorker
  };

  return createCuratorApiRouter(services);
}
