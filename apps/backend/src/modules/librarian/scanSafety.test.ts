import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Book, OrganizationAction } from "@audioshelf/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../../config/settings.js";
import type { WsRouter } from "../../websocket/index.js";
import { AudiobookOrganizer } from "./services/organizer.js";
import { MetadataScanner } from "./services/scanner.js";
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

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-plan-scan-"));
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

    previousSettingsStore = (SettingsStore as unknown as { instance?: SettingsStore }).instance;
    const settingsStore = new SettingsStore(dataDir);
    settingsStore.updateSettings({ inboxDir, libraryDir });
    (SettingsStore as unknown as { instance: SettingsStore }).instance = settingsStore;

    const book: Book = {
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
    const action: OrganizationAction = {
      book,
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
    vi.spyOn(MetadataScanner.prototype, "scanTarget").mockResolvedValue(book);
    vi.spyOn(AudiobookOrganizer.prototype, "organizeBook").mockResolvedValue(action);

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
});
