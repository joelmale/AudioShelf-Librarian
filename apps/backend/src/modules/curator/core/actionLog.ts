/**
 * Action log: a verbosity-filterable, in-memory ring buffer of granular events
 * from AI operations, for troubleshooting. Each `record()` fans out to the
 * structured stdout logger (gated by LOG_LEVEL) AND appends to the buffer, which
 * the API/MCP can query by minimum level, operation id, or time.
 *
 * The buffer captures every level (down to its own threshold, default debug) so
 * a user can crank up verbosity after the fact without having restarted with a
 * higher LOG_LEVEL.
 */
import type { LogLevel } from './config.js';
import { LEVEL_WEIGHT, nullLogger, type Logger } from './logger.js';

export interface ActionLogEntry {
  ts: number;
  level: LogLevel;
  operationId?: string;
  event: string;
  message: string;
  detail?: unknown;
}

export interface ActionLogQuery {
  level?: LogLevel; // minimum level (inclusive)
  operationId?: string;
  since?: number; // ts lower bound (exclusive)
  limit?: number;
}

export class ActionLog {
  private readonly buffer: ActionLogEntry[] = [];
  private readonly capacity: number;
  private readonly logger: Logger;
  /** Minimum level that the buffer retains (the stdout logger has its own gate). */
  private bufferThreshold: LogLevel;
  private readonly now: () => number;

  constructor(
    options: { logger?: Logger; capacity?: number; bufferThreshold?: LogLevel; now?: () => number } = {}
  ) {
    this.logger = options.logger ?? nullLogger;
    this.capacity = Math.max(100, options.capacity ?? 2000);
    this.bufferThreshold = options.bufferThreshold ?? 'debug';
    this.now = options.now ?? Date.now;
  }

  setBufferThreshold(level: LogLevel): void {
    this.bufferThreshold = level;
  }

  record(
    level: LogLevel,
    event: string,
    message: string,
    fields: { operationId?: string; detail?: unknown } = {}
  ): void {
    // Fan out to the structured logger (it applies its own LOG_LEVEL gate).
    const logFields = { event, ...(fields.operationId ? { operationId: fields.operationId } : {}), ...(fields.detail !== undefined ? { detail: fields.detail } : {}) };
    this.logger[level](message, logFields);

    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.bufferThreshold]) return;

    const entry: ActionLogEntry = { ts: this.now(), level, event, message };
    if (fields.operationId !== undefined) entry.operationId = fields.operationId;
    if (fields.detail !== undefined) entry.detail = fields.detail;

    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
  }

  query(q: ActionLogQuery = {}): ActionLogEntry[] {
    const minWeight = q.level ? LEVEL_WEIGHT[q.level] : 0;
    let results = this.buffer.filter(
      (e) =>
        LEVEL_WEIGHT[e.level] >= minWeight &&
        (q.operationId === undefined || e.operationId === q.operationId) &&
        (q.since === undefined || e.ts > q.since)
    );
    if (q.limit !== undefined && q.limit >= 0) results = results.slice(-q.limit);
    return results;
  }

  clear(): void {
    this.buffer.length = 0;
  }

  /** A thin binder so callers can record against a fixed operation id. */
  forOperation(operationId: string): {
    record: (level: LogLevel, event: string, message: string, detail?: unknown) => void;
  } {
    return {
      record: (level, event, message, detail) => this.record(level, event, message, { operationId, detail }),
    };
  }
}
