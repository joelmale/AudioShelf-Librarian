/**
 * In-memory pub/sub for live encode events (UI-facing — lives in api/, not core/).
 *
 * The encode engine writes raw subprocess log lines and progress updates through
 * the route's `onLine`/`onProgress` callbacks into this hub, keyed by the
 * operation id. WebSocket clients subscribe by operation id and receive a bounded
 * backlog (so a late/reconnecting console catches up) plus live events.
 *
 * Core stays transport-agnostic: it only ever calls the plain callbacks; this hub
 * is the api/ adapter, exactly as SseChannel is for the AI pipeline.
 */
import type { ProgressUpdate } from '../core/types.js';

export type EncodeEvent =
  | { type: 'log'; line: string; ts: number }
  | { type: 'progress'; progress: ProgressUpdate; ts: number }
  | { type: 'status'; status: string; summary?: unknown; ts: number };

interface Stream {
  backlog: EncodeEvent[];
  subscribers: Set<(event: EncodeEvent) => void>;
}

const DEFAULT_BACKLOG = 500;

export class EncodeHub {
  private readonly streams = new Map<string, Stream>();
  private readonly backlogCap: number;
  private readonly now: () => number;

  constructor(options: { backlogCap?: number; now?: () => number } = {}) {
    this.backlogCap = Math.max(50, options.backlogCap ?? DEFAULT_BACKLOG);
    this.now = options.now ?? Date.now;
  }

  private stream(operationId: string): Stream {
    let s = this.streams.get(operationId);
    if (!s) {
      s = { backlog: [], subscribers: new Set() };
      this.streams.set(operationId, s);
    }
    return s;
  }

  emitLog(operationId: string, line: string): void {
    this.publish(operationId, { type: 'log', line, ts: this.now() });
  }

  emitProgress(operationId: string, progress: ProgressUpdate): void {
    this.publish(operationId, { type: 'progress', progress, ts: this.now() });
  }

  emitStatus(operationId: string, status: string, summary?: unknown): void {
    this.publish(operationId, { type: 'status', status, summary, ts: this.now() });
  }

  private publish(operationId: string, event: EncodeEvent): void {
    const s = this.stream(operationId);
    s.backlog.push(event);
    if (s.backlog.length > this.backlogCap) s.backlog.shift();
    for (const sub of s.subscribers) sub(event);
  }

  /** Subscribe to an operation's events. Returns the current backlog + an unsubscribe fn. */
  subscribe(
    operationId: string,
    listener: (event: EncodeEvent) => void
  ): { backlog: EncodeEvent[]; unsubscribe: () => void } {
    const s = this.stream(operationId);
    s.subscribers.add(listener);
    return {
      backlog: [...s.backlog],
      unsubscribe: () => {
        s.subscribers.delete(listener);
      },
    };
  }

  /** Drop a finished operation's buffered events to bound memory. */
  release(operationId: string): void {
    this.streams.delete(operationId);
  }
}
