import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { OrganizationAction } from "@audioshelf/shared";

export interface HistoryBatch {
  id: string;
  timestamp: string;
  actions: OrganizationAction[];
}

export class HistoryStore {
  private static instance: HistoryStore;
  private readonly historyPath: string;
  private history: HistoryBatch[];
  private readonly createId: () => string;

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
    try {
      if (fs.existsSync(this.historyPath)) {
        const raw = fs.readFileSync(this.historyPath, "utf-8");
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error("Error loading history:", e);
    }
    return [];
  }

  private saveHistory(history: HistoryBatch[]) {
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
    const next = [batch, ...this.history].slice(0, 50);
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

  public getLatestBatch(): HistoryBatch | null {
    return this.history.length > 0 ? this.history[0] : null;
  }

  public removeBatch(id: string) {
    const next = this.history.filter(b => b.id !== id);
    this.saveHistory(next);
    this.history = next;
  }
}
