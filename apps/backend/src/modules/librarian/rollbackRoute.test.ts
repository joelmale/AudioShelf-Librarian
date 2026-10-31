import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Book, OrganizationAction } from "@audioshelf/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../../config/settings.js";
import { HistoryStore } from "../../config/history.js";
import type { WsRouter } from "../../websocket/index.js";
import { AudiobookOrganizer } from "./services/organizer.js";
import { MetadataScanner } from "./services/scanner.js";
import { IngestStore } from "./ingestStore.js";
import { createLibrarianRouter } from "./index.js";

vi.mock("node-cron", () => ({ default: { schedule: vi.fn() } }));

/**
 * An undo is a decision. The job behind an imported book is already complete,
 * so unless the rollback route dismisses its ingest items, the inbox poller
 * sees the restored folder as new and imports it straight back.
 */
describe("rollback route", () => {
  let dataDir: string;
  let sourceDir: string;
  let targetDir: string;
  let server: Server | undefined;
  let baseUrl: string;
  let ingestStore: IngestStore;
  let previousDataDir: string | undefined;
  let previousDbPath: string | undefined;
  let previousSettingsStore: SettingsStore | undefined;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-rollback-route-"));
    const inboxDir = path.join(dataDir, "inbox");
    const libraryDir = path.join(dataDir, "library");
    sourceDir = path.join(inboxDir, "Undo Book");
    const sourceFile = path.join(sourceDir, "Undo Book.mp3");
    targetDir = path.join(libraryDir, "Test Author", "Undo Book");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.writeFileSync(sourceFile, "disposable fixture");

    previousDataDir = process.env.DATA_DIR;
    previousDbPath = process.env.DB_PATH;
    process.env.DATA_DIR = dataDir;
    process.env.DB_PATH = ":memory:";
    (HistoryStore as unknown as { instance?: HistoryStore }).instance = undefined;

    previousSettingsStore = (SettingsStore as unknown as { instance?: SettingsStore }).instance;
    const settingsStore = new SettingsStore(dataDir);
    settingsStore.updateSettings({ inboxDir, libraryDir });
    (SettingsStore as unknown as { instance: SettingsStore }).instance = settingsStore;

    const book = {
      title: "Undo Book", authors: ["Test Author"], series: null, series_number: null, narrator: null,
      publisher: null, published_year: null, isbn: null, language: null, genre: null, description: null,
      duration: null, source_path: sourceDir, audio_files: [sourceFile], cover_file: null,
      metadata_source: "filename", confidence_score: 0.5, abs_item_id: null, abs_library_id: null,
      is_series: false, needs_processing: true,
    } as Book;
    const action: OrganizationAction = {
      book, action_type: "move", source_path: sourceDir, target_path: targetDir,
      reason: "test", executed: false, success: false,
    };
    vi.spyOn(MetadataScanner.prototype, "discoverTargets").mockResolvedValue([sourceDir]);
    vi.spyOn(MetadataScanner.prototype, "scanTarget").mockResolvedValue(book);
    vi.spyOn(AudiobookOrganizer.prototype, "organizeBook").mockResolvedValue(action);

    ingestStore = new IngestStore(path.join(dataDir, "curator.db"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.principal = { subject: "rollback-test", role: "administrator", libraries: [], claims: {} };
      next();
    });
    app.use("/api/librarian", createLibrarianRouter({ PORT: 0 }, { broadcast: vi.fn() } as unknown as WsRouter, { ingestStore }));
    const listening = app.listen(0);
    server = listening;
    await new Promise<void>((resolve) => listening.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/api/librarian`;
  });

  afterEach(async () => {
    const listening = server;
    if (listening) await new Promise<void>((resolve) => listening.close(() => resolve()));
    vi.restoreAllMocks();
    ingestStore.close();
    if (previousSettingsStore) (SettingsStore as unknown as { instance: SettingsStore }).instance = previousSettingsStore;
    else delete (SettingsStore as unknown as { instance?: SettingsStore }).instance;
    if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
    if (previousDbPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = previousDbPath;
    (HistoryStore as unknown as { instance?: HistoryStore }).instance = undefined;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function importViaScan(): Promise<string> {
    const started = await fetch(`${baseUrl}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(started.status).toBe(200);
    await vi.waitFor(() => {
      const batch = HistoryStore.getInstance().getLatestBatch();
      expect(batch?.actions.length).toBe(1);
    }, { timeout: 5000 });
    return HistoryStore.getInstance().getLatestBatch()!.id;
  }

  it("restores the book and dismisses its ingest item so the poller leaves it alone", async () => {
    const batchId = await importViaScan();
    expect(fs.existsSync(targetDir)).toBe(true);
    expect(fs.existsSync(sourceDir)).toBe(false);
    expect(ingestStore.lastDismissedAt(sourceDir)).toBeNull();

    const res = await fetch(`${baseUrl}/scan/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId }),
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(sourceDir)).toBe(true);
    expect(fs.existsSync(targetDir)).toBe(false);

    expect(ingestStore.lastDismissedAt(sourceDir)).not.toBeNull();
    const states = ingestStore.list().flatMap((job) => job.items.map((item) => item.state));
    expect(states).toEqual(["discarded"]);
  });

  it("rolls back the named batch rather than the newest one", async () => {
    const first = await importViaScan();
    const other = HistoryStore.getInstance().addBatch([]);
    expect(HistoryStore.getInstance().getLatestBatch()?.id).toBe(other);

    const res = await fetch(`${baseUrl}/scan/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId: first }),
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(sourceDir)).toBe(true);
    expect(HistoryStore.getInstance().getHistory().map((batch) => batch.id)).toEqual([other]);
  });
});
