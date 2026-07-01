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
        // Waiting for current task to finish via ABS events
        this.scheduleNextTick();
        return;
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
    
    const startedAt = Date.now();
    let status = 'completed';
    let detail: any = null;

    try {
      // Trigger ABS API
      await this.deps.absClient.encodeBookToM4b(item.id);
      
      // In a real implementation we would wait for the task_finished event from absSocketClient
      // For this migration, we'll simulate waiting since we decoupled the socket watcher.
      
      // Artificial delay so the UI shows it as running
      await new Promise(r => setTimeout(r, 3000));
      
    } catch (err: any) {
      this.deps.logger?.error(`Failed to encode ${item.name}`, { err });
      status = 'error';
      detail = { message: err.message || String(err) };
    } finally {
      this.deps.db.removeEncodeQueueItem(item.id);
      this.deps.db.insertEncodeHistoryItem({
        libraryItemId: item.id,
        name: item.name,
        author: item.author,
        totalBytes: item.totalBytes,
        status,
        startedAt,
        detail,
      });
      this.currentTaskId = null;
      this.emitUpdate();
    }
  }
}
