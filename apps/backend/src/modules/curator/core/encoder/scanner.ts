/**
 * ABS library directory scanner ([MADP-LIGHT]).
 *
 * Walks the configured library root and reports folders that hold loose
 * `.mp3`/`.m4a` files (and no existing single `.m4b`) — i.e. candidates for
 * merging into one chaptered `.m4b`.
 *
 * Safety (the destructive-capability guardrail):
 *  - `assertWithinRoot` rejects any path that escapes the configured root, so an
 *    API/MCP-supplied `relativeDir` can never be used for path traversal.
 *  - Symlinked directories are NOT followed, so a symlink inside the library
 *    cannot redirect the walk (or a later in-place write) outside the root.
 */
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';

import { PathForbiddenError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import { probeCandidate, type ProbeDeps } from './probe.js';
import { LOOSE_AUDIO_EXTENSIONS, type EncodeCandidate } from './encodeTypes.js';

const LOOSE = new Set<string>(LOOSE_AUDIO_EXTENSIONS);

/**
 * Resolve `target` (which may be relative) against `root` and ensure the result
 * stays inside `root`. Returns the absolute resolved path. Throws
 * PathForbiddenError on escape (`..`, absolute path outside, etc.).
 */
export function assertWithinRoot(root: string, target: string): string {
  const absRoot = resolve(root);
  const absTarget = resolve(absRoot, target);
  if (absTarget !== absRoot && !absTarget.startsWith(absRoot + sep)) {
    throw new PathForbiddenError(`Path "${target}" escapes the configured library root`, {
      root: absRoot,
    });
  }
  return absTarget;
}

/** Natural-order comparator so track2 sorts before track10. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export interface ScanDeps {
  /** Run ffprobe on each candidate to attach an AudioProbe (slower). */
  probe?: boolean;
  probeDeps?: ProbeDeps;
  logger?: Logger;
}

/**
 * Recursively scan `root` for encodable folders. A folder qualifies when it
 * directly contains at least one loose `.mp3`/`.m4a` and no `.m4b` already.
 */
export async function scanLibrary(root: string, deps: ScanDeps = {}): Promise<EncodeCandidate[]> {
  const logger = deps.logger ?? nullLogger;
  const absRoot = resolve(root);
  const out: EncodeCandidate[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      logger.debug('scan: unreadable dir', { dir, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const looseFiles: string[] = [];
    let hasM4b = false;
    const subdirs: string[] = [];

    for (const entry of entries) {
      // Never follow symlinks (file or dir) — they can point outside the root.
      if (entry.isSymbolicLink()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (entry.isDirectory()) {
        subdirs.push(resolve(dir, entry.name));
      } else if (entry.isFile()) {
        if (ext === '.m4b') hasM4b = true;
        else if (LOOSE.has(ext)) looseFiles.push(resolve(dir, entry.name));
      }
    }

    if (looseFiles.length > 0 && !hasM4b) {
      looseFiles.sort(naturalCompare);
      let totalBytes = 0;
      for (const f of looseFiles) {
        try {
          totalBytes += (await stat(f)).size;
        } catch {
          /* file vanished between readdir and stat — ignore in the total */
        }
      }
      const probe = deps.probe && deps.probeDeps ? await probeCandidate(looseFiles, deps.probeDeps) : null;
      const rel = relative(absRoot, dir);
      out.push({
        sourceDir: dir,
        relativeDir: rel === '' ? '.' : rel,
        name: basename(dir),
        files: looseFiles,
        totalBytes,
        probe,
      });
    }

    // Recurse regardless (nested author/series/title layouts are common).
    for (const sub of subdirs) await walk(sub);
  };

  await walk(absRoot);
  out.sort((a, b) => naturalCompare(a.relativeDir, b.relativeDir));
  return out;
}
