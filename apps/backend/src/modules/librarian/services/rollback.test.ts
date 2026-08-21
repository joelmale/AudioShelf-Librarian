import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Book, OrganizationAction } from "@audioshelf/shared";
import { rollbackBatch } from "./rollback.js";

let sandbox: string;
let inboxDir: string;
let libraryDir: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-rollback-"));
  inboxDir = path.join(sandbox, "inbox");
  libraryDir = path.join(sandbox, "library");
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(libraryDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const book = { title: "Elantris", authors: ["Brandon Sanderson"] } as unknown as Book;

function action(sourcePath: string, targetPath: string, overrides: Partial<OrganizationAction> = {}): OrganizationAction {
  return {
    book,
    action_type: "move",
    source_path: sourcePath,
    target_path: targetPath,
    reason: "test",
    executed: true,
    success: true,
    ...overrides,
  } as OrganizationAction;
}

/** Simulate a committed move, including the inbox cleanup the organizer performs. */
function commitMove(relativeSource: string, relativeTarget: string): OrganizationAction {
  const sourcePath = path.join(inboxDir, relativeSource);
  const targetPath = path.join(libraryDir, relativeTarget);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "audio");
  return action(sourcePath, targetPath);
}

const options = () => ({ inboxDir, libraryDir });

describe("rollbackBatch", () => {
  it("restores a file to its original inbox location", async () => {
    const moved = commitMove("Elantris.m4b", "Brandon Sanderson/Elantris.m4b");

    const summary = await rollbackBatch([moved], options());

    expect(summary.complete).toBe(true);
    expect(summary.rolledBack).toBe(1);
    expect(fs.existsSync(moved.source_path)).toBe(true);
    expect(fs.existsSync(moved.target_path)).toBe(false);
  });

  it("recreates a source directory the organizer cleaned up", async () => {
    // The regression: executeAction removes the emptied source folder, so the
    // rename back hit ENOENT, was swallowed, and the history entry was dropped.
    const moved = commitMove(path.join("Sanderson Pack", "Elantris.m4b"), "Brandon Sanderson/Elantris.m4b");
    expect(fs.existsSync(path.dirname(moved.source_path))).toBe(false);

    const summary = await rollbackBatch([moved], options());

    expect(summary.complete).toBe(true);
    expect(summary.failed).toBe(0);
    expect(fs.readFileSync(moved.source_path, "utf8")).toBe("audio");
  });

  it("reports incomplete when any action fails so the caller keeps the batch", async () => {
    const good = commitMove("Good.m4b", "Author/Good.m4b");
    const escaping = action(path.join(sandbox, "outside", "Bad.m4b"), path.join(libraryDir, "Author/Bad.m4b"));
    fs.mkdirSync(path.dirname(escaping.target_path), { recursive: true });
    fs.writeFileSync(escaping.target_path, "audio");

    const summary = await rollbackBatch([good, escaping], options());

    expect(summary.complete).toBe(false);
    expect(summary.rolledBack).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results[1].error).toMatch(/outside the configured directories/);
  });

  it("refuses to write a restore destination outside the configured roots", async () => {
    const escape = action(path.join(sandbox, "escape.m4b"), path.join(libraryDir, "Author/Book.m4b"));
    fs.mkdirSync(path.dirname(escape.target_path), { recursive: true });
    fs.writeFileSync(escape.target_path, "audio");

    const summary = await rollbackBatch([escape], options());

    expect(summary.failed).toBe(1);
    expect(fs.existsSync(escape.source_path)).toBe(false);
    expect(fs.existsSync(escape.target_path)).toBe(true);
  });

  it("treats an already-reverted action as success, not failure", async () => {
    const moved = commitMove("Elantris.m4b", "Brandon Sanderson/Elantris.m4b");
    fs.rmSync(moved.target_path);

    const summary = await rollbackBatch([moved], options());

    expect(summary.complete).toBe(true);
    expect(summary.alreadyReverted).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("is idempotent, so retrying a partial rollback finishes the job", async () => {
    const good = commitMove("Good.m4b", "Author/Good.m4b");
    const blocked = commitMove("Blocked.m4b", "Author/Blocked.m4b");
    // Occupy the restore destination so this one action fails.
    fs.writeFileSync(blocked.source_path, "conflict");

    const first = await rollbackBatch([good, blocked], options());
    expect(first.complete).toBe(false);
    expect(first.failed).toBe(1);

    // Operator clears the conflict, then retries the retained batch.
    fs.rmSync(blocked.source_path);
    const second = await rollbackBatch([good, blocked], options());

    expect(second.complete).toBe(true);
    expect(second.alreadyReverted).toBe(1);
    expect(second.rolledBack).toBe(1);
  });

  it("never clobbers an existing file at the restore destination", async () => {
    const moved = commitMove("Elantris.m4b", "Brandon Sanderson/Elantris.m4b");
    fs.writeFileSync(moved.source_path, "do not overwrite");

    const summary = await rollbackBatch([moved], options());

    expect(summary.failed).toBe(1);
    expect(fs.readFileSync(moved.source_path, "utf8")).toBe("do not overwrite");
  });

  it("skips non-filesystem actions without counting them as failures", async () => {
    const skipped = action(path.join(inboxDir, "a.m4b"), path.join(inboxDir, "a.m4b"), { action_type: "skip" });
    const duplicate = action(path.join(inboxDir, "b.m4b"), path.join(inboxDir, "b.m4b"), { action_type: "duplicate" });

    const summary = await rollbackBatch([skipped, duplicate], options());

    expect(summary.complete).toBe(true);
    expect(summary.notApplicable).toBe(2);
    expect(summary.rolledBack).toBe(0);
  });

  it("restores directory-shaped books, not just single files", async () => {
    const sourcePath = path.join(inboxDir, "Mistborn Pack");
    const targetPath = path.join(libraryDir, "Brandon Sanderson", "Mistborn", "1 - The Final Empire");
    fs.mkdirSync(targetPath, { recursive: true });
    fs.writeFileSync(path.join(targetPath, "01.mp3"), "audio");

    const summary = await rollbackBatch([action(sourcePath, targetPath)], options());

    expect(summary.complete).toBe(true);
    expect(fs.existsSync(path.join(sourcePath, "01.mp3"))).toBe(true);
  });
});
