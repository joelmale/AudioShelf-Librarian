import { loadConfig } from "./core/config.js";
import { CuratorDb } from "./core/db.js";
import { createLogger } from "./core/logger.js";
import { ABSClient } from "./core/absClient.js";
import { AbsSocketClient } from "./core/absSocketClient.js";
import { ClaudeClient, createAnthropicMessageCreator, createOllamaMessageCreator } from "./core/claudeClient.js";
import { TokenBucketRateLimiter } from "./core/rateLimiter.js";
import { ActionLog } from "./core/actionLog.js";
import { OperationRegistry } from "./core/operations.js";
import { EncodeHub } from "./api/encodeHub.js";
import { createCuratorApiRouter } from "./api/server.js";
import { Router } from "express";
import { EncodeQueueWorker } from "./core/encoder/encodeEngine.js";

export function createCuratorRouter(): Router {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = new CuratorDb(config.dbPath);
  const absClient = new ABSClient(config.absUrl, config.absToken);
  
  const rateLimiter = new TokenBucketRateLimiter({
    rpm: config.anthropicRpm,
    tpm: config.anthropicTpm,
    logger,
  });
  const creator = config.anthropicApiKey
    ? createAnthropicMessageCreator(config.anthropicApiKey)
    : createOllamaMessageCreator(config.ollamaUrl, logger);
  
  const claudeClient = new ClaudeClient({ 
    taggingModel: config.taggingModel,
    collectionModel: config.collectionModel,
    rateLimiter,
    creator,
    logger
  });
  
  const absSocketClient = new AbsSocketClient({
    absUrl: config.absUrl,
    token: config.absToken,
    logger
  });

  const actionLog = new ActionLog({ logger });
  const operations = new OperationRegistry();
  const encodeHub = new EncodeHub();

  const encodeWorker = new EncodeQueueWorker({
    config, db, absClient, absSocketClient, actionLog, logger, encodeHub
  });
  encodeWorker.start();

  const services = {
    config,
    logger,
    db,
    absClient,
    absSocketClient,
    claudeClient,
    actionLog,
    operations,
    encodeHub,
    encodeWorker
  };

  return createCuratorApiRouter(services);
}
