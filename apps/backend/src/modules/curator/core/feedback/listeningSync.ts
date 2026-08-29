/**
 * Ingest Audiobookshelf listening history and turn it into implicit feedback
 * (plan §6, Phase 5: "ABS listening progress via the existing sync").
 *
 * Three steps, deliberately separable so a partial failure is still useful:
 *   1. snapshot progress    — overwritten per book
 *   2. append sessions      — idempotent on the ABS session id
 *   3. derive verdicts      — restated, not appended (see listeningSignals.ts)
 *
 * The ABS surface is injected rather than imported so tests never touch a
 * network — the same seam `MessageCreator` and `EmbeddingCreator` use
 * (AGENTS.md testing rules).
 *
 * ── Only books this mirror knows about ─────────────────────────────────────
 * ABS reports progress for every item in the account, including libraries
 * this curator never synced (podcasts, a second library). Rows for unknown
 * book ids are counted and dropped rather than stored: `listening_progress`
 * has no foreign key precisely so a legitimate race does not lose data, but
 * a row that can never join to `books` would only ever dilute the taste
 * profile and inflate the coverage numbers.
 */
import type { CuratorDb } from '../db.js';
import type { ListeningProgress, ListeningSession } from '../types.js';
import { applyImplicitFeedback } from './listeningSignals.js';

/** The narrow slice of `ABSClient` this module needs. */
export interface ListeningHistorySource {
  getListeningProgress(now: number): Promise<ListeningProgress[]>;
  getListeningSessions(limit?: number): Promise<ListeningSession[]>;
}

export interface ListeningSyncResult {
  /** Progress rows stored (after dropping unknown books). */
  progressStored: number;
  /** Progress rows ABS reported for books this mirror has never synced. */
  progressSkippedUnknownBook: number;
  /** Sessions newly inserted; re-seen ids are not counted. */
  sessionsInserted: number;
  sessionsSkippedUnknownBook: number;
  /** Books that got an implicit verdict this run. */
  feedbackWritten: number;
  /** Books with progress but no verdict yet — barely started, or still active. */
  feedbackDeferred: number;
}

export interface SyncListeningHistoryInput {
  source: ListeningHistorySource;
  db: CuratorDb;
  /** Passed in, never read from the clock, so a sync is reproducible in tests. */
  now: number;
  /** How many recent sessions to pull. */
  sessionLimit?: number;
}

export async function syncListeningHistory(
  input: SyncListeningHistoryInput
): Promise<ListeningSyncResult> {
  const { db, now } = input;

  const known = new Set(db.getAllBooks().map((book) => book.id));

  const reportedProgress = await input.source.getListeningProgress(now);
  const progress = reportedProgress.filter((row) => known.has(row.bookId));
  for (const row of progress) db.upsertListeningProgress(row);

  const reportedSessions = await input.source.getListeningSessions(input.sessionLimit);
  const sessions = reportedSessions.filter((row) => known.has(row.bookId));
  const sessionsInserted = db.insertListeningSessions(sessions);

  // Derive from what is now stored rather than from `progress` alone, so a
  // book whose ABS row vanished this run keeps the verdict its last known
  // state earned instead of silently losing it.
  const { written, skipped } = applyImplicitFeedback(
    db.getAllListeningProgress(),
    now,
    (row) => db.upsertImplicitFeedback(row)
  );

  return {
    progressStored: progress.length,
    progressSkippedUnknownBook: reportedProgress.length - progress.length,
    sessionsInserted,
    sessionsSkippedUnknownBook: reportedSessions.length - sessions.length,
    feedbackWritten: written,
    feedbackDeferred: skipped,
  };
}
