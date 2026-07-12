import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertContained } from "./paths.js";

const created: string[] = [];
afterEach(() => created.splice(0).forEach((p) => fs.rmSync(p, { recursive: true, force: true })));

describe("assertContained", () => {
  it("accepts descendants and rejects prefix collisions and the root", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "asl-path-")); created.push(base);
    const root = path.join(base, "inbox"); const sibling = path.join(base, "inbox-other");
    fs.mkdirSync(path.join(root, "book"), { recursive: true }); fs.mkdirSync(sibling);
    await expect(assertContained(path.join(root, "book"), root, { mustExist: true })).resolves.toBeTruthy();
    await expect(assertContained(sibling, root, { mustExist: true })).rejects.toThrow();
    await expect(assertContained(root, root, { mustExist: true })).rejects.toThrow();
  });
});
