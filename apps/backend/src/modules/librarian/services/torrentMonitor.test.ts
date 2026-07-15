import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moveIntoInbox } from "./torrentMonitor.js";

describe("moveIntoInbox", () => {
  afterEach(() => vi.restoreAllMocks());

  it("copies read-only downloads and delegates source deletion to qBittorrent", async () => {
    vi.spyOn(fs.promises, "rename").mockRejectedValue(Object.assign(new Error("read only"), { code: "EROFS" }));
    const copy = vi.spyOn(fs.promises, "cp").mockResolvedValue(undefined);
    const remove = vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined);

    await expect(moveIntoInbox("/downloads/book", "/inbox/book")).resolves.toBe("copied-needs-client-delete");
    expect(copy).toHaveBeenCalledWith("/downloads/book", "/inbox/book", { recursive: true, errorOnExist: true });
    expect(remove).not.toHaveBeenCalled();
  });

  it("cleans up the source itself after a cross-device copy", async () => {
    vi.spyOn(fs.promises, "rename").mockRejectedValue(Object.assign(new Error("cross device"), { code: "EXDEV" }));
    vi.spyOn(fs.promises, "cp").mockResolvedValue(undefined);
    const remove = vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined);

    await expect(moveIntoInbox("/downloads/book", "/inbox/book")).resolves.toBe("copied-and-removed");
    expect(remove).toHaveBeenCalledWith("/downloads/book", { recursive: true, force: true });
  });
});
