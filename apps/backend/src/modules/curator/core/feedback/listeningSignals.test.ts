import { describe, expect, it } from 'vitest';

import type { FeedbackVerdict, ListeningProgress } from '../types.js';
import {
  ABANDON_AFTER_DAYS,
  applyImplicitFeedback,
  deriveImplicitSignal,
  NEAR_COMPLETION,
} from './listeningSignals.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function progress(overrides: Partial<ListeningProgress> & Pick<ListeningProgress, 'bookId'>): ListeningProgress {
  return {
    progress: 0,
    isFinished: false,
    startedAt: null,
    finishedAt: null,
    timeListening: 0,
    lastPlayedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('deriveImplicitSignal', () => {
  it('reads a finished book as a full-weight positive', () => {
    const signal = deriveImplicitSignal(progress({ bookId: 'b', isFinished: true, progress: 1 }), NOW);
    expect(signal).toEqual({ verdict: 'finished', weight: 1 });
  });

  it('treats stopping past the near-completion mark as finished, not abandoned', () => {
    // Stopping at 92% is not a verdict against the book.
    const signal = deriveImplicitSignal(
      progress({ bookId: 'b', progress: 0.92, lastPlayedAt: NOW - 400 * DAY }),
      NOW
    );
    expect(signal?.verdict).toBe('finished');
    expect(NEAR_COMPLETION).toBeLessThan(0.92);
  });

  it('does NOT call a mid-listen book abandoned while it is still being played', () => {
    // The whole point: in-progress and given-up-on look identical in a
    // snapshot, and only elapsed silence separates them.
    const active = deriveImplicitSignal(
      progress({ bookId: 'b', progress: 0.3, lastPlayedAt: NOW - 3 * DAY }),
      NOW
    );
    expect(active).toBeNull();

    const stale = deriveImplicitSignal(
      progress({ bookId: 'b', progress: 0.3, lastPlayedAt: NOW - (ABANDON_AFTER_DAYS + 1) * DAY }),
      NOW
    );
    expect(stale?.verdict).toBe('abandoned');
  });

  it('grades the abandon: dropped early is a far stronger negative than dropped late', () => {
    const idle = NOW - (ABANDON_AFTER_DAYS + 1) * DAY;
    const early = deriveImplicitSignal(progress({ bookId: 'a', progress: 0.08, lastPlayedAt: idle }), NOW);
    const late = deriveImplicitSignal(progress({ bookId: 'b', progress: 0.75, lastPlayedAt: idle }), NOW);

    expect(early?.verdict).toBe('abandoned');
    expect(late?.verdict).toBe('abandoned');
    expect(early!.weight).toBeGreaterThan(late!.weight);
    expect(early!.weight).toBeGreaterThan(0.8);
    expect(late!.weight).toBeLessThan(0.3);
  });

  it('ignores a book barely started — that is not a verdict', () => {
    const signal = deriveImplicitSignal(
      progress({ bookId: 'b', progress: 0.005, lastPlayedAt: NOW - 400 * DAY }),
      NOW
    );
    expect(signal).toBeNull();
  });

  it('falls back to updatedAt when ABS reported no lastUpdate', () => {
    const signal = deriveImplicitSignal(
      progress({ bookId: 'b', progress: 0.3, lastPlayedAt: null, updatedAt: NOW - 400 * DAY }),
      NOW
    );
    expect(signal?.verdict).toBe('abandoned');
  });
});

describe('applyImplicitFeedback', () => {
  it('writes one row per book with a verdict and defers the rest', () => {
    const written: Array<{ bookId: string; verdict: FeedbackVerdict; createdAt: number }> = [];
    const idle = NOW - (ABANDON_AFTER_DAYS + 1) * DAY;

    const result = applyImplicitFeedback(
      [
        progress({ bookId: 'done', isFinished: true, finishedAt: idle }),
        progress({ bookId: 'dropped', progress: 0.1, lastPlayedAt: idle }),
        progress({ bookId: 'reading', progress: 0.4, lastPlayedAt: NOW - DAY }),
      ],
      NOW,
      (row) => written.push({ bookId: row.bookId, verdict: row.verdict, createdAt: row.createdAt })
    );

    expect(result).toEqual({ written: 2, skipped: 1 });
    expect(written.map((row) => row.bookId)).toEqual(['done', 'dropped']);
    expect(written.map((row) => row.verdict)).toEqual(['finished', 'abandoned']);
  });

  it('stamps the row when the listening happened, not when sync ran', () => {
    // Otherwise every re-sync would make years-old taste look brand new to
    // the recency decay in tasteProfile.ts.
    const written: number[] = [];
    const listenedAt = NOW - 300 * DAY;
    applyImplicitFeedback(
      [progress({ bookId: 'old', isFinished: true, lastPlayedAt: listenedAt })],
      NOW,
      (row) => written.push(row.createdAt)
    );
    expect(written).toEqual([listenedAt]);
  });
});
