import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OrganizationAction } from "@audioshelf/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IngestStore } from "../ingestStore.js";
import { InboxPollerService } from "./inboxPoller.js";

const MINUTE = 60_000;

function heldDuplicate(source: string): OrganizationAction {
  return {
    book: { title: "Book", authors: ["Author"], source_path: source, audio_files: [], metadata_source: "filename", confidence_score: 1, is_series: false, needs_processing: true },
    action_type: "duplicate",
    source_path: source,
    target_path: "/library/Author/Book",
    reason: "Duplicate detected",
    executed: false,
    success: false,
  };
}

describe("InboxPollerService", () => {
  let dir: string;
  let inbox: string;
  let store: IngestStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-poller-"));
    inbox = path.join(dir, "inbox");
    fs.mkdirSync(path.join(inbox, "Book"), { recursive: true });
    fs.writeFileSync(path.join(inbox, "Book", "track.mp3"), "audio");
    store = new IngestStore(path.join(dir, "curator.db"));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const poller = (onDiscovered: (p: string) => void, now: () => number) =>
    new InboxPollerService(store, onDiscovered, { getInboxDir: () => inbox, now, schedule: false });

  it("waits for a folder that is still being written", async () => {
    const discovered = vi.fn();
    await poller(discovered, () => Date.now()).poll();
    expect(discovered).not.toHaveBeenCalled();

    await poller(discovered, () => Date.now() + 3 * MINUTE).poll();
    expect(discovered).toHaveBeenCalledWith(path.join(inbox, "Book"), "Book");
  });

  it("does not bring back an item that was dismissed", async () => {
    const bookPath = path.join(inbox, "Book");
    const jobId = store.create(bookPath);
    const itemId = store.addItem(jobId, heldDuplicate(bookPath));
    expect(store.discardItem(itemId)).toBe(true);
    expect(store.hasActiveJobForTarget(bookPath)).toBe(false);

    const discovered = vi.fn();
    await poller(discovered, () => Date.now() + 10 * MINUTE).poll();
    expect(discovered).not.toHaveBeenCalled();
  });

  it("picks a dismissed folder up again once something new lands in it", async () => {
    const bookPath = path.join(inbox, "Book");
    const jobId = store.create(bookPath);
    store.discardItem(store.addItem(jobId, heldDuplicate(bookPath)));

    const later = new Date(Date.now() + 60_000);
    fs.writeFileSync(path.join(bookPath, "track2.mp3"), "more audio");
    fs.utimesSync(path.join(bookPath, "track2.mp3"), later, later);

    const discovered = vi.fn();
    await poller(discovered, () => later.getTime() + 10 * MINUTE).poll();
    expect(discovered).toHaveBeenCalledWith(bookPath, "Book");
  });

  it("ignores in-progress copies", async () => {
    fs.rmSync(path.join(inbox, "Book"), { recursive: true });
    fs.mkdirSync(path.join(inbox, ".asl-incoming-123"));
    const discovered = vi.fn();
    await poller(discovered, () => Date.now() + 10 * MINUTE).poll();
    expect(discovered).not.toHaveBeenCalled();
  });
  it("stays out of the way while a manual scan is running", async () => {
    const discovered = vi.fn();
    let scanning = true;
    const paused = new InboxPollerService(store, discovered, {
      getInboxDir: () => inbox, now: () => Date.now() + 10 * MINUTE, schedule: false, isPaused: () => scanning,
    });
    await paused.poll();
    expect(discovered).not.toHaveBeenCalled();

    scanning = false;
    await paused.poll();
    expect(discovered).toHaveBeenCalledOnce();
  });
});
