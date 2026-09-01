import fs from "node:fs";
import path from "node:path";
import { assertContained } from "../../../security/paths.js";
import type { IngestStore } from "../ingestStore.js";

/**
 * Why an item still sits in "Requires input" after its file went away.
 *
 * The queue is projected straight from `ingest_job_items`, so an item stays
 * forever until something resolves it. The delete endpoint resolves items it
 * deletes itself; this pass covers every other route a file can leave by —
 * removed from the NAS, moved by hand, cleaned up by Audiobookshelf.
 */
export interface AcquisitionReconcileResult {
  /** Items discarded because their source file is gone. */
  discarded: number;
  /** Left alone: the file is still there, so the decision is still real. */
  keptExisting: number;
  /**
   * Left alone: the source path is not under the configured inbox, so this
   * pass cannot prove anything about it. A non-zero count here with a stuck
   * item is the signal that `inboxDir` is wrong or the item came from a root
   * this pass does not know about.
   */
  skippedOutsideInbox: number;
  /**
   * True when the inbox root itself was missing, in which case NOTHING was
   * discarded — see the guard below.
   */
  rootMissing: boolean;
}

/**
 * Discard pending review items whose source file no longer exists.
 *
 * ── The mount guard is the important part ──────────────────────────────────
 * The inbox is a network mount on a real deployment (`/mnt/…/inbox`). When a
 * mount drops, every path under it stops existing at once — and without this
 * guard the pass would read that as "every pending acquisition was deleted"
 * and discard the entire review queue in one sweep. Those items are decisions
 * the user has not made yet, and a transient network blip must not be able to
 * throw them away. So: if the root is not a present directory, do nothing at
 * all and say so. A missing root is never evidence about the files under it.
 *
 * The check is `statSync`, not `existsSync`, because a root that has become a
 * broken symlink or a plain file is just as unusable and just as much a
 * reason to refuse.
 */
export async function discardMissingAcquisitionInputs(
  ingestStore: IngestStore,
  inboxDir: string,
): Promise<AcquisitionReconcileResult> {
  const result: AcquisitionReconcileResult = {
    discarded: 0,
    keptExisting: 0,
    skippedOutsideInbox: 0,
    rootMissing: false,
  };
  const resolvedInbox = path.resolve(inboxDir);

  try {
    if (!fs.statSync(resolvedInbox).isDirectory()) {
      result.rootMissing = true;
      return result;
    }
  } catch {
    result.rootMissing = true;
    return result;
  }

  for (const item of ingestStore.pendingReviewItems()) {
    if (item.action.action_type !== "duplicate" && item.action.action_type !== "error") continue;
    const sourcePath = path.resolve(item.action.source_path);
    try {
      await assertContained(sourcePath, resolvedInbox, { mustExist: false });
    } catch {
      result.skippedOutsideInbox += 1;
      continue;
    }
    if (fs.existsSync(sourcePath)) {
      result.keptExisting += 1;
      continue;
    }
    if (ingestStore.discardItem(item.id)) result.discarded += 1;
  }

  return result;
}
