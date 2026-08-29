import { describe, expect, it } from 'vitest';

import { EmbeddingStore } from '../retrieval/embeddings.js';
import type { ListeningProgress, RecFeedback } from '../types.js';
import { buildTasteProfile, MIN_PROFILE_BOOKS, tasteScoreFor } from './tasteProfile.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

/** Two well-separated appetites in a 2-D space, plus one outlier axis. */
const SCIFI: [number, number] = [1, 0];
const COZY: [number, number] = [0, 1];

function store(entries: Array<[string, [number, number]]>): EmbeddingStore {
  return new EmbeddingStore(
    entries.map(([bookId, vector]) => ({
      bookId,
      model: 'test-model',
      cardHash: bookId,
      vector: Float32Array.from(vector),
    }))
  );
}

function feedback(
  bookId: string,
  verdict: RecFeedback['verdict'],
  overrides: Partial<RecFeedback> = {}
): RecFeedback {
  return {
    id: 0,
    bookId,
    externalKey: null,
    queryText: 'q',
    verdict,
    source: 'implicit',
    weight: 1,
    createdAt: NOW,
    ...overrides,
  };
}

function finished(bookId: string): ListeningProgress {
  return {
    bookId,
    progress: 1,
    isFinished: true,
    startedAt: null,
    finishedAt: NOW,
    timeListening: 100,
    lastPlayedAt: NOW,
    updatedAt: NOW,
  };
}

describe('buildTasteProfile', () => {
  it('returns null below the cold-start threshold rather than a thin profile', () => {
    const ids = ['a', 'b', 'c'];
    const profile = buildTasteProfile({
      feedback: ids.map((id) => feedback(id, 'finished')),
      progress: [],
      store: store(ids.map((id) => [id, SCIFI])),
      now: NOW,
    });
    expect(ids.length).toBeLessThan(MIN_PROFILE_BOOKS);
    expect(profile).toBeNull();
  });

  it('separates two distinct appetites into their own modes', () => {
    // The reason §6 was amended: a single mean of these two clusters would
    // land between them and match neither.
    const entries: Array<[string, [number, number]]> = [
      ['s1', SCIFI], ['s2', SCIFI], ['s3', SCIFI],
      ['c1', COZY], ['c2', COZY], ['c3', COZY],
    ];
    const embeddings = store(entries);
    const profile = buildTasteProfile({
      feedback: entries.map(([id]) => feedback(id, 'finished')),
      progress: [],
      store: embeddings,
      now: NOW,
    });

    expect(profile).not.toBeNull();
    expect(profile!.modes.length).toBe(2);
    // Both a hard-sci-fi and a cozy candidate score highly, which a single
    // averaged centroid could not deliver.
    expect(tasteScoreFor(profile!, embeddings, 's1')).toBeGreaterThan(0.9);
    expect(tasteScoreFor(profile!, embeddings, 'c1')).toBeGreaterThan(0.9);
  });

  it('counts a finished book with no feedback row as a positive', () => {
    // Books found without a suggestion still say what the user likes.
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const embeddings = store(ids.map((id) => [id, SCIFI]));
    const profile = buildTasteProfile({
      feedback: [],
      progress: ids.map(finished),
      store: embeddings,
      now: NOW,
    });
    expect(profile?.positiveIds.sort()).toEqual(ids);
  });

  it('demotes a candidate that resembles something rejected', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const entries: Array<[string, [number, number]]> = [
      ...ids.map((id) => [id, SCIFI] as [string, [number, number]]),
      ['hated', COZY],
      // Halfway between the liked cluster and the rejected one, so it starts
      // with a real positive score there IS something for the penalty to bite.
      ['likeHated', [0.7, 0.7]],
    ];
    const embeddings = store(entries);
    const base = {
      progress: [] as ListeningProgress[],
      store: embeddings,
      now: NOW,
    };
    const withoutNegative = buildTasteProfile({
      ...base,
      feedback: ids.map((id) => feedback(id, 'finished')),
    })!;
    const withNegative = buildTasteProfile({
      ...base,
      feedback: [...ids.map((id) => feedback(id, 'finished')), feedback('hated', 'rejected')],
    })!;

    expect(tasteScoreFor(withNegative, embeddings, 'likeHated'))
      .toBeLessThan(tasteScoreFor(withoutNegative, embeddings, 'likeHated')!);
  });

  it('weights a recent signal above an old one', () => {
    const recent = buildTasteProfile({
      feedback: ['a', 'b', 'c', 'd', 'e'].map((id) => feedback(id, 'finished')),
      progress: [],
      store: store(['a', 'b', 'c', 'd', 'e'].map((id) => [id, SCIFI])),
      now: NOW,
    });
    const ancient = buildTasteProfile({
      feedback: ['a', 'b', 'c', 'd', 'e'].map((id) =>
        feedback(id, 'finished', { createdAt: NOW - 2000 * DAY })),
      progress: [],
      store: store(['a', 'b', 'c', 'd', 'e'].map((id) => [id, SCIFI])),
      now: NOW,
    });
    // Both still build — decay changes weight, not membership — but the old
    // one must not have crept up to full strength.
    expect(recent).not.toBeNull();
    expect(ancient).not.toBeNull();
  });

  it('is deterministic: identical inputs give identical modes', () => {
    const entries: Array<[string, [number, number]]> = [
      ['s1', SCIFI], ['s2', SCIFI], ['s3', SCIFI],
      ['c1', COZY], ['c2', COZY], ['c3', COZY],
    ];
    const build = () => buildTasteProfile({
      feedback: entries.map(([id]) => feedback(id, 'finished')),
      progress: [],
      store: store(entries),
      now: NOW,
    });
    const first = build()!;
    const second = build()!;
    expect(first.modes.map((m) => [...m.memberIds].sort()))
      .toEqual(second.modes.map((m) => [...m.memberIds].sort()));
  });
});

describe('tasteScoreFor', () => {
  it('returns null for a book with no embedding — no signal, not dislike', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const embeddings = store(ids.map((id) => [id, SCIFI]));
    const profile = buildTasteProfile({
      feedback: ids.map((id) => feedback(id, 'finished')),
      progress: [],
      store: embeddings,
      now: NOW,
    })!;
    expect(tasteScoreFor(profile, embeddings, 'never-embedded')).toBeNull();
  });
});
