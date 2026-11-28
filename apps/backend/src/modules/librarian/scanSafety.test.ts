import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import cron from "node-cron";
import { parseBlob } from "music-metadata";
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
vi.mock("music-metadata", async importOriginal => {
  const actual = await importOriginal<typeof import("music-metadata")>();
  return { ...actual, parseBlob: vi.fn(actual.parseBlob) };
});

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
    vi.mocked(parseBlob).mockReset();

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

  it.each(["book alias", "canonical book path"])("scans the %s and records the configured inbox path used by acquisitions", async (selection) => {
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
      body: JSON.stringify({ targetDir: selection === "book alias" ? alias : sourceDir, planOnly: true }),
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
    const outsideAlias = path.join(outside, "Would Resolve Inside");
    fs.symlinkSync(sourceDir, outsideAlias, "junction");
    const exists = vi.spyOn(fs, "existsSync");
    const realpath = vi.spyOn(fs.promises, "realpath");

    for (const targetDir of [outside, alias, outsideAlias]) {
      const response = await fetch(baseUrl + "/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetDir, planOnly: true }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "Path is outside all configured roots" });
    }
    for (const rejectedPath of [outside, outsideAlias]) {
      expect(exists).not.toHaveBeenCalledWith(rejectedPath);
      expect(realpath).not.toHaveBeenCalledWith(rejectedPath);
    }
    expect(MetadataScanner.prototype.discoverTargets).not.toHaveBeenCalled();
  });

  it.each([42, null, "invalid\0path", ["/inbox"]])("rejects malformed scan target %j before filesystem validation", async (targetDir) => {
    const realpath = vi.spyOn(fs.promises, "realpath");
    const response = await fetch(baseUrl + "/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetDir, planOnly: true }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Scan target must be a valid path string." });
    expect(realpath).not.toHaveBeenCalled();
    expect(MetadataScanner.prototype.discoverTargets).not.toHaveBeenCalled();
  });

  it("limits scan requests before filesystem validation with one shared budget", async () => {
    const realpath = vi.spyOn(fs.promises, "realpath");
    for (let request = 0; request <= 20; request++) {
      const response = await fetch(baseUrl + "/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "192.0.2." + (request + 1) },
        body: JSON.stringify({ targetDir: 42, planOnly: true }),
      });
      if (request === 20) {
        expect(response.status).toBe(429);
        expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
        expect(await response.json()).toMatchObject({ error: "Too many scan requests. Try again shortly." });
      } else {
        expect(response.status).toBe(400);
        await response.json();
      }
    }
    expect(realpath).not.toHaveBeenCalled();
  });

  it("holds a mixed package for read-only collection review when the automatic poller discovers it", async () => {
    vi.mocked(MetadataScanner.prototype.scanTarget).mockRestore();
    const mixed = path.join(inboxDir, "Package");
    const child = path.join(mixed, "Another Book");
    const firstTrack = path.join(mixed, "01.mp3");
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
      items: [expect.objectContaining({
        state: "discovered",
        action: expect.objectContaining({ reason: expect.stringContaining("dedicated book folder") }),
      })],
    })]));
    expect(AudiobookOrganizer.prototype.organizeBook).not.toHaveBeenCalled();
    expect(fs.readFileSync(firstTrack, "utf-8")).toBe("synthetic track");
    expect(fs.readFileSync(otherBook, "utf-8")).toBe("synthetic separate book");
    const before = fs.readdirSync(inboxDir);
    const list = await fetch(baseUrl + "/collections").then(response => response.json());
    expect(list.data).toEqual([{ id: jobs.data[0].items[0].id, title: "Package", complete: false }]);
    const preview = await fetch(baseUrl + "/collections/" + list.data[0].id).then(response => response.json());
    expect(preview.data.candidates.flatMap((book: { files: string[] }) => book.files)).toContain("Another Book/audio.m4b");
    expect(fs.readdirSync(inboxDir)).toEqual(before);
    const inventory = await fetch(baseUrl + "/inbox").then(response => response.json());
    expect(inventory.data.rows).toEqual(expect.arrayContaining([expect.objectContaining({
      name: "Package", status: "review", collectionId: list.data[0].id, audioFiles: 2,
    })]));
    const live = await fetch(baseUrl + "/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetDir: child, planOnly: false }),
    });
    expect(live.status).toBe(409);

    vi.mocked(AudiobookOrganizer.prototype.organizeBook).mockRestore();
    const collectionUrl = baseUrl + "/collections/" + list.data[0].id;
    const approved = await fetch(collectionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: preview.data.fingerprint, groups: [{
        title: "Reviewed title", author: "Reviewed author", files: ["Another Book/audio.m4b"],
      }] }),
    });
    expect(approved.status).toBe(202);
    const { data: { operationId } } = await approved.json() as { data: { operationId: string } };
    await vi.waitFor(async () => {
      const progress = await fetch(collectionUrl + "/imports/" + operationId).then(response => response.json());
      expect(progress.data).toMatchObject({
        state: "complete",
        preview: { counts: { imported: 1, unassigned: 1 } },
      });
    });
    const after = await fetch(baseUrl + "/jobs").then(response => response.json());
    const imported = after.data.flatMap((job: { items: unknown[] }) => job.items)
      .find((item: { state: string }) => item.state === "complete");
    expect(fs.readFileSync(path.join(imported.action.target_path, "00001 - audio.m4b"), "utf8")).toBe("synthetic separate book");
    expect(fs.readFileSync(otherBook, "utf-8")).toBe("synthetic separate book");
    expect(fs.readFileSync(firstTrack, "utf-8")).toBe("synthetic track");
  });

  it("resolves duplicate-only collections, archives them, and restores the original review after the name is reused", async () => {
    vi.mocked(MetadataScanner.prototype.scanTarget).mockRestore();
    vi.mocked(AudiobookOrganizer.prototype.organizeBook).mockRestore();
    vi.mocked(parseBlob).mockImplementation(async blob => ({
      common: JSON.parse(new TextDecoder().decode(await blob.slice().arrayBuffer())),
      format: { duration: 14_400, tagTypes: [], trackInfo: [] }, native: {}, quality: { warnings: [] },
    }));
    const pack = path.join(inboxDir, "Duplicate pack");
    const titles = ["A standalone volume", "Another adventure"];
    const settled = new Date(Date.now() - INBOX_QUIET_PERIOD_MS - 1000);
    function dropPack() {
      fs.mkdirSync(pack);
      for (const title of titles) {
        const file = path.join(pack, `Author - ${title}.mp3`);
        fs.writeFileSync(file, JSON.stringify({ title, album: title, artist: "Author" }));
        fs.utimesSync(file, settled, settled);
      }
      fs.utimesSync(pack, settled, settled);
    }
    for (const title of titles) {
      const target = path.join(libraryDir, "Author", title);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "original.mp3"), "retained library edition");
    }
    const poll = vi.spyOn(InboxPollerService.prototype, "poll");
    const tick = vi.mocked(cron.schedule).mock.calls.find(([expression]) => expression === "*/5 * * * *")?.[1];
    if (typeof tick !== "function") throw new Error("Missing inbox poll task");
    const runTick = tick;
    async function discover() {
      runTick({} as Parameters<typeof runTick>[0]);
      await poll.mock.results.at(-1)?.value;
      const inbox = await fetch(baseUrl + "/inbox").then(response => response.json());
      return inbox.data.rows.find((row: { name: string }) => row.name === "Duplicate pack");
    }
    const post = (url: string, body?: unknown) => fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    dropPack();
    const row = await discover();
    expect(row).toMatchObject({ status: "review", pendingAudioFiles: 2 });
    const collectionUrl = baseUrl + "/collections/" + row.collectionId;
    const { data: before } = await fetch(collectionUrl).then(response => response.json());
    const decisions = before.candidates.map((book: { id: string; decisionToken: string }) => ({ id: book.id, outcome: "keep", token: book.decisionToken }));
    const confirmed = await post(collectionUrl + "/decisions", { snapshot: before.fingerprint, decisions });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ data: { counts: { imported: 0, resolved: 2, remaining: 0 } } });
    const cleanup = collectionUrl + "/cleanup";
    const archiveList = baseUrl + "/inbox/archive";
    const { data: plan } = await fetch(cleanup).then(response => response.json());
    expect(plan).toMatchObject({ audioFiles: 2, duplicateBooks: 2, blockers: [], token: expect.any(String) });
    const archived = await post(cleanup, { token: plan.token });
    expect(archived.status).toBe(200);
    const { data: item } = await archived.json();
    expect(fs.existsSync(pack)).toBe(false);
    expect(await fetch(archiveList).then(response => response.json())).toEqual({ data: [item] });
    const archiveTarget = path.join(inboxDir, ".intake-archive", item.id, "source");
    expect((await post(baseUrl + "/scan", { targetDir: archiveTarget })).status).toBe(409);

    dropPack();
    const replacement = await discover();
    expect(replacement).toMatchObject({ status: "review", resolvedBooks: 0 });
    expect(replacement.collectionId).not.toBe(row.collectionId);
    expect((await fetch(collectionUrl)).status).toBe(404);
    const restore = archiveList + "/" + item.id + "/restore";
    expect((await post(restore)).status).toBe(409);
    for (const file of fs.readdirSync(pack)) fs.unlinkSync(path.join(pack, file));
    fs.rmdirSync(pack);
    expect((await post(restore)).status).toBe(200);
    const restored = await discover();
    expect(restored).toMatchObject({ collectionId: row.collectionId, status: "retained", resolvedBooks: 2 });
    expect(await fetch(collectionUrl).then(response => response.json())).toMatchObject({ data: { counts: { resolved: 2 } } });
  });

  it.each([["review", true], ["automatic", true], ["automatic", false]] as const)("applies the %s policy (exceptions: %s)", async (mode, exceptions) => {
    vi.mocked(MetadataScanner.prototype.scanTarget).mockRestore();
    vi.mocked(AudiobookOrganizer.prototype.organizeBook).mockRestore();
    SettingsStore.getInstance().updateSettings({ collectionImportMode: mode });
    vi.mocked(parseBlob).mockImplementation(async blob => ({
      common: JSON.parse(new TextDecoder().decode(await blob.slice().arrayBuffer())),
      format: { duration: 14_400, tagTypes: [], trackInfo: [] }, native: {}, quality: { warnings: [] },
    }));
    const pack = path.join(inboxDir, "Standalone MP3 pack");
    const existing = path.join(libraryDir, "Author", "Existing Book");
    fs.mkdirSync(pack);
    if (exceptions) {
      fs.mkdirSync(existing, { recursive: true });
      fs.writeFileSync(path.join(existing, "Existing Book.mp3"), "Already in library");
    }
    for (const title of ["New Book", "Different Adventure", ...(exceptions ? ["Existing Book"] : [])]) {
      fs.writeFileSync(path.join(pack, "Author - " + title + ".mp3"), JSON.stringify({ title, album: title, artist: "Author" }));
    }
    if (exceptions) fs.writeFileSync(path.join(pack, "01.mp3"), "{}");
    const settled = new Date(Date.now() - INBOX_QUIET_PERIOD_MS - 1000);
    for (const file of fs.readdirSync(pack)) fs.utimesSync(path.join(pack, file), settled, settled);
    fs.utimesSync(pack, settled, settled);
    const poll = vi.spyOn(InboxPollerService.prototype, "poll");
    const tick = vi.mocked(cron.schedule).mock.calls.find(([expression]) => expression === "*/5 * * * *")?.[1];
    if (typeof tick !== "function") throw new Error("Missing inbox poll task");
    tick({} as Parameters<typeof tick>[0]);
    await poll.mock.results[0].value;

    expect(fs.existsSync(path.join(libraryDir, "Author", "New Book"))).toBe(mode === "automatic");
    if (exceptions) expect(fs.readFileSync(path.join(existing, "Existing Book.mp3"), "utf8")).toBe("Already in library");
    expect(fs.readdirSync(pack)).toHaveLength(exceptions ? 4 : 2);
    const list = await fetch(baseUrl + "/collections").then(response => response.json());
    expect(list.data).toHaveLength(1);
    const detail = await fetch(baseUrl + "/collections/" + list.data[0].id).then(response => response.json());
    expect(detail.data.counts).toMatchObject({ imported: mode === "automatic" ? 2 : 0, unassigned: exceptions ? 1 : 0 });
    if (exceptions) expect(detail.data.candidates.find((book: { title: string }) => book.title === "Existing Book")).toMatchObject({
      ready: false, duplicate: expect.any(String),
    });
    const inventory = await fetch(baseUrl + "/inbox").then(response => response.json());
    expect(inventory.data.rows.find((row: { name: string }) => row.name === "Standalone MP3 pack")).toMatchObject({
      status: mode === "automatic" && !exceptions ? "retained" : "review", audioFiles: exceptions ? 4 : 2,
      importedBooks: mode === "automatic" ? 2 : 0,
    });
    if (mode === "review") {
      const clear = detail.data.candidates.find((book: { title: string }) => book.title === "New Book");
      const duplicate = detail.data.candidates.find((book: { title: string }) => book.title === "Existing Book");
      const endpoint = baseUrl + "/collections/" + list.data[0].id;
      const accepted = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "clear", fingerprint: detail.data.fingerprint, candidateIds: [clear.id, duplicate.id] }),
      });
      expect(accepted.status).toBe(202);
      const { data: { operationId } } = await accepted.json() as { data: { operationId: string } };
      await vi.waitFor(async () => {
        const result = await fetch(endpoint + "/imports/" + operationId).then(response => response.json());
        expect(result.data).toMatchObject({ state: "complete", preview: { counts: { imported: 1 } } });
      });
      expect(fs.existsSync(path.join(libraryDir, "Author", "New Book"))).toBe(true);
      expect(fs.existsSync(path.join(libraryDir, "Author", "Different Adventure"))).toBe(false);
      expect(fs.readFileSync(path.join(existing, "Existing Book.mp3"), "utf8")).toBe("Already in library");
    }
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
