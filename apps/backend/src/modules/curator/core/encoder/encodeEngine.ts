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

export class EncodeQueueWorker {
  private running = false;
  private currentTaskId: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private deps: EncodeEngineDeps) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.deps.logger?.info('EncodeQueueWorker started');
    this.scheduleNextTick();
  }

  stop() {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
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

  remove(id: string) {
    if (this.currentTaskId === id) {
      // Cannot remove currently running directly from queue cleanly without aborting ABS
      // For now just ignore or handle gracefully
      return;
    }
    this.deps.db.removeEncodeQueueItem(id);
    this.emitUpdate();
  }

  private async tick() {
    try {
      if (this.currentTaskId) {
        // Checking if the operation finished
        const op = this.deps.operations?.get(this.currentTaskId);
        if (op && op.isTerminal()) {
          const snap = op.snapshot();
          
          // The item is finished, handle cleanup
          const item = this.deps.db.listEncodeQueue().find((q: any) => q.id === this.currentTaskId);
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
}
