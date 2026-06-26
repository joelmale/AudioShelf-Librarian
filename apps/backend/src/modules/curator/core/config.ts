import { SettingsStore } from "../../../config/settings.js";

/**
 * Centralized, typed environment configuration.
 *
 * Model defaults encode the cost-control decision: per-book tagging is a
 * high-volume, low-complexity classification job, so it defaults to the cheaper
 * Haiku model; collection reasoning is lower-volume but needs stronger judgment,
 * so it defaults to Sonnet. Both are overridable via env.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  absUrl: string;
  absToken: string;
  anthropicApiKey: string;
  port: number;
  mcpPort: number;
  dbPath: string;
  logLevel: LogLevel;
  taggingModel: string;
  collectionModel: string;
  taggingConcurrency: number;
  anthropicRpm: number;
  anthropicTpm: number;
  taggingBatchSize: number;
  cronSchedule: string;
  autoPush: boolean;
  // ── Audio encoding (mp3/m4a → m4b) sidecar capability ──
  /** Root of the ABS library on disk the encoder reads/writes. Empty = encoder disabled. */
  absLibraryPath: string;
  /** Where `.m4b` output is written in output-dir mode. */
  encodeOutputPath: string;
  /** Where originals are moved before in-place replacement. */
  encodeBackupPath: string;
  /** Path or command for the m4b-tool binary. */
  m4bToolPath: string;
  /** Path or command for ffprobe (used to probe sources / verify output). */
  ffprobePath: string;
  /** Max concurrent encode subprocesses (CPU-bound; default 1). */
  encodeConcurrency: number;
  /** ABS library id used to trigger a rescan after encoding. */
  absLibraryId: string;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

function logLevel(value: string | undefined): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  return 'info';
}

/**
 * Load config from process.env. `requireSecrets: false` (the default for tests)
 * permits empty ABS/Anthropic credentials; the runtime entrypoint passes `true`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sysSettings = SettingsStore.getInstance().getSettings();
  return {
    absUrl: (sysSettings.absUrl || env.ABS_URL || 'http://audiobookshelf:80').replace(/\/+$/, ''),
    absToken: sysSettings.absToken || env.ABS_TOKEN || '',
    anthropicApiKey: sysSettings.anthropicApiKey || env.ANTHROPIC_API_KEY || '',
    port: num(env.PORT, 3000),
    mcpPort: num(env.MCP_PORT, 3001),
    dbPath: env.DB_PATH ?? '/data/curator.db',
    logLevel: logLevel(env.LOG_LEVEL),
    taggingModel: env.TAGGING_MODEL ?? 'claude-haiku-4-5-20251001',
    collectionModel: env.COLLECTION_MODEL ?? 'claude-sonnet-4-6',
    taggingConcurrency: Math.max(1, num(env.TAGGING_CONCURRENCY, 4)),
    anthropicRpm: Math.max(1, num(env.ANTHROPIC_RPM, 50)),
    anthropicTpm: Math.max(1000, num(env.ANTHROPIC_TPM, 40000)),
    taggingBatchSize: Math.max(1, num(env.TAGGING_BATCH_SIZE, 10)),
    cronSchedule: env.CRON_SCHEDULE ?? '',
    autoPush: bool(env.AUTO_PUSH, false),
    absLibraryPath: (env.ABS_LIBRARY_PATH ?? '').replace(/\/+$/, ''),
    encodeOutputPath: (env.ENCODE_OUTPUT_PATH ?? '').replace(/\/+$/, ''),
    encodeBackupPath: (env.ENCODE_BACKUP_PATH ?? '').replace(/\/+$/, ''),
    m4bToolPath: env.M4B_TOOL_PATH ?? 'm4b-tool',
    ffprobePath: env.FFPROBE_PATH ?? 'ffprobe',
    encodeConcurrency: Math.max(1, num(env.ENCODE_CONCURRENCY, 1)),
    absLibraryId: env.ABS_LIBRARY_ID ?? '',
  };
}


