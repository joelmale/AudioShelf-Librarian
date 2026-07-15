import type { IngestJob, IngestJobItem, IngestState } from "../ingestStore.js";
import type { QbitTorrent } from "./qbittorrent.js";

const PROCESSING_STATES = new Set<IngestState>([
  "discovered",
  "approved",
  "staging",
  "finalized",
  "scan_requested",
  "abs_item_resolved",
  "enriched",
]);

const PROCESSING_LABELS: Partial<Record<IngestState, string>> = {
  discovered: "Reading metadata",
  approved: "Approved for shelving",
  staging: "Moving into the library",
  finalized: "Finalizing files",
  scan_requested: "Updating Audiobookshelf",
  abs_item_resolved: "Confirming library item",
  enriched: "Enriching metadata",
};

function title(item: IngestJobItem): string {
  return item.action.book?.title || "Unknown audiobook";
}

export interface AcquisitionPipelineSummary {
  downloading: Array<{ id: string; title: string; progress: number; detail: string; eta: number }>;
  processing: Array<{ id: string; title: string; detail: string; updatedAt: number }>;
  requiresInput: Array<{ id: string; title: string; detail: string; updatedAt: number }>;
  shelved24h: Array<{ id: string; title: string; detail: string; updatedAt: number }>;
}

export function buildAcquisitionPipeline(
  torrents: QbitTorrent[],
  jobs: IngestJob[],
  now = Date.now(),
): AcquisitionPipelineSummary {
  const items = jobs.filter((job) => !job.planOnly).flatMap((job) => job.items);
  const downloading = torrents
    .filter((torrent) => torrent.progress < 1)
    .map((torrent) => ({
      id: torrent.hash,
      title: torrent.name,
      progress: Math.max(0, Math.min(100, Math.round(torrent.progress * 100))),
      detail: torrent.dlspeed > 0 ? `${(torrent.dlspeed / 1024 / 1024).toFixed(1)} MB/s` : torrent.state,
      eta: torrent.eta,
    }));

  const requiresInput = items
    .filter((item) => item.state === "failed" || ["duplicate", "error"].includes(item.action.action_type))
    .map((item) => ({
      id: item.id,
      title: title(item),
      detail: item.error || item.action.reason || "Review needed",
      updatedAt: item.updatedAt,
    }));
  const inputIds = new Set(requiresInput.map((item) => item.id));

  const processing = items
    .filter((item) => PROCESSING_STATES.has(item.state) && !inputIds.has(item.id) && item.action.action_type !== "skip")
    .map((item) => ({
      id: item.id,
      title: title(item),
      detail: PROCESSING_LABELS[item.state] || "Processing",
      updatedAt: item.updatedAt,
    }));

  const cutoff = now - 24 * 60 * 60 * 1000;
  const shelved24h = items
    .filter((item) => item.state === "complete" && item.updatedAt >= cutoff)
    .map((item) => ({
      id: item.id,
      title: title(item),
      detail: "Shelved successfully",
      updatedAt: item.updatedAt,
    }));

  return { downloading, processing, requiresInput, shelved24h };
}
