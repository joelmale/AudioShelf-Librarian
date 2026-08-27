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

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("discards missing duplicate inputs but preserves missing move failures", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-acquisition-reconcile-"));
    temporaryDirectories.push(directory);
    const inboxDir = path.join(directory, "inbox");
    fs.mkdirSync(inboxDir);
    const store = new IngestStore(path.join(directory, "curator.db"));

    const duplicateJobId = store.create(path.join(inboxDir, "Missing Duplicate"));
    store.addItem(duplicateJobId, action(path.join(inboxDir, "Missing Duplicate"), "duplicate"));
    const failedJobId = store.create(path.join(inboxDir, "Failed Move"));
    const failedItemId = store.addItem(failedJobId, action(path.join(inboxDir, "Failed Move"), "move"));
    store.transitionItem(failedItemId, "failed", "ABS resolution failed");

    await expect(discardMissingAcquisitionInputs(store, inboxDir)).resolves.toBe(1);
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
    const store = new IngestStore(path.join(directory, "curator.db"));
    const jobId = store.create(sourcePath);
    store.addItem(jobId, action(sourcePath, "duplicate"));

    await expect(discardMissingAcquisitionInputs(store, inboxDir)).resolves.toBe(0);
    expect(store.get(jobId)?.items[0].state).toBe("discovered");
    store.close();
  });
});
