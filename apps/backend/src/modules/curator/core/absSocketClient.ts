import { io, Socket } from 'socket.io-client';
import type { Logger } from './logger.js';
import { nullLogger } from './logger.js';
import type { OperationController } from './operations.js';

export interface AbsSocketClientOptions {
  absUrl: string;
  token: string;
  logger?: Logger;
}

export class AbsSocketClient {
  private socket: Socket;
  private logger: Logger;
  private activeOperations: Map<string, OperationController> = new Map();

  constructor(options: AbsSocketClientOptions) {
    this.logger = options.logger ?? nullLogger;
    
    // Connect to Audiobookshelf socket
    this.socket = io(options.absUrl, {
      auth: { token: options.token },
      transports: ['websocket', 'polling']
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

    // Listen to generic item events from ABS
    this.socket.on('item_updated', (data) => {
      this.logger.debug('ABS item_updated event', { data });
    });

    // ABS typically emits task-related events for background jobs
    this.socket.on('task_update', (task) => {
      this.logger.debug('ABS task_update', { task });
      if (task && task.data && task.data.libraryItemId) {
        const itemId = task.data.libraryItemId;
        const op = this.activeOperations.get(itemId);
        if (op) {
          op.setProgress({
            phase: 'encode',
            current: task.progress || 0,
            total: 100,
            message: `Encoding... ${task.progress}%`
          });
        }
      }
    });
    
    this.socket.on('task_finished', (task) => {
       if (task && task.data && task.data.libraryItemId) {
        const itemId = task.data.libraryItemId;
        const op = this.activeOperations.get(itemId);
        if (op) {
           op.setProgress({
            phase: 'encode',
            current: 100,
            total: 100,
            message: `Finished`
          });
          op.markCompleted(task);
        }
      }
    });

    this.socket.on('task_failed', (task) => {
       if (task && task.data && task.data.libraryItemId) {
        const itemId = task.data.libraryItemId;
        const op = this.activeOperations.get(itemId);
        if (op) {
          op.markError({ code: 'ABS_TASK_FAILED', message: task.error || 'ABS Task Failed' }, task);
        }
      }
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

  close(): void {
    this.socket.close();
  }
}
