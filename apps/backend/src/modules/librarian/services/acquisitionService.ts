import { randomUUID } from "node:crypto";
import type { CuratorDb } from "../../curator/core/db.js";
import type { Acquisition, AcquisitionStatus } from "../../curator/core/types.js";
import { AudiobookBayService } from "./audiobookbay.js";
import { QBittorrentService, type QbitTorrent } from "./qbittorrent.js";
import type { IngestJobItem, IngestStore } from "../ingestStore.js";

export interface StartAcquisitionParams {
  bookUrl: string;
  candidateId?: string | null;
  editionTitle?: string;
  source?: string;
}

export interface StartAcquisitionResult {
  acquisition: Acquisition;
  duplicate: boolean;
  magnetLink?: string;
  error?: string;
}

export class AcquisitionService {
  constructor(
    private readonly db: CuratorDb,
    private readonly abbService: AudiobookBayService = new AudiobookBayService(),
    private readonly qbtService: QBittorrentService = new QBittorrentService(),
    private readonly ingestStore?: IngestStore,
  ) {}

  async startAcquisition(params: StartAcquisitionParams): Promise<StartAcquisitionResult> {
    const { bookUrl, candidateId, editionTitle, source = "audiobookbay" } = params;

    // Check for existing in-progress acquisition (idempotency)
    const existing = this.db.findActiveAcquisition(bookUrl, candidateId);
    if (existing && !["failed", "needs_confirmation"].includes(existing.status)) {
      return { acquisition: existing, duplicate: true };
    }

    const id = `acq_${randomUUID().slice(0, 8)}`;
    const title = editionTitle || "Audiobook";

    // Initial record: 'requested'
    const acq = this.db.createAcquisition({
      id,
      candidateId: candidateId ?? null,
      editionTitle: title,
      bookUrl,
      source,
      torrentHash: null,
      torrentName: null,
      inboxPath: null,
      status: "requested",
      progress: 0,
      detail: "Resolving source magnet link",
      ingestJobId: null,
      ingestItemId: null,
      absItemId: null,
    });

    try {
      // 1. Resolve magnet link
      const magnetLink = await this.abbService.getMagnetLink(bookUrl);

      // Extract info hash: urn:btih:([a-zA-Z0-9]{40})
      const hashMatch = magnetLink.match(/xt=urn:btih:([a-zA-Z0-9]{40})/i);
      const torrentHash = hashMatch ? hashMatch[1].toLowerCase() : null;

      // 2. Submit to qBittorrent
      try {
        await this.qbtService.addMagnetLink(magnetLink);
        const updated = this.db.updateAcquisition(id, {
          torrentHash,
          status: "downloading",
          detail: "Sent to qBittorrent",
          progress: 0,
        });
        return {
          acquisition: updated || acq,
          duplicate: false,
          magnetLink,
        };
      } catch (qbtError) {
        const errMsg = qbtError instanceof Error ? qbtError.message : String(qbtError);
        console.error(`[AcquisitionService] qBittorrent submission failed for ${id}:`, errMsg);
        const updated = this.db.updateAcquisition(id, {
          torrentHash,
          status: "needs_confirmation",
          detail: `qBittorrent submission failed: ${errMsg}`,
        });
        return {
          acquisition: updated || acq,
          duplicate: false,
          error: errMsg,
        };
      }
    } catch (abbError) {
      const errMsg = abbError instanceof Error ? abbError.message : String(abbError);
      console.error(`[AcquisitionService] Magnet resolution failed for ${id}:`, errMsg);
      const updated = this.db.updateAcquisition(id, {
        status: "failed",
        detail: `Source resolution failed: ${errMsg}`,
      });
      return {
        acquisition: updated || acq,
        duplicate: false,
        error: errMsg,
      };
    }
  }

  reconcileTorrents(torrents: QbitTorrent[]): void {
    const active = this.db.listAcquisitions({
      status: ["requested", "downloading", "seeding"],
    });

    for (const acq of active) {
      if (!acq.torrentHash) continue;
      const match = torrents.find(
        (t) => t.hash.toLowerCase() === acq.torrentHash!.toLowerCase()
      );
      if (match) {
        const progress = Math.max(0, Math.min(100, Math.round(match.progress * 100)));
        const detail = match.dlspeed > 0
          ? `${(match.dlspeed / 1024 / 1024).toFixed(1)} MB/s`
          : match.state;
        const newStatus: AcquisitionStatus = match.progress >= 1 ? "seeding" : "downloading";

        if (progress !== acq.progress || detail !== acq.detail || newStatus !== acq.status) {
          this.db.updateAcquisition(acq.id, {
            progress,
            detail,
            status: newStatus,
            torrentName: match.name,
          });
        }
      }
    }
  }

  onTorrentImported(inboxPath: string, torrent: QbitTorrent): void {
    const acq = this.db.getAcquisitionByHash(torrent.hash);
    if (acq) {
      this.db.updateAcquisition(acq.id, {
        inboxPath,
        status: "importing",
        progress: 100,
        detail: "Imported into inbox, awaiting library staging",
      });
    }
  }

  onIngestItemUpdated(item: IngestJobItem): void {
    const all = this.db.listAcquisitions({
      status: ["importing", "processing", "downloading", "seeding"],
    });

    const match = all.find((a) => {
      if (a.ingestItemId === item.id) return true;
      if (a.inboxPath && item.action.source_path && a.inboxPath === item.action.source_path) return true;
      return false;
    });

    if (match) {
      if (item.state === "complete" || item.absItemId) {
        this.db.updateAcquisition(match.id, {
          status: "shelved",
          absItemId: item.absItemId,
          ingestItemId: item.id,
          ingestJobId: item.jobId,
          detail: "Shelved successfully in library",
          progress: 100,
        });
      } else if (item.state === "failed") {
        this.db.updateAcquisition(match.id, {
          status: "failed",
          detail: item.error || "Library ingest failed",
          ingestItemId: item.id,
          ingestJobId: item.jobId,
        });
      } else {
        this.db.updateAcquisition(match.id, {
          status: "processing",
          ingestItemId: item.id,
          ingestJobId: item.jobId,
          detail: item.action.reason || "Staging files into library",
        });
      }
    }
  }

  getAcquisition(id: string): Acquisition | null {
    return this.db.getAcquisition(id);
  }

  getAcquisitionByCandidate(candidateId: string): Acquisition | null {
    return this.db.getAcquisitionByCandidate(candidateId);
  }

  listAcquisitions(options?: { status?: AcquisitionStatus[]; candidateId?: string; limit?: number }): Acquisition[] {
    return this.db.listAcquisitions(options);
  }

  async retryAcquisition(id: string): Promise<Acquisition | null> {
    const acq = this.db.getAcquisition(id);
    if (!acq) return null;

    if (!["failed", "needs_confirmation"].includes(acq.status)) {
      return acq;
    }

    const result = await this.startAcquisition({
      bookUrl: acq.bookUrl,
      candidateId: acq.candidateId,
      editionTitle: acq.editionTitle,
      source: acq.source,
    });
    return result.acquisition;
  }

  dismissAcquisition(id: string): boolean {
    const acq = this.db.getAcquisition(id);
    if (!acq) return false;
    this.db.updateAcquisition(id, {
      status: "failed",
      detail: "Dismissed by user",
    });
    return true;
  }
}
