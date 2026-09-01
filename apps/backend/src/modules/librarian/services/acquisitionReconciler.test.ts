import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OrganizationAction } from "@audioshelf/shared";
import { afterEach, describe, expect, it } from "vitest";
import { IngestStore } from "../ingestStore.js";
import { discardMissingAcquisitionInputs } from "./acquisitionReconciler.js";

function action(sourcePath: string, actionType: OrganizationAction["action_type"]): OrganizationAction {
  return {
    action_type: actionType,
    source_path: sourcePath,
    target_path: `${sourcePath}-target`,
    reason: "Review needed",
    executed: false,
    success: false,
    book: { title: path.basename(sourcePath) },
  } as OrganizationAction;
}

describe("acquisition input reconciliation", () => {
  const temporaryDirectories: string[] = [];
  const stores: IngestStore[] = [];

  /** Open the store AND register it for close — Windows will not remove a
   *  directory while SQLite still holds the database file open. */
  function openStore(dbPath: string): IngestStore {
    const store = new IngestStore(dbPath);
    stores.push(store);
    return store;
  }

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("discards missing duplicate inputs but preserves missing move failures", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-acquisition-reconcile-"));
    temporaryDirectories.push(directory);
    const inboxDir = path.join(directory, "inbox");
    fs.mkdirSync(inboxDir);
    const store = openStore(path.join(directory, "curator.db"));

    const duplicateJobId = store.create(path.join(inboxDir, "Missing Duplicate"));
    store.addItem(duplicateJobId, action(path.join(inboxDir, "Missing Duplicate"), "duplicate"));
    const failedJobId = store.create(path.join(inboxDir, "Failed Move"));
    const failedItemId = store.addItem(failedJobId, action(path.join(inboxDir, "Failed Move"), "move"));
    store.transitionItem(failedItemId, "failed", "ABS resolution failed");

    await expect(discardMissingAcquisitionInputs(store, inboxDir)).resolves.toMatchObject({ discarded: 1 });
    expect(store.get(duplicateJobId)?.items[0].state).toBe("discarded");
    expect(store.get(failedJobId)?.items[0]).toMatchObject({ state: "failed", error: "ABS resolution failed" });
    store.close();
  });

  it("does not discard a pending duplicate that still exists", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-acquisition-existing-"));
    temporaryDirectories.push(directory);
    const inboxDir = path.join(directory, "inbox");
    const sourcePath = path.join(inboxDir, "Existing Duplicate");
    fs.mkdirSync(sourcePath, { recursive: true });
    const store = openStore(path.join(directory, "curator.db"));
    const jobId = store.create(sourcePath);
    store.addItem(jobId, action(sourcePath, "duplicate"));

    await expect(discardMissingAcquisitionInputs(store, inboxDir)).resolves.toMatchObject({ discarded: 0, keptExisting: 1 });
    expect(store.get(jobId)?.items[0].state).toBe("discovered");
    store.close();
  });

  it("discards NOTHING when the inbox root itself is missing", async () => {
    // The inbox is a network mount on a real deployment. When it drops, every
    // path under it stops existing at once — and reading that as "every
    // pending acquisition was deleted" would sweep away decisions the user has
    // not made yet, because of a transient blip. A missing root is never
    // evidence about the files under it.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-acquisition-mount-"));
    temporaryDirectories.push(directory);
    const inboxDir = path.join(directory, "inbox");
    fs.mkdirSync(inboxDir);
    const store = openStore(path.join(directory, "curator.db"));

    const jobId = store.create(path.join(inboxDir, "Pending Duplicate"));
    store.addItem(jobId, action(path.join(inboxDir, "Pending Duplicate"), "duplicate"));

    // The mount goes away, taking the item's source path with it.
    fs.rmSync(inboxDir, { recursive: true, force: true });

    await expect(discardMissingAcquisitionInputs(store, inboxDir))
      .resolves.toMatchObject({ rootMissing: true, discarded: 0 });
    expect(store.get(jobId)?.items[0].state).toBe("discovered");
  });

  it("refuses when the root exists but is not a directory", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-acquisition-file-root-"));
    temporaryDirectories.push(directory);
    const inboxDir = path.join(directory, "inbox");
    fs.writeFileSync(inboxDir, "not a directory");
    const store = openStore(path.join(directory, "curator.db"));

    const jobId = store.create(path.join(inboxDir, "Pending Duplicate"));
    store.addItem(jobId, action(path.join(inboxDir, "Pending Duplicate"), "duplicate"));

    await expect(discardMissingAcquisitionInputs(store, inboxDir))
      .resolves.toMatchObject({ rootMissing: true, discarded: 0 });
    expect(store.get(jobId)?.items[0].state).toBe("discovered");
  });

  it("reports an item it cannot reason about instead of silently ignoring it", async () => {
    // A source outside the configured inbox is exactly the shape of a stuck
    // "Requires input" row: the pass can prove nothing, so it must leave the
    // item alone AND say that it did.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-acquisition-outside-"));
    temporaryDirectories.push(directory);
    const inboxDir = path.join(directory, "inbox");
    const elsewhere = path.join(directory, "downloads");
    fs.mkdirSync(inboxDir);
    fs.mkdirSync(elsewhere);
    const store = openStore(path.join(directory, "curator.db"));

    const jobId = store.create(path.join(elsewhere, "Red Rising"));
    store.addItem(jobId, action(path.join(elsewhere, "Red Rising"), "duplicate"));

    await expect(discardMissingAcquisitionInputs(store, inboxDir))
      .resolves.toMatchObject({ discarded: 0, skippedOutsideInbox: 1 });
    expect(store.get(jobId)?.items[0].state).toBe("discovered");
  });
});
