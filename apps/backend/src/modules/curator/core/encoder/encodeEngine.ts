/**
 * Audio encode engine ([MADP-FULL]).
 *
 * Orchestrates a job over candidate folders, mirroring the tagger's ergonomics
 * (dryRun / sample / cooperative pause-cancel via OperationController) but for a
 * filesystem+subprocess workload instead of an API one.
 *
 * File-safety is the headline guarantee:
 *  - `output-dir`: write the `.m4b` to a mirrored path under ENCODE_OUTPUT_PATH;
 *    the source folder is NEVER touched (even on failure).
 *  - `in-place`: encode to a temp file, ffprobe-VERIFY it, and only THEN move the
 *    originals to ENCODE_BACKUP_PATH and drop the `.m4b` into the source folder.
 *    A failed/unverifiable encode leaves the source completely intact.
 *
 * Subprocess + probe runners are injectable so tests prove the safety invariants
 * without a real ffmpeg/m4b-tool.
 */
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import pLimit from 'p-limit';

import type { ABSClient } from '../absClient.js';
import type { ActionLog } from '../actionLog.js';
import { EncodeError, OperationCancelledError, toAppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { OperationController } from '../operations.js';
import type { ProgressCallback } from '../types.js';
import { runM4bTool, type SpawnFn } from './m4bTool.js';
import { probeFile, type ExecFileFn } from './probe.js';
import { scanLibrary } from './scanner.js';
import {
  encodeOptionsSchema,
  type EncodeCandidate,
  type EncodeItemResult,
  type EncodeOptions,
  type EncodeResult,
} from './encodeTypes.js';

/** Runtime config the engine needs (subset of the global Config). */
export interface EncoderRuntimeConfig {
  absLibraryPath: string;
  encodeOutputPath: string;
  encodeBackupPath: string;
  m4bToolPath: string;
  ffprobePath: string;
  encodeConcurrency: number;
  absLibraryId: string;
}

export interface EncodeEngineDeps {
  config: EncoderRuntimeConfig;
  /** Used only when options.rescanAfter is set. */
  absClient?: ABSClient;
  spawnImpl?: SpawnFn;
  execFileImpl?: ExecFileFn;
  controller?: OperationController;
  actionLog?: ActionLog;
  logger?: Logger;
  onProgress?: ProgressCallback;
  /** Raw subprocess log lines (WS console + ActionLog at debug). */
  onLine?: (line: string) => void;
  now?: () => number;
}

/** Throw a clear error when the encoder isn't configured (library path unset). */
export function assertEncoderEnabled(config: EncoderRuntimeConfig): void {
  if (!config.absLibraryPath) {
    throw new EncodeError(
      'Encoder disabled: set ABS_LIBRARY_PATH to the ABS library directory to enable encoding.'
    );
  }
}

function outputPathFor(candidate: EncodeCandidate, config: EncoderRuntimeConfig, mode: EncodeOptions['mode']): string {
  const fileName = `${candidate.name}.m4b`;
  if (mode === 'in-place') return join(candidate.sourceDir, fileName);
  return join(config.encodeOutputPath, candidate.relativeDir, fileName);
}

/** Verify a produced .m4b looks like real, non-empty audio before trusting it. */
async function verifyOutput(outputPath: string, deps: EncodeEngineDeps): Promise<boolean> {
  try {
    if ((await stat(outputPath)).size === 0) return false;
  } catch {
    return false;
  }
  const probe = await probeFile(outputPath, {
    ffprobePath: deps.config.ffprobePath,
    ...(deps.execFileImpl ? { execFileImpl: deps.execFileImpl } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
  return Boolean(probe && probe.durationSeconds && probe.durationSeconds > 0);
}

export async function encodeCandidates(
  rawOptions: unknown,
  deps: EncodeEngineDeps
): Promise<EncodeResult> {
  assertEncoderEnabled(deps.config);
  const options: EncodeOptions = encodeOptionsSchema.parse(rawOptions);
  const logger = deps.logger ?? nullLogger;
  const action = deps.actionLog;
  const opId = deps.controller?.id;

  // Fresh scan (no probe — fast) then narrow to the requested folders.
  let candidates = await scanLibrary(deps.config.absLibraryPath, { logger });
  if (options.candidates && options.candidates.length > 0) {
    const wanted = new Set(options.candidates);
    candidates = candidates.filter((c) => wanted.has(c.relativeDir));
  }
  if (options.sample > 0) candidates = candidates.slice(0, options.sample);

  const result: EncodeResult = {
    encoded: 0,
    skipped: 0,
    failed: 0,
    mode: options.mode,
    items: [],
    dryRun: options.dryRun,
  };

  action?.record('info', 'encode_started', `Encode run started (${candidates.length} candidates)`, {
    operationId: opId,
    detail: { candidates: candidates.length, mode: options.mode, dryRun: options.dryRun },
  });

  // ── Dry run: report the plan, spawn nothing. ────────────────────────────────
  if (options.dryRun) {
    result.plan = candidates;
    result.skipped = candidates.length;
    deps.controller?.markCompleted(result);
    action?.record('info', 'encode_dry_run', `Dry run: ${candidates.length} folders would be encoded`, {
      operationId: opId,
    });
    return result;
  }

  if (candidates.length === 0) {
    deps.controller?.markCompleted(result);
    return result;
  }

  const limit = pLimit(Math.max(1, deps.config.encodeConcurrency));
  let done = 0;
  let cancelled = false;

  const tasks = candidates.map((candidate) =>
    limit(async () => {
      if (deps.controller) {
        try {
          await deps.controller.checkpoint();
        } catch (err) {
          if (err instanceof OperationCancelledError) {
            cancelled = true;
            result.skipped += 1;
            result.items.push({ relativeDir: candidate.relativeDir, status: 'skipped' });
            return;
          }
          throw err;
        }
      }

      const item: EncodeItemResult = { relativeDir: candidate.relativeDir, status: 'failed' };
      try {
        const finalPath = outputPathFor(candidate, deps.config, options.mode);
        // In-place encodes to a temp file first so the source is only mutated
        // after a verified success.
        const encodePath = options.mode === 'in-place' ? `${finalPath}.part` : finalPath;
        await mkdir(dirname(encodePath), { recursive: true });

        const totalDur = candidate.probe?.durationSeconds ?? null;
        await runM4bTool(
          {
            files: candidate.files,
            outputPath: encodePath,
            audioCodec: options.audioCodec,
            bitRate: options.bitRate,
            totalDurationSeconds: totalDur,
            ...(deps.controller ? { signal: cancelSignal(deps.controller) } : {}),
            ...(deps.onLine ? { onLine: deps.onLine } : {}),
            ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
          },
          {
            m4bToolPath: deps.config.m4bToolPath,
            ...(deps.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
            ...(deps.logger ? { logger: deps.logger } : {}),
          }
        );

        const ok = await verifyOutput(encodePath, deps);
        if (!ok) {
          await rm(encodePath, { force: true });
          throw new EncodeError(`Produced .m4b for "${candidate.name}" failed verification`, {
            outputPath: encodePath,
          });
        }

        if (options.mode === 'in-place') {
          // Move originals to the backup tree, THEN promote the temp file.
          await backupOriginals(candidate, deps);
          await rename(encodePath, finalPath);
        }

        item.status = 'encoded';
        item.outputPath = finalPath;
        item.outputBytes = (await stat(finalPath)).size;
        result.encoded += 1;
        action?.record('info', 'encode_item_done', `Encoded "${candidate.name}"`, {
          operationId: opId,
          detail: { relativeDir: candidate.relativeDir, outputPath: finalPath },
        });
      } catch (err) {
        const appErr = toAppError(err);
        item.error = { code: appErr.code, message: appErr.message };
        result.failed += 1;
        action?.record('error', 'encode_item_failed', `Failed "${candidate.name}": ${appErr.message}`, {
          operationId: opId,
          detail: { relativeDir: candidate.relativeDir, code: appErr.code },
        });
        logger.warn('Encode failed', { relativeDir: candidate.relativeDir, code: appErr.code });
      } finally {
        result.items.push(item);
        done += 1;
        const progress = { phase: 'encode', current: done, total: candidates.length, message: candidate.name };
        deps.controller?.setProgress(progress);
        deps.onProgress?.(progress);
      }
    })
  );

  await Promise.all(tasks);

  // Optional ABS rescan so the new .m4b is picked up; otherwise warn the UI.
  if (!cancelled && result.encoded > 0) {
    if (options.rescanAfter && deps.absClient && deps.config.absLibraryId) {
      try {
        await deps.absClient.triggerLibraryScan(deps.config.absLibraryId);
        result.rescanTriggered = true;
        action?.record('info', 'encode_rescan', 'Triggered ABS library rescan', { operationId: opId });
      } catch (err) {
        result.rescanRequired = true;
        const appErr = toAppError(err);
        action?.record('warn', 'encode_rescan_failed', `Rescan trigger failed: ${appErr.message}`, {
          operationId: opId,
        });
      }
    } else {
      result.rescanRequired = true;
    }
  }

  if (cancelled) {
    result.cancelled = true;
    deps.controller?.markCancelled(result);
    action?.record('warn', 'encode_cancelled', `Encode cancelled after ${result.encoded} done`, {
      operationId: opId,
    });
  } else {
    deps.controller?.markCompleted(result);
    action?.record('info', 'encode_finished', `Encode finished: ${result.encoded} done, ${result.failed} failed`, {
      operationId: opId,
      detail: { encoded: result.encoded, failed: result.failed },
    });
  }

  return result;
}

/** Move a candidate's source audio files into the mirrored backup tree. */
async function backupOriginals(candidate: EncodeCandidate, deps: EncodeEngineDeps): Promise<void> {
  const backupRoot = deps.config.encodeBackupPath;
  if (!backupRoot) {
    throw new EncodeError('in-place mode requires ENCODE_BACKUP_PATH to be set');
  }
  const destDir = join(backupRoot, candidate.relativeDir);
  await mkdir(destDir, { recursive: true });
  for (const file of candidate.files) {
    await rename(file, join(destDir, basenameOf(file)));
  }
}

function basenameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Bridge an OperationController's cancellation to an AbortSignal so a cancel
 * kills the in-flight subprocess (not just future checkpoints). Polls the
 * controller status cheaply; the process usually finishes long before.
 */
function cancelSignal(controller: OperationController): AbortSignal {
  const ac = new AbortController();
  const poll = setInterval(() => {
    if (controller.status === 'cancelling' || controller.status === 'cancelled') {
      ac.abort();
      clearInterval(poll);
    }
  }, 200);
  poll.unref?.();
  ac.signal.addEventListener('abort', () => clearInterval(poll), { once: true });
  return ac.signal;
}
