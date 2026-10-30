import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OrganizationAction } from "@audioshelf/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IngestStore } from "../ingestStore.js";
import { IngestRunner, type ImportJournal } from "./ingestRunner.js";

function action(source: string, target: string, actionType: OrganizationAction["action_type"] = "move"): OrganizationAction {
  return {
    book: {
      title: path.basename(source),
      authors: ["Author"],
      source_path: source,
      audio_files: [],
      metadata_source: "filename",
      confidence_score: 1,
      is_series: false,
      needs_processing: true,
    },
    action_type: actionType,
    source_path: source,
    target_path: target,
    reason: "test",
    executed: false,
    success: false,
  };
}

class MemoryJournal implements ImportJournal {
  batches = new Map<string, OrganizationAction[]>();
  private next = 0;
  addBatch(actions: OrganizationAction[]): string { const id = `batch-${++this.next}`; this.batches.set(id, actions.map((a) => ({ ...a }))); return id; }
  updateBatch(id: string, actions: OrganizationAction[]): void { this.batches.set(id, actions.map((a) => ({ ...a }))); }
  removeBatch(id: string): void { this.batches.delete(id); }
  getBatchActions(id: string): OrganizationAction[] | null { return this.batches.get(id) ?? null; }
}

describe("IngestRunner", () => {
  let dir: string;
  let store: IngestStore;
  let journal: MemoryJournal;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-runner-"));
    store = new IngestStore(path.join(dir, "curator.db"));
    journal = new MemoryJournal();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runner = (overrides: Partial<ConstructorParameters<typeof IngestRunner>[0]> = {}) => new IngestRunner({
    ingestStore: store,
    journal,
    executeAction: async (a) => { a.executed = true; a.success = true; },
    resolveInAbs: async (itemId) => { store.transitionItem(itemId, "complete"); },
    ...overrides,
  });

  it("journals the move before executing it, so a crash mid-move can still be rolled back", async () => {
    const jobId = store.create("/inbox/Book");
    const a = action("/inbox/Book", "/library/Author/Book");
    const itemId = store.addItem(jobId, a);
    let journaledDuringMove: OrganizationAction[] | undefined;
    const { results, batchId } = await runner({
      executeAction: async (moving) => {
        journaledDuringMove = [...journal.batches.values()][0];
        moving.executed = true; moving.success = true;
      },
    }).importActions([{ action: a, itemId, jobId }]);

    expect(journaledDuringMove?.map((x) => x.source_path)).toEqual(["/inbox/Book"]);
    expect(results[0]).toMatchObject({ moved: true });
    expect(journal.getBatchActions(batchId!)?.[0]).toMatchObject({ success: true, target_path: "/library/Author/Book" });
    expect(store.getItem(itemId)?.state).toBe("complete");
  });

  it("drops the journal entry and marks the item failed when the move fails", async () => {
    const jobId = store.create("/inbox/Book");
    const a = action("/inbox/Book", "/library/Author/Book");
    const itemId = store.addItem(jobId, a);
    const { results, batchId } = await runner({
      executeAction: async () => { throw new Error("Target already exists"); },
    }).importActions([{ action: a, itemId, jobId }]);

    expect(results[0]).toMatchObject({ moved: false, error: "Target already exists" });
    expect(batchId).toBeNull();
    expect(journal.batches.size).toBe(0);
    expect(store.getItem(itemId)).toMatchObject({ state: "failed", error: "Target already exists" });
  });

  it("keeps a completed move complete when Audiobookshelf does not list it in time", async () => {
    const jobId = store.create("/inbox/Book", "lib-1");
    const a = action("/inbox/Book", "/library/Author/Book");
    const itemId = store.addItem(jobId, a);
    const { results } = await runner({
      resolveInAbs: async () => { throw new Error("the library scan did not list it within 30 seconds"); },
    }).importActions([{ action: a, itemId, jobId }]);

    expect(results[0].moved).toBe(true);
    expect(results[0].absWarning).toMatch(/has not listed it yet/);
    expect(store.getItem(itemId)?.state).toBe("complete");
    expect(store.pendingReviewItems()).toHaveLength(0);
  });

  it("never moves a held duplicate, even when it is committed", async () => {
    const execute = vi.fn();
    const jobId = store.create("/inbox/Book");
    const a = action("/inbox/Book", "/library/Author/Book", "duplicate");
    const itemId = store.addItem(jobId, a);
    const { results } = await runner({ executeAction: execute }).importActions([{ action: a, itemId, jobId }]);

    expect(execute).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ moved: false });
    expect(results[0].error).toMatch(/Import anyway/);
    expect(journal.batches.size).toBe(0);
    expect(store.getItem(itemId)?.state).toBe("discovered");
  });

  it("appends a scan's later imports to the same rollback entry", async () => {
    const jobId = store.create("/inbox");
    const r = runner();
    const first = await r.importActions([{ action: action("/inbox/A", "/library/A"), itemId: store.addItem(jobId, action("/inbox/A", "/library/A")), jobId }]);
    const second = await r.importActions(
      [{ action: action("/inbox/B", "/library/B"), itemId: store.addItem(jobId, action("/inbox/B", "/library/B")), jobId }],
      { appendToBatch: first.batchId },
    );
    expect(second.batchId).toBe(first.batchId);
    expect(journal.batches.size).toBe(1);
    expect(journal.getBatchActions(first.batchId!)?.map((x) => x.source_path)).toEqual(["/inbox/A", "/inbox/B"]);
  });

  it("on retry, recognises a book an earlier attempt already moved", async () => {
    const target = path.join(dir, "library", "Book");
    fs.mkdirSync(target, { recursive: true });
    const execute = vi.fn();
    const jobId = store.create(path.join(dir, "inbox", "Book"));
    const a = action(path.join(dir, "inbox", "Book"), target);
    const itemId = store.addItem(jobId, a);
    store.transitionItem(itemId, "failed", "ABS scan completed but the imported item could not be resolved");

    const { results } = await runner({ executeAction: execute }).importActions([{ action: a, itemId, jobId, recoverMoved: true }]);
    expect(execute).not.toHaveBeenCalled();
    expect(results[0].moved).toBe(true);
    expect(store.getItem(itemId)?.state).toBe("complete");
  });

  describe("processInbox", () => {
    it("leaves a visible, dismissable failed item when planning throws before any item exists", async () => {
      const onFailed = vi.fn();
      await runner().processInbox("/inbox/Broken", "Broken", {
        planAction: async () => { throw new Error("Target contains no supported audio files: /inbox/Broken"); },
        onFailed,
      });

      const [pending] = store.pendingReviewItems();
      expect(pending).toMatchObject({ state: "failed", error: "Target contains no supported audio files: /inbox/Broken" });
      expect(pending.action.source_path).toBe("/inbox/Broken");
      expect(onFailed).toHaveBeenCalledWith("/inbox/Broken", expect.stringContaining("no supported audio"));
      expect(store.discardItem(pending.id)).toBe(true);
    });

    it("imports a clean book and journals it", async () => {
      const onImported = vi.fn();
      await runner().processInbox("/inbox/Book", "Book", {
        planAction: async () => action("/inbox/Book", "/library/Author/Book"),
        onImported,
      });
      expect(onImported).toHaveBeenCalled();
      expect([...journal.batches.values()][0][0]).toMatchObject({ source_path: "/inbox/Book", success: true });
    });

    it("holds a duplicate without moving or journaling it", async () => {
      const onHeld = vi.fn();
      const execute = vi.fn();
      await runner({ executeAction: execute }).processInbox("/inbox/Book", "Book", {
        planAction: async () => action("/inbox/Book", "/library/Author/Book", "duplicate"),
        onHeld,
      });
      expect(onHeld).toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(journal.batches.size).toBe(0);
      expect(store.pendingReviewItems()).toHaveLength(1);
    });
  });
});
