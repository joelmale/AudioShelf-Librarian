import fs from "fs";
import path from "path";
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

  private constructor() {
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
    this.historyPath = path.join(dataDir, "history.json");
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

  private saveHistory() {
    try {
      const dataDir = path.dirname(this.historyPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(this.historyPath, JSON.stringify(this.history, null, 2), "utf-8");
    } catch (e) {
      console.error("Error saving history:", e);
    }
  }

  public addBatch(actions: OrganizationAction[]): string {
    const batch: HistoryBatch = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      actions
    };
    
    // Prepend to keep latest first
    this.history.unshift(batch);
    
    // Keep only last 50 batches
    if (this.history.length > 50) {
      this.history = this.history.slice(0, 50);
    }
    
    this.saveHistory();
    return batch.id;
  }

  public getHistory(): HistoryBatch[] {
    return this.history;
  }

  public getLatestBatch(): HistoryBatch | null {
    return this.history.length > 0 ? this.history[0] : null;
  }

  public removeBatch(id: string) {
    this.history = this.history.filter(b => b.id !== id);
    this.saveHistory();
  }
}
