import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTorrentEligible, moveIntoInbox } from "./torrentMonitor.js";

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

describe("isTorrentEligible", () => {
  const torrent = { hash: "abc", progress: 1 } as any;

  it("limits a manual run to selected completed hashes", () => {
    expect(isTorrentEligible(torrent, new Set(), new Set(["abc"]))).toBe(true);
    expect(isTorrentEligible(torrent, new Set(), new Set(["other"]))).toBe(false);
    expect(isTorrentEligible({ ...torrent, progress: 0.99 }, new Set(), new Set(["abc"]))).toBe(false);
  });

  it("allows manual recovery to retry a previously recorded hash", () => {
    expect(isTorrentEligible(torrent, new Set(["abc"]), new Set(["abc"]))).toBe(false);
    expect(isTorrentEligible(torrent, new Set(["abc"]), new Set(["abc"]), true)).toBe(true);
  });
});
