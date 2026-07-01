/**
 * Scheduled auto-curation (Task 3.5) — OFF by default.
 *
 * Gated entirely by CRON_SCHEDULE: an empty schedule installs NO cron job. When
 * enabled, each tick runs sync → tag new books → regenerate templates, and only
 * pushes to ABS when AUTO_PUSH=true.
 *
 * Adversarial set (MADP-FULL — this code can modify ABS unattended, so the
 * safety defaults must be proven): disabled-by-default (empty schedule = no job),
 * AUTO_PUSH=false NEVER writes to ABS, D1–D3. The job body is exported as
 * `runScheduledCuration` so the defaults are testable without real cron timing.
 */
import cron from 'node-cron';

import type { ActionLog } from './actionLog.js';
import type { ABSClient } from './absClient.js';
import type { ClaudeClient } from './claudeClient.js';
import type { Config } from './config.js';
import type { CuratorDb } from './db.js';
import { toAppError } from './errors.js';
import { nullLogger, type Logger } from './logger.js';
import { generateFromTemplate, pushCollection, TEMPLATES } from './collectionEngine.js';
import { syncLibrary } from './sync.js';
import { tagUntaggedBooks } from './tagger.js';

export interface SchedulerDeps {
  absClient: ABSClient;
  db: CuratorDb;
  claudeClient: ClaudeClient;
  config: Config;
  logger?: Logger;
  actionLog?: ActionLog;
}

export interface ScheduledRunSummary {
  synced: number;
  tagged: number;
  regenerated: string[];
  pushed: number;
  autoPush: boolean;
  errors: { code: string; message: string }[];
}

export async function runScheduledCuration(deps: SchedulerDeps): Promise<ScheduledRunSummary> {
  const logger = deps.logger ?? nullLogger;
  const summary: ScheduledRunSummary = {
    synced: 0,
    tagged: 0,
    regenerated: [],
    pushed: 0,
    autoPush: deps.config.autoPush,
    errors: [],
  };

  deps.actionLog?.record('info', 'cron_started', 'Scheduled curation started', {
    detail: { autoPush: deps.config.autoPush },
  });

  try {
    const sync = await syncLibrary(deps.absClient, deps.db, { logger });
    summary.synced = sync.added + sync.updated;

    const tag = await tagUntaggedBooks(deps.claudeClient, deps.db, {
      concurrency: deps.config.taggingConcurrency,
      absClient: deps.absClient,
      logger,
      ...(deps.actionLog ? { actionLog: deps.actionLog } : {}),
    });
    summary.tagged = tag.processed;

    for (const template of TEMPLATES) {
      if (template.usesClaude) continue;
      const result = generateFromTemplate(deps.db, template.id, { replaceExisting: true, logger });
      summary.regenerated.push(template.id);

      // SAFETY: only ever write to ABS when AUTO_PUSH is explicitly enabled.
      if (deps.config.autoPush && result.books.length > 0) {
        deps.db.updateCollectionStatus(result.collection.id, 'approved');
        const push = await pushCollection(deps.absClient, deps.db, result.collection.id, {
          policy: 'skip',
          logger,
        });
        if (push.action !== 'skipped') summary.pushed += 1;
      }
    }

    deps.actionLog?.record('info', 'cron_finished', 'Scheduled curation finished', { detail: summary });
    logger.info('Scheduled curation finished', { ...summary });
  } catch (err) {
    const appErr = toAppError(err);
    summary.errors.push({ code: appErr.code, message: appErr.message });
    deps.actionLog?.record('error', 'cron_error', `Scheduled curation failed: ${appErr.message}`, {
      detail: { code: appErr.code },
    });
    logger.error('Scheduled curation failed', { code: appErr.code, message: appErr.message });
  }

  return summary;
}

export interface SchedulerHandle {
  stop(): void;
}

/**
 * Install the cron job if a schedule is configured. Returns null when disabled
 * (empty schedule) — the safe default.
 */
export function startScheduler(deps: SchedulerDeps): SchedulerHandle | null {
  const logger = deps.logger ?? nullLogger;
  const schedule = deps.config.cronSchedule.trim();
  if (schedule === '') {
    logger.info('Scheduler disabled (CRON_SCHEDULE empty)');
    return null;
  }
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid CRON_SCHEDULE: "${schedule}"`);
  }

  let running = false;
  const task = cron.schedule(schedule, () => {
    if (running) {
      logger.warn('Skipping scheduled run — previous run still in progress');
      return;
    }
    running = true;
    void runScheduledCuration(deps).finally(() => {
      running = false;
    });
  });

  logger.info('Scheduler enabled', { schedule, autoPush: deps.config.autoPush });
  return { stop: () => task.stop() };
}
