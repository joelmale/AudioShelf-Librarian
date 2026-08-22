import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../db.js';
import { composeBookCardFromDb } from './bookCard.js';
import { EmbeddingStore } from './embeddings.js';
import { findSimilar } from './findSimilar.js';
import { FIXTURE_BOOKS, seedFixtureLibrary } from './fixtures/library.js';
import { STUB_EMBEDDING_DIM, stubEmbed } from './fixtures/stubEmbedder.js';

const tempDirs: string[] = [];
let db: CuratorDb;

/** Embed every fixture book from its real composed card, deterministically. */
function embedFixtureLibrary(): void {
  for (const fx of FIXTURE_BOOKS) {
    const card = composeBookCardFromDb(db, fx.id);
    if (!card) throw new Error(`no card for ${fx.id}`);
    db.upsertBookEmbedding({
      bookId: fx.id,
      model: 'stub',
      cardHash: card.hash,
      vector: stubEmbed(card.text),
    });
  }
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-similar-'));
  tempDirs.push(dir);
  db = new CuratorDb(path.join(dir, 'test.db'));
  seedFixtureLibrary(db);
  embedFixtureLibrary();
});

afterEach(() => {
  db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function ids(results: { book: { id: string } }[]): string[] {
  return results.map((r) => r.book.id);
}

describe('findSimilar — basics', () => {
  it('never returns the anchor itself', () => {
    const results = findSimilar(db, 'fx-01', { k: 30 });
    expect(ids(results)).not.toContain('fx-01');
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns results ordered by descending score, capped at k', () => {
    const results = findSimilar(db, 'fx-01', { k: 5 });
    expect(results).toHaveLength(5);
    const scores = results.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('surfaces the anchor cluster: fx-01 is nearest to its Bell Harbor siblings', () => {
    const top = ids(findSimilar(db, 'fx-01', { k: 3 }));
    // fx-02 and fx-03 are the other two Cluster M coastal books.
    expect(top).toContain('fx-02');
    expect(top).toContain('fx-03');
  });

  it('respects candidateIds — nothing outside the allowed set is returned', () => {
    const allowed = new Set(['fx-12', 'fx-13']);
    const results = findSimilar(db, 'fx-10', { k: 10, candidateIds: allowed });
    expect(ids(results).every((id) => allowed.has(id))).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('throws NotFoundError for a book that does not exist', () => {
    expect(() => findSimilar(db, 'fx-999')).toThrow(/No book with id/);
  });

  it('throws a clear error when the anchor has no embedding, rather than returning empty', () => {
    // An empty result would be indistinguishable from "nothing is similar",
    // but the caller's fix is entirely different (run the embed operation).
    db.deleteBookEmbedding('fx-01');
    expect(() => findSimilar(db, 'fx-01')).toThrow(/no embedding/i);
  });
});

describe('findSimilar — acrossGenre (plan §5.2 archetype 2)', () => {
  // fx-10 "The Fractured Fleet": space-opera + political + multi-pov.
  // fx-20 "The Ember Court Assembly": fantasy + political + multi-pov.
  // This is the "world-building and politics of The Expanse, but fantasy" case.
  it('excludes every book sharing a genre tag with the anchor', () => {
    const anchorGenres = new Set(
      db.getTagsForBook('fx-10').filter((t) => t.category === 'genre').map((t) => t.tag)
    );
    expect(anchorGenres.size).toBeGreaterThan(0);

    const results = findSimilar(db, 'fx-10', { k: 30, acrossGenre: true });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      const genres = db.getTagsForBook(r.book.id).filter((t) => t.category === 'genre');
      for (const g of genres) expect(anchorGenres.has(g.tag)).toBe(false);
    }
  });

  it('surfaces the cross-genre structural match fx-20, which the same-genre search buries', () => {
    const across = ids(findSimilar(db, 'fx-10', { k: 5, acrossGenre: true }));
    expect(across).toContain('fx-20');

    // Without acrossGenre the same-genre space-opera siblings crowd it out.
    const within = ids(findSimilar(db, 'fx-10', { k: 5 }));
    expect(within.some((id) => ['fx-12', 'fx-13'].includes(id))).toBe(true);
  });

  it('sharedTags explains the transfer and omits genre', () => {
    const across = findSimilar(db, 'fx-10', { k: 5, acrossGenre: true });
    const match = across.find((r) => r.book.id === 'fx-20');
    expect(match).toBeDefined();
    // The structural qualities that carried across the genre boundary.
    expect(match?.sharedTags).toContain('political');
    expect(match?.sharedTags).toContain('multi-pov');
    // Genre is never listed — under acrossGenre there is none by construction.
    const anchorGenres = db
      .getTagsForBook('fx-10')
      .filter((t) => t.category === 'genre')
      .map((t) => t.tag);
    for (const g of anchorGenres) expect(match?.sharedTags).not.toContain(g);
  });

  it('acrossGenre is a no-op filter when the anchor has no genre tag', () => {
    db.replaceBookTags(
      'fx-10',
      db.getTagsForBook('fx-10').filter((t) => t.category !== 'genre'),
      Date.now()
    );
    const results = findSimilar(db, 'fx-10', { k: 5, acrossGenre: true });
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('vibe regression — "melancholic coastal autumn" (plan §5.2 archetype 1)', () => {
  // The headline query for the whole retrieval layer. This asserts a specific
  // ORDERING, not merely that the right books appear: an earlier stub embedder
  // returned the right set in the wrong order (a book repeating "autumn" but
  // lacking the melancholic facet ranked first), which would have made a
  // set-membership assertion pass while the feature was broken.
  it('ranks the three Bell Harbor books first, in fx-01 > fx-02 > fx-03 order', () => {
    const store = EmbeddingStore.fromDb(db, 'stub');
    const query = stubEmbed('melancholic coastal autumn');
    expect(query).toHaveLength(STUB_EMBEDDING_DIM);

    const top = store.topK(query, 3).map((n) => n.bookId);
    expect(top).toEqual(['fx-01', 'fx-02', 'fx-03']);
  });

  it('keeps the space-opera cluster out of the top ten', () => {
    const store = EmbeddingStore.fromDb(db, 'stub');
    const top10 = new Set(store.topK(stubEmbed('melancholic coastal autumn'), 10).map((n) => n.bookId));
    for (const id of ['fx-10', 'fx-11', 'fx-12', 'fx-13', 'fx-14']) {
      expect(top10.has(id)).toBe(false);
    }
  });

  it('scores every candidate finitely — no NaN can sort to the front', () => {
    const store = EmbeddingStore.fromDb(db, 'stub');
    for (const score of store.scoreAll(stubEmbed('melancholic coastal autumn')).values()) {
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(-1);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
