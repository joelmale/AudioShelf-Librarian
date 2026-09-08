import { describe, expect, it } from 'vitest';

import type { Book } from '../types.js';
import { judgeTagFreshness, type TagStaleCandidate } from './staleness.js';

const BOOK: Book = {
  id: 'it',
  title: 'It',
  author: 'Stephen King',
  series: null,
  seriesSequence: null,
  durationSeconds: 4 * 3600,
  publishedYear: 1986,
  genres: [],
  description: null,
  coverPath: null,
  absAddedAt: null,
  lastSyncedAt: Date.now(),
};

/** A fully current book, for tests to spoil one field at a time. */
function fresh(overrides: Partial<TagStaleCandidate> = {}): TagStaleCandidate {
  return {
    book: BOOK,
    hasTags: true,
    storedPromptHash: 'P',
    storedComposeHash: 'C',
    storedSchemaVersion: 1,
    hasProposals: true,
    ...overrides,
  };
}

describe('judgeTagFreshness', () => {
  it('returns null when every stored hash matches', () => {
    expect(judgeTagFreshness(fresh(), 'P', 'C', 1)).toBeNull();
  });

  it('reports an untagged book as never-tagged, needing the model', () => {
    const v = judgeTagFreshness(fresh({ hasTags: false }), 'P', 'C', 1);
    expect(v).toMatchObject({ reason: 'never-tagged', kind: 'retag' });
  });

  it('reports a pre-mechanism run as never-recorded rather than assuming it is fresh', () => {
    // A run we did not observe stored no hashes. Treating that as fresh would
    // be a confident claim standing in for a check that never ran.
    const v = judgeTagFreshness(
      fresh({ storedPromptHash: null, storedComposeHash: null, hasProposals: false }),
      'P',
      'C',
      1
    );
    expect(v).toMatchObject({ reason: 'never-recorded', kind: 'retag' });
  });

  it('reports a schema bump as needing the model', () => {
    const v = judgeTagFreshness(fresh({ storedSchemaVersion: 1 }), 'P', 'C', 2);
    expect(v).toMatchObject({ reason: 'schema-changed', kind: 'retag' });
  });

  it('reports prompt drift as needing the model', () => {
    const v = judgeTagFreshness(fresh(), 'P2', 'C', 1);
    expect(v).toMatchObject({ reason: 'prompt-changed', kind: 'retag' });
  });

  it('reports compose-only drift as free to fix when proposals were kept', () => {
    // The case this whole mechanism exists for: entities moved, the model
    // has nothing new to say, so recomposing costs nothing.
    const v = judgeTagFreshness(fresh(), 'P', 'C2', 1);
    expect(v).toMatchObject({ reason: 'compose-changed', kind: 'reground' });
  });

  it('falls back to the model for compose drift when no proposals were kept', () => {
    const v = judgeTagFreshness(fresh({ hasProposals: false }), 'P', 'C2', 1);
    expect(v).toMatchObject({ reason: 'compose-changed', kind: 'retag' });
  });

  it('prefers the paid verdict when both halves drifted', () => {
    // A backfilled description moves BOTH hashes. Reporting the free verdict
    // would re-ground proposals the model made without ever seeing that
    // description — a tag set no forward run would ever produce.
    const v = judgeTagFreshness(fresh(), 'P2', 'C2', 1);
    expect(v).toMatchObject({ reason: 'prompt-changed', kind: 'retag' });
  });

  it('never reports a free fix for a book that has no tags at all', () => {
    const v = judgeTagFreshness(fresh({ hasTags: false, hasProposals: true }), 'P', 'C2', 1);
    expect(v?.kind).toBe('retag');
  });
});
