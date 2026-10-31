import cron, { type ScheduledTask } from "node-cron";
import fs from "fs";
import path from "path";
import { SettingsStore } from "../../../config/settings.js";
import type { IngestStore } from "../ingestStore.js";

type ProcessCallback = (inboxPath: string, itemName: string) => Promise<void> | void;

/**
 * How long an inbox entry must go unmodified before it is imported. A folder
 * copied in over SMB, or by any tool that writes in place, is visible long
 * before it is complete; importing it mid-copy splits the book in two.
 */
export const INBOX_QUIET_PERIOD_MS = 2 * 60_000;

/** Deep enough for `Series/Book/Disc 1/track.mp3`. */
const MAX_MTIME_DEPTH = 4;

export interface InboxPollerOptions {
  getInboxDir?: () => string | undefined;
  quietPeriodMs?: number;
  now?: () => number;
  /**
   * Skip a pass while this returns true. A manual scan tracks its job against
   * the inbox root, so the per-folder active-job check cannot see it and both
   * would pick up the same book.
   */
  isPaused?: () => boolean;
  /** Tests drive poll() directly. */
  schedule?: boolean;
}

/** Newest modification time anywhere under `target`, bounded in depth. */
export async function newestMtime(target: string, depth = 0): Promise<number> {
  const stat = await fs.promises.lstat(target);
  let newest = stat.mtimeMs;
  if (!stat.isDirectory() || depth >= MAX_MTIME_DEPTH) return newest;
  for (const entry of await fs.promises.readdir(target)) {
    try {
      newest = Math.max(newest, await newestMtime(path.join(target, entry), depth + 1));
    } catch {
      // Removed mid-walk: the entry is changing, which the parent's mtime shows.
    }
  }
  return newest;
}

export class InboxPollerService {
  private readonly task: ScheduledTask | null;
  private running = false;
  private readonly getInboxDir: () => string | undefined;
  private readonly quietPeriodMs: number;
  private readonly now: () => number;
  private readonly isPaused: () => boolean;

  constructor(
    private readonly ingestStore: IngestStore,
    private readonly onDiscovered: ProcessCallback,
    options: InboxPollerOptions = {},
  ) {
    this.getInboxDir = options.getInboxDir ?? (() => SettingsStore.getInstance().getSettings().inboxDir);
    this.quietPeriodMs = options.quietPeriodMs ?? INBOX_QUIET_PERIOD_MS;
    this.now = options.now ?? Date.now;
    this.isPaused = options.isPaused ?? (() => false);
    if (options.schedule === false) {
      this.task = null;
      return;
    }
    this.task = cron.schedule("*/5 * * * *", () => void this.poll().catch(console.error));
    // Run immediately on startup, unless in test where it interferes with isolated test fixtures
    if (process.env.NODE_ENV !== "test") {
      setImmediate(() => void this.poll().catch((error) =>
        console.error("Initial Inbox poll failed:", error)));
    }
  }

  async poll(): Promise<void> {
    if (this.running || this.isPaused()) return;
    this.running = true;
    try {
      const inboxDir = this.getInboxDir();
      if (!inboxDir || !fs.existsSync(inboxDir)) return;

      const entries = await fs.promises.readdir(inboxDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue; // Skip hidden and temp files

        const fullPath = path.resolve(inboxDir, entry.name);

        // If an active job already exists for this directory/file, skip it.
        // It's either currently processing, or it's holding for user input.
        if (this.ingestStore.hasActiveJobForTarget(fullPath)) continue;

        let modified: number;
        try {
          modified = await newestMtime(fullPath);
        } catch {
          continue; // Gone between readdir and stat.
        }
        // Still being written: try again on a later pass.
        if (this.now() - modified < this.quietPeriodMs) continue;
        // Dismissed, and nothing in it has changed since. A new file landing in
        // the folder moves its mtime past the dismissal and brings it back.
        const dismissedAt = this.ingestStore.lastDismissedAt(fullPath);
        if (dismissedAt !== null && modified <= dismissedAt) continue;

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
    this.task?.stop();
  }
}
