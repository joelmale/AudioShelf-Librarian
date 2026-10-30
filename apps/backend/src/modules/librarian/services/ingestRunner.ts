import fs from "node:fs";
import path from "node:path";
import type { OrganizationAction } from "@audioshelf/shared";
import { errorMessage } from "@audioshelf/shared";
import type { IngestStore } from "../ingestStore.js";

/**
 * The one place an ingest item goes from "approved" to "in the library".
 *
 * Every entry point used to do this itself — the scan loop, the inbox poller,
 * commit, retry, and force-integrate — and each one got a different subset of
 * it right: auto-imports were never journaled, so they could not be rolled
 * back; a slow Audiobookshelf scan turned a completed move into a "failed"
 * item; and a throw before the first item was added left a job that blocked
 * its folder forever with nothing in the UI. Routing them all through here is
 * what keeps those fixes from drifting apart again.
 */

const MOVABLE_ACTIONS = new Set<OrganizationAction["action_type"]>(["move", "rename"]);

export function shouldAutoExecuteScanAction(
  actionType: OrganizationAction["action_type"],
  planOnly: boolean,
): boolean {
  return !planOnly && MOVABLE_ACTIONS.has(actionType);
}

/** The subset of HistoryStore the runner writes the rollback journal through. */
export interface ImportJournal {
  addBatch(actions: OrganizationAction[]): string;
  updateBatch(id: string, actions: OrganizationAction[]): void;
  removeBatch(id: string): void;
  getBatchActions(id: string): OrganizationAction[] | null;
}

export interface IngestRunnerDeps {
  ingestStore: IngestStore;
  executeAction: (action: OrganizationAction) => Promise<void>;
  journal: ImportJournal;
  /** Ask Audiobookshelf to pick up a moved book and record its item id. */
  resolveInAbs: (itemId: string, jobId: string, action: OrganizationAction) => Promise<void>;
}

export interface ImportEntry {
  action: OrganizationAction;
  itemId?: string;
  jobId?: string;
  /**
   * Retry only: a previous attempt may have moved the book and then failed on
   * the Audiobookshelf step. With the source gone and the target present,
   * treat it as moved instead of failing on the missing source forever.
   */
  recoverMoved?: boolean;
}

export interface ImportResult {
  action: OrganizationAction;
  moved: boolean;
  error?: string;
  /** Set when the move succeeded but Audiobookshelf did not list the book. */
  absWarning?: string;
}

export interface ImportOptions {
  /** Journal into this existing history batch instead of starting a new one. */
  appendToBatch?: string | null;
}

export interface InboxProcessDeps {
  /** Scan the path and decide what to do with it. */
  planAction: (inboxPath: string) => Promise<OrganizationAction>;
  /** A duplicate or conflict held for a human decision. */
  onHeld?: (action: OrganizationAction, itemName: string) => void;
  onImported?: (action: OrganizationAction, itemName: string) => void;
  onFailed?: (inboxPath: string, message: string) => void;
}

export class IngestRunner {
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly deps: IngestRunnerDeps) {}

  /**
   * Move each entry into the library, journaling the whole batch before the
   * first rename (the same contract realign follows), so a crash mid-batch
   * still leaves a rollback record for every move that may have happened.
   *
   * Entries that are not moves (held duplicates, errors) are reported as
   * failures without touching disk or their ingest item.
   */
  importActions(entries: ImportEntry[], options: ImportOptions = {}): Promise<{ results: ImportResult[]; batchId: string | null }> {
    const run = this.runBatch(entries, options);
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run)).catch(() => undefined);
    return run;
  }

  /** Wait for in-flight imports, bounded so shutdown cannot hang on one. */
  async drain(timeoutMs: number): Promise<boolean> {
    if (this.inFlight.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const settled = Promise.allSettled([...this.inFlight]).then(() => true as const);
    try {
      return await Promise.race([settled, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Handle one top-level inbox entry end to end. Whatever goes wrong, the job
   * ends up with an item a human can see and dismiss — a job with no items
   * used to stay "discovered" forever, which also hid the folder from every
   * later poll.
   */
  async processInbox(inboxPath: string, itemName: string, process: InboxProcessDeps): Promise<void> {
    const { ingestStore } = this.deps;
    const jobId = ingestStore.create(inboxPath, undefined, false);
    let itemId: string | undefined;
    try {
      const action = await process.planAction(inboxPath);
      itemId = ingestStore.addItem(jobId, action);
      if (!shouldAutoExecuteScanAction(action.action_type, false)) {
        process.onHeld?.(action, itemName);
        return;
      }
      const { results: [result] } = await this.importActions([{ action, itemId, jobId }]);
      if (result.error) throw new Error(result.error);
      process.onImported?.(action, itemName);
    } catch (error) {
      const message = errorMessage(error);
      if (!itemId) {
        itemId = ingestStore.addItem(jobId, placeholderAction(inboxPath, message));
        ingestStore.transitionItem(itemId, "failed", message);
      }
      process.onFailed?.(inboxPath, message);
    }
  }

  private async runBatch(entries: ImportEntry[], options: ImportOptions): Promise<{ results: ImportResult[]; batchId: string | null }> {
    const { ingestStore, journal } = this.deps;
    const results: ImportResult[] = [];
    const movable = entries.filter((entry) => MOVABLE_ACTIONS.has(entry.action.action_type));

    let batchId: string | null = null;
    let baseActions: OrganizationAction[] = [];
    if (movable.length > 0) {
      const pending = movable.map((entry) => ({ ...entry.action, executed: false, success: false }));
      const existing = options.appendToBatch ? journal.getBatchActions(options.appendToBatch) : null;
      if (options.appendToBatch && existing) {
        batchId = options.appendToBatch;
        baseActions = existing;
        journal.updateBatch(batchId, [...existing, ...pending]);
      } else {
        batchId = journal.addBatch(pending);
      }
    }

    const succeeded: OrganizationAction[] = [];
    for (const entry of entries) {
      const { action, itemId, jobId } = entry;
      if (!MOVABLE_ACTIONS.has(action.action_type)) {
        results.push({
          action,
          moved: false,
          error: action.action_type === "duplicate"
            ? "Held as a duplicate; use Import anyway to bring it in"
            : `Nothing to import for a "${action.action_type}" action`,
        });
        continue;
      }

      try {
        if (itemId) {
          ingestStore.transitionItem(itemId, "approved");
          ingestStore.transitionItem(itemId, "staging");
        }
        if (entry.recoverMoved && !fs.existsSync(action.source_path) && fs.existsSync(action.target_path)) {
          action.executed = true;
          action.success = true;
        } else {
          await this.deps.executeAction(action);
        }
        if (!action.success) throw new Error(action.error_message || "Action did not complete");
      } catch (error) {
        const message = errorMessage(error);
        if (itemId) {
          try { ingestStore.transitionItem(itemId, "failed", message); }
          catch (transitionError) { console.error(`[ingest] could not record failure for item ${itemId}:`, transitionError); }
        }
        results.push({ action, moved: false, error: message });
        continue;
      }

      succeeded.push(action);
      const result: ImportResult = { action, moved: true };
      if (itemId && jobId) {
        try {
          await this.deps.resolveInAbs(itemId, jobId, action);
        } catch (error) {
          // The book IS in the library. Audiobookshelf will list it on its own
          // next scan, so this is a note on a completed item, not a failure
          // that invites a retry of a move that already happened.
          result.absWarning = `Moved into the library, but Audiobookshelf has not listed it yet: ${errorMessage(error)}`;
          ingestStore.transitionItem(itemId, "complete", result.absWarning);
        }
      }
      results.push(result);
    }

    if (batchId) {
      const all = [...baseActions, ...succeeded];
      if (all.length > 0) journal.updateBatch(batchId, all);
      else journal.removeBatch(batchId);
      if (succeeded.length === 0 && baseActions.length === 0) batchId = null;
    }
    return { results, batchId };
  }
}

/** Stand-in action for an inbox entry that failed before it could be planned. */
export function placeholderAction(inboxPath: string, message: string): OrganizationAction {
  return {
    book: {
      title: path.basename(inboxPath),
      authors: ["Unknown Author"],
      source_path: inboxPath,
      audio_files: [],
      metadata_source: "filename",
      confidence_score: 0,
      is_series: false,
      needs_processing: true,
    },
    action_type: "error",
    source_path: inboxPath,
    target_path: inboxPath,
    reason: message,
    error_message: message,
    executed: false,
    success: false,
  };
}
