/**
 * Pause / resume / cancel control for long-running AI operations (tagging,
 * collection generation). Lets a user stop a run they started by accident
 * without corrupting already-persisted work.
 *
 * Model: the operation function calls `await controller.checkpoint()` between
 * units of work (e.g. before tagging each book). checkpoint:
 *   - resolves immediately while running,
 *   - blocks while paused (until resume or cancel),
 *   - throws OperationCancelledError once cancelled.
 *
 * Cancellation is cooperative: in-flight units finish, but no new unit starts.
 * Node is single-threaded, so all state transitions between awaits are atomic —
 * pause/cancel from a route handler can't interleave mid-mutation with a worker.
 */
import { OperationCancelledError } from './errors.js';
import type { OperationError, ProgressUpdate, SyncOperation } from './types.js';

export type OperationStatus =
  | 'running'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'error';

export interface OperationSnapshot {
  id: string;
  type: SyncOperation;
  status: OperationStatus;
  progress: ProgressUpdate;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  summary: unknown | null;
  error: OperationError | null;
}

const TERMINAL: ReadonlySet<OperationStatus> = new Set(['cancelled', 'completed', 'error']);

export class OperationController {
  readonly id: string;
  readonly type: SyncOperation;
  readonly createdAt: number;

  private _status: OperationStatus = 'running';
  private _progress: ProgressUpdate;
  private _updatedAt: number;
  private _finishedAt: number | null = null;
  private _summary: unknown = null;
  private _error: OperationError | null = null;
  private pauseWaiters: Array<() => void> = [];
  private readonly now: () => number;

  constructor(id: string, type: SyncOperation, now: () => number = Date.now) {
    this.id = id;
    this.type = type;
    this.now = now;
    this.createdAt = now();
    this._updatedAt = this.createdAt;
    this._progress = { phase: type, current: 0, total: 0 };
  }

  get status(): OperationStatus {
    return this._status;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  private isCancelRequested(): boolean {
    return this._status === 'cancelling' || this._status === 'cancelled';
  }

  setProgress(progress: ProgressUpdate): void {
    this._progress = progress;
    this._updatedAt = this.now();
  }

  /** Cooperative checkpoint — call between units of work. */
  async checkpoint(): Promise<void> {
    if (this.isCancelRequested()) throw new OperationCancelledError(this.id);
    if (this._status === 'paused') {
      await new Promise<void>((resolve) => this.pauseWaiters.push(resolve));
      // Woken by resume() or cancel(); re-evaluate.
      if (this.isCancelRequested()) throw new OperationCancelledError(this.id);
    }
  }

  pause(): boolean {
    if (this._status !== 'running') return false;
    this._status = 'paused';
    this._updatedAt = this.now();
    return true;
  }

  resume(): boolean {
    if (this._status !== 'paused') return false;
    this._status = 'running';
    this._updatedAt = this.now();
    this.flushWaiters();
    return true;
  }

  /** Request cancellation. Wakes any paused checkpoints so they can throw. */
  cancel(): boolean {
    if (this.isTerminal() || this._status === 'cancelling') return false;
    this._status = 'cancelling';
    this._updatedAt = this.now();
    this.flushWaiters();
    return true;
  }

  /** Called by the operation runner after it observes the cancellation. */
  markCancelled(summary?: unknown): void {
    if (this.isTerminal()) return;
    this._status = 'cancelled';
    this._summary = summary ?? null;
    this._finishedAt = this.now();
    this._updatedAt = this._finishedAt;
    this.flushWaiters();
  }

  markCompleted(summary?: unknown): void {
    if (this.isTerminal()) return;
    this._status = 'completed';
    this._summary = summary ?? null;
    this._finishedAt = this.now();
    this._updatedAt = this._finishedAt;
    this.flushWaiters();
  }

  markError(error: OperationError, summary?: unknown): void {
    if (this.isTerminal()) return;
    this._status = 'error';
    this._error = error;
    this._summary = summary ?? null;
    this._finishedAt = this.now();
    this._updatedAt = this._finishedAt;
    this.flushWaiters();
  }

  snapshot(): OperationSnapshot {
    return {
      id: this.id,
      type: this.type,
      status: this._status,
      progress: this._progress,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
      finishedAt: this._finishedAt,
      summary: this._summary,
      error: this._error,
    };
  }

  private flushWaiters(): void {
    const waiters = this.pauseWaiters;
    this.pauseWaiters = [];
    for (const w of waiters) w();
  }
}

/**
 * Registry of operations. The API/MCP layers look operations up by id to
 * pause/resume/cancel and to report status.
 */
export class OperationRegistry {
  private readonly ops = new Map<string, OperationController>();
  private seq = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  create(type: SyncOperation): OperationController {
    this.seq += 1;
    const id = `${type}_${this.now().toString(36)}_${this.seq.toString(36)}`;
    const controller = new OperationController(id, type, this.now);
    this.ops.set(id, controller);
    return controller;
  }

  get(id: string): OperationController | undefined {
    return this.ops.get(id);
  }

  list(): OperationSnapshot[] {
    return [...this.ops.values()].map((o) => o.snapshot()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Drop terminal operations finished more than `maxAgeMs` ago. */
  prune(maxAgeMs: number): void {
    const cutoff = this.now() - maxAgeMs;
    for (const [id, op] of this.ops) {
      const snap = op.snapshot();
      if (op.isTerminal() && snap.finishedAt !== null && snap.finishedAt < cutoff) {
        this.ops.delete(id);
      }
    }
  }
}
