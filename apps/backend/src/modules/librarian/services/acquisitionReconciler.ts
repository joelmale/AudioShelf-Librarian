import fs from "node:fs";
import path from "node:path";
import { assertContained } from "../../../security/paths.js";
import type { IngestStore } from "../ingestStore.js";
import { AUDIO_EXTENSIONS } from "./scanner.js";

/**
 * Why an item still sits in "Requires input" after its file went away.
 *
 * The queue is projected straight from `ingest_job_items`, so an item stays
 * forever until something resolves it. The delete endpoint resolves items it
 * deletes itself; this pass covers every other route a file can leave by —
 * removed from the NAS, moved by hand, cleaned up by Audiobookshelf, or
 * emptied of everything importable while the folder itself survives.
 */
export interface AcquisitionReconcileResult {
  /** Items discarded because their source path is gone. */
  discarded: number;
  /**
   * Items discarded because the source folder still EXISTS but holds nothing
   * importable — the leftover case. Observed live: a `Red Rising [1-5]` folder
   * that had been emptied down to a single `.txt`, holding a duplicate
   * decision open over a folder with no audiobook in it.
   */
  discardedEmpty: number;
  /** Folders behind `discardedEmpty`, so a caller can report or clean them up. */
  emptyFolders: string[];
  /** Left alone: real media is still there, so the decision is still real. */
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

/** Directory depth to search for media before giving up. Deep enough for
 *  `Series/Book/Disc 1/track.mp3`, shallow enough never to walk a library. */
const MAX_MEDIA_SCAN_DEPTH = 4;

/**
 * Does this path still hold anything worth importing?
 *
 * A bare file is judged by its own extension. A directory is walked until the
 * first audio file is found — first hit wins, so the common case costs one
 * `readdir`.
 *
 * ── An unreadable directory is NOT an empty one ────────────────────────────
 * Every failure path returns `true` ("assume media"). This function only ever
 * causes an item to be DISCARDED, so a permission error or a half-mounted
 * share must never be read as "nothing here" — the safe direction is to leave
 * the decision alone and let a human look.
 */
export function hasImportableMedia(target: string, depth = 0): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return true;
  }

  if (stat.isFile()) return AUDIO_EXTENSIONS.has(path.extname(target).toLowerCase());
  if (!stat.isDirectory()) return true;
  if (depth >= MAX_MEDIA_SCAN_DEPTH) return true;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return true;
  }

  for (const entry of entries) {
    // Synology index folders and macOS metadata are not content. Counting
    // them would make every leftover look occupied — the `@eaDir` and
    // `.DS_Store` sitting beside the real folder in this very inbox are why
    // this exclusion is here rather than theoretical.
    if (entry.name === "@eaDir" || entry.name.startsWith(".")) continue;
    const child = path.join(target, entry.name);
    if (entry.isFile()) {
      if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) return true;
    } else if (entry.isDirectory()) {
      if (hasImportableMedia(child, depth + 1)) return true;
    } else {
      // A symlink or special entry we did not resolve — do not call it empty.
      return true;
    }
  }
  return false;
}

/**
 * Discard pending review items whose source no longer holds an audiobook.
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
 *
 * ── This never deletes anything from disk ──────────────────────────────────
 * Only the ingest ROW is discarded. An emptied folder is reported in
 * `emptyFolders` for a human to remove through the existing delete endpoint,
 * which has its own containment checks. Resolving a stale decision is cheap
 * and reversible; removing files on a heuristic is neither.
 */
export async function discardMissingAcquisitionInputs(
  ingestStore: IngestStore,
  inboxDir: string,
): Promise<AcquisitionReconcileResult> {
  const result: AcquisitionReconcileResult = {
    discarded: 0,
    discardedEmpty: 0,
    emptyFolders: [],
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

    if (!fs.existsSync(sourcePath)) {
      if (ingestStore.discardItem(item.id)) result.discarded += 1;
      continue;
    }

    if (!hasImportableMedia(sourcePath)) {
      if (ingestStore.discardItem(item.id)) {
        result.discardedEmpty += 1;
        result.emptyFolders.push(sourcePath);
      }
      continue;
    }

    result.keptExisting += 1;
  }

  return result;
}
