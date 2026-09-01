import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OrganizationAction } from "@audioshelf/shared";
import { afterEach, describe, expect, it } from "vitest";
import { IngestStore } from "../ingestStore.js";
import { discardMissingAcquisitionInputs, hasImportableMedia } from "./acquisitionReconciler.js";

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
    // Real audio, not an empty folder: an emptied folder is a LEFTOVER now
    // and is discarded on purpose, so an empty fixture would no longer be
    // testing "a genuine pending duplicate is left alone".
    fs.writeFileSync(path.join(sourcePath, "book.m4b"), "audio");
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

  it("discards a leftover folder that still exists but holds no importable media", async () => {
    // The live case: a "Red Rising [1-5]" folder emptied down to a single
    // .txt, holding a duplicate decision open over a folder with no audiobook
    // in it. The path exists, so the missing-file check passes it through.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-acquisition-leftover-"));
    temporaryDirectories.push(directory);
    const inboxDir = path.join(directory, "inbox");
    const leftover = path.join(inboxDir, "Pierce Brown-Red Rising-[1-5]");
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, "readme.txt"), "nothing to import");
    const store = openStore(path.join(directory, "curator.db"));

    const jobId = store.create(leftover);
    store.addItem(jobId, action(leftover, "duplicate"));

    const result = await discardMissingAcquisitionInputs(store, inboxDir);

    expect(result).toMatchObject({ discardedEmpty: 1, discarded: 0, keptExisting: 0 });
    expect(result.emptyFolders).toEqual([leftover]);
    expect(store.get(jobId)?.items[0].state).toBe("discarded");
    // The row is resolved; the folder is left on disk for a human to remove.
    expect(fs.existsSync(leftover)).toBe(true);
  });

  it("keeps a folder that still holds audio, however deeply nested", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-acquisition-nested-"));
    temporaryDirectories.push(directory);
    const inboxDir = path.join(directory, "inbox");
    const book = path.join(inboxDir, "Some Book");
    fs.mkdirSync(path.join(book, "Disc 1"), { recursive: true });
    fs.writeFileSync(path.join(book, "Disc 1", "track01.mp3"), "audio");
    const store = openStore(path.join(directory, "curator.db"));

    const jobId = store.create(book);
    store.addItem(jobId, action(book, "duplicate"));

    const result = await discardMissingAcquisitionInputs(store, inboxDir);

    expect(result).toMatchObject({ keptExisting: 1, discardedEmpty: 0 });
    expect(store.get(jobId)?.items[0].state).toBe("discovered");
  });
});

describe("hasImportableMedia", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-media-")); dirs.push(d); return d; };

  it("ignores Synology index folders and dotfiles when judging emptiness", () => {
    // Both sit beside the real folder in the live inbox. Counting them would
    // make every leftover look occupied.
    const root = tmp();
    fs.mkdirSync(path.join(root, "@eaDir"), { recursive: true });
    fs.writeFileSync(path.join(root, "@eaDir", "thumb.mp3"), "not content");
    fs.writeFileSync(path.join(root, ".DS_Store"), "junk");
    expect(hasImportableMedia(root)).toBe(false);
  });

  it("accepts every extension the scanner imports", () => {
    for (const extension of [".mp3", ".m4a", ".m4b", ".flac", ".ogg", ".opus", ".wav", ".aac"]) {
      const root = tmp();
      fs.writeFileSync(path.join(root, `book${extension}`), "audio");
      expect(hasImportableMedia(root)).toBe(true);
    }
  });

  it("treats an unreadable path as media-bearing, never as empty", () => {
    // This function only ever causes a DISCARD, so every failure path must
    // err toward leaving the decision alone.
    expect(hasImportableMedia(path.join(tmp(), "does-not-exist"))).toBe(true);
  });

  it("judges a bare file by its own extension", () => {
    const root = tmp();
    const audio = path.join(root, "book.m4b");
    const text = path.join(root, "notes.txt");
    fs.writeFileSync(audio, "audio");
    fs.writeFileSync(text, "text");
    expect(hasImportableMedia(audio)).toBe(true);
    expect(hasImportableMedia(text)).toBe(false);
  });
});
