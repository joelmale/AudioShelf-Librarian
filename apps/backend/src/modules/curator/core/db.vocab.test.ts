import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from './db.js';
import { validateTagQuality } from './tagQuality.js';
import type { Book } from './types.js';
import { SEED_VOCABULARY } from './vocabulary.js';

const databases: CuratorDb[] = [];
const tempDirs: string[] = [];

function addBook(db: CuratorDb, input: Pick<Book, 'id' | 'title'>): void {
  db.upsertBook({
    ...input,
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
  });
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('vocab_terms seeding', () => {
  it('a fresh DB has every SEED_VOCABULARY term as a seed row', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);

    const seedTerms = db.getVocabTerms(['seed']);
    const expectedCount = Object.values(SEED_VOCABULARY).reduce((n, terms) => n + terms.length, 0);
    expect(seedTerms).toHaveLength(expectedCount);
    expect(seedTerms.every((t) => t.status === 'seed' && t.bookCount === 0)).toBe(true);

    const genreTerms = seedTerms.filter((t) => t.category === 'genre').map((t) => t.term).sort();
    expect(genreTerms).toEqual([...SEED_VOCABULARY.genre].sort());
  });

  it('re-opening the DB does not duplicate seed rows or reset a promoted status', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-db-vocab-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'lib.db');

    const first = new CuratorDb(dbPath);
    databases.push(first);
    const [firstTerm] = SEED_VOCABULARY.genre;
    first.setVocabTermStatus(firstTerm!, 'genre', 'promoted', 500);
    first.close();
    databases.splice(databases.indexOf(first), 1);

    const reopened = new CuratorDb(dbPath);
    databases.push(reopened);

    const allTerms = reopened.getVocabTerms();
    const expectedCount = Object.values(SEED_VOCABULARY).reduce((n, terms) => n + terms.length, 0);
    expect(allTerms).toHaveLength(expectedCount);

    const promoted = allTerms.find((t) => t.term === firstTerm && t.category === 'genre');
    expect(promoted?.status).toBe('promoted');
  });
});

describe('tag_aliases', () => {
  it('round-trips an alias, and the same alias string is scoped independently per category', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);

    db.upsertTagAlias('the-power-of-friendship', 'found-family', 'trope');
    db.upsertTagAlias('the-power-of-friendship', 'hopeful', 'mood');

    expect(db.getTagAlias('the-power-of-friendship', 'trope')).toEqual({
      alias: 'the-power-of-friendship',
      canonical: 'found-family',
      category: 'trope',
    });
    expect(db.getTagAlias('the-power-of-friendship', 'mood')).toEqual({
      alias: 'the-power-of-friendship',
      canonical: 'hopeful',
      category: 'mood',
    });
  });

  it('getTagAlias returns null when no row exists', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    expect(db.getTagAlias('nope', 'genre')).toBeNull();
  });

  it('a second upsert for the same alias/category overwrites the canonical form', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);

    db.upsertTagAlias('spooky', 'dark', 'mood');
    db.upsertTagAlias('spooky', 'tense', 'mood');

    expect(db.getTagAlias('spooky', 'mood')?.canonical).toBe('tense');
  });
});

describe('refreshProposedVocabCounts', () => {
  it('produces proposed rows with distinct-book counts for llm-open tags only', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });
    addBook(db, { id: 'b3', title: 'Book Three' });

    db.replaceBookTags('b1', [{ tag: 'noblebright', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1000);
    db.replaceBookTags('b2', [{ tag: 'noblebright', category: 'mood', confidence: 0.7, source: 'llm-open' }], 1000);
    // Same tag string but different category: should not merge into the mood count.
    db.replaceBookTags('b3', [{ tag: 'noblebright', category: 'theme', confidence: 0.6, source: 'llm-open' }], 1000);
    // vocab/derived-source tags must not generate proposed rows.
    db.replaceBookTags('b1', [
      { tag: 'noblebright', category: 'mood', confidence: 0.8, source: 'llm-open' },
      { tag: 'fantasy', category: 'genre', confidence: 0.9, source: 'vocab' },
    ], 1000);

    db.refreshProposedVocabCounts(5000);

    const proposed = db.getVocabTerms(['proposed']);
    const moodEntry = proposed.find((t) => t.term === 'noblebright' && t.category === 'mood');
    const themeEntry = proposed.find((t) => t.term === 'noblebright' && t.category === 'theme');
    expect(moodEntry).toBeDefined();
    expect(moodEntry?.bookCount).toBe(2);
    expect(moodEntry?.firstSeen).toBe(5000);
    expect(themeEntry?.bookCount).toBe(1);

    expect(proposed.some((t) => t.term === 'fantasy')).toBe(false);
  });

  it('re-running after a book loses its tag updates or deletes the proposed row', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    db.replaceBookTags('b1', [{ tag: 'zany', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);
    db.replaceBookTags('b2', [{ tag: 'zany', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);
    db.refreshProposedVocabCounts(1000);
    expect(db.getVocabTerms(['proposed']).find((t) => t.term === 'zany')?.bookCount).toBe(2);

    // b2 loses the tag entirely.
    db.replaceBookTags('b2', [], 2000);
    db.refreshProposedVocabCounts(2000);
    expect(db.getVocabTerms(['proposed']).find((t) => t.term === 'zany')?.bookCount).toBe(1);

    // b1 loses it too — the proposed row should be deleted, not left at 0.
    db.replaceBookTags('b1', [], 3000);
    db.refreshProposedVocabCounts(3000);
    expect(db.getVocabTerms(['proposed']).find((t) => t.term === 'zany')).toBeUndefined();
  });

  it('never touches seed, promoted, or rejected rows even if their term collides with an llm-open tag', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    const seedTerm = SEED_VOCABULARY.genre[0]!;
    // An llm-open tag that happens to reuse an existing seed term string.
    db.replaceBookTags('b1', [{ tag: seedTerm, category: 'genre', confidence: 0.5, source: 'llm-open' }], 1000);

    db.refreshProposedVocabCounts(9999);

    const seedRow = db.getVocabTerms(['seed']).find((t) => t.term === seedTerm && t.category === 'genre');
    expect(seedRow).toBeDefined();
    expect(seedRow?.bookCount).toBe(0);
    // No duplicate 'proposed' row should exist for the same (term, category) primary key.
    expect(db.getVocabTerms(['proposed']).some((t) => t.term === seedTerm && t.category === 'genre')).toBe(false);
  });

  it('is idempotent when run twice with no changes in between', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    db.replaceBookTags('b1', [{ tag: 'quiet', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);

    db.refreshProposedVocabCounts(1000);
    db.refreshProposedVocabCounts(2000);

    const rows = db.getVocabTerms(['proposed']).filter((t) => t.term === 'quiet');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bookCount).toBe(1);
  });
});

describe('getProposedVocabTerms', () => {
  it('orders by book_count DESC and includes up to N distinct sample titles', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Alpha' });
    addBook(db, { id: 'b2', title: 'Beta' });
    addBook(db, { id: 'b3', title: 'Gamma' });
    addBook(db, { id: 'b4', title: 'Delta' });

    for (const id of ['b1', 'b2', 'b3', 'b4']) {
      db.replaceBookTags(id, [{ tag: 'popular-term', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);
    }
    db.replaceBookTags('b1', [
      { tag: 'popular-term', category: 'mood', confidence: 0.5, source: 'llm-open' },
      { tag: 'rare-term', category: 'mood', confidence: 0.5, source: 'llm-open' },
    ], 1000);

    db.refreshProposedVocabCounts(1000);

    const proposed = db.getProposedVocabTerms(2);
    expect(proposed[0]?.term).toBe('popular-term');
    expect(proposed[0]?.sampleBooks).toHaveLength(2);
    expect(proposed[0]?.bookCount).toBe(4);

    const rare = proposed.find((t) => t.term === 'rare-term');
    expect(rare?.sampleBooks).toEqual(['Alpha']);
  });
});

describe('retagLlmOpenTags', () => {
  it('renames a plain llm-open tag and promotes its source to vocab', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    db.replaceBookTags('b1', [{ tag: 'noblebright', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);

    const changed = db.retagLlmOpenTags('noblebright', 'mood', 'hopeful');

    expect(changed).toBe(1);
    const tags = db.getTagsForBook('b1');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ tag: 'hopeful', category: 'mood', source: 'vocab' });
  });

  it('deletes the from-row instead of violating UNIQUE(book_id, tag) when the book already has the target tag', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    db.replaceBookTags('b1', [
      { tag: 'noblebright', category: 'mood', confidence: 0.5, source: 'llm-open' },
      { tag: 'hopeful', category: 'mood', confidence: 0.9, source: 'vocab' },
    ], 1000);

    const changed = db.retagLlmOpenTags('noblebright', 'mood', 'hopeful');

    expect(changed).toBe(1);
    const tags = db.getTagsForBook('b1');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ tag: 'hopeful', source: 'vocab' });
  });

  it('leaves non-llm-open rows with the same tag/category untouched', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });
    db.replaceBookTags('b1', [{ tag: 'noblebright', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);
    db.replaceBookTags('b2', [{ tag: 'noblebright', category: 'mood', confidence: 0.9, source: 'vocab' }], 1000);

    const changed = db.retagLlmOpenTags('noblebright', 'mood', 'hopeful');

    expect(changed).toBe(1);
    expect(db.getTagsForBook('b1')[0]?.tag).toBe('hopeful');
    expect(db.getTagsForBook('b2')[0]).toMatchObject({ tag: 'noblebright', source: 'vocab' });
  });

  it('returns 0 and changes nothing when no matching rows exist', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    expect(db.retagLlmOpenTags('nonexistent', 'mood', 'hopeful')).toBe(0);
  });
});

describe('isVocabTerm', () => {
  it('is true for seed and promoted terms, false for proposed and rejected', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);

    const seedTerm = SEED_VOCABULARY.mood[0]!;
    expect(db.isVocabTerm(seedTerm, 'mood')).toBe(true);

    db.setVocabTermStatus('brand-new', 'mood', 'promoted', 1000);
    expect(db.isVocabTerm('brand-new', 'mood')).toBe(true);

    db.setVocabTermStatus('under-review', 'mood', 'proposed', 1000);
    expect(db.isVocabTerm('under-review', 'mood')).toBe(false);

    db.setVocabTermStatus('nope', 'mood', 'rejected', 1000);
    expect(db.isVocabTerm('nope', 'mood')).toBe(false);

    expect(db.isVocabTerm('never-heard-of-it', 'mood')).toBe(false);
  });
});

describe('validateTagQuality with vocab_terms', () => {
  it('flags an out-of-vocabulary llm-open tag and does not flag a seed-vocab tag', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    const seedGenre = SEED_VOCABULARY.genre[0]!;
    db.replaceBookTags('b1', [
      { tag: seedGenre, category: 'genre', confidence: 0.9, source: 'vocab' },
      { tag: SEED_VOCABULARY.mood[0]!, category: 'mood', confidence: 0.9, source: 'vocab' },
      { tag: SEED_VOCABULARY.pacing[0]!, category: 'pacing', confidence: 0.9, source: 'vocab' },
      { tag: SEED_VOCABULARY.length[0]!, category: 'length', confidence: 0.9, source: 'vocab' },
      { tag: 'a-totally-made-up-tag', category: 'genre', confidence: 0.6, source: 'llm-open' },
    ], Date.now());

    const report = validateTagQuality(db);

    expect(report.outOfVocabulary).toContainEqual(
      expect.objectContaining({ tag: 'a-totally-made-up-tag', category: 'genre' })
    );
    expect(report.outOfVocabulary.some((o) => o.tag === seedGenre)).toBe(false);
  });
});
