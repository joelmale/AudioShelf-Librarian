import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { OrganizationAction } from "@audioshelf/shared";
import { afterEach, describe, expect, it } from "vitest";
import { IngestStore } from "./ingestStore.js";

describe("ingest job safety persistence", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates existing databases and keeps plan-only jobs locked across reopen", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-ingest-migration-"));
    temporaryDirectories.push(directory);
    const dbPath = path.join(directory, "curator.db");
    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE ingest_jobs(id TEXT PRIMARY KEY,state TEXT NOT NULL,target_dir TEXT NOT NULL,library_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
    legacy.close();

    const first = new IngestStore(dbPath);
    const jobId = first.create("/controlled/inbox", undefined, true);
    expect(first.get(jobId)?.planOnly).toBe(true);
    first.close();

    const reopened = new IngestStore(dbPath);
    expect(reopened.get(jobId)?.planOnly).toBe(true);
    reopened.close();
  });

  it("persists a discarded review item and completes its job", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-ingest-discard-"));
    temporaryDirectories.push(directory);
    const dbPath = path.join(directory, "curator.db");
    const sourcePath = path.join(directory, "inbox", "Duplicate Book");
    const action = {
      action_type: "duplicate",
      source_path: sourcePath,
      target_path: path.join(directory, "library", "Duplicate Book"),
      reason: "Already in library",
      executed: false,
      success: false,
      book: { title: "Duplicate Book" },
    } as OrganizationAction;

    const store = new IngestStore(dbPath);
    const jobId = store.create(sourcePath);
    store.addItem(jobId, action);

    expect(store.discardPendingItemsBySourcePath(sourcePath)).toBe(1);
    expect(store.get(jobId)).toMatchObject({
      state: "complete",
      items: [{ state: "discarded", error: null }],
    });
    expect(store.pendingReviewItems()).toEqual([]);
    store.close();
  });

  it("notifies listeners when an item is added or discarded, not only on transitions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-ingest-notify-"));
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, "inbox", "Held Book");
    const action = {
      action_type: "duplicate",
      source_path: sourcePath,
      target_path: path.join(directory, "library", "Held Book"),
      reason: "Already in library",
      executed: false,
      success: false,
      book: { title: "Held Book" },
    } as OrganizationAction;

    const store = new IngestStore(path.join(directory, "curator.db"));
    const seen: string[] = [];
    store.onItemUpdated((item) => seen.push(item.state));

    const jobId = store.create(sourcePath);
    const itemId = store.addItem(jobId, action);
    expect(seen).toEqual(["discovered"]);

    expect(store.discardItem(itemId)).toBe(true);
    expect(seen).toEqual(["discovered", "discarded"]);

    // A failed discard (already resolved) must not emit a phantom event.
    expect(store.discardItem(itemId)).toBe(false);
    expect(seen).toHaveLength(2);
    store.close();
  });

  it("notifies once per item when discarding by source path, and survives a throwing listener", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-ingest-notify-path-"));
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, "inbox", "Held Book");
    const action = {
      action_type: "duplicate",
      source_path: sourcePath,
      target_path: path.join(directory, "library", "Held Book"),
      reason: "Already in library",
      executed: false,
      success: false,
      book: { title: "Held Book" },
    } as OrganizationAction;

    const store = new IngestStore(path.join(directory, "curator.db"));
    const jobId = store.create(sourcePath);
    store.addItem(jobId, action);

    const seen: string[] = [];
    store.onItemUpdated(() => { throw new Error("listener bug"); });
    store.onItemUpdated((item) => seen.push(item.state));

    expect(store.discardPendingItemsBySourcePath(sourcePath)).toBe(1);
    expect(seen).toEqual(["discarded"]);
    expect(store.get(jobId)?.items[0].state).toBe("discarded");
    store.close();
  });
  it("does not fail in-flight transfers when a second store opens with recovery off", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-ingest-recover-"));
    temporaryDirectories.push(directory);
    const dbPath = path.join(directory, "curator.db");
    const action = {
      action_type: "move", source_path: path.join(directory, "inbox", "Book"), target_path: path.join(directory, "library", "Book"),
      reason: "", executed: false, success: false, book: { title: "Book" },
    } as OrganizationAction;
    const owner = new IngestStore(dbPath);
    const jobId = owner.create(action.source_path);
    const itemId = owner.addItem(jobId, action);
    owner.transitionItem(itemId, "staging");

    const reader = new IngestStore(dbPath, { recoverInterrupted: false });
    expect(reader.getItem(itemId)?.state).toBe("staging");
    reader.close();

    const restarted = new IngestStore(dbPath);
    expect(restarted.getItem(itemId)?.state).toBe("failed");
    restarted.close();
    owner.close();
  });

  it("dismisses a completed item by source path so a restored folder is not re-imported", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-ingest-undo-"));
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, "inbox", "Undone Book");
    const action = {
      action_type: "move", source_path: sourcePath, target_path: path.join(directory, "library", "Undone Book"),
      reason: "", executed: false, success: false, book: { title: "Undone Book" },
    } as OrganizationAction;
    const store = new IngestStore(path.join(directory, "curator.db"));
    const jobId = store.create(sourcePath);
    const itemId = store.addItem(jobId, action);
    store.transitionItem(itemId, "complete");

    expect(store.lastDismissedAt(sourcePath)).toBeNull();
    expect(store.discardItemsBySourcePath(sourcePath)).toBe(1);
    expect(store.getItem(itemId)?.state).toBe("discarded");
    expect(store.lastDismissedAt(sourcePath)).not.toBeNull();
    store.close();
  });
});
