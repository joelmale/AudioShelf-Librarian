/**
 * Server-sent events helper (UI-facing transport — lives in api/, not core/).
 *
 * Wraps an Express response as an SSE stream emitting typed `progress`,
 * `complete`, and `error` events. Includes a heartbeat so proxies don't drop the
 * connection, and a `retry` hint for client reconnects. The numeric `id` on each
 * event lets a reconnecting client resume via Last-Event-ID without
 * double-counting.
 */
import type { Request, Response } from 'express';

import { toErrorPayload } from '../core/errors.js';

export type SseEventType = 'progress' | 'complete' | 'error' | 'log';

export class SseChannel {
  private id = 0;
  private heartbeat: NodeJS.Timeout;
  private closed = false;

  constructor(
    req: Request,
    private readonly res: Response,
    heartbeatMs = 15_000
  ) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');

    this.heartbeat = setInterval(() => {
      if (!this.closed) this.res.write(': ping\n\n');
    }, heartbeatMs);

    req.on('close', () => this.close());
  }

  /** True if the client has disconnected; callers can stop work early. */
  get isClosed(): boolean {
    return this.closed;
  }

  send(event: SseEventType, data: unknown): void {
    if (this.closed) return;
    this.id += 1;
    this.res.write(`id: ${this.id}\n`);
    this.res.write(`event: ${event}\n`);
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  progress(data: unknown): void {
    this.send('progress', data);
  }

  /** Emit a terminal `complete` event and close the stream. */
  complete(data: unknown): void {
    this.send('complete', data);
    this.close();
  }

  /** Emit a terminal `error` event (structured payload) and close the stream. */
  fail(err: unknown): void {
    this.send('error', toErrorPayload(err));
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.res.end();
  }
}

/** Convenience for opening a channel inside a route handler. */
export function openSse(req: Request, res: Response): SseChannel {
  return new SseChannel(req, res);
}
