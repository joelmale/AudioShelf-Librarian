import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CuratorDb } from "../curator/core/db.js";
import { IngestStore } from "./ingestStore.js";
import { createLibrarianRouter } from "./index.js";
import { AcquisitionService } from "./services/acquisitionService.js";
import type { AudiobookBayService } from "./services/audiobookbay.js";
import type { QBittorrentService } from "./services/qbittorrent.js";
import type { WsRouter } from "../../websocket/index.js";

describe("Librarian Acquisition Routes", () => {
  let tmpDir: string;
  let db: CuratorDb;
  let ingestStore: IngestStore;
  let acquisitionService: AcquisitionService;
  let mockAbb: Partial<AudiobookBayService>;
  let mockQbt: Partial<QBittorrentService>;
  let app: express.Express;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-acq-routes-"));
    const dbPath = path.join(tmpDir, "curator.db");
    db = new CuratorDb(dbPath);
    ingestStore = new IngestStore(dbPath);

    mockAbb = {
      getMagnetLink: vi.fn().mockResolvedValue(
        "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Mistborn"
      ),
    };

    mockQbt = {
      addMagnetLink: vi.fn().mockResolvedValue(undefined),
      getTorrents: vi.fn().mockResolvedValue([]),
    };

    acquisitionService = new AcquisitionService(
      db,
      mockAbb as AudiobookBayService,
      mockQbt as QBittorrentService,
      ingestStore
    );

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).principal = { subject: "test", role: "administrator", libraries: [], claims: {} };
      next();
    });

    const ws = { broadcast: vi.fn() } as unknown as WsRouter;
    const router = createLibrarianRouter(
      { PORT: 0 },
      ws,
      {
        curatorDb: db,
        ingestStore,
        acquisitionService,
      }
    );

    app.use("/api/librarian", router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}/api/librarian`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("POST /download creates and tracks acquisition", async () => {
    const res = await fetch(`${baseUrl}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookUrl: "https://audiobookbay.is/audio-books/mistborn/",
        candidateId: "cand_mistborn",
        editionTitle: "Mistborn: The Final Empire",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.duplicate).toBe(false);
    expect(data.acquisition).toBeDefined();
    expect(data.acquisition.id).toMatch(/^acq_/);
    expect(data.acquisition.torrentHash).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(data.acquisition.status).toBe("downloading");

    // Repeat download returns duplicate
    const repeatRes = await fetch(`${baseUrl}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookUrl: "https://audiobookbay.is/audio-books/mistborn/",
        candidateId: "cand_mistborn",
        editionTitle: "Mistborn: The Final Empire",
      }),
    });
    const repeatData = await repeatRes.json();
    expect(repeatData.duplicate).toBe(true);
    expect(repeatData.acquisition.id).toBe(data.acquisition.id);
  });

  it("GET /acquisitions and /acquisitions/by-candidate/:candidateId return tracked state", async () => {
    // Initiate download
    await fetch(`${baseUrl}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookUrl: "https://audiobookbay.is/audio-books/warbreaker/",
        candidateId: "cand_warbreaker",
        editionTitle: "Warbreaker",
      }),
    });

    // Query all acquisitions
    const listRes = await fetch(`${baseUrl}/acquisitions`);
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.success).toBe(true);
    expect(listData.data.length).toBe(1);
    expect(listData.data[0].candidateId).toBe("cand_warbreaker");

    // Query by candidate ID
    const candRes = await fetch(`${baseUrl}/acquisitions/by-candidate/cand_warbreaker`);
    expect(candRes.status).toBe(200);
    const candData = await candRes.json();
    expect(candData.success).toBe(true);
    expect(candData.data).not.toBeNull();
    expect(candData.data.editionTitle).toBe("Warbreaker");

    // Non-existent candidate returns null
    const nonExistent = await fetch(`${baseUrl}/acquisitions/by-candidate/cand_unknown`);
    const nonExistentData = await nonExistent.json();
    expect(nonExistentData.data).toBeNull();
  });

  it("GET /acquisitions/:id returns 404 for unknown ID", async () => {
    const res = await fetch(`${baseUrl}/acquisitions/non_existent_id`);
    expect(res.status).toBe(404);
  });

  it("POST /acquisitions/:id/dismiss marks acquisition dismissed", async () => {
    const dlRes = await fetch(`${baseUrl}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookUrl: "https://audiobookbay.is/audio-books/starsight/",
        candidateId: "cand_starsight",
        editionTitle: "Starsight",
      }),
    });
    const dlData = await dlRes.json();
    const acqId = dlData.acquisition.id;

    const dismissRes = await fetch(`${baseUrl}/acquisitions/${acqId}/dismiss`, {
      method: "POST",
    });
    expect(dismissRes.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/acquisitions/${acqId}`);
    const getData = await getRes.json();
    expect(getData.data.status).toBe("failed");
    expect(getData.data.detail).toContain("Dismissed");
  });
});
