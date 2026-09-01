import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemSettingsSchema, type LibraryFolderPattern, type OrganizationAction } from "@audioshelf/shared";
import type { ABSLibraryItem } from "../../curator/core/types.js";
import { AudiobookOrganizer } from "./organizer.js";
import { mapAbsItemToBook, measureLibraryStructure, RealignService, type RealignClient } from "./realign.js";
import { HistoryStore } from "../../../config/history.js";
import { rollbackBatch } from "./rollback.js";

describe("safe library realignment", () => {
  let sandbox: string;
  let root: string;
  let now: number;
  let pattern: LibraryFolderPattern;
  let settings: ReturnType<typeof SystemSettingsSchema.parse>;
  let items: ABSLibraryItem[];
  let history: OrganizationAction[][];
  let scans: string[];

  const item = (id: string, currentPath: string, overrides: Record<string, unknown> = {}): ABSLibraryItem => ({
    id,
    path: currentPath,
    media: { metadata: {
      title: "Leviathan Wakes", authorName: "James S.A. Corey", narratorName: "Jefferson Mays",
      seriesName: "The Expanse", series: [{ name: "The Expanse", sequence: "1" }], publishedYear: "2011",
      ...overrides,
    } },
  });
  const client = (): RealignClient => ({
    getLibraries: async () => [{ id: "lib", name: "Audiobooks", mediaType: "book" }],
    getLibraryItems: async () => items,
    triggerLibraryScan: async (id) => { scans.push(id) },
  });
  const service = (overrides: Record<string, unknown> = {}) => new RealignService({
    getSettings: () => settings,
    createClient: client,
    history: {
      addBatch: (actions) => { history.push(actions.map((action) => ({ ...action }))); return "batch-1" },
      updateBatch: (_id, actions) => { history[0] = actions.map((action) => ({ ...action })) },
      removeBatch: () => { history = [] },
    },
    organizer: new AudiobookOrganizer({ PORT: 0 }), now: () => now, uuid: () => "plan-1", planTtlMs: 1_000, maxPlans: 2,
    ...overrides,
  });

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-realign-"));
    root = path.join(sandbox, "library"); fs.mkdirSync(root);
    pattern = { libraryId: "lib", rootDir: root, standalone: "{author}/{year} - {title} - {{{narrator}}}", series: "{author}/{series}/{year} - #{series_number} - {title} - {{{narrator}}}", source: "configured" };
    settings = SystemSettingsSchema.parse({ libraryFolderPatterns: [pattern], absUrl: "http://invalid.test", absToken: "test" });
    items = []; history = []; scans = []; now = Date.parse("2026-08-28T12:00:00Z");
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(sandbox, { recursive: true, force: true }) });

  it("maps rich standalone and series metadata without Unknown fallbacks", async () => {
    const seriesBook = mapAbsItemToBook(item("series", path.join(root, "old")), "lib")!;
    expect(seriesBook).toMatchObject({ title: "Leviathan Wakes", authors: ["James S.A. Corey"], series: "The Expanse", series_number: 1, published_year: 2011, narrator: "Jefferson Mays", source_path: path.join(root, "old") });
    const organizer = new AudiobookOrganizer({ PORT: 0 });
    expect(await organizer.generatePatternTargetPath(seriesBook, pattern)).toBe(path.join(root, "James S.A. Corey", "The Expanse", "2011 - #1 - Leviathan Wakes - {Jefferson Mays}"));
    const standalone = mapAbsItemToBook(item("standalone", path.join(root, "other"), { seriesName: null, series: [] }), "lib")!;
    expect(await organizer.generatePatternTargetPath(standalone, pattern)).toBe(path.join(root, "James S.A. Corey", "2011 - Leviathan Wakes - {Jefferson Mays}"));
  });

  it("treats an NFD path on disk as already matching its NFC proposal", async () => {
    // Synology and macOS write filenames decomposed; metadata from ABS comes
    // back composed. Byte equality therefore reports a book as misaligned
    // against itself, and the resulting "move" renames a directory to a name
    // it already has. path.resolve normalizes separators, never Unicode.
    const composed = path.join(root, "José Rivera", "The Expanse", "2011 - #1 - Leviathan Wakes - {Jefferson Mays}");
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);

    items = [item("book", decomposed, { authorName: "José Rivera" })];
    const measured = await measureLibraryStructure(
      [{ library: { id: "lib", name: "Audiobooks", mediaType: "book" }, items }],
      settings,
    );

    expect(measured).toMatchObject({ eligible: 1, matched: 1, issues: 0, score: 100 });
  });

  it("still reports a genuinely different path as misaligned", async () => {
    // The normalization must not become a blanket "close enough" — a real
    // structural difference has to survive it.
    items = [item("book", path.join(root, "Wrong Place", "Leviathan Wakes"))];
    const measured = await measureLibraryStructure(
      [{ library: { id: "lib", name: "Audiobooks", mediaType: "book" }, items }],
      settings,
    );

    expect(measured).toMatchObject({ eligible: 1, matched: 0 });
  });

  it("reports a configured rich convention as measurable and already consistent", async () => {
    const current = path.join(root, "James S.A. Corey", "The Expanse", "2011 - #1 - Leviathan Wakes - {Jefferson Mays}");
    items = [item("book", current)];
    const measured = await measureLibraryStructure([{ library: { id: "lib", name: "Audiobooks", mediaType: "book" }, items }], settings);
    expect(measured).toEqual({ status: "Great", score: 100, total: 1, observed: 1, configuredObserved: 1, eligible: 1, matched: 1, issues: 0, coverage: 1 });
  });

  it("keeps unconfigured and metadata-ineligible structure unknown", async () => {
    items = [item("book", path.join(root, "old"), { narratorName: null })];
    const unknown = await measureLibraryStructure([{ library: { id: "lib", name: "Audiobooks" }, items }], SystemSettingsSchema.parse({}));
    expect(unknown).toMatchObject({ status: "Unknown", score: 100, total: null, issues: null });
    fs.mkdirSync(path.join(root, "old"));
    const plan = await service().scanLibrary();
    expect(plan.candidates).toEqual([]);
    expect(plan.libraries[0].status).toBe("Unknown");
  });

  it("keeps structure unknown when any populated library is unconfigured or eligibility coverage is low", async () => {
    const consistent = item("configured", path.join(root, "James S.A. Corey", "The Expanse", "2011 - #1 - Leviathan Wakes - {Jefferson Mays}"));
    const unconfiguredItems = Array.from({ length: 949 }, (_, index) => item(`u-${index}`, path.join(sandbox, "unconfigured", String(index))));
    const mixed = await measureLibraryStructure([
      { library: { id: "lib", name: "Configured" }, items: [consistent] },
      { library: { id: "other", name: "Unconfigured" }, items: unconfiguredItems },
    ], settings);
    expect(mixed).toMatchObject({ status: "Unknown", score: 100, total: null, observed: 950, configuredObserved: 1, eligible: 1, issues: null });

    const mostlyIneligible = [consistent, ...Array.from({ length: 3 }, (_, index) => item(`missing-${index}`, path.join(root, `missing-${index}`), { narratorName: null }))];
    const lowCoverage = await measureLibraryStructure([{ library: { id: "lib", name: "Configured" }, items: mostlyIneligible }], settings);
    expect(lowCoverage).toMatchObject({ status: "Unknown", total: null, observed: 4, configuredObserved: 4, eligible: 1, coverage: 0.25 });
  });

  it("never plans or executes a low-coverage library even if internal plan state is tampered", async () => {
    const source = path.join(root, "eligible-source"); fs.mkdirSync(source);
    const eligible = item("eligible", source);
    const ineligible = Array.from({ length: 99 }, (_, index) => item(`ineligible-${index}`, path.join(root, `missing-${index}`), { narratorName: null }));
    items = [eligible, ...ineligible];
    const realign = service(); const plan = await realign.scanLibrary();
    expect(plan.libraries[0]).toMatchObject({ status: "Unknown", total: null, observed: 100, configuredObserved: 100, eligible: 1, matched: 0, coverage: 0.01 });
    expect(plan.candidates).toEqual([]);

    const target = await new AudiobookOrganizer({ PORT: 0 }).generatePatternTargetPath(mapAbsItemToBook(eligible, "lib")!, pattern);
    const internal = realign as unknown as { plans: Map<string, { plannedBooks: Map<string, unknown> }> };
    internal.plans.get(plan.planId)!.plannedBooks.set("eligible", {
      bookId: "eligible", libraryId: "lib", title: "Leviathan Wakes", author: "James S.A. Corey",
      currentPath: source, proposedPath: target, patternFingerprint: "tampered",
    });
    const rename = vi.spyOn(fs.promises, "rename");
    await expect(realign.executeRealign(plan.planId, ["eligible"])).rejects.toThrow(/not sufficiently measured/);
    expect(rename).not.toHaveBeenCalled(); expect(fs.existsSync(source)).toBe(true);
  });

  it("creates a server-authored plan and records rollback-compatible success", async () => {
    const source = path.join(root, "old"); fs.mkdirSync(source); items = [item("book", source)];
    const realign = service(); const plan = await realign.scanLibrary();
    expect(plan.candidates).toHaveLength(1); expect(plan.candidates[0].currentPath).toBe(source);
    const result = await realign.executeRealign(plan.planId, ["book"]);
    expect(result).toEqual({ success: 1, failed: 0, errors: [], scanErrors: [], historyBatchId: "batch-1" });
    expect(history[0][0]).toMatchObject({ source_path: source, target_path: plan.candidates[0].proposedPath, executed: true, success: true, book: { abs_item_id: "book", abs_library_id: "lib" } });
    expect(scans).toEqual(["lib"]); expect(fs.existsSync(source)).toBe(false); expect(fs.existsSync(plan.candidates[0].proposedPath)).toBe(true);
  });

  it("rejects unknown, expired, duplicate and stale-pattern selections before mutation", async () => {
    const source = path.join(root, "old"); fs.mkdirSync(source); items = [item("book", source)];
    const realign = service(); const plan = await realign.scanLibrary();
    await expect(realign.executeRealign("forged", ["book"])).rejects.toThrow(/unknown or expired/);
    await expect(realign.executeRealign(plan.planId, ["book", "book"])).rejects.toThrow(/unique/);
    settings = SystemSettingsSchema.parse({ ...settings, libraryFolderPatterns: [{ ...pattern, standalone: "{author}/{title}", series: "{author}/{series}/{title}" }] });
    await expect(realign.executeRealign(plan.planId, ["book"])).rejects.toThrow(/convention or root changed/);
    expect(fs.existsSync(source)).toBe(true); now += 2_000;
    await expect(realign.executeRealign(plan.planId, ["book"])).rejects.toThrow(/unknown or expired/);
  });

  it("rejects changed ABS paths and a whole batch preflight failure causes zero renames", async () => {
    const first = path.join(root, "old-one"); const second = path.join(root, "old-two"); fs.mkdirSync(first); fs.mkdirSync(second);
    items = [item("one", first), item("two", second, { title: "Caliban's War", series: [{ name: "The Expanse", sequence: 2 }] })];
    const realign = service(); const plan = await realign.scanLibrary();
    items[0] = item("one", path.join(root, "changed"));
    await expect(realign.executeRealign(plan.planId, ["one"])).rejects.toThrow(/source changed/);
    items[0] = item("one", first); fs.rmSync(second, { recursive: true });
    const rename = vi.spyOn(fs.promises, "rename");
    const mkdir = vi.spyOn(fs.promises, "mkdir");
    await expect(realign.executeRealign(plan.planId, ["one", "two"])).rejects.toThrow();
    expect(rename).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(fs.existsSync(first)).toBe(true);
  });

  it("does not copy/delete on rename failure and separates scan failures", async () => {
    const source = path.join(root, "old"); fs.mkdirSync(source); items = [item("book", source)];
    const realign = service(); const plan = await realign.scanLibrary();
    const failure = Object.assign(new Error("cross device"), { code: "EXDEV" });
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(failure);
    const failed = await realign.executeRealign(plan.planId, ["book"]);
    expect(failed).toMatchObject({ success: 0, failed: 1, historyBatchId: null }); expect(fs.existsSync(source)).toBe(true); expect(history).toEqual([]); expect(scans).toEqual([]);

    vi.restoreAllMocks(); fs.mkdirSync(path.join(root, "second")); items = [item("second", path.join(root, "second"))];
    const scanFailing = service({ createClient: () => ({ ...client(), triggerLibraryScan: async () => { throw new Error("ABS busy") } }) });
    const secondPlan = await scanFailing.scanLibrary(); const moved = await scanFailing.executeRealign(secondPlan.planId, ["second"]);
    expect(moved.success).toBe(1); expect(moved.scanErrors).toEqual(["lib: ABS busy"]); expect(moved.errors).toEqual([]);
  });

  it("records only successful moves when a later rename fails", async () => {
    const first = path.join(root, "first"); const second = path.join(root, "second"); fs.mkdirSync(first); fs.mkdirSync(second);
    items = [item("one", first), item("two", second, { title: "Caliban's War", series: [{ name: "The Expanse", sequence: 2 }] })];
    const realign = service(); const plan = await realign.scanLibrary();
    const nativeRename = fs.promises.rename.bind(fs.promises); let calls = 0;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
      calls += 1; if (calls === 2) throw new Error("disk rejected move"); return nativeRename(source, target);
    });
    const result = await realign.executeRealign(plan.planId, ["one", "two"]);
    expect(result).toMatchObject({ success: 1, failed: 1, historyBatchId: "batch-1" });
    expect(history).toHaveLength(1);
    expect(history[0].map((action) => [action.book.abs_item_id, action.success])).toEqual([["one", true], ["two", false]]);
    expect(scans).toEqual(["lib"]); expect(fs.existsSync(second)).toBe(true);
  });

  it("preflights target collisions, non-directories, symlinks, duplicate targets, and overlaps", async () => {
    const assertNoRename = async (configure: () => void) => {
      items = []; configure(); const realign = service(); const plan = await realign.scanLibrary();
      const rename = vi.spyOn(fs.promises, "rename");
      await expect(realign.executeRealign(plan.planId, plan.candidates.map((candidate) => candidate.bookId))).rejects.toThrow();
      expect(rename).not.toHaveBeenCalled(); vi.restoreAllMocks();
    };
    await assertNoRename(() => {
      const source = path.join(root, "collision-source"); fs.mkdirSync(source); items = [item("collision", source)];
      const target = path.join(root, "James S.A. Corey", "The Expanse", "2011 - #1 - Leviathan Wakes - {Jefferson Mays}"); fs.mkdirSync(target, { recursive: true });
    });
    await assertNoRename(() => { const file = path.join(root, "not-dir"); fs.writeFileSync(file, "x"); items = [item("file", file)] });
    await assertNoRename(() => {
      const actual = path.join(root, "actual"); const link = path.join(root, "link"); fs.mkdirSync(actual); fs.symlinkSync(actual, link, "junction"); items = [item("link", link)];
    });
    await assertNoRename(() => {
      const one = path.join(root, "dupe-one"); const two = path.join(root, "dupe-two"); fs.mkdirSync(one); fs.mkdirSync(two); items = [item("one", one), item("two", two)];
    });
    await assertNoRename(() => {
      const source = path.join(root, "Overlap Author"); fs.mkdirSync(source); items = [item("overlap", source, { authorName: "Overlap Author", seriesName: null, series: [] })];
    });
  });

  it("skips paths outside each exact library root and rejects root itself", async () => {
    const outside = path.join(sandbox, "outside"); fs.mkdirSync(outside); items = [item("outside", outside), item("root", root)];
    const plan = await service().scanLibrary(); expect(plan.candidates).toEqual([]); expect(plan.libraries[0].status).toBe("Unknown");
  });

  it("keeps configured library roots isolated from one another", async () => {
    const secondRoot = path.join(sandbox, "second-library"); fs.mkdirSync(secondRoot);
    const secondPattern = { ...pattern, libraryId: "lib-two", rootDir: secondRoot };
    settings = SystemSettingsSchema.parse({ ...settings, libraryFolderPatterns: [pattern, secondPattern] });
    const misplaced = path.join(secondRoot, "belongs-to-two"); fs.mkdirSync(misplaced);
    const own = path.join(secondRoot, "own"); fs.mkdirSync(own);
    const byLibrary: Record<string, ABSLibraryItem[]> = { lib: [item("wrong-root", misplaced)], "lib-two": [item("right-root", own)] };
    const realign = service({ createClient: () => ({
      getLibraries: async () => [{ id: "lib", name: "One", mediaType: "book" }, { id: "lib-two", name: "Two", mediaType: "book" }],
      getLibraryItems: async (libraryId: string) => byLibrary[libraryId], triggerLibraryScan: async () => undefined,
    }) });
    const plan = await realign.scanLibrary();
    expect(plan.candidates.map((candidate) => candidate.bookId)).toEqual(["right-root"]);
    expect(plan.libraries.find((library) => library.libraryId === "lib")?.status).toBe("Unknown");
  });

  it.each([["a", "b"], ["b", "a"]])("rejects cross-candidate source/target nesting in selection order %s,%s", async (firstId, secondId) => {
    pattern = { ...pattern, standalone: "{author}/{title}", series: "{author}/{title}" };
    settings = SystemSettingsSchema.parse({ ...settings, libraryFolderPatterns: [pattern] });
    const sourceA = path.join(root, "source-a"); const sourceB = path.join(root, "Nesting Author"); fs.mkdirSync(sourceA); fs.mkdirSync(sourceB);
    items = [
      item("a", sourceA, { title: "Nested Target", authorName: "Nesting Author", seriesName: null, series: [] }),
      item("b", sourceB, { title: "Other Target", authorName: "Other Author", seriesName: null, series: [] }),
    ];
    const realign = service(); const plan = await realign.scanLibrary();
    const rename = vi.spyOn(fs.promises, "rename"); const mkdir = vi.spyOn(fs.promises, "mkdir");
    await expect(realign.executeRealign(plan.planId, [firstId, secondId])).rejects.toThrow(/overlap/);
    expect(rename).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(history).toEqual([]);
  });

  it("rejects a configured root whose symlink binding changed after scan", async () => {
    const firstRoot = path.join(sandbox, "root-a"); const secondRoot = path.join(sandbox, "root-b"); const link = path.join(sandbox, "library-link");
    fs.mkdirSync(firstRoot); fs.mkdirSync(secondRoot); fs.symlinkSync(firstRoot, link, "junction");
    pattern = { ...pattern, rootDir: link }; settings = SystemSettingsSchema.parse({ ...settings, libraryFolderPatterns: [pattern] });
    const source = path.join(link, "old"); fs.mkdirSync(source); items = [item("book", source)];
    const realign = service(); const plan = await realign.scanLibrary();
    fs.rmSync(link); fs.symlinkSync(secondRoot, link, "junction"); fs.mkdirSync(path.join(secondRoot, "old"));
    await expect(realign.executeRealign(plan.planId, ["book"])).rejects.toThrow(/root changed/);
  });

  it("serializes execution and consumes a plan after its first authorized attempt", async () => {
    const source = path.join(root, "old"); fs.mkdirSync(source); items = [item("book", source)];
    let block = false; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve });
    const realign = service({ createClient: () => ({ ...client(), getLibraryItems: async () => { if (block) await gate; return items } }) });
    const plan = await realign.scanLibrary(); block = true;
    const first = realign.executeRealign(plan.planId, ["book"]); await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(realign.executeRealign(plan.planId, ["book"])).rejects.toThrow(/in flight or consumed/);
    release(); await expect(first).resolves.toMatchObject({ success: 1 });
    await expect(realign.executeRealign(plan.planId, ["book"])).rejects.toThrow(/in flight or consumed/);
  });

  it("serializes mutation across distinct plans", async () => {
    const source = path.join(root, "old"); fs.mkdirSync(source); items = [item("book", source)];
    let block = false; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve });
    const ids = ["plan-one", "plan-two"];
    const realign = service({ uuid: () => ids.shift()!, createClient: () => ({ ...client(), getLibraryItems: async () => { if (block) await gate; return items } }) });
    const firstPlan = await realign.scanLibrary(); const secondPlan = await realign.scanLibrary(); block = true;
    const first = realign.executeRealign(firstPlan.planId, ["book"]); await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(realign.executeRealign(secondPlan.planId, ["book"])).rejects.toThrow(/already in progress/);
    release(); await expect(first).resolves.toMatchObject({ success: 1 });
  });

  it("journals before mutation and a journal failure causes zero mkdir or rename", async () => {
    const source = path.join(root, "old"); fs.mkdirSync(source); items = [item("book", source)];
    const realign = service({ history: { addBatch: () => { throw new Error("journal unavailable") }, updateBatch: () => undefined, removeBatch: () => undefined } });
    const plan = await realign.scanLibrary(); const mkdir = vi.spyOn(fs.promises, "mkdir"); const rename = vi.spyOn(fs.promises, "rename");
    await expect(realign.executeRealign(plan.planId, ["book"])).rejects.toThrow("journal unavailable");
    expect(mkdir).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled(); expect(fs.existsSync(source)).toBe(true);
  });

  it("retains a restart-recoverable journal when interruption prevents cleanup", async () => {
    const source = path.join(root, "old"); fs.mkdirSync(source); items = [item("book", source)];
    const durable = new HistoryStore(sandbox);
    const realign = service({ history: {
      addBatch: (actions: OrganizationAction[]) => durable.addBatch(actions),
      updateBatch: (id: string, actions: OrganizationAction[]) => durable.updateBatch(id, actions),
      removeBatch: () => { throw new Error("simulated interruption") },
    } });
    const plan = await realign.scanLibrary(); vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("move interrupted"));
    await expect(realign.executeRealign(plan.planId, ["book"])).rejects.toThrow("simulated interruption");
    const restarted = new HistoryStore(sandbox); const journal = restarted.getLatestBatch(); expect(journal).not.toBeNull();
    const inbox = path.join(sandbox, "inbox"); const other = path.join(sandbox, "other"); fs.mkdirSync(inbox); fs.mkdirSync(other);
    const rollback = await rollbackBatch(journal!.actions, { inboxDir: inbox, libraryDir: other, additionalRoots: [root] });
    expect(rollback).toMatchObject({ complete: true, alreadyReverted: 1 }); expect(fs.existsSync(source)).toBe(true);
  });

  it("revalidates a target parent replaced after mkdir and performs no rename", async () => {
    const source = path.join(root, "old"); fs.mkdirSync(source); items = [item("book", source)];
    const realign = service(); const plan = await realign.scanLibrary(); const targetParent = path.dirname(plan.candidates[0].proposedPath);
    const outside = path.join(sandbox, "outside-parent"); fs.mkdirSync(outside);
    const nativeMkdir = fs.promises.mkdir.bind(fs.promises);
    vi.spyOn(fs.promises, "mkdir").mockImplementation(async (directory, options) => {
      const result = await nativeMkdir(directory, options);
      if (path.resolve(String(directory)) === path.resolve(targetParent)) {
        fs.renameSync(targetParent, `${targetParent}-original`); fs.symlinkSync(outside, targetParent, "junction");
      }
      return result;
    });
    const rename = vi.spyOn(fs.promises, "rename");
    const result = await realign.executeRealign(plan.planId, ["book"]);
    expect(result).toMatchObject({ success: 0, failed: 1, historyBatchId: null }); expect(rename).not.toHaveBeenCalled(); expect(fs.existsSync(source)).toBe(true);
  });

  it("rejects canonical target aliases through symlink ancestors", async () => {
    pattern = { ...pattern, standalone: "{author}/{title}", series: "{author}/{title}" };
    settings = SystemSettingsSchema.parse({ ...settings, libraryFolderPatterns: [pattern] });
    const realAuthor = path.join(root, "Real Author"); const aliasAuthor = path.join(root, "Alias Author"); fs.mkdirSync(realAuthor); fs.symlinkSync(realAuthor, aliasAuthor, "junction");
    const sourceA = path.join(root, "source-a"); const sourceB = path.join(root, "source-b"); fs.mkdirSync(sourceA); fs.mkdirSync(sourceB);
    items = [
      item("a", sourceA, { title: "Same", authorName: "Alias Author", seriesName: null, series: [] }),
      item("b", sourceB, { title: "Same", authorName: "Real Author", seriesName: null, series: [] }),
    ];
    const realign = service(); const plan = await realign.scanLibrary(); const rename = vi.spyOn(fs.promises, "rename");
    await expect(realign.executeRealign(plan.planId, ["a", "b"])).rejects.toThrow(/duplicate targets/);
    expect(rename).not.toHaveBeenCalled();
  });

  it("rejects canonical source aliases through symlink ancestors", async () => {
    pattern = { ...pattern, standalone: "{author}/{title}", series: "{author}/{title}" };
    settings = SystemSettingsSchema.parse({ ...settings, libraryFolderPatterns: [pattern] });
    const actualParent = path.join(root, "actual"); const aliasParent = path.join(root, "alias"); const actualBook = path.join(actualParent, "book"); fs.mkdirSync(actualBook, { recursive: true }); fs.symlinkSync(actualParent, aliasParent, "junction");
    items = [
      item("a", actualBook, { title: "One", authorName: "Author One", seriesName: null, series: [] }),
      item("b", path.join(aliasParent, "book"), { title: "Two", authorName: "Author Two", seriesName: null, series: [] }),
    ];
    const realign = service(); const plan = await realign.scanLibrary(); const rename = vi.spyOn(fs.promises, "rename");
    await expect(realign.executeRealign(plan.planId, ["a", "b"])).rejects.toThrow(/duplicate sources/);
    expect(rename).not.toHaveBeenCalled();
  });
});
