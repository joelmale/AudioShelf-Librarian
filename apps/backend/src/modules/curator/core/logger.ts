/**
 * Minimal structured JSON logger.
 *
 * Logging is observability, never the sole handling of an error (MADP D3): errors
 * are still thrown as typed AppErrors. This logger just records context.
 */
import type { LogLevel } from './config.js';

export const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(
  threshold: LogLevel,
  level: LogLevel,
  bindings: Record<string, unknown>,
  message: string,
  fields?: Record<string, unknown>
): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[threshold]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...bindings,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export function createLogger(threshold: LogLevel = 'info', bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, f) => emit(threshold, 'debug', bindings, m, f),
    info: (m, f) => emit(threshold, 'info', bindings, m, f),
    warn: (m, f) => emit(threshold, 'warn', bindings, m, f),
    error: (m, f) => emit(threshold, 'error', bindings, m, f),
    child: (extra) => createLogger(threshold, { ...bindings, ...extra }),
  };
}

/** A logger that discards everything — convenient default for tests/libraries. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
