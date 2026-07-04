import * as util from 'util';
import { io, Socket } from 'socket.io-client';
import type { Logger } from './logger.js';
import { nullLogger } from './logger.js';
import type { OperationController } from './operations.js';

export interface AbsSocketClientOptions {
  absUrl: string;
  token: string;
  logger?: Logger;
}

/**
 * Known ABS encode-related socket event names across versions.
 *
 * ABS has used different names in different releases:
 *  - v2.x early:  task_update / task_finished / task_failed
 *  - v2.x later:  encode_progress / encode_complete / encode_failed
 *  - All versions: item_updated  ← most reliable fallback
 */
const ENCODE_PROGRESS_EVENTS = ['task_update', 'encode_progress'] as const;
const ENCODE_COMPLETE_EVENTS = ['task_finished', 'encode_complete'] as const;
const ENCODE_FAILED_EVENTS  = ['task_failed',  'encode_failed']  as const;

/** Extract libraryItemId from any known ABS task/encode payload shape. */
function extractItemId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  // Direct field
  if (typeof d.libraryItemId === 'string') return d.libraryItemId;
  // Nested under data.data
  if (d.data && typeof d.data === 'object') {
    const inner = d.data as Record<string, unknown>;
    if (typeof inner.libraryItemId === 'string') return inner.libraryItemId;
  }
  return null;
}

/** Check if an item_updated payload indicates encode completion (m4b present). */
function itemUpdatedHasM4b(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const itemId = typeof d.id === 'string' ? d.id : null;
  if (!itemId) return null;

  const media = (d.media ?? {}) as Record<string, unknown>;
  const audioFiles = (media.audioFiles ?? media.tracks ?? []) as unknown[];
  const hasM4b = audioFiles.some(
    (f: unknown) =>
      typeof (f as any)?.metadata?.ext === 'string' &&
      (f as any).metadata.ext.toLowerCase() === '.m4b'
  );
  return hasM4b ? itemId : null;
}

export class AbsSocketClient {
  private socket: Socket;
  private logger: Logger;
  private activeOperations: Map<string, OperationController> = new Map();

  constructor(options: AbsSocketClientOptions) {
    this.logger = options.logger ?? nullLogger;

    // Connect to Audiobookshelf socket
    this.socket = io(options.absUrl, {
      auth: { token: `Bearer ${options.token}` },
      transports: ['websocket', 'polling'],
    });

    this.socket.on('connect', () => {
      this.logger.info('Connected to ABS WebSocket');
    });

    this.socket.on('disconnect', (reason) => {
      this.logger.info('Disconnected from ABS WebSocket', { reason });
    });

    this.socket.on('connect_error', (error) => {
      this.logger.error('ABS WebSocket connection error', { error: error.message });
    });

    // ── Log ALL events (for diagnosing event name discrepancies across ABS versions) ──
    this.socket.onAny((eventName, ...args) => {
      if (
        eventName !== 'ping' &&
        eventName !== 'pong' &&
        eventName !== 'connect' &&
        eventName !== 'disconnect'
      ) {
        const inspectedArgs = util.inspect(args, { depth: 5, colors: false });
        this.logger.info(`ABS Socket Event: ${eventName}`, { args: inspectedArgs });
      }
    });

    // ── Encode progress (multiple event name variants) ────────────────────────
    for (const eventName of ENCODE_PROGRESS_EVENTS) {
      this.socket.on(eventName, (data: unknown) => {
        const itemId = extractItemId(data);
        if (!itemId) return;
        const op = this.activeOperations.get(itemId);
        if (!op) return;
        const progress =
          typeof (data as any)?.progress === 'number'
            ? (data as any).progress
            : typeof (data as any)?.data?.progress === 'number'
            ? (data as any).data.progress
            : 0;
        op.setProgress({
          phase: 'encode',
          current: Math.round(progress),
          total: 100,
          message: `Encoding… ${Math.round(progress)}%`,
        });
      });
    }

    // ── Encode complete (multiple event name variants) ────────────────────────
    for (const eventName of ENCODE_COMPLETE_EVENTS) {
      this.socket.on(eventName, (data: unknown) => {
        const itemId = extractItemId(data);
        if (!itemId) return;
        const op = this.activeOperations.get(itemId);
        if (!op) return;
        this.logger.info(`ABS encode complete for ${itemId} (via ${eventName})`);
        op.setProgress({ phase: 'encode', current: 100, total: 100, message: 'Finished' });
        op.markCompleted(data);
      });
    }

    // ── Encode failed (multiple event name variants) ──────────────────────────
    for (const eventName of ENCODE_FAILED_EVENTS) {
      this.socket.on(eventName, (data: unknown) => {
        const itemId = extractItemId(data);
        if (!itemId) return;
        const op = this.activeOperations.get(itemId);
        if (!op) return;
        const errorMsg =
          typeof (data as any)?.error === 'string'
            ? (data as any).error
            : typeof (data as any)?.data?.error === 'string'
            ? (data as any).data.error
            : 'ABS encode failed';
        this.logger.warn(`ABS encode failed for ${itemId} (via ${eventName})`, { data });
        op.markError({ code: 'ABS_ENCODE_FAILED', message: errorMsg }, data);
      });
    }

    // ── item_updated: reliable fallback for completion detection ─────────────
    //
    // ABS emits item_updated whenever a library item changes, including after
    // a successful encode. We check if the updated item now has an .m4b file
    // and, if so, mark any watching operation as completed.
    this.socket.on('item_updated', (data: unknown) => {
      const itemId = itemUpdatedHasM4b(data);
      if (!itemId) return;
      const op = this.activeOperations.get(itemId);
      if (!op || op.isTerminal()) return;
      this.logger.info(
        `item_updated detected .m4b for ${itemId} — marking encode complete`
      );
      op.setProgress({ phase: 'encode', current: 100, total: 100, message: 'Finished (detected via item_updated)' });
      op.markCompleted(data);
    });
  }

  /** Watch an encode operation for a given item */
  watchItem(libraryItemId: string, controller: OperationController): void {
    this.activeOperations.set(libraryItemId, controller);
  }

  /** Stop watching */
  unwatchItem(libraryItemId: string): void {
    this.activeOperations.delete(libraryItemId);
  }

  /**
   * Force-complete an operation being tracked for `libraryItemId`.
   * Used by the recovery path when we detect via REST that ABS already encoded
   * the item but the socket event was never received.
   */
  forceComplete(libraryItemId: string, reason: string): void {
    const op = this.activeOperations.get(libraryItemId);
    if (op && !op.isTerminal()) {
      this.logger.info(`Force-completing operation for ${libraryItemId}: ${reason}`);
      op.setProgress({ phase: 'encode', current: 100, total: 100, message: reason });
      op.markCompleted({ recoveredBy: reason });
    }
    this.activeOperations.delete(libraryItemId);
  }

  close(): void {
    this.socket.close();
  }
}
