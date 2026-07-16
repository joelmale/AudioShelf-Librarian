import cron, { type ScheduledTask } from "node-cron";
import fs from "fs";
import path from "path";
import { SettingsStore } from "../../../config/settings.js";
import type { IngestStore } from "../ingestStore.js";

type ProcessCallback = (inboxPath: string, itemName: string) => Promise<void> | void;

export class InboxPollerService {
  private readonly task: ScheduledTask;
  private running = false;

  constructor(
    private readonly ingestStore: IngestStore,
    private readonly onDiscovered: ProcessCallback
  ) {
    this.task = cron.schedule("*/5 * * * *", () => void this.poll().catch(console.error));
    // Run immediately on startup
    setImmediate(() => void this.poll().catch((error) =>
      console.error("Initial Inbox poll failed:", error)));
  }

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const inboxDir = SettingsStore.getInstance().getSettings().inboxDir;
      if (!inboxDir || !fs.existsSync(inboxDir)) return;

      const entries = await fs.promises.readdir(inboxDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue; // Skip hidden and temp files
        
        const fullPath = path.resolve(inboxDir, entry.name);
        
        // If an active job already exists for this directory/file, skip it.
        // It's either currently processing, or it's holding for user input.
        if (this.ingestStore.hasActiveJobForTarget(fullPath)) continue;

        // Found an untracked item! Trigger the auto-acquisition pipeline.
        await this.onDiscovered(fullPath, entry.name);
      }
    } catch (error) {
      console.error("Error polling inbox directory:", error);
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.task.stop();
  }
}
