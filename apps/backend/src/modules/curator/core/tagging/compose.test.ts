import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book } from '../types.js';
import { composeBookTags } from './compose.js';

const databases: CuratorDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function freshDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

const BOOK: Book = {
  id: 'it',
  title: 'It',
  author: 'Stephen King',
  series: null,
  seriesSequence: null,
  durationSeconds: 4 * 3600, // -> derived length 'short'
  publishedYear: 1986,
  genres: [],
  description: null,
  coverPath: null,
  absAddedAt: null,
  lastSyncedAt: Date.now(),
};

describe('composeBookTags', () => {
  it('repairs a groundable character, drops a fabricated one, canonicalizes a genre, and lets derived length win over the LLM length tag', () => {
    const db = freshDb();
    db.upsertBook(BOOK);
    db.replaceBookEntities('it', [{ entity: 'Benjamin Hanscom', kind: 'person', sources: ['openlibrary'] }]);

    const llmTags = [
      { tag: 'Ben Hannigan', category: 'character' as const, confidence: 0.8 },
      { tag: 'Adrian Dover', category: 'character' as const, confidence: 0.6 },
      { tag: 'HardSciFi', category: 'genre' as const, confidence: 0.9 },
      { tag: 'epic', category: 'length' as const, confidence: 0.5 },
    ];

    const composed = composeBookTags(BOOK, llmTags, db);

    // Repair: the groundable character is present, canonicalized, external-sourced.
    expect(composed).toContainEqual({
      tag: 'benjamin-hanscom',
      category: 'character',
      confidence: 0.8,
      source: 'external:openlibrary',
    });

    // Drop: the fabricated character never appears in any form.
    expect(composed.some((t) => t.category === 'character' && t.tag !== 'benjamin-hanscom')).toBe(false);
    expect(composed.some((t) => t.tag === 'adrian-dover')).toBe(false);

    // Canonicalization: the genre maps onto the seed vocab term.
    expect(composed).toContainEqual({ tag: 'hard-sci-fi', category: 'genre', confidence: 0.9, source: 'vocab' });

    // Derived wins: length is 'short' (derived from duration), not the LLM's 'epic'.
    expect(composed).toContainEqual({ tag: 'short', category: 'length', confidence: 1, source: 'derived' });
    expect(composed.some((t) => t.category === 'length' && t.source !== 'derived')).toBe(false);

    // Exactly one entry per category, per the precedence rules above.
    const lengthEntries = composed.filter((t) => t.category === 'length');
    expect(lengthEntries).toHaveLength(1);
  });

  it('never asks the ground/canonicalize steps to touch a category the derive step already claimed', () => {
    const db = freshDb();
    db.upsertBook({ ...BOOK, id: 'era-book', publishedYear: 1950 });

    const composed = composeBookTags(
      { ...BOOK, id: 'era-book', publishedYear: 1950 },
      [{ tag: 'Modern', category: 'era' as const, confidence: 0.7 }],
      db
    );

    expect(composed).toContainEqual({ tag: 'golden-age', category: 'era', confidence: 1, source: 'derived' });
    expect(composed.some((t) => t.tag === 'modern')).toBe(false);
  });

  /**
   * The reason EXCLUSIVE_DERIVED_CATEGORIES exists. `full-cast` describes the
   * production and `multi-pov` describes the narrative; both are true of the
   * same GraphicAudio title. When any derived tag claimed its whole category,
   * adding full-cast to `structure` would have silently deleted the POV tag
   * from every dramatized book in the library.
   */
  it('lets a derived structure tag coexist with the LLM structure tag, unlike length', () => {
    const db = freshDb();
    const book = { ...BOOK, id: 'ga', title: 'Amazon Gate Full Cast (GraphicAudio)' };
    db.upsertBook(book);

    const composed = composeBookTags(
      book,
      [
        { tag: 'multi-pov', category: 'structure' as const, confidence: 0.8 },
        { tag: 'epic', category: 'length' as const, confidence: 0.9 },
      ],
      db
    );

    // Merged: the derived production tag and the LLM's narrative tag both survive.
    expect(composed).toContainEqual({ tag: 'full-cast', category: 'structure', confidence: 1, source: 'derived' });
    expect(composed.some((t) => t.tag === 'multi-pov' && t.category === 'structure')).toBe(true);
    expect(composed.filter((t) => t.category === 'structure')).toHaveLength(2);

    // Still exclusive: length remains single-valued and derived still wins it.
    expect(composed.filter((t) => t.category === 'length')).toHaveLength(1);
    expect(composed.some((t) => t.tag === 'epic')).toBe(false);
  });

  /**
   * `book_tags` is unique on (book_id, tag) rather than (book_id, tag,
   * category), so an LLM tag sharing a derived tag's string would overwrite
   * the derived row on insert and demote its source away from 'derived'.
   */
  it('drops an LLM tag that duplicates a derived tag string, even in another category', () => {
    const db = freshDb();
    const book = { ...BOOK, id: 'dup', title: 'Something Dramatized' };
    db.upsertBook(book);

    const composed = composeBookTags(book, [{ tag: 'full-cast', category: 'genre' as const, confidence: 0.9 }], db);

    const fullCastEntries = composed.filter((t) => t.tag === 'full-cast');
    expect(fullCastEntries).toHaveLength(1);
    expect(fullCastEntries[0]).toMatchObject({ category: 'structure', source: 'derived' });
  });
});
