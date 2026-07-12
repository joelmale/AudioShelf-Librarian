import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
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
});
