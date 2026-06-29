import pLimit from 'p-limit';

import type { ABSClient } from '../absClient.js';
import type { AbsSocketClient } from '../absSocketClient.js';
import type { ActionLog } from '../actionLog.js';
import { EncodeError, OperationCancelledError, toAppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { OperationController } from '../operations.js';
import type { ProgressCallback } from '../types.js';
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
  absLibraryId: string;
}

export interface EncodeEngineDeps {
  config: EncoderRuntimeConfig;
  absClient: ABSClient;
  absSocketClient: AbsSocketClient;
  controller?: OperationController;
  actionLog?: ActionLog;
  logger?: Logger;
  onProgress?: ProgressCallback;
  onLine?: (line: string) => void;
  now?: () => number;
}

export function assertEncoderEnabled(config: EncoderRuntimeConfig): void {
  if (!config.absLibraryId) {
    throw new EncodeError(
      'Encoder disabled: set ABS_LIBRARY_ID to the ABS library ID to enable encoding.'
    );
  }
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

  // Fresh scan to find candidates
  let candidates = await scanLibrary({ absClient: deps.absClient, libraryId: deps.config.absLibraryId });
  if (options.candidates && options.candidates.length > 0) {
    const wanted = new Set(options.candidates);
    candidates = candidates.filter((c) => wanted.has(c.libraryItemId));
  }
  if (options.sample > 0) candidates = candidates.slice(0, options.sample);

  const result: EncodeResult = {
    encoded: 0,
    skipped: 0,
    failed: 0,
    items: [],
    dryRun: options.dryRun,
  };

  action?.record('info', 'encode_started', `Encode run started (${candidates.length} candidates)`, {
    operationId: opId,
    detail: { candidates: candidates.length, dryRun: options.dryRun },
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

  // Usually ABS queues tasks natively, but we limit concurrent dispatch here
  const limit = pLimit(1);
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
            result.items.push({ libraryItemId: candidate.libraryItemId, status: 'skipped' });
            return;
          }
          throw err;
        }
      }

      const item: EncodeItemResult = { libraryItemId: candidate.libraryItemId, status: 'failed' };
      try {
        if (deps.controller) {
           deps.absSocketClient.watchItem(candidate.libraryItemId, deps.controller);
        }

        deps.onLine?.(`Triggering ABS M4B encode for item ${candidate.libraryItemId} ("${candidate.name}")...`);
        
        await deps.absClient.encodeBookToM4b(candidate.libraryItemId);

        // In a fully integrated flow, we would wait for the socket client to report completion.
        // For simplicity, we just assume the API trigger succeeded and the background job is queued in ABS.
        // The frontend will track the socket stream.
        item.status = 'encoded';
        result.encoded += 1;
        
        action?.record('info', 'encode_item_queued', `Queued "${candidate.name}" for encoding in ABS`, {
          operationId: opId,
          detail: { libraryItemId: candidate.libraryItemId },
        });
      } catch (err) {
        const appErr = toAppError(err);
        item.error = { code: appErr.code, message: appErr.message };
        result.failed += 1;
        action?.record('error', 'encode_item_failed', `Failed "${candidate.name}": ${appErr.message}`, {
          operationId: opId,
          detail: { libraryItemId: candidate.libraryItemId, code: appErr.code },
        });
        logger.warn('Encode failed', { libraryItemId: candidate.libraryItemId, code: appErr.code });
      } finally {
        if (deps.controller) {
           // deps.absSocketClient.unwatchItem(candidate.libraryItemId); 
           // Usually we keep watching until ABS says it's finished, but this script moves on.
           // Leaving it watched is fine for the session.
        }
        result.items.push(item);
        done += 1;
        const progress = { phase: 'encode', current: done, total: candidates.length, message: candidate.name };
        deps.controller?.setProgress(progress);
        deps.onProgress?.(progress);
      }
    })
  );

  await Promise.all(tasks);

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
