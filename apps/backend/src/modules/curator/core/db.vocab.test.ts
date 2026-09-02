import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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

    const result = db.retagLlmOpenTags('noblebright', 'mood', 'hopeful');

    expect(result).toEqual({ changed: 1, bookIds: ['b1'] });
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

    const result = db.retagLlmOpenTags('noblebright', 'mood', 'hopeful');

    expect(result).toEqual({ changed: 1, bookIds: ['b1'] });
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

    const result = db.retagLlmOpenTags('noblebright', 'mood', 'hopeful');

    expect(result).toEqual({ changed: 1, bookIds: ['b1'] });
    expect(db.getTagsForBook('b1')[0]?.tag).toBe('hopeful');
    expect(db.getTagsForBook('b2')[0]).toMatchObject({ tag: 'noblebright', source: 'vocab' });
  });

  it('returns changed: 0 and an empty bookIds array when no matching rows exist', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    expect(db.retagLlmOpenTags('nonexistent', 'mood', 'hopeful')).toEqual({ changed: 0, bookIds: [] });
  });

  it('promoting a term to itself (fromTag === toTag) flips source to vocab in place, without self-deleting', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });
    db.replaceBookTags('b1', [{ tag: 'noblebright', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);
    db.replaceBookTags('b2', [{ tag: 'noblebright', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);

    const result = db.retagLlmOpenTags('noblebright', 'mood', 'noblebright');

    expect(result.changed).toBe(2);
    expect(result.bookIds.slice().sort()).toEqual(['b1', 'b2']);
    expect(db.getTagsForBook('b1')).toMatchObject([{ tag: 'noblebright', source: 'vocab' }]);
    expect(db.getTagsForBook('b2')).toMatchObject([{ tag: 'noblebright', source: 'vocab' }]);
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

// R1 (docs/enrichment-sources-review.md §3): `vocab_terms.origin` distinguishes
// an llm-open 'proposed' row (origin='tagger', from refreshProposedVocabCounts)
// from a cached-provider-subjects one (origin='enrichment', from
// core/enrichment/promoteSubjects.ts / refreshEnrichmentVocabProposals). These
// tests own the schema mechanics only — the promotion/canonicalization logic
// itself is core/enrichment/promoteSubjects.test.ts's job.
describe('vocab_terms.origin migrates onto a pre-existing table', () => {
  it('adds origin, defaulting every pre-existing row to "tagger", to a DB predating this column', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-db-vocab-origin-migrate-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'lib.db');

    // Old-shape vocab_terms: the column set as it existed immediately before
    // this migration, no `origin`. MIGRATIONS' `CREATE TABLE IF NOT EXISTS`
    // leaves this table alone (it already exists) and creates every other
    // table fresh, same pattern as db.enrichmentColumns.test.ts's books-table
    // migration test.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE vocab_terms (
        term TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        book_count INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL,
        PRIMARY KEY (term, category)
      );
    `);
    raw
      .prepare(
        `INSERT INTO vocab_terms (term, category, status, book_count, first_seen)
         VALUES ('cozy', 'genre', 'proposed', 3, 1000)`
      )
      .run();
    raw.close();

    const db = new CuratorDb(dbPath);
    databases.push(db);

    const row = db.getVocabTerms().find((t) => t.term === 'cozy' && t.category === 'genre');
    expect(row).toMatchObject({ status: 'proposed', bookCount: 3, origin: 'tagger' });
  });

  it('is idempotent: reopening an already-migrated database does not throw or duplicate the column', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-db-vocab-origin-reopen-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'lib.db');

    const first = new CuratorDb(dbPath);
    first.close();

    const second = new CuratorDb(dbPath);
    databases.push(second);
    expect(() => second.getVocabTerms()).not.toThrow();

    const raw = new Database(dbPath);
    const columns = (raw.prepare('PRAGMA table_info(vocab_terms)').all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    raw.close();
    expect(columns.filter((c) => c === 'origin')).toHaveLength(1);
  });
});

describe('refreshEnrichmentVocabProposals (R1: origin=enrichment side of the promotion queue)', () => {
  it('proposes a new term and reports 0 pruned when nothing is stale', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);

    const pruned = db.refreshEnrichmentVocabProposals([{ term: 'cozy', category: 'genre', bookCount: 4 }], 1000);

    expect(pruned).toBe(0);
    const row = db.getVocabTerms(['proposed']).find((t) => t.term === 'cozy' && t.category === 'genre');
    expect(row).toMatchObject({ status: 'proposed', bookCount: 4, origin: 'enrichment' });
  });

  it('recomputes (not increments) book_count on a second call, and prunes a term absent from the new set', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);

    db.refreshEnrichmentVocabProposals(
      [
        { term: 'cozy', category: 'genre', bookCount: 4 },
        { term: 'gritty', category: 'genre', bookCount: 2 },
      ],
      1000
    );

    const pruned = db.refreshEnrichmentVocabProposals([{ term: 'cozy', category: 'genre', bookCount: 9 }], 2000);

    expect(pruned).toBe(1);
    expect(db.getVocabTerms(['proposed']).find((t) => t.term === 'cozy')?.bookCount).toBe(9);
    expect(db.getVocabTerms(['proposed']).find((t) => t.term === 'gritty')).toBeUndefined();
  });

  it('never flips a seed, promoted, or rejected row back to proposed, and never touches its book_count', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    const seedTerm = SEED_VOCABULARY.genre[0]!;
    db.setVocabTermStatus('rejected-term', 'genre', 'rejected', 500);

    db.refreshEnrichmentVocabProposals(
      [
        { term: seedTerm, category: 'genre', bookCount: 50 },
        { term: 'rejected-term', category: 'genre', bookCount: 50 },
      ],
      1000
    );

    expect(db.getVocabTerms().find((t) => t.term === seedTerm)).toMatchObject({ status: 'seed', bookCount: 0 });
    expect(db.getVocabTerms().find((t) => t.term === 'rejected-term')).toMatchObject({
      status: 'rejected',
      bookCount: 0,
    });
  });

  it('never touches a "tagger"-origin proposed row, even for the same (term, category)', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    db.setVocabTermStatus('cozy', 'genre', 'proposed', 500); // origin defaults to 'tagger'

    db.refreshEnrichmentVocabProposals([{ term: 'cozy', category: 'genre', bookCount: 99 }], 1000);

    const row = db.getVocabTerms(['proposed']).find((t) => t.term === 'cozy' && t.category === 'genre');
    expect(row).toMatchObject({ origin: 'tagger', bookCount: 0 });
  });
});

describe('refreshProposedVocabCounts is scoped to origin=tagger (R1 regression guard)', () => {
  it('never deletes an "enrichment"-origin proposed row, even with zero matching llm-open book_tags', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    db.refreshEnrichmentVocabProposals([{ term: 'adventurous', category: 'mood', bookCount: 5 }], 1000);

    // The exact bug this scoping fixes: the tagger-side refresh used to
    // unconditionally DELETE every 'proposed' row with no llm-open backing.
    db.refreshProposedVocabCounts(2000);

    const row = db.getVocabTerms(['proposed']).find((t) => t.term === 'adventurous' && t.category === 'mood');
    expect(row).toMatchObject({ origin: 'enrichment', bookCount: 5 });
  });

  it('never overwrites an "enrichment"-origin row even when a same-named llm-open tag exists', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    db.refreshEnrichmentVocabProposals([{ term: 'adventurous', category: 'mood', bookCount: 5 }], 1000);

    db.replaceBookTags('b1', [{ tag: 'adventurous', category: 'mood', confidence: 0.8, source: 'llm-open' }], 2000);
    db.refreshProposedVocabCounts(3000);

    // Still the enrichment row's original count — the tagger-side upsert's
    // WHERE clause never matched it.
    const row = db.getVocabTerms(['proposed']).find((t) => t.term === 'adventurous' && t.category === 'mood');
    expect(row).toMatchObject({ origin: 'enrichment', bookCount: 5 });
  });

  it('still writes/refreshes/deletes ordinary "tagger"-origin rows exactly as before', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    db.replaceBookTags('b1', [{ tag: 'zany', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1000);

    db.refreshProposedVocabCounts(1000);
    expect(db.getVocabTerms(['proposed']).find((t) => t.term === 'zany')).toMatchObject({
      origin: 'tagger',
      bookCount: 1,
    });

    db.replaceBookTags('b1', [], 2000);
    db.refreshProposedVocabCounts(2000);
    expect(db.getVocabTerms(['proposed']).find((t) => t.term === 'zany')).toBeUndefined();
  });
});
