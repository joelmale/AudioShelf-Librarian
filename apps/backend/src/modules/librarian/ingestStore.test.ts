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
});
