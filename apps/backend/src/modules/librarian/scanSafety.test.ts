import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import cron from "node-cron";
import type { Book, OrganizationAction } from "@audioshelf/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../../config/settings.js";
import type { WsRouter } from "../../websocket/index.js";
import { AudiobookOrganizer } from "./services/organizer.js";
import { MetadataScanner } from "./services/scanner.js";
import { QBittorrentService } from "./services/qbittorrent.js";
import { INBOX_QUIET_PERIOD_MS, InboxPollerService } from "./services/inboxPoller.js";
import { createLibrarianRouter, shouldAutoExecuteScanAction } from "./index.js";

vi.mock("node-cron", () => ({ default: { schedule: vi.fn() } }));

describe("controlled scan safety", () => {
  it.each(["move", "rename"] as const)("never auto-executes %s actions in plan-only mode", (actionType) => {
    expect(shouldAutoExecuteScanAction(actionType, true)).toBe(false);
    expect(shouldAutoExecuteScanAction(actionType, false)).toBe(true);
  });

  it.each(["duplicate", "error", "skip"] as const)("never auto-executes %s actions", (actionType) => {
    expect(shouldAutoExecuteScanAction(actionType, true)).toBe(false);
    expect(shouldAutoExecuteScanAction(actionType, false)).toBe(false);
  });
});

describe("plan-only scan session routes", () => {
  let dataDir: string;
  let inboxDir: string;
  let libraryDir: string;
  let sourceDir: string;
  let sourceFile: string;
  let targetDir: string;
  let server: Server | undefined;
  let baseUrl: string;
  let previousDataDir: string | undefined;
  let previousDbPath: string | undefined;
  let previousSettingsStore: SettingsStore | undefined;
  let broadcast: ReturnType<typeof vi.fn>;
  let scanBook: Book;
  let scanAction: OrganizationAction;

  beforeEach(async () => {
    dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-plan-scan-")));
    inboxDir = path.join(dataDir, "inbox");
    libraryDir = path.join(dataDir, "library");
    sourceDir = path.join(inboxDir, "Safety Book");
    sourceFile = path.join(sourceDir, "Safety Book.mp3");
    targetDir = path.join(libraryDir, "Test Author", "Safety Book");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.writeFileSync(sourceFile, "disposable scan fixture");

    previousDataDir = process.env.DATA_DIR;
    previousDbPath = process.env.DB_PATH;
    process.env.DATA_DIR = dataDir;
    process.env.DB_PATH = ":memory:";
    vi.stubEnv("ABB_OFFLINE", "true");
    vi.stubEnv("ABS_URL", "");
    vi.stubEnv("ABS_TOKEN", "");
    vi.spyOn(QBittorrentService.prototype, "getTorrents").mockResolvedValue([]);
    vi.mocked(cron.schedule).mockClear();

    previousSettingsStore = (SettingsStore as unknown as { instance?: SettingsStore }).instance;
    const settingsStore = new SettingsStore(dataDir);
    settingsStore.updateSettings({ inboxDir, libraryDir });
    (SettingsStore as unknown as { instance: SettingsStore }).instance = settingsStore;

    scanBook = {
      title: "Safety Book",
      authors: ["Test Author"],
      series: null,
      series_number: null,
      narrator: null,
      publisher: null,
      published_year: null,
      isbn: null,
      language: null,
      genre: null,
      description: null,
      duration: null,
      source_path: sourceDir,
      audio_files: [sourceFile],
      cover_file: null,
      metadata_source: "filename",
      confidence_score: 0.5,
      abs_item_id: null,
      abs_library_id: null,
      is_series: false,
      needs_processing: true,
    };
    scanAction = {
      book: scanBook,
      action_type: "move",
      source_path: sourceDir,
      target_path: targetDir,
      reason: "Controlled test proposal",
      executed: false,
      success: false,
    };

    vi.spyOn(MetadataScanner.prototype, "discoverTargets").mockImplementation(
      async (_dir, _onWarning, onProgress) => {
        onProgress?.(sourceDir);
        return [sourceDir];
      },
    );
    vi.spyOn(MetadataScanner.prototype, "scanTarget").mockResolvedValue(scanBook);
    vi.spyOn(AudiobookOrganizer.prototype, "organizeBook").mockResolvedValue(scanAction);

    broadcast = vi.fn();
    const ws = { broadcast } as unknown as WsRouter;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.principal = {
        subject: "plan-scan-test",
        role: "administrator",
        libraries: [],
        claims: {},
      };
      next();
    });
    app.use("/api/librarian", createLibrarianRouter({ PORT: 0 }, ws));
    const listeningServer = app.listen(0);
    server = listeningServer;
    await new Promise<void>((resolve) => listeningServer.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(listeningServer.address() as AddressInfo).port}/api/librarian`;
  });

  afterEach(async () => {
    const listeningServer = server;
    if (listeningServer) await new Promise<void>((resolve) => listeningServer.close(() => resolve()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (previousSettingsStore) {
      (SettingsStore as unknown as { instance: SettingsStore }).instance = previousSettingsStore;
    } else {
      delete (SettingsStore as unknown as { instance?: SettingsStore }).instance;
    }
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("scans a canonical book alias and records the same configured inbox path as acquisitions", async () => {
    vi.mocked(MetadataScanner.prototype.discoverTargets).mockRestore();
    vi.mocked(MetadataScanner.prototype.scanTarget).mockRestore();
    vi.mocked(AudiobookOrganizer.prototype.organizeBook).mockRestore();
    const disc = path.join(sourceDir, "CD1");
    fs.mkdirSync(disc);
    const firstTrack = path.join(disc, "01.mp3");
    fs.writeFileSync(firstTrack, "synthetic track");
    fs.writeFileSync(path.join(sourceDir, "metadata.json"), JSON.stringify({ title: "Safety Book", authors: ["Test Author"] }));
    const configuredInbox = path.join(dataDir, "inbox-alias");
    fs.symlinkSync(inboxDir, configuredInbox, "junction");
    SettingsStore.getInstance().updateSettings({ inboxDir: configuredInbox });
    const alias = path.join(configuredInbox, "Safety Book Alias");
    fs.symlinkSync(sourceDir, alias, "junction");
    const acquisitionPath = path.join(configuredInbox, path.basename(sourceDir));
    const discoverTargets = vi.spyOn(MetadataScanner.prototype, "discoverTargets");
    const executeAction = vi.spyOn(AudiobookOrganizer.prototype, "executeAction");

    const started = await fetch(baseUrl + "/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetDir: alias, planOnly: true }),
    });
    expect(started.status).toBe(200);
    const { jobId } = await started.json() as { jobId: string };
    await vi.waitFor(() => expect(broadcast.mock.calls.some(([message]) => (
      message.type === "librarian:scan_progress" && message.payload.jobId === jobId && message.payload.status === "completed"
    ))).toBe(true));

    const persisted = await fetch(baseUrl + "/jobs/" + jobId).then(response => response.json());
    expect(discoverTargets.mock.calls[0][0]).toBe(sourceDir);
    expect(persisted.data.targetDir).toBe(acquisitionPath);
    expect(persisted.data.items).toHaveLength(1);
    expect(persisted.data.items[0].action).toMatchObject({
      source_path: acquisitionPath,
      book: {
        title: "Safety Book",
        authors: ["Test Author"],
        source_path: acquisitionPath,
        audio_files: expect.arrayContaining([path.join(acquisitionPath, path.basename(sourceFile)), path.join(acquisitionPath, "CD1", "01.mp3")]),
      },
    });
    expect(executeAction).not.toHaveBeenCalled();
    expect(fs.readFileSync(firstTrack, "utf-8")).toBe("synthetic track");
  });

  it("rejects similarly named sibling directories and escaping inbox aliases before dispatching a scan", async () => {
    const outside = inboxDir + "-outside";
    fs.mkdirSync(outside);
    const alias = path.join(inboxDir, "Outside Alias");
    fs.symlinkSync(outside, alias, "junction");

    for (const targetDir of [outside, alias]) {
      const response = await fetch(baseUrl + "/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetDir, planOnly: true }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "Path is outside all configured roots" });
    }
    expect(MetadataScanner.prototype.discoverTargets).not.toHaveBeenCalled();
  });

  it("leaves a mixed package in the inbox when the automatic poller discovers it", async () => {
    vi.mocked(MetadataScanner.prototype.scanTarget).mockRestore();
    const mixed = path.join(inboxDir, "Package");
    const child = path.join(mixed, "Another Book");
    const firstTrack = path.join(mixed, "Part 1.mp3");
    const otherBook = path.join(child, "audio.m4b");
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(firstTrack, "synthetic track");
    fs.writeFileSync(otherBook, "synthetic separate book");
    const settled = new Date(Date.now() - INBOX_QUIET_PERIOD_MS - 1000);
    for (const entry of [firstTrack, otherBook, child, mixed]) fs.utimesSync(entry, settled, settled);

    const poll = vi.spyOn(InboxPollerService.prototype, "poll");
    const scheduledTask = vi.mocked(cron.schedule).mock.calls.find(([expression]) => expression === "*/5 * * * *")?.[1];
    if (typeof scheduledTask !== "function") throw new Error("Missing inbox poll task");
    scheduledTask({} as Parameters<typeof scheduledTask>[0]);
    expect(poll).toHaveBeenCalledOnce();
    await poll.mock.results[0].value;

    const jobs = await fetch(baseUrl + "/jobs").then(response => response.json());
    expect(jobs.data).toEqual(expect.arrayContaining([expect.objectContaining({
      targetDir: mixed,
      items: [expect.objectContaining({ state: "failed", error: expect.stringContaining("dedicated book folder") })],
    })]));
    expect(AudiobookOrganizer.prototype.organizeBook).not.toHaveBeenCalled();
    expect(fs.readFileSync(firstTrack, "utf-8")).toBe("synthetic track");
    expect(fs.readFileSync(otherBook, "utf-8")).toBe("synthetic separate book");
  });

  it("keeps a plan-only session read-only across every scan mutation route", async () => {
    const executeAction = vi.spyOn(AudiobookOrganizer.prototype, "executeAction");
    const started = await fetch(`${baseUrl}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetDir: inboxDir, scanOrder: "alphabetical", planOnly: true }),
    });
    expect(started.status).toBe(200);
    const startedBody = await started.json() as { jobId: string; mode: string };
    expect(startedBody.mode).toBe("plan-only");

    const persistedJob = await fetch(`${baseUrl}/jobs/${startedBody.jobId}`).then((response) => response.json()) as { data: { planOnly: boolean } };
    expect(persistedJob.data.planOnly).toBe(true);

    await vi.waitFor(() => {
      expect(broadcast.mock.calls.some(([message]) => (
        message.type === "librarian:scan_progress" && message.payload.status === "completed"
      ))).toBe(true);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const progressMessages = broadcast.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "librarian:scan_progress");
    expect(progressMessages.map((message) => message.payload.status)).toEqual([
      "discovering",
      "scanning",
      "completed",
    ]);
    expect(progressMessages.every((message) => message.payload.planOnly === true)).toBe(true);
    expect(progressMessages.every((message) => message.payload.jobId === startedBody.jobId)).toBe(true);
    expect(executeAction).not.toHaveBeenCalled();
    expect(fs.existsSync(sourceFile)).toBe(true);

    const mutations: Array<[string, unknown]> = [
      ["/scan/delete", { source_path: sourceDir }],
      ["/scan/integrate-duplicate", { source_path: sourceDir }],
      ["/scan/commit", { selectedPaths: [sourceDir] }],
      ["/scan/rollback", {}],
      ["/scan/enhance-metadata", { action: { source_path: sourceDir } }],
      [`/jobs/${startedBody.jobId}/retry`, {}],
    ];

    for (const [endpoint, body] of mutations) {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, endpoint).toBe(409);
      expect(await response.json(), endpoint).toMatchObject({ code: "PLAN_ONLY_SESSION" });
    }

    expect(executeAction).not.toHaveBeenCalled();
    expect(fs.existsSync(sourceFile)).toBe(true);
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it("persists a discarded state after deleting a duplicate", async () => {
    vi.spyOn(AudiobookOrganizer.prototype, "organizeBook").mockResolvedValue({
      ...scanAction,
      action_type: "duplicate",
      reason: "Already in library",
    });
    const started = await fetch(`${baseUrl}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetDir: inboxDir, planOnly: false }),
    });
    const { jobId } = await started.json() as { jobId: string };
    await vi.waitFor(() => expect(broadcast.mock.calls.some(([message]) => (
      message.type === "librarian:scan_progress" && message.payload.status === "completed"
    ))).toBe(true));

    const deleted = await fetch(`${baseUrl}/scan/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_path: sourceDir }),
    });

    expect(deleted.status).toBe(200);
    expect(fs.existsSync(sourceDir)).toBe(false);
    const persisted = await fetch(`${baseUrl}/jobs/${jobId}`).then((response) => response.json()) as {
      data: { state: string; items: Array<{ state: string }> };
    };
    expect(persisted.data).toMatchObject({ state: "complete", items: [{ state: "discarded" }] });
  });

  it("keeps the duplicate pending when filesystem deletion fails", async () => {
    vi.spyOn(AudiobookOrganizer.prototype, "organizeBook").mockResolvedValue({
      ...scanAction,
      action_type: "duplicate",
      reason: "Already in library",
    });
    const started = await fetch(`${baseUrl}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetDir: inboxDir, planOnly: false }),
    });
    const { jobId } = await started.json() as { jobId: string };
    await vi.waitFor(() => expect(broadcast.mock.calls.some(([message]) => (
      message.type === "librarian:scan_progress" && message.payload.status === "completed"
    ))).toBe(true));
    vi.spyOn(fs.promises, "rm").mockRejectedValueOnce(new Error("simulated delete failure"));

    const deleted = await fetch(`${baseUrl}/scan/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_path: sourceDir }),
    });

    expect(deleted.status).toBe(500);
    expect(fs.existsSync(sourceDir)).toBe(true);
    const persisted = await fetch(`${baseUrl}/jobs/${jobId}`).then((response) => response.json()) as {
      data: { items: Array<{ state: string }> };
    };
    expect(persisted.data.items[0].state).toBe("discovered");
  });
});
