import pLimit from 'p-limit';

import type { ABSClient } from '../absClient.js';
import type { AbsSocketClient } from '../absSocketClient.js';
import type { ActionLog } from '../actionLog.js';
import { EncodeError, toAppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import { scanLibrary } from './scanner.js';
import {
  type EncodeCandidate,
  type NewEncodeQueueItem,
} from './encodeTypes.js';
import type { CuratorDb } from '../db.js';
import { OperationController, type OperationRegistry } from '../operations.js';

export interface EncoderRuntimeConfig {
  absLibraryId?: string;
}

export interface EncodeEngineDeps {
  config: EncoderRuntimeConfig;
  db: CuratorDb;
  absClient: ABSClient;
  absSocketClient: AbsSocketClient;
  actionLog?: ActionLog;
  logger?: Logger;
  encodeHub?: any; // To emit events globally
  operations?: OperationRegistry;
}

export function assertEncoderEnabled(config: EncoderRuntimeConfig): void {
  // Always enabled as long as ABS is connected.
}

/** How often (in ticks) to perform a REST-based recovery check against ABS. */
const RECOVERY_CHECK_INTERVAL_TICKS = 30; // ~60 seconds at 2s per tick

export class EncodeQueueWorker {
  private running = false;
  private currentTaskId: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private tickCount = 0;

  constructor(private deps: EncodeEngineDeps) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.deps.logger?.info('EncodeQueueWorker started');

    // On startup, reset any stuck `running` items to `queued` so they can
    // be retried. BUT before doing that, check ABS to see if they already
    // finished — if so, mark completed immediately instead of re-queueing.
    this.recoverOnStartup().then(() => {
      this.emitUpdate();
      this.scheduleNextTick();
    }).catch((err) => {
      this.deps.logger?.error('Error during startup recovery', { err });
      this.emitUpdate();
      this.scheduleNextTick();
    });
  }

  stop() {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }

  /**
   * On startup: check ABS for any items that were `running` in our DB.
   * If ABS already has an .m4b, mark completed. Otherwise reset to queued.
   */
  private async recoverOnStartup(): Promise<void> {
    const queue = this.deps.db.listEncodeQueue();
    for (const item of queue) {
      if (item.status === 'running') {
        this.deps.logger?.info(
          `Recovery check for stuck item "${item.name}" (${item.id})`
        );
        try {
          const alreadyEncoded = await this.deps.absClient.isItemEncoded(item.id);
          if (alreadyEncoded) {
            this.deps.logger?.info(
              `Item "${item.name}" is already encoded in ABS — marking completed`
            );
            this.deps.db.removeEncodeQueueItem(item.id);
            this.deps.db.insertEncodeHistoryItem({
              libraryItemId: item.id,
              name: item.name,
              author: item.author,
              totalBytes: item.totalBytes,
              status: 'completed',
              startedAt: item.addedAt,
              detail: { recoveredBy: 'startup_check' },
            });
          } else {
            this.deps.logger?.info(
              `Resetting stuck item "${item.name}" to queued for retry`
            );
            this.deps.db.updateEncodeQueueItem(item.id, { status: 'queued' });
          }
        } catch (err) {
          // ABS unreachable — reset to queued so we retry next cycle
          this.deps.logger?.warn(
            `Could not check ABS for "${item.name}" during recovery — resetting to queued`,
            { err }
          );
          this.deps.db.updateEncodeQueueItem(item.id, { status: 'queued' });
        }
      }
    }
  }

  /**
   * Periodic recovery check: if the currently-tracked item is taking too long
   * and ABS already has an .m4b, finish it rather than waiting for a socket
   * event that may never come.
   */
  private async periodicRecoveryCheck(): Promise<void> {
    if (!this.currentTaskId) return;
    try {
      const alreadyEncoded = await this.deps.absClient.isItemEncoded(
        this.currentTaskId
      );
      if (alreadyEncoded) {
        this.deps.logger?.info(
          `Periodic check: ${this.currentTaskId} is encoded in ABS — forcing completion`
        );
        this.deps.absSocketClient.forceComplete(
          this.currentTaskId,
          'detected via periodic REST check'
        );
      }
    } catch {
      // Non-fatal — we'll try again next interval
    }
  }

  private scheduleNextTick() {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => this.tick(), 2000); // Check every 2 seconds
  }

  private emitUpdate() {
    if (!this.deps.encodeHub) return;
    const queue = this.deps.db.listEncodeQueue();
    this.deps.encodeHub.emitStatus('encode_queue', 'queue_updated', queue);
  }

  async enqueue(libraryId: string, candidates: EncodeCandidate[]): Promise<void> {
    const queue = this.deps.db.listEncodeQueue();
    let maxOrder = queue.length > 0 ? Math.max(...queue.map((q: any) => q.sortOrder)) : 0;

    for (const c of candidates) {
      // Skip if already in queue (idempotent)
      if (queue.some((q: any) => q.id === c.libraryItemId)) {
        this.deps.logger?.info(
          `Skipping enqueue for "${c.name}" — already in queue`
        );
        continue;
      }
      maxOrder++;
      const item: NewEncodeQueueItem = {
        id: c.libraryItemId,
        libraryId: libraryId || c.libraryId,
        name: c.name,
        author: c.author,
        totalBytes: c.totalBytes,
        sortOrder: maxOrder,
        addedAt: Date.now(),
      };
      this.deps.db.insertEncodeQueueItem(item);
    }
    this.emitUpdate();
  }

  reorder(id: string, sortOrder: number) {
    this.deps.db.updateEncodeQueueItem(id, { sortOrder });
    this.emitUpdate();
  }

  /**
   * Remove an item from the queue.
   *
   * For `queued` items this is immediate and clean.
   *
   * For `running` items, ABS does not expose a cancel endpoint — encoding
   * continues in the background. Passing `force = true` removes the DB
   * entry and stops AudioShelf tracking the job. The result will appear on
   * the next library rescan. Without `force`, a running item is silently
   * skipped (old behaviour preserved for safety).
   */
  remove(id: string, force = false) {
    if (this.currentTaskId === id) {
      if (!force) {
        this.deps.logger?.warn(
          `Cannot remove running item ${id} without force=true`
        );
        return;
      }
      // Detach the socket watcher so completion events don't fire.
      this.deps.absSocketClient.unwatchItem(id);
      // Remove from operation registry if present.
      if (this.deps.operations) {
        const op = (this.deps.operations as any).ops?.get(id);
        if (op && !op.isTerminal()) {
          op.markCancelled({ reason: 'force_removed' });
        }
      }
      this.currentTaskId = null;
      this.deps.logger?.info(
        `Force-removed running item ${id} from queue. ABS will finish encoding in the background.`
      );
    }
    this.deps.db.removeEncodeQueueItem(id);
    this.emitUpdate();
  }

  private async tick() {
    try {
      this.tickCount++;

      // Periodic REST-based recovery check (every N ticks)
      if (this.tickCount % RECOVERY_CHECK_INTERVAL_TICKS === 0) {
        await this.periodicRecoveryCheck();
      }

      if (this.currentTaskId) {
        // Checking if the operation finished
        const op = this.deps.operations?.get(this.currentTaskId);
        if (op && op.isTerminal()) {
          const snap = op.snapshot();

          // The item is finished, handle cleanup
          const item = this.deps.db
            .listEncodeQueue()
            .find((q: any) => q.id === this.currentTaskId);
          if (item) {
            this.deps.db.removeEncodeQueueItem(item.id);
            this.deps.db.insertEncodeHistoryItem({
              libraryItemId: item.id,
              name: item.name,
              author: item.author,
              totalBytes: item.totalBytes,
              status: snap.status === 'error' ? 'error' : 'completed',
              startedAt: snap.createdAt,
              detail: snap.error ? { message: snap.error.message } : null,
            });
          }

          this.deps.absSocketClient.unwatchItem(this.currentTaskId);
          this.currentTaskId = null;
          this.emitUpdate();
        } else {
          // Still running
          this.scheduleNextTick();
          return;
        }
      }

      const queue = this.deps.db.listEncodeQueue();
      const nextItem = queue.find((q: any) => q.status === 'queued');

      if (nextItem) {
        await this.processItem(nextItem);
      }
    } catch (err) {
      this.deps.logger?.error('Error in EncodeQueueWorker tick', { err });
    }

    this.scheduleNextTick();
  }

  private async processItem(item: any) {
    // Before triggering ABS, check if the item is already encoded.
    // This handles the case where a book was encoded outside AudioShelf
    // or a previous run completed but the history write failed.
    try {
      const alreadyEncoded = await this.deps.absClient.isItemEncoded(item.id);
      if (alreadyEncoded) {
        this.deps.logger?.info(
          `Skipping ABS encode for "${item.name}" — already has .m4b in ABS`
        );
        this.deps.db.removeEncodeQueueItem(item.id);
        this.deps.db.insertEncodeHistoryItem({
          libraryItemId: item.id,
          name: item.name,
          author: item.author,
          totalBytes: item.totalBytes,
          status: 'completed',
          startedAt: Date.now(),
          detail: { skippedReason: 'already_encoded' },
        });
        this.emitUpdate();
        return;
      }
    } catch {
      // Non-fatal — proceed with encode attempt
    }

    this.currentTaskId = item.id;
    this.deps.db.updateEncodeQueueItem(item.id, { status: 'running' });
    this.emitUpdate();

    this.deps.logger?.info(`Triggering ABS encode for ${item.name}`);

    try {
      if (this.deps.operations) {
        // We instantiate the controller directly so its ID matches the ABS item ID.
        // This is necessary because absSocketClient routes by libraryItemId.
        const op = new OperationController(item.id, 'encode');
        // We manually inject it into the registry so the UI can also poll it via MCP/API
        (this.deps.operations as any).ops.set(item.id, op);
        this.deps.absSocketClient.watchItem(item.id, op);
      }

      // Trigger ABS API
      await this.deps.absClient.encodeBookToM4b(item.id);

    } catch (err: any) {
      this.deps.logger?.error(`Failed to trigger encode for ${item.name}`, { err });

      // Cleanup synchronously since it failed to start
      this.deps.db.removeEncodeQueueItem(item.id);
      this.deps.db.insertEncodeHistoryItem({
        libraryItemId: item.id,
        name: item.name,
        author: item.author,
        totalBytes: item.totalBytes,
        status: 'error',
        startedAt: Date.now(),
        detail: { message: err.message || String(err) },
      });

      this.deps.absSocketClient.unwatchItem(item.id);
      this.currentTaskId = null;
      this.emitUpdate();
    }
  }

  /** Current worker state — used by the status endpoint. */
  getStatus(): { isRunning: boolean; currentTaskId: string | null; queueLength: number } {
    const queue = this.deps.db.listEncodeQueue();
    return {
      isRunning: this.running,
      currentTaskId: this.currentTaskId,
      queueLength: queue.length,
    };
  }
}
