import fs from "node:fs";
import path from "node:path";
import { assertContained } from "../../../security/paths.js";
import type { IngestStore } from "../ingestStore.js";

export async function discardMissingAcquisitionInputs(
  ingestStore: IngestStore,
  inboxDir: string,
): Promise<number> {
  const resolvedInbox = path.resolve(inboxDir);
  let discarded = 0;

  for (const item of ingestStore.pendingReviewItems()) {
    if (item.action.action_type !== "duplicate" && item.action.action_type !== "error") continue;
    const sourcePath = path.resolve(item.action.source_path);
    try {
      await assertContained(sourcePath, resolvedInbox, { mustExist: false });
    } catch {
      continue;
    }
    if (fs.existsSync(sourcePath)) continue;
    if (ingestStore.discardItem(item.id)) discarded++;
  }

  return discarded;
}
