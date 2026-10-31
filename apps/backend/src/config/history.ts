import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { OrganizationAction } from "@audioshelf/shared";

export interface HistoryBatch {
  id: string;
  timestamp: string;
  actions: OrganizationAction[];
}

/** Always keep at least this many batches, however old. */
const MIN_BATCHES = 50;
/** Keep everything newer than this, so a busy week cannot push out an undo. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard ceiling so the journal file cannot grow without bound. */
const MAX_BATCHES = 500;

/** Newest-first list trimmed by age, never below MIN_BATCHES or above MAX_BATCHES. */
export function pruneHistory(history: HistoryBatch[], now = Date.now()): HistoryBatch[] {
  return history
    .filter((batch, index) => {
      if (index >= MAX_BATCHES) return false;
      if (index < MIN_BATCHES) return true;
      const age = now - new Date(batch.timestamp).getTime();
      return !(age > MAX_AGE_MS);
    });
}

export class HistoryStore {
  private static instance: HistoryStore;
  private readonly historyPath: string;
  private history: HistoryBatch[];
  private readonly createId: () => string;
  /** Set when an unreadable journal could not be moved aside; writes would destroy it. */
  private blockedReason: string | null = null;

  public constructor(dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data"), createId: () => string = randomUUID) {
    this.historyPath = path.join(dataDir, "history.json");
    this.createId = createId;
    this.history = this.loadHistory();
  }

  public static getInstance(): HistoryStore {
    if (!HistoryStore.instance) {
      HistoryStore.instance = new HistoryStore();
    }
    return HistoryStore.instance;
  }

  private loadHistory(): HistoryBatch[] {
    if (!fs.existsSync(this.historyPath)) return [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.historyPath, "utf-8"));
      if (Array.isArray(parsed)) return parsed as HistoryBatch[];
      throw new Error("history is not an array");
    } catch (e) {
      // Starting empty would let the next commit atomically overwrite the only
      // rollback record. Move the unreadable file aside so it can be recovered.
      const quarantine = `${this.historyPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        fs.renameSync(this.historyPath, quarantine);
        console.error(`Rollback history at ${this.historyPath} could not be read and was moved to ${quarantine}:`, e);
      } catch (renameError) {
        this.blockedReason = `Rollback history at ${this.historyPath} is unreadable and could not be moved aside; refusing to overwrite it`;
        console.error(this.blockedReason, e, renameError);
      }
    }
    return [];
  }

  private saveHistory(history: HistoryBatch[]) {
    if (this.blockedReason) throw new Error(this.blockedReason);
    const dataDir = path.dirname(this.historyPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const temporary = path.join(dataDir, `.history.${process.pid}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(history, null, 2), "utf-8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      // Same-directory rename is the commit point: the prior valid journal is
      // never truncated in place.
      fs.renameSync(temporary, this.historyPath);
    } finally {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* preserve original error */ }
      try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
    }
  }

  public addBatch(actions: OrganizationAction[]): string {
    const batch: HistoryBatch = {
      id: this.createId(),
      timestamp: new Date().toISOString(),
      actions
    };
    
    // Prepend to keep latest first
    const next = pruneHistory([batch, ...this.history]);
    this.saveHistory(next);
    this.history = next;
    return batch.id;
  }

  public updateBatch(id: string, actions: OrganizationAction[]): void {
    const index = this.history.findIndex((batch) => batch.id === id);
    if (index < 0) throw new Error(`History batch ${id} was not found`);
    const next = this.history.map((batch) => batch.id === id ? { ...batch, actions } : batch);
    this.saveHistory(next);
    this.history = next;
  }

  public getHistory(): HistoryBatch[] {
    return this.history;
  }

  public getBatchActions(id: string): OrganizationAction[] | null {
    return this.history.find((batch) => batch.id === id)?.actions ?? null;
  }

  public getLatestBatch(): HistoryBatch | null {
    return this.history.length > 0 ? this.history[0] : null;
  }

  public removeBatch(id: string) {
    const next = this.history.filter(b => b.id !== id);
    this.saveHistory(next);
    this.history = next;
  }
}
