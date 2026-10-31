import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CuratorDb } from "../../curator/core/db.js";
import type { Acquisition, AcquisitionStatus } from "../../curator/core/types.js";
import { AudiobookBayService } from "./audiobookbay.js";
import { QBittorrentService, type QbitTorrent } from "./qbittorrent.js";
import type { IngestJobItem, IngestStore } from "../ingestStore.js";

/** Statuses an ingest event may still advance. Terminal ones are never reopened. */
const OPEN_STATUSES: AcquisitionStatus[] = ["importing", "processing", "downloading", "seeding", "needs_review"];

/** A finished download should import within a minute; this is far past that. */
export const STALE_ACQUISITION_MS = 15 * 60 * 1000;

/**
 * How long a download may be absent from qBittorrent before it is flagged. A
 * just-added magnet takes a few seconds to appear, so this is deliberately slow.
 */
export const MISSING_TORRENT_MS = 10 * 60 * 1000;

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function acquisitionMatchesItem(acq: Acquisition, item: IngestJobItem): boolean {
  if (acq.ingestItemId === item.id) return true;
  return Boolean(acq.inboxPath && item.action.source_path && samePath(acq.inboxPath, item.action.source_path));
}

/** What an ingest item's state means for the acquisition that produced it. */
export function statusForIngestItem(item: IngestJobItem): { status: AcquisitionStatus; detail: string } {
  if (item.state === "complete" || item.absItemId) {
    return { status: "shelved", detail: "Shelved successfully in library" };
  }
  if (item.state === "failed") {
    return { status: "failed", detail: item.error || "Library ingest failed" };
  }
  if (item.state === "discarded") {
    return { status: "dismissed", detail: "Discarded in intake" };
  }
  if (item.state === "cancelled") {
    return { status: "dismissed", detail: "Cancelled" };
  }
  const actionType = item.action.action_type;
  if (item.state === "discovered" && actionType !== "move" && actionType !== "rename") {
    return {
      status: "needs_review",
      detail: item.action.reason || `Held for review in Intake (${actionType})`,
    };
  }
  return { status: "processing", detail: item.action.reason || "Staging files into library" };
}

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

  reconcileTorrents(torrents: QbitTorrent[], now = Date.now()): void {
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
      } else if (now - acq.updatedAt >= MISSING_TORRENT_MS) {
        // Deleted from qBittorrent (or never added): nothing will ever advance
        // this row, and it would otherwise read as downloading indefinitely.
        this.db.updateAcquisition(acq.id, {
          status: "needs_review",
          detail: "This torrent is no longer in qBittorrent. Dismiss it to request the book again.",
        });
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
    const all = this.db.listAcquisitions({ status: OPEN_STATUSES });
    const match = all.find((a) => acquisitionMatchesItem(a, item));
    if (!match) return;

    const next = statusForIngestItem(item);
    this.db.updateAcquisition(match.id, {
      ...next,
      ...(next.status === "shelved" ? { absItemId: item.absItemId, progress: 100 } : {}),
      ingestItemId: item.id,
      ingestJobId: item.jobId,
    });
  }

  /**
   * The download finished but AudioShelf cannot import it (unreadable path,
   * inbox folder already present). Recorded on the acquisition so the cause is
   * visible instead of the book sitting at 100% "in progress" with no reason.
   */
  onImportBlocked(torrentHash: string, reason: string): void {
    const acq = this.db.getAcquisitionByHash(torrentHash);
    if (!acq || !["requested", "downloading", "seeding", "needs_review"].includes(acq.status)) return;
    const detail = `Cannot import: ${reason}`;
    if (acq.status === "needs_review" && acq.detail === detail) return;
    this.db.updateAcquisition(acq.id, { status: "needs_review", detail, progress: 100 });
  }

  /** Inbox processing threw before any ingest item could report an outcome. */
  onInboxProcessingFailed(inboxPath: string, message: string): void {
    const acq = this.db
      .listAcquisitions({ status: ["importing", "processing"] })
      .find((a) => a.inboxPath && samePath(a.inboxPath, inboxPath));
    if (!acq) return;
    this.db.updateAcquisition(acq.id, {
      status: "needs_review",
      detail: `Inbox processing failed: ${message}`,
    });
  }

  /**
   * Heal and flag acquisitions that no event will ever advance.
   *
   * First it replays the current state of any matching ingest item, which
   * repairs rows stranded before ingest changes were wired to this service.
   * Whatever is still open after a long silence is moved to `needs_review`
   * so it surfaces with a reason instead of reading as in-progress forever.
   */
  sweepStuck(ingestItems: IngestJobItem[], now = Date.now(), staleMs = STALE_ACQUISITION_MS): number {
    let changed = 0;
    for (const acq of this.db.listAcquisitions({ status: ["requested", "importing", "processing", "seeding"] })) {
      const match = acq.inboxPath
        ? ingestItems
            .filter((item) => item.action.source_path && samePath(item.action.source_path, acq.inboxPath!))
            .sort((a, b) => b.updatedAt - a.updatedAt)[0]
        : undefined;
      if (match) {
        const next = statusForIngestItem(match);
        if (next.status !== acq.status || next.detail !== acq.detail) {
          this.onIngestItemUpdated(match);
          changed++;
          continue;
        }
      }
      if (now - acq.updatedAt < staleMs) continue;
      const minutes = Math.round((now - acq.updatedAt) / 60_000);
      this.db.updateAcquisition(acq.id, {
        status: "needs_review",
        detail: acq.status === "seeding"
          ? `Downloaded but not imported after ${minutes} min. ${acq.detail ?? ""}`.trim()
          : acq.status === "requested"
            ? `The request never reached qBittorrent (${minutes} min). Dismiss it to request the book again.`
            : `No progress for ${minutes} min (was ${acq.status}). Open Intake to see what is holding it.`,
      });
      changed++;
    }
    return changed;
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
      status: "dismissed",
      detail: "Dismissed by user",
    });
    return true;
  }
}
