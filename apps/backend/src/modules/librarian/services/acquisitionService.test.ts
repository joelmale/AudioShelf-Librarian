import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CuratorDb } from "../../curator/core/db.js";
import { AcquisitionService } from "./acquisitionService.js";
import type { AudiobookBayService } from "./audiobookbay.js";
import type { QBittorrentService, QbitTorrent } from "./qbittorrent.js";
import type { IngestJobItem } from "../ingestStore.js";
import type { OrganizationAction } from "@audioshelf/shared";

describe("AcquisitionService", () => {
  let tmpDir: string;
  let db: CuratorDb;
  let mockAbb: Partial<AudiobookBayService>;
  let mockQbt: Partial<QBittorrentService>;
  let service: AcquisitionService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-acq-test-"));
    const dbPath = path.join(tmpDir, "test-curator.db");
    db = new CuratorDb(dbPath);

    mockAbb = {
      getMagnetLink: vi.fn().mockResolvedValue(
        "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=The+Way+of+Kings&tr=http%3A%2F%2Ftracker.example.com"
      ),
    };

    mockQbt = {
      addMagnetLink: vi.fn().mockResolvedValue(undefined),
      getTorrents: vi.fn().mockResolvedValue([]),
    };

    service = new AcquisitionService(
      db,
      mockAbb as AudiobookBayService,
      mockQbt as QBittorrentService
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates a new acquisition, extracts hash from magnet URL, and sends to qBittorrent", async () => {
    const result = await service.startAcquisition({
      bookUrl: "https://audiobookbay.is/audio-books/the-way-of-kings/",
      candidateId: "cand_123",
      editionTitle: "The Way of Kings (Unabridged)",
    });

    expect(result.duplicate).toBe(false);
    expect(result.acquisition.id).toMatch(/^acq_/);
    expect(result.acquisition.candidateId).toBe("cand_123");
    expect(result.acquisition.editionTitle).toBe("The Way of Kings (Unabridged)");
    expect(result.acquisition.torrentHash).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(result.acquisition.status).toBe("downloading");

    expect(mockAbb.getMagnetLink).toHaveBeenCalledWith(
      "https://audiobookbay.is/audio-books/the-way-of-kings/"
    );
    expect(mockQbt.addMagnetLink).toHaveBeenCalled();

    // Verify stored in DB
    const fetched = db.getAcquisition(result.acquisition.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.status).toBe("downloading");
    expect(fetched?.torrentHash).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("deduplicates in-flight acquisition requests idempotently", async () => {
    const first = await service.startAcquisition({
      bookUrl: "https://audiobookbay.is/audio-books/the-way-of-kings/",
      candidateId: "cand_123",
      editionTitle: "The Way of Kings",
    });
    expect(first.duplicate).toBe(false);

    // Second request with same candidateId / bookUrl
    const second = await service.startAcquisition({
      bookUrl: "https://audiobookbay.is/audio-books/the-way-of-kings/",
      candidateId: "cand_123",
      editionTitle: "The Way of Kings",
    });

    expect(second.duplicate).toBe(true);
    expect(second.acquisition.id).toBe(first.acquisition.id);
    // Magnet link / qBt should not have been called a second time
    expect(mockAbb.getMagnetLink).toHaveBeenCalledTimes(1);
    expect(mockQbt.addMagnetLink).toHaveBeenCalledTimes(1);
  });

  it("handles qBittorrent timeout/error safely by transitioning to needs_confirmation", async () => {
    mockQbt.addMagnetLink = vi.fn().mockRejectedValue(new Error("qBittorrent connection timed out"));

    const result = await service.startAcquisition({
      bookUrl: "https://audiobookbay.is/audio-books/words-of-radiance/",
      candidateId: "cand_456",
      editionTitle: "Words of Radiance",
    });

    expect(result.duplicate).toBe(false);
    expect(result.error).toContain("qBittorrent connection timed out");
    expect(result.acquisition.status).toBe("needs_confirmation");
    expect(result.acquisition.detail).toContain("qBittorrent submission failed");

    const fetched = db.getAcquisition(result.acquisition.id);
    expect(fetched?.status).toBe("needs_confirmation");
  });

  it("handles AudiobookBay resolution failure safely by transitioning to failed", async () => {
    mockAbb.getMagnetLink = vi.fn().mockRejectedValue(new Error("Page not found"));

    const result = await service.startAcquisition({
      bookUrl: "https://audiobookbay.is/audio-books/missing-book/",
      candidateId: "cand_789",
      editionTitle: "Missing Book",
    });

    expect(result.duplicate).toBe(false);
    expect(result.error).toContain("Page not found");
    expect(result.acquisition.status).toBe("failed");
    expect(result.acquisition.detail).toContain("Source resolution failed");
  });

  it("reconciles live progress from qBittorrent torrents", async () => {
    const { acquisition } = await service.startAcquisition({
      bookUrl: "https://audiobookbay.is/audio-books/oathbringer/",
      candidateId: "cand_oath",
      editionTitle: "Oathbringer",
    });

    const torrents: QbitTorrent[] = [
      {
        hash: "0123456789abcdef0123456789abcdef01234567",
        name: "Oathbringer M4B",
        progress: 0.654,
        state: "downloading",
        save_path: "/downloads",
        eta: 120,
        dlspeed: 2.5 * 1024 * 1024,
        size: 1000000000,
      },
    ];

    service.reconcileTorrents(torrents);

    const updated = db.getAcquisition(acquisition.id);
    expect(updated?.progress).toBe(65);
    expect(updated?.detail).toBe("2.5 MB/s");
    expect(updated?.status).toBe("downloading");
  });

  it("transitions to importing when torrent is imported into inbox", async () => {
    const { acquisition } = await service.startAcquisition({
      bookUrl: "https://audiobookbay.is/audio-books/rhythm-of-war/",
      candidateId: "cand_row",
      editionTitle: "Rhythm of War",
    });

    const torrent: QbitTorrent = {
      hash: "0123456789abcdef0123456789abcdef01234567",
      name: "Rhythm of War",
      progress: 1.0,
      state: "uploading",
      save_path: "/downloads",
      eta: 0,
      dlspeed: 0,
      size: 1200000000,
    };

    service.onTorrentImported("/inbox/Rhythm of War", torrent);

    const updated = db.getAcquisition(acquisition.id);
    expect(updated?.status).toBe("importing");
    expect(updated?.inboxPath).toBe("/inbox/Rhythm of War");
    expect(updated?.progress).toBe(100);
  });

  it("transitions to shelved when ingest item completes with Audiobookshelf ID", async () => {
    const { acquisition } = await service.startAcquisition({
      bookUrl: "https://audiobookbay.is/audio-books/wind-and-truth/",
      candidateId: "cand_wat",
      editionTitle: "Wind and Truth",
    });

    const torrent: QbitTorrent = {
      hash: "0123456789abcdef0123456789abcdef01234567",
      name: "Wind and Truth",
      progress: 1.0,
      state: "uploading",
      save_path: "/downloads",
      eta: 0,
      dlspeed: 0,
      size: 1200000000,
    };

    service.onTorrentImported("/inbox/Wind and Truth", torrent);

    const ingestItem: IngestJobItem = {
      id: "item_ingest_123",
      jobId: "job_1",
      state: "complete",
      action: {
        action_type: "move",
        source_path: "/inbox/Wind and Truth",
        target_path: "/library/Brandon Sanderson/Wind and Truth",
        reason: "Imported from completed torrent",
        executed: true,
        success: true,
        book: { title: "Wind and Truth" },
      } as OrganizationAction,
      attempts: 1,
      error: null,
      absItemId: "abs_book_777",
      updatedAt: Date.now(),
    };

    service.onIngestItemUpdated(ingestItem);

    const updated = db.getAcquisition(acquisition.id);
    expect(updated?.status).toBe("shelved");
    expect(updated?.absItemId).toBe("abs_book_777");
    expect(updated?.ingestItemId).toBe("item_ingest_123");
    expect(updated?.detail).toContain("Shelved successfully");
  });

  it("retries a failed acquisition cleanly", async () => {
    mockAbb.getMagnetLink = vi.fn().mockRejectedValueOnce(new Error("Transient network drop"));

    const initial = await service.startAcquisition({
      bookUrl: "https://audiobookbay.is/audio-books/elantris/",
      candidateId: "cand_elantris",
      editionTitle: "Elantris",
    });
    expect(initial.acquisition.status).toBe("failed");

    // Fix ABB mock for retry
    mockAbb.getMagnetLink = vi.fn().mockResolvedValueOnce(
      "magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd&dn=Elantris"
    );

    const retried = await service.retryAcquisition(initial.acquisition.id);
    expect(retried).not.toBeNull();
    expect(retried?.status).toBe("downloading");
    expect(retried?.torrentHash).toBe("aabbccddeeff00112233445566778899aabbccdd");
  });
});
