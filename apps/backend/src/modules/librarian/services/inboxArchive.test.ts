import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InboxArchive, INBOX_ARCHIVE, torrentArchiveBlocker } from "./inboxArchive.js";
import type { QbitTorrent } from "./qbittorrent.js";

let sandbox: string;
let inbox: string;
let library: string;
let source: string;
const verification = vi.fn();
const torrentBlocker = vi.fn<(source: string) => Promise<string | undefined>>();
const archive = () => new InboxArchive({ inbox: () => inbox, library: () => library,
  review: { cleanupCoverage: verification }, torrentBlocker });

beforeEach(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "intake-cleanup-")));
  inbox = path.join(sandbox, "inbox");
  library = path.join(sandbox, "library");
  source = path.join(inbox, "A collection");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(library);
  await fs.writeFile(path.join(source, "book.mp3"), "audio");
  verification.mockReset().mockResolvedValue({ importedBooks: 1, duplicateBooks: 0, covered: new Set(["book.mp3"]), blockers: [] });
  torrentBlocker.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(sandbox, { recursive: true, force: true });
});

it("archives the complete folder and restores the same data after a service restart", async () => {
  await fs.writeFile(path.join(source, ".DS_Store"), "sidecar");
  const service = archive();
  const preview = await service.preview(source, "Collection");
  expect(preview).toMatchObject({ audioFiles: 1, otherFiles: 1, blockers: [], token: expect.any(String) });
  const item = await service.archive(source, "Collection", preview.token!);
  await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  const restarted = archive();
  expect(await restarted.list()).toEqual([item]);

  await fs.mkdir(source);
  await expect(restarted.restore(item.id)).rejects.toThrow("already occupies");
  expect(await restarted.list()).toEqual([item]);
  await fs.rmdir(source);
  expect(await restarted.restore(item.id)).toEqual({ restored: true });
  expect(await fs.readFile(path.join(source, ".DS_Store"), "utf8")).toBe("sidecar");
  expect(await fs.readFile(path.join(source, "book.mp3"), "utf8")).toBe("audio");
  expect(await restarted.list()).toEqual([]);
});

it("rechecks changed hidden files and never archives a newly blocked source", async () => {
  const service = archive();
  const preview = await service.preview(source, "Collection");
  await fs.writeFile(path.join(source, ".sidecar"), "new");
  await expect(service.archive(source, "Collection", preview.token!)).rejects.toThrow("source changed");
  const updated = await service.preview(source, "Collection");
  torrentBlocker.mockResolvedValue("A registered torrent uses this source.");
  await expect(service.archive(source, "Collection", updated.token!)).rejects.toThrow("registered torrent");
  expect(await fs.readFile(path.join(source, ".sidecar"), "utf8")).toBe("new");
  expect(await service.list()).toEqual([]);
});

it("fails closed on hidden unresolved audio, changed library coverage, and linked entries", async () => {
  const service = archive();
  const preview = await service.preview(source, "Collection");
  verification.mockResolvedValueOnce({ importedBooks: 1, duplicateBooks: 0, covered: new Set(["book.mp3"]), blockers: ["Library copy is missing."] });
  await expect(service.archive(source, "Collection", preview.token!)).rejects.toThrow("Library copy is missing");
  await fs.writeFile(path.join(source, ".hidden.mp3"), "second audio");
  expect(await service.preview(source, "Collection")).toMatchObject({ token: undefined, blockers: ["The folder still contains audio without a resolved book decision."] });
  await fs.symlink(library, path.join(source, "linked"), "junction");
  expect(await service.preview(source, "Collection")).toMatchObject({ token: undefined, blockers: [expect.stringMatching(/verify|linked/)] });
});

it("keeps the source and ignores unpublished recovery records when rename fails", async () => {
  const service = archive();
  const preview = await service.preview(source, "Collection");
  vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("device"), { code: "EXDEV" }));
  await expect(service.archive(source, "Collection", preview.token!)).rejects.toThrow("device");
  expect(await fs.readFile(path.join(source, "book.mp3"), "utf8")).toBe("audio");
  expect(await fs.readdir(path.join(inbox, INBOX_ARCHIVE))).toHaveLength(1);
  expect(await archive().list()).toEqual([]);
});

it("checks every torrent category, including stopped payloads, and blocks unknown paths", async () => {
  const getTorrents = vi.fn<() => Promise<QbitTorrent[]>>();
  const torrent = (contentPath: string, savePath: string) =>
    ({ content_path: contentPath, save_path: savePath, state: "stoppedUP" } as QbitTorrent);
  getTorrents.mockResolvedValue([torrent(path.join(source, "book.mp3"), source)]);
  expect(await torrentArchiveBlocker(source, { getTorrents }, [])).toMatch(/registered torrent/);
  expect(getTorrents).toHaveBeenCalledWith("all");
  getTorrents.mockResolvedValue([torrent("/remote/A collection/book.mp3", "/remote")]);
  expect(await torrentArchiveBlocker(source, { getTorrents }, [{ remotePath: "/remote", localPath: inbox }])).toMatch(/registered torrent/);
  expect(await torrentArchiveBlocker(source, { getTorrents }, [])).toMatch(/Could not verify/);
  getTorrents.mockRejectedValue(new Error("unreachable"));
  expect(await torrentArchiveBlocker(source, { getTorrents }, [])).toMatch(/Could not verify/);
  getTorrents.mockResolvedValue([torrent(path.join(library, "finished.mp3"), library)]);
  expect(await torrentArchiveBlocker(source, { getTorrents }, [])).toBeUndefined();
  const subfolder = path.join(source, "Disc");
  const alias = path.join(sandbox, "client view");
  await fs.mkdir(subfolder);
  await fs.writeFile(path.join(subfolder, "track.mp3"), "audio");
  await fs.symlink(subfolder, alias, "junction");
  getTorrents.mockResolvedValue([torrent(path.join(alias, "track.mp3"), alias)]);
  expect(await torrentArchiveBlocker(source, { getTorrents }, [])).toMatch(/registered torrent/);
});
