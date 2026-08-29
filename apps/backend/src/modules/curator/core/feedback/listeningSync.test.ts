import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book, ListeningProgress, ListeningSession } from '../types.js';
import { syncListeningHistory, type ListeningHistorySource } from './listeningSync.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const databases: CuratorDb[] = [];

function makeDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

function addBook(db: CuratorDb, input: Partial<Book> & Pick<Book, 'id' | 'title'>): void {
  db.upsertBook({
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: NOW,
    ...input,
  });
}

function source(
  progress: ListeningProgress[],
  sessions: ListeningSession[] = []
): ListeningHistorySource {
  return {
    getListeningProgress: vi.fn(async () => progress),
    getListeningSessions: vi.fn(async () => sessions),
  };
}

function progressRow(bookId: string, overrides: Partial<ListeningProgress> = {}): ListeningProgress {
  return {
    bookId,
    progress: 1,
    isFinished: true,
    startedAt: null,
    finishedAt: NOW,
    timeListening: 3600,
    lastPlayedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe('syncListeningHistory', () => {
  it('stores progress, appends sessions, and derives one implicit verdict per book', async () => {
    const db = makeDb();
    addBook(db, { id: 'a', title: 'A' });
    addBook(db, { id: 'b', title: 'B' });

    const result = await syncListeningHistory({
      db,
      now: NOW,
      source: source(
        [
          progressRow('a'),
          progressRow('b', { isFinished: false, progress: 0.1, lastPlayedAt: NOW - 90 * DAY }),
        ],
        [{ id: 's1', bookId: 'a', startedAt: NOW - DAY, duration: 1800, playbackSpeed: 1.5, device: 'phone' }]
      ),
    });

    expect(result.progressStored).toBe(2);
    expect(result.sessionsInserted).toBe(1);
    expect(result.feedbackWritten).toBe(2);
    const verdicts = db.getRecFeedback().map((row) => `${row.bookId}:${row.verdict}`).sort();
    expect(verdicts).toEqual(['a:finished', 'b:abandoned']);
  });

  it('drops rows for books this mirror has never synced, and counts them', async () => {
    const db = makeDb();
    addBook(db, { id: 'known', title: 'Known' });

    const result = await syncListeningHistory({
      db,
      now: NOW,
      source: source(
        [progressRow('known'), progressRow('podcast-from-another-library')],
        [
          { id: 's1', bookId: 'known', startedAt: NOW, duration: 60, playbackSpeed: null, device: null },
          { id: 's2', bookId: 'unknown', startedAt: NOW, duration: 60, playbackSpeed: null, device: null },
        ]
      ),
    });

    expect(result.progressStored).toBe(1);
    expect(result.progressSkippedUnknownBook).toBe(1);
    expect(result.sessionsInserted).toBe(1);
    expect(result.sessionsSkippedUnknownBook).toBe(1);
    expect(db.getListeningProgress('podcast-from-another-library')).toBeNull();
  });

  it('is idempotent: a second sync adds no duplicate session or feedback row', async () => {
    const db = makeDb();
    addBook(db, { id: 'a', title: 'A' });
    const input = {
      db,
      now: NOW,
      source: source(
        [progressRow('a')],
        [{ id: 's1', bookId: 'a', startedAt: NOW, duration: 60, playbackSpeed: null, device: null }]
      ),
    };

    await syncListeningHistory(input);
    const second = await syncListeningHistory(input);

    // Re-seeing a session id must not append; re-deriving a verdict must
    // restate, not accumulate — otherwise a book's weight in the taste
    // profile would grow with how often sync happened to run.
    expect(second.sessionsInserted).toBe(0);
    expect(db.getListeningSessions()).toHaveLength(1);
    expect(db.getRecFeedback()).toHaveLength(1);
  });

  it('never overwrites an explicit verdict with a listening-derived one', async () => {
    const db = makeDb();
    addBook(db, { id: 'a', title: 'A' });
    db.insertRecFeedback({
      bookId: 'a',
      queryText: 'a query',
      verdict: 'rejected',
      source: 'explicit',
      createdAt: NOW,
    });

    await syncListeningHistory({ db, now: NOW, source: source([progressRow('a')]) });

    const rows = db.getRecFeedback();
    expect(rows.filter((row) => row.source === 'explicit').map((row) => row.verdict)).toEqual(['rejected']);
    expect(rows.filter((row) => row.source === 'implicit').map((row) => row.verdict)).toEqual(['finished']);
  });
});
