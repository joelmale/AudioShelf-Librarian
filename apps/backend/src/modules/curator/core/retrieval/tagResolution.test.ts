import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book } from '../types.js';
import { resolveSingleTag, resolveTagFilters } from './tagResolution.js';

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
    lastSyncedAt: Date.now(),
    ...input,
  });
}

/** A library whose genre vocabulary spells mysteries several ways. */
function keyWestLibrary(): CuratorDb {
  const db = makeDb();
  const shelf: [string, string, string][] = [
    ['b1', 'Key West Normal', 'comedy-mystery'],
    ['b2', 'Relative Humidity', 'humorous-mystery'],
    ['b3', 'Key West Luck', 'comedy-mystery'],
    ['b4', 'Plain Case', 'mystery'],
    ['b5', 'Sunburn', 'psychological-thriller'],
    ['b6', 'Night Work', 'thriller'],
  ];
  for (const [id, title, tag] of shelf) {
    addBook(db, { id, title });
    db.replaceBookTags(id, [{ tag, category: 'genre', confidence: 1, source: 'vocab' }], Date.now());
  }
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('resolveTagFilters', () => {
  it('canonicalizes a spaced surface form onto the stored vocabulary term', () => {
    const db = keyWestLibrary();
    db.setVocabTermStatus('mystery', 'genre', 'seed', Date.now());

    const resolved = resolveTagFilters(db, {
      preferredTags: [{ tag: 'murder mystery', category: 'genre' }],
    });

    // `murder-mystery` is in no vocabulary; its single qualifying token is.
    expect(resolved.preferredTags?.[0]).toMatchObject({ tag: 'mystery', category: 'genre' });
  });

  it('widens a weighted preference to the subtypes the library actually uses', () => {
    const db = keyWestLibrary();
    db.setVocabTermStatus('mystery', 'genre', 'seed', Date.now());

    const resolved = resolveTagFilters(db, {
      preferredTags: [{ tag: 'murder mystery', category: 'genre', weight: 4 }],
    });

    const tags = resolved.preferredTags?.map((entry) => entry.tag) ?? [];
    expect(tags).toContain('mystery');
    expect(tags).toContain('comedy-mystery');
    expect(tags).toContain('humorous-mystery');
    // The term the caller named outranks the family it pulled in.
    const exact = resolved.preferredTags?.find((entry) => entry.tag === 'mystery');
    const subtype = resolved.preferredTags?.find((entry) => entry.tag === 'comedy-mystery');
    expect(exact?.weight).toBe(4);
    expect(subtype?.weight).toBe(2);
  });

  it('widens a hard exclusion to its subtypes, because a subtype is still the banned thing', () => {
    const db = keyWestLibrary();
    db.setVocabTermStatus('thriller', 'genre', 'seed', Date.now());

    const resolved = resolveTagFilters(db, {
      excludeTags: [{ tag: 'Thriller', category: 'genre' }],
    });

    const tags = resolved.excludeTags?.map((entry) => entry.tag) ?? [];
    expect(tags).toEqual(expect.arrayContaining(['thriller', 'psychological-thriller']));
    // Exclusions are hard filters, so they carry no weight key.
    expect(resolved.excludeTags?.every((entry) => !('weight' in entry))).toBe(true);
  });

  it('never widens allTags, whose AND semantics cannot express an OR group', () => {
    const db = keyWestLibrary();
    db.setVocabTermStatus('mystery', 'genre', 'seed', Date.now());

    const resolved = resolveTagFilters(db, {
      allTags: [{ tag: 'murder mystery', category: 'genre' }],
    });

    // Canonicalized — so it can match at all — but not expanded, because a
    // second allTags entry would AND against the widened one.
    expect(resolved.allTags).toEqual([{ tag: 'mystery', category: 'genre' }]);
  });

  it('discloses every rewrite it performed', () => {
    const db = keyWestLibrary();
    db.setVocabTermStatus('mystery', 'genre', 'seed', Date.now());

    const { notes } = resolveTagFilters(db, {
      preferredTags: [{ tag: 'murder mystery', category: 'genre' }],
    });

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ field: 'preferredTags', from: 'genre:murder mystery' });
    expect(notes[0]?.to).toContain('comedy-mystery');
  });

  it('leaves a term alone when its category is ambiguous rather than guessing one', () => {
    const db = makeDb();
    addBook(db, { id: 'a', title: 'A' });
    addBook(db, { id: 'b', title: 'B' });
    // `dark` exists as both a mood and a theme, so no category can be inferred.
    db.replaceBookTags('a', [{ tag: 'dark', category: 'mood', confidence: 1, source: 'vocab' }], Date.now());
    db.replaceBookTags('b', [{ tag: 'dark', category: 'theme', confidence: 1, source: 'vocab' }], Date.now());
    addBook(db, { id: 'c', title: 'C' });
    addBook(db, { id: 'd', title: 'D' });
    db.replaceBookTags('c', [{ tag: 'very-dark', category: 'mood', confidence: 1, source: 'vocab' }], Date.now());
    db.replaceBookTags('d', [{ tag: 'very-dark', category: 'theme', confidence: 1, source: 'vocab' }], Date.now());

    const resolved = resolveTagFilters(db, { preferredTags: [{ tag: 'Dark' }] });

    expect(resolved.preferredTags).toEqual([{ tag: 'dark' }]);
    expect(resolved.notes.map((note) => note.reason)).toEqual([
      'Resolved to the library vocabulary term',
    ]);
  });

  it('orders equal-count subtype expansions by deterministic codepoint order', () => {
    const db = makeDb();
    db.setVocabTermStatus('mystery', 'genre', 'seed', Date.now());
    addBook(db, { id: 'upper', title: 'Upper' });
    addBook(db, { id: 'lower', title: 'Lower' });
    db.replaceBookTags('upper', [{ tag: 'A-mystery', category: 'genre', confidence: 1, source: 'vocab' }], Date.now());
    db.replaceBookTags('lower', [{ tag: 'a-mystery', category: 'genre', confidence: 1, source: 'vocab' }], Date.now());

    const resolved = resolveTagFilters(db, {
      preferredTags: [{ tag: 'mystery', category: 'genre' }],
    });

    expect(resolved.preferredTags?.map((entry) => entry.tag)).toEqual([
      'mystery', 'A-mystery', 'a-mystery',
    ]);
  });

  it('returns only the fields it was given', () => {
    const db = keyWestLibrary();

    const resolved = resolveTagFilters(db, { excludeTags: [{ tag: 'thriller', category: 'genre' }] });

    expect(resolved).not.toHaveProperty('allTags');
    expect(resolved).not.toHaveProperty('preferredTags');
    expect(resolved.excludeTags).toBeDefined();
  });

  it('drops a tag that normalizes to nothing and says so', () => {
    const db = keyWestLibrary();

    const resolved = resolveTagFilters(db, { preferredTags: [{ tag: '---', category: 'genre' }] });

    expect(resolved.preferredTags).toEqual([]);
    expect(resolved.notes[0]?.reason).toContain('empty tag');
  });
});

describe('resolveSingleTag', () => {
  it('canonicalizes the exact-lookup term without widening it', () => {
    const db = keyWestLibrary();
    db.setVocabTermStatus('mystery', 'genre', 'seed', Date.now());

    const resolved = resolveSingleTag(db, 'Murder Mystery', 'genre');

    expect(resolved.tag).toBe('mystery');
    expect(resolved.note?.from).toBe('genre:Murder Mystery');
  });

  it('reports no note when the caller already used the stored form', () => {
    const db = keyWestLibrary();
    db.setVocabTermStatus('mystery', 'genre', 'seed', Date.now());

    expect(resolveSingleTag(db, 'mystery', 'genre')).toEqual({ tag: 'mystery', note: null });
  });
});
