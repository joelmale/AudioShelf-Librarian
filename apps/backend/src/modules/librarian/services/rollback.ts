import fs from "node:fs";
import path from "node:path";
import type { OrganizationAction } from "@audioshelf/shared";
import { assertContainedInAny } from "../../../security/paths.js";
import { INBOX_INCOMING_PREFIX } from "./torrentMonitor.js";
import { randomUUID } from "node:crypto";

/**
 * Undo a committed batch of organization actions.
 *
 * Extracted from the route handler because the previous inline version reported
 * success unconditionally: every per-action failure was logged and swallowed,
 * and the history entry was deleted whether or not anything moved. That is
 * reachable on the ordinary path — committing an action cleans up the emptied
 * source directory, so the rename back fails with ENOENT — and it destroyed the
 * only record needed to retry.
 *
 * Rolling back is idempotent: an action whose file is no longer at the target is
 * reported as already-rolled-back rather than failed, so retrying a partially
 * applied rollback re-attempts only what is still outstanding.
 */

export type RollbackStatus =
  | "rolled_back"
  /** Not a filesystem mutation (skip / duplicate / error actions). */
  | "not_applicable"
  /** Nothing at the target — most likely rolled back already. */
  | "already_reverted"
  | "failed";

export interface RollbackItemResult {
  sourcePath: string;
  targetPath: string;
  status: RollbackStatus;
  error?: string;
}

export interface RollbackSummary {
  /** True only when nothing failed, i.e. the batch may be discarded. */
  complete: boolean;
  rolledBack: number;
  alreadyReverted: number;
  notApplicable: number;
  failed: number;
  results: RollbackItemResult[];
}

export interface RollbackOptions {
  inboxDir: string;
  libraryDir: string;
  additionalRoots?: string[];
}

function isReversible(action: OrganizationAction): boolean {
  return action.action_type === "move" || action.action_type === "rename";
}

async function revertOne(action: OrganizationAction, roots: string[]): Promise<RollbackItemResult> {
  const targetPath = path.resolve(action.target_path);
  const sourcePath = path.resolve(action.source_path);
  const base = { sourcePath, targetPath };

  // Both ends are validated. The destination matters most: it is where this
  // function *writes*, and it was previously unchecked — the one code path
  // whose entire job is undoing damage should not be able to cause any.
  for (const [candidate, label] of [[targetPath, "current location"], [sourcePath, "restore destination"]] as const) {
    try {
      await assertContainedInAny(candidate, roots);
    } catch {
      return { ...base, status: "failed", error: `Rollback ${label} is outside the configured directories` };
    }
  }

  if (!fs.existsSync(targetPath)) {
    return { ...base, status: "already_reverted" };
  }

  if (fs.existsSync(sourcePath)) {
    return { ...base, status: "failed", error: "Restore destination is already occupied" };
  }

  try {
    // Committing the action removed the emptied source directory, so the parent
    // usually no longer exists. Recreating it is what makes rollback work at all.
    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });

    try {
      await fs.promises.rename(targetPath, sourcePath);
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== "EXDEV") throw error;
      // Across mounts there is no atomic rename. Copy under a hidden name the
      // inbox poller skips, then rename into place, so a failure halfway never
      // leaves a partial book at the restore path -- where the poller would
      // import it and a retry would stop on "destination is occupied".
      const staged = path.join(path.dirname(sourcePath), `${INBOX_INCOMING_PREFIX}${randomUUID()}`);
      try {
        await fs.promises.cp(targetPath, staged, { recursive: true, errorOnExist: true });
        await fs.promises.rename(staged, sourcePath);
      } catch (copyError) {
        await fs.promises.rm(staged, { recursive: true, force: true }).catch(() => undefined);
        throw copyError;
      }
      await fs.promises.rm(targetPath, { recursive: true, force: true });
    }

    return { ...base, status: "rolled_back" };
  } catch (error: unknown) {
    return { ...base, status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function rollbackBatch(
  actions: OrganizationAction[],
  options: RollbackOptions,
): Promise<RollbackSummary> {
  const roots = [options.inboxDir, options.libraryDir, ...(options.additionalRoots ?? [])]
    .filter(Boolean)
    .map((root) => path.resolve(root));

  const results: RollbackItemResult[] = [];
  for (const action of actions) {
    if (!isReversible(action)) {
      results.push({
        sourcePath: path.resolve(action.source_path),
        targetPath: path.resolve(action.target_path),
        status: "not_applicable",
      });
      continue;
    }
    results.push(await revertOne(action, roots));
  }

  const count = (status: RollbackStatus) => results.filter((result) => result.status === status).length;
  const failed = count("failed");

  return {
    complete: failed === 0,
    rolledBack: count("rolled_back"),
    alreadyReverted: count("already_reverted"),
    notApplicable: count("not_applicable"),
    failed,
    results,
  };
}
