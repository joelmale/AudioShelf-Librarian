import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QBittorrentService, QbitTorrent } from "./qbittorrent.js";

vi.mock("node-cron", () => ({ default: { schedule: vi.fn(() => ({ stop: vi.fn() })) } }));

const settings = { inboxDir: "", pathMappings: [] as unknown[] };
vi.mock("../../../config/settings.js", () => ({
  SettingsStore: { getInstance: () => ({ getSettings: () => settings }) },
}));

import { TorrentMonitorService } from "./torrentMonitor.js";

describe("TorrentMonitorService blocked imports", () => {
  let tmp: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-monitor-blocked-"));
    previousDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = path.join(tmp, "data");
    settings.inboxDir = path.join(tmp, "inbox");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const torrentAt = (contentPath: string): QbitTorrent => ({
    hash: "feedfacefeedfacefeedfacefeedfacefeedface",
    name: "Roadkill",
    progress: 1,
    state: "forcedUP",
    save_path: path.dirname(contentPath),
    content_path: contentPath,
  } as QbitTorrent);

  const qbt = (torrent: QbitTorrent) => ({
    getTorrents: vi.fn().mockResolvedValue([torrent]),
    getTorrentFiles: vi.fn().mockResolvedValue([]),
    removeTorrent: vi.fn().mockResolvedValue(undefined),
  }) as unknown as QBittorrentService;

  it("reports a download path AudioShelf cannot see, warns once, and leaves the torrent in qBittorrent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const torrent = torrentAt(path.join(tmp, "not-mounted", "Roadkill"));
    const service = qbt(torrent);
    const onBlocked = vi.fn();
    const monitor = new TorrentMonitorService(service, vi.fn(), onBlocked);

    const first = await monitor.checkAndImport();
    const second = await monitor.checkAndImport();
    monitor.stop();

    expect(first[0]).toMatchObject({ status: "unavailable" });
    expect(second[0]).toMatchObject({ status: "unavailable" });
    // The acquisition is told every cycle (cheap, idempotent)...
    expect(onBlocked).toHaveBeenCalledTimes(2);
    expect(onBlocked).toHaveBeenCalledWith(torrent, expect.stringContaining("not visible"));
    // ...but the log is not spammed once a minute for the same reason.
    expect(warn.mock.calls.filter(([message]) => String(message).includes("[torrent-import]"))).toHaveLength(1);
    expect(service.removeTorrent).not.toHaveBeenCalled();
  });

  it("reports an existing inbox folder as a conflict without touching either copy", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = path.join(tmp, "downloads", "Roadkill");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "a.mp3"), "source");
    const existing = path.join(settings.inboxDir, "Roadkill");
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, "a.mp3"), "already here");

    const service = qbt(torrentAt(source));
    const onBlocked = vi.fn();
    const monitor = new TorrentMonitorService(service, vi.fn(), onBlocked);

    const [result] = await monitor.checkAndImport();
    monitor.stop();

    expect(result).toMatchObject({ status: "conflict" });
    expect(onBlocked).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("already exists"));
    expect(fs.readFileSync(path.join(source, "a.mp3"), "utf8")).toBe("source");
    expect(fs.readFileSync(path.join(existing, "a.mp3"), "utf8")).toBe("already here");
    expect(service.removeTorrent).not.toHaveBeenCalled();
  });

  it("does not report anything when the import succeeds", async () => {
    const source = path.join(tmp, "downloads", "Roadkill");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "a.mp3"), "audio");

    const onBlocked = vi.fn();
    const onImported = vi.fn();
    const service = qbt(torrentAt(source));
    const monitor = new TorrentMonitorService(service, onImported, onBlocked);

    const [result] = await monitor.checkAndImport();
    monitor.stop();

    expect(result).toMatchObject({ status: "imported" });
    expect(onImported).toHaveBeenCalledOnce();
    expect(onBlocked).not.toHaveBeenCalled();
    expect(service.removeTorrent).toHaveBeenCalledOnce();
  });
});
