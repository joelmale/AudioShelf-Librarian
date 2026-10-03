import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPathMapping,
  checkPathAccessible,
  isTorrentEligible,
  moveIntoInbox,
  resolveTorrentSourcePath,
} from "./torrentMonitor.js";

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

describe("applyPathMapping", () => {
  it("translates remote prefixes to local prefixes", () => {
    const mappings = [{ remotePath: "/downloads", localPath: "/local/torrents" }];
    expect(applyPathMapping("/downloads/complete/book.m4b", mappings)).toBe(
      path.join("/local/torrents", "complete", "book.m4b"),
    );
  });

  it("handles trailing slashes on remotePath correctly", () => {
    const mappings = [{ remotePath: "/downloads/", localPath: "/local/torrents" }];
    expect(applyPathMapping("/downloads/complete/book.m4b", mappings)).toBe(
      path.join("/local/torrents", "complete", "book.m4b"),
    );
  });

  it("normalizes Windows backslashes", () => {
    const mappings = [{ remotePath: "D:\\torrents", localPath: "/mnt/torrents" }];
    expect(applyPathMapping("D:\\torrents\\complete\\book.m4b", mappings)).toBe(
      path.join("/mnt/torrents", "complete", "book.m4b"),
    );
  });

  it("returns original path when no mapping matches or input is empty", () => {
    expect(applyPathMapping("", [])).toBe("");
    expect(applyPathMapping("/other/path", [{ remotePath: "/downloads", localPath: "/local" }])).toBe("/other/path");
  });
});

describe("checkPathAccessible", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns accessible: true when file exists and is readable", () => {
    vi.spyOn(fs, "accessSync").mockReturnValue(undefined);
    expect(checkPathAccessible("/any/path")).toEqual({ accessible: true });
  });

  it("returns accessible: false for generic ENOENT error", () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    expect(checkPathAccessible("/missing/path")).toEqual({ accessible: false });
  });

  it("identifies permission denied (EACCES) errors and formats an actionable message", () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    const result = checkPathAccessible("/restricted/path");
    expect(result.accessible).toBe(false);
    expect(result.error).toContain("Permission denied reading download path");
  });
});

describe("resolveTorrentSourcePath", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves direct content_path when accessible", async () => {
    vi.spyOn(fs, "accessSync").mockImplementation((p) => {
      if (p === path.resolve("/downloads/complete/Book.m4b")) return;
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    const torrent = {
      hash: "123",
      name: "Book",
      save_path: "/downloads/complete",
      content_path: "/downloads/complete/Book.m4b",
    } as any;

    const res = await resolveTorrentSourcePath(torrent, []);
    expect(res.found).toBe(true);
    expect(res.sourcePath).toBe(path.resolve("/downloads/complete/Book.m4b"));
  });

  it("resolves content_path missing an audio extension (e.g. .m4b)", async () => {
    vi.spyOn(fs, "accessSync").mockImplementation((p) => {
      if (p === path.resolve("/downloads/complete/Book.m4b")) return;
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    const torrent = {
      hash: "123",
      name: "Book",
      save_path: "/downloads/complete",
      content_path: "/downloads/complete/Book",
    } as any;

    const res = await resolveTorrentSourcePath(torrent, []);
    expect(res.found).toBe(true);
    expect(res.sourcePath).toBe(path.resolve("/downloads/complete/Book.m4b"));
  });

  it("resolves save_path + torrent.name when content_path is missing", async () => {
    vi.spyOn(fs, "accessSync").mockImplementation((p) => {
      if (p === path.resolve("/downloads/complete/Roadkill")) return;
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    const torrent = {
      hash: "123",
      name: "Roadkill",
      save_path: "/downloads/complete",
    } as any;

    const res = await resolveTorrentSourcePath(torrent, []);
    expect(res.found).toBe(true);
    expect(res.sourcePath).toBe(path.resolve("/downloads/complete/Roadkill"));
  });

  it("resolves via qBittorrent getTorrentFiles when display title differs from on-disk filename", async () => {
    vi.spyOn(fs, "accessSync").mockImplementation((p) => {
      if (p === path.resolve("/downloads/complete/Dennis E. Taylor - Feedback.m4b")) return;
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    const torrent = {
      hash: "123",
      name: "Feedback - Dennis E. Taylor",
      save_path: "/downloads/complete",
      content_path: "/downloads/complete/Feedback - Dennis E. Taylor",
    } as any;

    const fakeQbt = {
      getTorrentFiles: vi.fn().mockResolvedValue([
        { index: 0, name: "Dennis E. Taylor - Feedback.m4b", size: 1000, progress: 1, priority: 1 },
      ]),
    };

    const res = await resolveTorrentSourcePath(torrent, [], fakeQbt as any);
    expect(res.found).toBe(true);
    expect(res.sourcePath).toBe(path.resolve("/downloads/complete/Dennis E. Taylor - Feedback.m4b"));
  });

  it("resolves multi-file torrent via qBittorrent getTorrentFiles top-level directory", async () => {
    vi.spyOn(fs, "accessSync").mockImplementation((p) => {
      if (p === path.resolve("/downloads/complete/Bobiverse Trilogy")) return;
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    const torrent = {
      hash: "123",
      name: "Bobiverse",
      save_path: "/downloads/complete",
    } as any;

    const fakeQbt = {
      getTorrentFiles: vi.fn().mockResolvedValue([
        { index: 0, name: "Bobiverse Trilogy/Book1.m4b", size: 1000, progress: 1, priority: 1 },
        { index: 1, name: "Bobiverse Trilogy/Book2.m4b", size: 1000, progress: 1, priority: 1 },
      ]),
    };

    const res = await resolveTorrentSourcePath(torrent, [], fakeQbt as any);
    expect(res.found).toBe(true);
    expect(res.sourcePath).toBe(path.resolve("/downloads/complete/Bobiverse Trilogy"));
  });

  it("falls back to directory scan inside save_path when naming differs", async () => {
    vi.spyOn(fs, "accessSync").mockImplementation((p) => {
      if (p === path.resolve("/downloads/complete") || p === path.resolve("/downloads/complete/Dennis E. Taylor - Feedback.m4b")) return;
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    vi.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => true } as any);
    vi.spyOn(fs, "readdirSync").mockReturnValue(["Dennis E. Taylor - Feedback.m4b", "other.txt"] as any);

    const torrent = {
      hash: "123",
      name: "Dennis E. Taylor - Feedback",
      save_path: "/downloads/complete",
    } as any;

    const res = await resolveTorrentSourcePath(torrent, []);
    expect(res.found).toBe(true);
    expect(res.sourcePath).toBe(path.resolve("/downloads/complete/Dennis E. Taylor - Feedback.m4b"));
  });

  it("surfaces permission errors when accessing download path", async () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    const torrent = {
      hash: "123",
      name: "Book",
      save_path: "/downloads/complete",
      content_path: "/downloads/complete/Book.m4b",
    } as any;

    const res = await resolveTorrentSourcePath(torrent, []);
    expect(res.found).toBe(false);
    expect(res.reason).toContain("Permission denied reading download path");
  });

  it("applies pathMappings to torrent paths before resolution", async () => {
    const mappings = [{ remotePath: "/remote/downloads", localPath: "/local/downloads" }];
    vi.spyOn(fs, "accessSync").mockImplementation((p) => {
      if (p === path.resolve("/local/downloads/complete/Book.m4b")) return;
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    const torrent = {
      hash: "123",
      name: "Book",
      save_path: "/remote/downloads/complete",
      content_path: "/remote/downloads/complete/Book.m4b",
    } as any;

    const res = await resolveTorrentSourcePath(torrent, mappings);
    expect(res.found).toBe(true);
    expect(res.sourcePath).toBe(path.resolve("/local/downloads/complete/Book.m4b"));
  });
});
