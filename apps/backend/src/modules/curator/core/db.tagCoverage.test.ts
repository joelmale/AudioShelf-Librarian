import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CuratorDb } from './db.js';
import { TAG_CATEGORIES, type Book } from './types.js';

const tempDirs: string[] = [];
let db: CuratorDb;

function addBook(input: Pick<Book, 'id' | 'title'>): void {
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

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-db-tag-coverage-'));
  tempDirs.push(dir);
  db = new CuratorDb(path.join(dir, 'test.db'));
});

afterEach(() => {
  db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('tag_runs — recordTagRun / getTagRunsForBook', () => {
  it('round-trips categories, schema version and taggedAt', () => {
    addBook({ id: 'b1', title: 'Book One' });
    db.recordTagRun('b1', ['genre', 'mood', 'trope'], 1, 1000);

    const runs = db.getTagRunsForBook('b1');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.bookId).toBe('b1');
    expect(runs[0]?.categories).toEqual(['genre', 'mood', 'trope']);
    expect(runs[0]?.schemaVersion).toBe(1);
    expect(runs[0]?.taggedAt).toBe(1000);
  });

  it('returns every run for a book, newest first', () => {
    addBook({ id: 'b1', title: 'Book One' });
    db.recordTagRun('b1', ['genre'], 1, 1000);
    db.recordTagRun('b1', [...TAG_CATEGORIES], 1, 2000);

    const runs = db.getTagRunsForBook('b1');
    expect(runs).toHaveLength(2);
    expect(runs[0]?.taggedAt).toBe(2000);
    expect(runs[1]?.taggedAt).toBe(1000);
  });

  it('returns an empty list for a book that has never been tagged', () => {
    addBook({ id: 'b1', title: 'Book One' });
    expect(db.getTagRunsForBook('b1')).toEqual([]);
  });
});

describe('getAuditedCategories', () => {
  it('maps a book with no tag_runs row to an empty set, not a missing entry, when bookIds is given', () => {
    addBook({ id: 'never-run', title: 'Never Run' });

    const audited = db.getAuditedCategories(['never-run']);
    expect(audited.get('never-run')).toEqual(new Set());
  });

  it('unions categories across every recorded run for a book', () => {
    addBook({ id: 'b1', title: 'Book One' });
    db.recordTagRun('b1', ['genre', 'mood'], 1, 1000);
    db.recordTagRun('b1', ['trope', 'mood'], 1, 2000);

    const audited = db.getAuditedCategories(['b1']);
    expect(audited.get('b1')).toEqual(new Set(['genre', 'mood', 'trope']));
  });

  it('with bookIds omitted, includes every book that has at least one run', () => {
    addBook({ id: 'b1', title: 'Book One' });
    addBook({ id: 'b2', title: 'Book Two' });
    db.recordTagRun('b1', ['genre'], 1, 1000);

    const audited = db.getAuditedCategories();
    expect(audited.get('b1')).toEqual(new Set(['genre']));
    expect(audited.has('b2')).toBe(false); // caller treats a missing key as empty
  });
});

describe('getTagCoverage — three-state classification', () => {
  beforeEach(() => {
    // p1: actually carries chosen-one/trope -> present.
    addBook({ id: 'p1', title: 'Present Book' });
    db.recordTagRun('p1', [...TAG_CATEGORIES], 1, 1000);
    db.replaceBookTags('p1', [{ tag: 'chosen-one', category: 'trope', confidence: 0.9, source: 'vocab' }], 1000);

    // a1: trope was audited (run attempted it), tag not present -> absent.
    addBook({ id: 'a1', title: 'Absent Book' });
    db.recordTagRun('a1', [...TAG_CATEGORIES], 1, 1000);
    db.replaceBookTags('a1', [{ tag: 'epic', category: 'length', confidence: 0.8, source: 'derived' }], 1000);

    // u1: pre-Phase-0 book — has OTHER tags but no tag_runs row at all -> unaudited.
    addBook({ id: 'u1', title: 'Unaudited Never-Run Book' });
    db.replaceBookTags('u1', [{ tag: 'dark', category: 'mood', confidence: 0.7, source: 'llm-open' }], 1000);

    // u2: HAS a tag_runs row, but it never attempted 'trope' -> unaudited despite a run existing.
    addBook({ id: 'u2', title: 'Unaudited Wrong-Category Book' });
    db.recordTagRun('u2', ['genre', 'mood'], 1, 1000);
    db.replaceBookTags('u2', [{ tag: 'hopeful', category: 'mood', confidence: 0.6, source: 'llm-open' }], 1000);
  });

  it('classifies every candidate into exactly one of present/absent/unaudited', () => {
    const report = db.getTagCoverage([{ tag: 'chosen-one', category: 'trope' }], {
      bookIds: ['p1', 'a1', 'u1', 'u2'],
    });

    expect(report.entries).toHaveLength(1);
    const entry = report.entries[0]!;
    expect(entry.tag).toBe('chosen-one');
    expect(entry.category).toBe('trope');
    expect(entry.present.count).toBe(1);
    expect(entry.present.bookIds).toEqual(['p1']);
    expect(entry.absent.count).toBe(1);
    expect(entry.absent.bookIds).toEqual(['a1']);
    expect(entry.unaudited.count).toBe(2);
    expect(new Set(entry.unaudited.bookIds)).toEqual(new Set(['u1', 'u2']));
  });

  it('exit criterion: a pre-Phase-0 book (has tags, no tag_runs row) reports unaudited, not absent', () => {
    const report = db.getTagCoverage([{ tag: 'chosen-one', category: 'trope' }], { bookIds: ['u1'] });
    const entry = report.entries[0]!;
    expect(entry.absent.count).toBe(0);
    expect(entry.unaudited.count).toBe(1);
    expect(entry.unaudited.bookIds).toEqual(['u1']);
  });

  it('exit criterion: excludeTags survivors fed into getTagCoverage report how many were never trope-audited', () => {
    // None of the fixture books carry a tag that would be excluded here except
    // p1 (which carries chosen-one itself), so excludeTags must drop exactly
    // p1 and nothing else — feed the UNFILTERED survivor ids straight into
    // getTagCoverage so this test actually exercises the excludeTags
    // predicate end to end, rather than a hardcoded id list that would pass
    // even if excludeTags were a no-op.
    const survivors = db.queryBooks({
      excludeTags: [{ tag: 'chosen-one', category: 'trope' }],
      limit: 100,
    });
    const survivorIds = survivors.books.map((b) => b.id);
    expect(survivorIds).not.toContain('p1');
    expect(survivorIds.sort()).toEqual(['a1', 'u1', 'u2']);

    const report = db.getTagCoverage([{ tag: 'chosen-one', category: 'trope' }], { bookIds: survivorIds });
    const entry = report.entries[0]!;
    expect(entry.present.count).toBe(0); // p1 was excluded from the candidate set entirely
    expect(entry.absent.count).toBe(1); // a1
    expect(entry.unaudited.count).toBe(2); // u1, u2 — never trope-audited
  });

  it('counts are exact even when a bucket exceeds the id-list cap', () => {
    // Add enough never-run books to exceed TAG_COVERAGE_ID_CAP (50) so the
    // unaudited bucket's id list is capped while its count stays exact.
    const ids: string[] = [];
    for (let i = 0; i < 55; i += 1) {
      const id = `cap-${i}`;
      addBook({ id, title: `Cap Book ${i}` });
      ids.push(id);
    }
    const report = db.getTagCoverage([{ tag: 'chosen-one', category: 'trope' }], { bookIds: ids });
    const entry = report.entries[0]!;
    expect(entry.unaudited.count).toBe(55);
    expect(entry.unaudited.bookIds.length).toBe(50);
  });
});

describe('getTagCoverage — category derivation when TagFilter omits category', () => {
  it('derives the category from a single canonical usage', () => {
    addBook({ id: 'b1', title: 'Book One' });
    db.recordTagRun('b1', ['mood'], 1, 1000);
    db.replaceBookTags('b1', [{ tag: 'solo-derived-tag', category: 'mood', confidence: 0.7, source: 'llm-open' }], 1000);

    addBook({ id: 'b2', title: 'Book Two' });
    db.recordTagRun('b2', ['mood'], 1, 1000); // audited for mood, doesn't carry the tag
    // A book with zero book_tags rows falls to unaudited regardless of run
    // history (finding 2) — give b2 an unrelated tag so it has real evidence
    // and this test still exercises "audited, doesn't carry THIS tag".
    db.replaceBookTags('b2', [{ tag: 'other-tag', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);

    const report = db.getTagCoverage([{ tag: 'solo-derived-tag' }], { bookIds: ['b1', 'b2'] });
    const entry = report.entries[0]!;
    expect(entry.category).toBe('mood');
    expect(entry.present.bookIds).toEqual(['b1']);
    expect(entry.absent.bookIds).toEqual(['b2']);
  });

  it('a seed-vocabulary tag resolves its category even for a book that never used it', () => {
    addBook({ id: 'b1', title: 'Book One' });
    db.recordTagRun('b1', ['trope'], 1, 1000);
    // A book with zero book_tags rows falls to unaudited regardless of run
    // history (finding 2) — give b1 an unrelated tag so it has real evidence.
    db.replaceBookTags('b1', [{ tag: 'other-tag', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);

    // 'chosen-one' is seeded into vocab_terms under 'trope' only, so the
    // category resolves via the vocabulary even though b1 never carries it.
    const report = db.getTagCoverage([{ tag: 'chosen-one' }], { bookIds: ['b1'] });
    const entry = report.entries[0]!;
    expect(entry.category).toBe('trope');
    expect(entry.absent.bookIds).toEqual(['b1']);
  });

  it('an ambiguous tag (recorded under more than one category) resolves to null and is never reported absent', () => {
    addBook({ id: 'b1', title: 'Book One' });
    db.replaceBookTags('b1', [{ tag: 'weird-tag', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);
    addBook({ id: 'b2', title: 'Book Two' });
    db.replaceBookTags('b2', [{ tag: 'weird-tag', category: 'theme', confidence: 0.5, source: 'llm-open' }], 1000);

    // b3 does not carry the tag, but IS audited for both categories it's
    // recorded under. Even so, an unresolved category must still report
    // unaudited rather than guess which category to check.
    addBook({ id: 'b3', title: 'Book Three' });
    db.recordTagRun('b3', ['mood', 'theme'], 1, 1000);

    const report = db.getTagCoverage([{ tag: 'weird-tag' }], { bookIds: ['b3'] });
    const entry = report.entries[0]!;
    expect(entry.category).toBeNull();
    expect(entry.absent.count).toBe(0);
    expect(entry.unaudited.count).toBe(1);
    expect(entry.unaudited.bookIds).toEqual(['b3']);
  });
});

describe('getTagCoverage — candidate set scoping', () => {
  it('with bookIds omitted, defaults to active books and excludes deleted ones', () => {
    addBook({ id: 'active1', title: 'Active Book' });
    addBook({ id: 'deleted1', title: 'Deleted Book' });
    db.tombstoneBook('deleted1', 2000);

    const report = db.getTagCoverage([{ tag: 'chosen-one', category: 'trope' }]);
    const entry = report.entries[0]!;
    const allUnaudited = new Set([...entry.unaudited.bookIds, ...entry.present.bookIds, ...entry.absent.bookIds]);
    expect(allUnaudited.has('active1')).toBe(true);
    expect(allUnaudited.has('deleted1')).toBe(false);
  });

  it('finding 1: an explicitly empty bookIds array scopes to an empty candidate set, not the whole library', () => {
    addBook({ id: 'b1', title: 'Book One' });
    addBook({ id: 'b2', title: 'Book Two' });
    addBook({ id: 'b3', title: 'Book Three' });
    for (const id of ['b1', 'b2', 'b3']) db.recordTagRun(id, [...TAG_CATEGORIES], 1, 1000);

    const report = db.getTagCoverage([{ tag: 'chosen-one', category: 'trope' }], { bookIds: [] });
    const entry = report.entries[0]!;
    expect(entry.present.count).toBe(0);
    expect(entry.absent.count).toBe(0);
    expect(entry.unaudited.count).toBe(0);
  });

  it('finding 1: bookIds omitted still scopes to every active book (distinguished from an empty array)', () => {
    addBook({ id: 'b1', title: 'Book One' });
    addBook({ id: 'b2', title: 'Book Two' });
    for (const id of ['b1', 'b2']) {
      db.recordTagRun(id, [...TAG_CATEGORIES], 1, 1000);
      db.replaceBookTags(id, [{ tag: 'epic', category: 'length', confidence: 0.8, source: 'derived' }], 1000);
    }

    const report = db.getTagCoverage([{ tag: 'chosen-one', category: 'trope' }]);
    const entry = report.entries[0]!;
    expect(entry.absent.count).toBe(2);
  });
});

describe('getTagCoverage — a book whose tags were wiped falls to unaudited (finding 2)', () => {
  it('deleteBookTags on an audited, tagged book: coverage falls to unaudited, not absent', () => {
    addBook({ id: 'b1', title: 'Book One' });
    db.recordTagRun('b1', [...TAG_CATEGORIES], 1, 1000);
    db.replaceBookTags('b1', [{ tag: 'epic', category: 'length', confidence: 0.8, source: 'derived' }], 1000);

    // Before the wipe: a genuine, correct "absent" verdict.
    let report = db.getTagCoverage([{ tag: 'chosen-one', category: 'trope' }], { bookIds: ['b1'] });
    expect(report.entries[0]?.absent.bookIds).toEqual(['b1']);

    // deleteBookTags wipes the evidence AND the runs that attested to it.
    // This is the write-side retraction: the read side cannot distinguish a
    // wiped book from one audited that legitimately produced nothing, so the
    // caller that knows evidence was destroyed is the one that must say so.
    db.deleteBookTags('b1');
    expect(db.getTagRunsForBook('b1')).toHaveLength(0);

    report = db.getTagCoverage([{ tag: 'chosen-one', category: 'trope' }], { bookIds: ['b1'] });
    const entry = report.entries[0]!;
    expect(entry.absent.count).toBe(0);
    expect(entry.unaudited.count).toBe(1);
    expect(entry.unaudited.bookIds).toEqual(['b1']);
  });

  it('a mid-retagAll tagger failure clears a book\'s tags but leaves no new run — coverage falls to unaudited', async () => {
    const { tagUntaggedBooks } = await import('./tagger.js');

    addBook({ id: 'b1', title: 'Book One' });
    db.recordTagRun('b1', [...TAG_CATEGORIES], 1, 1000);
    db.replaceBookTags('b1', [{ tag: 'epic', category: 'length', confidence: 0.8, source: 'derived' }], 1000);

    let report = db.getTagCoverage([{ tag: 'chosen-one', category: 'trope' }], { bookIds: ['b1'] });
    expect(report.entries[0]?.absent.bookIds).toEqual(['b1']); // genuine absent before the failed re-run

    const llmClient = { tagBook: async () => { throw new Error('LLM exploded'); } } as never;
    const absClient = { getBook: async () => ({ id: 'b1', media: { metadata: { tags: [] } } }), updateBookTags: async () => undefined } as never;
    const result = await tagUntaggedBooks(llmClient, db, {
      retagAll: true,
      bookIds: ['b1'],
      concurrency: 1,
      absClient,
    });

    expect(result.failed).toBe(1);
    expect(db.getTagsForBook('b1')).toHaveLength(0); // A4: cleared, not regenerated
    // The failed run's recordTagRun never executes (invariant 6), and the
    // catch retracts the EARLIER successful run too — reaching the catch on a
    // retag means the pre-clear destroyed this book's tags and nothing
    // replaced them, so that older row now attests to erased evidence.
    expect(db.getTagRunsForBook('b1')).toHaveLength(0);

    report = db.getTagCoverage([{ tag: 'chosen-one', category: 'trope' }], { bookIds: ['b1'] });
    const entry = report.entries[0]!;
    expect(entry.absent.count).toBe(0);
    expect(entry.unaudited.count).toBe(1);
    expect(entry.unaudited.bookIds).toEqual(['b1']);
  });
});
