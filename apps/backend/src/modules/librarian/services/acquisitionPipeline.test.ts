import { describe, expect, it } from "vitest";
import type { OrganizationAction } from "@audioshelf/shared";
import type { IngestJob, IngestJobItem, IngestState } from "../ingestStore.js";
import type { QbitTorrent } from "./qbittorrent.js";
import { buildAcquisitionPipeline } from "./acquisitionPipeline.js";

const now = 2_000_000_000_000;
const action = (actionType: OrganizationAction["action_type"], bookTitle: string): OrganizationAction => ({
  action_type: actionType,
  source_path: `/inbox/${bookTitle}`,
  target_path: `/library/${bookTitle}`,
  reason: actionType === "duplicate" ? "Possible duplicate in library" : "Ready",
  executed: false,
  success: false,
  book: { title: bookTitle } as OrganizationAction["book"],
});
const item = (id: string, state: IngestState, actionType: OrganizationAction["action_type"], updatedAt = now): IngestJobItem => ({
  id,
  jobId: "job",
  state,
  action: action(actionType, id),
  attempts: 0,
  error: state === "failed" ? "Move failed" : null,
  absItemId: null,
  updatedAt,
});

describe("buildAcquisitionPipeline", () => {
  it("assigns acquisitions to live tracker stages", () => {
    const torrents = [
      { hash: "one", name: "Downloading book", progress: 0.42, state: "downloading", dlspeed: 1_048_576, eta: 60 },
      { hash: "done", name: "Completed book", progress: 1, state: "uploading", dlspeed: 0, eta: 0 },
    ] as QbitTorrent[];
    const jobs = [{
      id: "job",
      state: "discovered",
      targetDir: "/inbox",
      libraryId: null,
      planOnly: false,
      createdAt: now,
      updatedAt: now,
      items: [
        item("processing", "scan_requested", "move"),
        item("duplicate", "discovered", "duplicate"),
        item("failed", "failed", "move"),
        item("recent", "complete", "move", now - 1_000),
        item("old", "complete", "move", now - 25 * 60 * 60 * 1000),
      ],
    }] as IngestJob[];

    const result = buildAcquisitionPipeline(torrents, jobs, now);
    expect(result.downloading).toMatchObject([{ id: "one", progress: 42, detail: "1.0 MB/s" }]);
    expect(result.processing.map((entry) => entry.id)).toEqual(["processing"]);
    expect(result.requiresInput.map((entry) => entry.id)).toEqual(["duplicate", "failed"]);
    expect(result.shelved24h.map((entry) => entry.id)).toEqual(["recent"]);
  });
});
