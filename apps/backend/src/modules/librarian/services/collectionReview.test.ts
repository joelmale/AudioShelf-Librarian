import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, OrganizationAction } from "@audioshelf/shared";
import { IngestStore } from "../ingestStore.js";
import { IngestRunner } from "./ingestRunner.js";
import { COLLECTION_STAGING, CollectionConflict, CollectionReview } from "./collectionReview.js";

let sandbox: string;
let inbox: string;
let library: string;
let source: string;
let store: IngestStore;
let database: string;
const first = { title: "First book", author: "Author", files: ["First/02.mp3", "First/01.mp3"] };
const second = { title: "Second book", author: "Author", files: ["Second/01.mp3"] };

async function fixture(relative: string, contents = "audio"): Promise<void> {
  const target = path.join(source, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

function harness(execute = async (action: OrganizationAction) => {
  await fs.rename(action.source_path, action.target_path);
  action.success = true;
}) {
  const executeAction = vi.fn(execute);
  const scan = vi.fn(async (stage: string): Promise<Book> => ({
    title: "Unknown Title",
    authors: [],
    source_path: stage,
    audio_files: (await fs.readdir(stage)).filter(name => name.endsWith(".mp3")).map(name => path.join(stage, name)),
    metadata_source: "filename",
    confidence_score: 0,
    needs_processing: true,
    is_series: false,
  }));
  const runner = new IngestRunner({
    ingestStore: store,
    executeAction,
    journal: {
      addBatch: () => "batch", getBatchActions: () => null,
      updateBatch: () => undefined, removeBatch: () => undefined,
    },
    resolveInAbs: async itemId => { store.transitionItem(itemId, "complete"); },
  });
  const review = new CollectionReview({
    store, runner, scan,
    organize: async (book): Promise<OrganizationAction> => ({
      book, source_path: book.source_path, target_path: path.join(library, book.title),
      action_type: "move", reason: "move", executed: false, success: false,
    }),
    inbox: () => inbox, library: () => library,
  });
  return { review, executeAction, scan };
}

beforeEach(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "collection-review-")));
  inbox = path.join(sandbox, "inbox");
  source = path.join(inbox, "Collection");
  library = path.join(sandbox, "library");
  await fs.mkdir(library);
  await fixture("First/01.mp3", "first track");
  await fixture("First/02.mp3", "second track");
  await fixture("Second/01.mp3");
  database = path.join(sandbox, "ingest.db");
  store = new IngestStore(database);
});

afterEach(async () => {
  store.close();
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("collection import review", () => {
  it("builds a read-only preview and imports only approved files in their chosen order", async () => {
    const { review, executeAction } = harness();
    const preview = await review.preview(source);
    expect(await fs.readdir(inbox)).toEqual(["Collection"]);
    expect(store.collectionSources()).toEqual([]);
    const result = await review.approve(source, preview.fingerprint, [first]);
    expect(result.counts).toMatchObject({ imported: 1, held: 0, failed: 0 });
    expect(await fs.readdir(library)).toEqual(["First book"]);
    expect(await fs.readFile(path.join(library, "First book", "00001 - 02.mp3"), "utf8")).toBe("second track");
    expect(await fs.readFile(path.join(source, "First", "02.mp3"), "utf8")).toBe("second track");
    expect(JSON.parse(await fs.readFile(path.join(library, "First book", "metadata.json"), "utf8"))).toMatchObject({
      title: first.title, authors: [first.author],
    });
    expect(store.hasActiveJobForTarget(source)).toBe(true);
    await review.approve(source, preview.fingerprint, [first]);
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(path.join(source, "Second"))).toEqual(["01.mp3"]);
  });

  it("rejects a stale preview and overlapping membership before staging writes", async () => {
    const { review } = harness();
    const old = await review.preview(source);
    await fixture("First/02.mp3", "replaced");
    await expect(review.approve(source, old.fingerprint, [first])).rejects.toThrow(CollectionConflict);
    const preview = await review.preview(source);
    await expect(review.approve(source, preview.fingerprint, [first, { ...second, files: [first.files[0]] }]))
      .rejects.toThrow(/exactly one/);
    expect(await fs.readdir(inbox)).toEqual(["Collection"]);
  });

  it("recovers a move interrupted before completion and independently retries the remaining book", async () => {
    const initial = harness(async action => {
      if (action.book.title === first.title) await fs.rename(action.source_path, action.target_path);
      throw new Error("Interrupted");
    });
    const preview = await initial.review.preview(source);
    const partial = await initial.review.approve(source, preview.fingerprint, [first, second]);
    expect(partial.counts.failed).toBe(2);
    expect(await fs.readdir(library)).toEqual(["First book"]);
    store.close();
    store = new IngestStore(database);
    const { review, executeAction } = harness();
    const complete = await review.approve(source, preview.fingerprint, [first, second]);
    expect(complete.counts).toMatchObject({ imported: 2, failed: 0, remaining: 0 });
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(executeAction.mock.calls[0][0].book.title).toBe(second.title);
  });

  it("reconciles a published cross-device copy without leaving a rollback collision", async () => {
    const initial = harness(async action => {
      await fs.cp(action.source_path, action.target_path, { recursive: true });
      throw new Error("Interrupted after publication");
    });
    const { fingerprint } = await initial.review.preview(source);
    const attempt = await initial.review.approve(source, fingerprint, [first]);
    expect(attempt.counts.failed).toBe(1);
    const [staged] = await fs.readdir(path.join(inbox, COLLECTION_STAGING));
    const retry = harness();
    const recovered = await retry.review.approve(source, fingerprint, [first]);
    expect(recovered.counts.imported).toBe(1);
    expect(retry.executeAction).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(inbox, COLLECTION_STAGING, staged))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns an unfinished book with changed source files to review", async () => {
    const failing = harness(async () => { throw new Error("Temporary move error"); });
    const original = await failing.review.preview(source);
    expect((await failing.review.approve(source, original.fingerprint, [first])).counts.failed).toBe(1);
    await fixture("First/02.mp3", "corrected recording");
    const retry = harness();
    const current = await retry.review.preview(source);
    expect(current.progress).toHaveLength(0);
    expect(current.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Files changed")]));
    const corrected = { ...first, title: "Corrected title" };
    expect((await retry.review.approve(source, current.fingerprint, [corrected])).counts.imported).toBe(1);
    expect(await fs.readFile(path.join(library, corrected.title, "00001 - 02.mp3"), "utf8")).toBe("corrected recording");
  });

  it("removes a temporary book after a copy fails after its first track", async () => {
    const { review, executeAction } = harness();
    const { fingerprint } = await review.preview(source);
    const open = fs.open.bind(fs);
    const failure = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("00002 - 01.mp3")) throw new Error("No space left");
      return open(...args);
    });
    try {
      const result = await review.approve(source, fingerprint, [first]);
      expect(result.counts.failed).toBe(1);
      expect(executeAction).not.toHaveBeenCalled();
      expect(await fs.readdir(path.join(inbox, COLLECTION_STAGING))).toEqual([]);
      expect(await fs.readdir(library)).toEqual([]);
    } finally {
      failure.mockRestore();
    }
  });

  it("writes approved metadata when an owned sidecar is malformed", async () => {
    await fixture("First/metadata.json", "{ broken content");
    const { review } = harness();
    const preview = await review.preview(source);
    const candidate = preview.candidates.find(entry => entry.files.includes("First/01.mp3"))!;
    expect(candidate.extras).toContain("First/metadata.json");
    const result = await review.approve(source, preview.fingerprint, [{ ...first, files: candidate.files }]);
    expect(result.counts.imported).toBe(1);
    expect(await fs.readFile(path.join(source, "First", "metadata.json"), "utf8")).toBe("{ broken content");
    expect(JSON.parse(await fs.readFile(path.join(library, first.title, "metadata.json"), "utf8"))).toMatchObject({
      title: first.title, authors: [first.author],
    });
  });

  it("holds a colliding destination and refuses a simultaneous approval", async () => {
    const { review, scan, executeAction } = harness();
    await fs.mkdir(path.join(library, "First book"));
    const { fingerprint } = await review.preview(source);
    const active = review.approve(source, fingerprint, [first]);
    await expect(review.approve(source, fingerprint, [second])).rejects.toThrow(/already importing/);
    const result = await active;
    expect(result.counts).toMatchObject({ imported: 0, held: 1 });
    expect(executeAction).not.toHaveBeenCalled();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(path.join(library, "First book"))).toEqual([]);
  });

  it("reports inaccessible staging without touching the source or library", async () => {
    const { review, executeAction } = harness();
    const { fingerprint } = await review.preview(source);
    // Occupying the staging root makes it impossible to publish staging.
    // This failure must never fall through to the organizer.
    await fs.writeFile(path.join(inbox, COLLECTION_STAGING), "blocked");
    const result = await review.approve(source, fingerprint, [first]);
    expect(result.counts.failed).toBe(1);
    expect(executeAction).not.toHaveBeenCalled();
    expect(await fs.readdir(library)).toEqual([]);
    expect(await fs.readFile(path.join(source, "First", "01.mp3"), "utf8")).toBe("first track");
  });
});
