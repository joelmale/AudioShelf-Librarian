import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationAction } from "@audioshelf/shared";
import { HistoryStore } from "./history.js";

describe("HistoryStore durability", () => {
  let dataDir: string;
  const action = { action_type: "move", source_path: "/source", target_path: "/target" } as OrganizationAction;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-history-")) });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dataDir, { recursive: true, force: true }) });

  it("persists ordinary batches and reloads them after restart", () => {
    const first = new HistoryStore(dataDir); const id = first.addBatch([action]);
    const restarted = new HistoryStore(dataDir);
    expect(restarted.getLatestBatch()).toMatchObject({ id, actions: [action] });
  });

  it("propagates persistence errors without changing in-memory history", () => {
    const store = new HistoryStore(dataDir);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("disk full") });
    expect(() => store.addBatch([action])).toThrow("disk full");
    expect(store.getHistory()).toEqual([]);
  });

  it("uses collision-resistant IDs and updates/removes exactly one same-time batch", () => {
    const ids = ["first-id", "second-id"];
    const store = new HistoryStore(dataDir, () => ids.shift()!);
    const first = store.addBatch([action]); const second = store.addBatch([{ ...action, source_path: "/second" }]);
    expect(first).not.toBe(second);
    store.updateBatch(first, [{ ...action, source_path: "/updated" }]);
    expect(store.getHistory().find((batch) => batch.id === first)?.actions[0].source_path).toBe("/updated");
    expect(store.getHistory().find((batch) => batch.id === second)?.actions[0].source_path).toBe("/second");
    store.removeBatch(first);
    expect(store.getHistory().map((batch) => batch.id)).toEqual([second]);
  });

  it("keeps the prior durable JSON unchanged when atomic replacement fails", () => {
    const store = new HistoryStore(dataDir, () => "first"); store.addBatch([action]);
    const historyPath = path.join(dataDir, "history.json"); const before = fs.readFileSync(historyPath, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename failed") });
    expect(() => store.updateBatch("first", [{ ...action, source_path: "/changed" }])).toThrow("rename failed");
    const after = fs.readFileSync(historyPath, "utf8");
    expect(after).toBe(before); expect(() => JSON.parse(after)).not.toThrow();
    expect(store.getLatestBatch()?.actions[0].source_path).toBe("/source");
    expect(fs.readdirSync(dataDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
