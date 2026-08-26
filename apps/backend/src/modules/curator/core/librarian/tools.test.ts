/**
 * The librarian retrieval tool registry (readiness item I, plan §5.1).
 *
 * Exercises each handler directly (no MCP transport involved — that wiring,
 * and its own coverage, belongs to a future MCP registration; see this
 * file's docblock). `search_library`'s coverage-disclosure cases exist here
 * too, not just in `mcp/tools/queryLibrary.test.ts` — proving the SHARED
 * `core/librarian/coverage.ts` extraction actually works through this
 * second call site is the point of readiness item D's "single-sourced"
 * guarantee (see `coverage.ts`'s docblock).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../db.js';
import { AppError, NotFoundError } from '../errors.js';
import { composeEmbeddingCard } from '../retrieval/embedder.js';
import type { Book } from '../types.js';
import { LIBRARIAN_TOOLS, type LibrarianToolDeps } from './tools.js';

const databases: CuratorDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

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

/** Embed a book over the card it actually has, same as a real run — a
 *  placeholder cardHash would make the book read STALE, which is not
 *  coverage (see queryLibrary.test.ts's identical helper). */
function embedFresh(db: CuratorDb, id: string, model = 'stub-model'): void {
  const card = composeEmbeddingCard(db, db.getBook(id)!);
  db.upsertBookEmbedding({ bookId: id, model, cardHash: card.hash, vector: new Float32Array([1]) });
}

function deps(db: CuratorDb, embeddingModel = 'stub-model'): LibrarianToolDeps {
  return { db, embeddingModel };
}

/** Invoke a registered tool by name. The registry is deliberately typed as a
 *  union of concrete tool shapes (see tools.ts), so dispatch-by-name needs an
 *  escape hatch here — fine in a test file, where `no-explicit-any` is off. */
function callTool(name: string, toolDeps: LibrarianToolDeps, input: unknown): any {
  const tool = LIBRARIAN_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no librarian tool named ${name}`);
  return (tool.handler as any)(toolDeps, input);
}

describe('search_library', () => {
  it('filters by tag, matching query_library\'s filter surface', () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Cozy Book' });
    addBook(db, { id: 'b2', title: 'Other Book' });
    db.replaceBookTags('b1', [{ tag: 'cozy', category: 'mood', confidence: 0.9, source: 'vocab' }], Date.now());
    db.replaceBookTags('b2', [{ tag: 'thriller', category: 'genre', confidence: 0.9, source: 'vocab' }], Date.now());

    const result = callTool('search_library', deps(db), { tag: 'cozy' });
    expect(result.total).toBe(1);
    expect(result.books[0].id).toBe('b1');
    expect(result.books[0].tags.map((t: { tag: string }) => t.tag)).toEqual(['cozy']);
  });

  it('applies duration-hours and series filters after the SQL query', () => {
    const db = makeDb();
    addBook(db, { id: 's1', title: 'Standalone Short', durationSeconds: 3600 * 5 });
    addBook(db, { id: 's2', title: 'In-Series Long', durationSeconds: 3600 * 20, series: 'A Series' });

    const standalone = callTool('search_library', deps(db), { series: 'standalone' });
    expect(standalone.books.map((b: { id: string }) => b.id)).toEqual(['s1']);

    const long = callTool('search_library', deps(db), { minDurationHours: 10 });
    expect(long.books.map((b: { id: string }) => b.id)).toEqual(['s2']);
  });

  it('attaches libraryCoverage when coverage is materially low (via the shared coverage module)', () => {
    const db = makeDb();
    for (const id of ['c1', 'c2', 'c3', 'c4']) addBook(db, { id, title: `Book ${id}` });

    const result = callTool('search_library', deps(db), {});
    expect(result.libraryCoverage).toBeDefined();
    expect(result.libraryCoverage.disclosure).toEqual(expect.any(String));
  });

  it('omits libraryCoverage entirely when coverage is healthy', () => {
    const db = makeDb();
    for (const id of ['w1', 'w2']) {
      addBook(db, { id, title: `Book ${id}` });
      db.upsertExternalMetadata({ bookId: id, provider: 'openlibrary', payload: {}, fetchedAt: 1, status: 'ok' });
      db.replaceBookEntities(id, [{ entity: 'Ahab', kind: 'person', sources: ['openlibrary'] }]);
      db.recordTagRun(id, ['genre'], 1, 1);
      embedFresh(db, id);
    }

    const result = callTool('search_library', deps(db), {});
    expect(result.libraryCoverage).toBeUndefined();
    expect(result.total).toBe(2);
  });
});

describe('get_book', () => {
  it('returns the book and its tags', () => {
    const db = makeDb();
    addBook(db, { id: 'g1', title: 'Get Me' });
    db.replaceBookTags('g1', [{ tag: 'noir', category: 'genre', confidence: 0.7, source: 'llm-open' }], Date.now());

    const result = callTool('get_book', deps(db), { id: 'g1' });
    expect(result.book.id).toBe('g1');
    expect(result.tags.map((t: { tag: string }) => t.tag)).toEqual(['noir']);
  });

  it('throws NotFoundError for an unknown id, rather than returning null', () => {
    const db = makeDb();
    expect(() => callTool('get_book', deps(db), { id: 'missing' })).toThrow(NotFoundError);
  });
});

describe('find_similar', () => {
  it('wraps findSimilar and excludes the anchor from its own results', () => {
    const db = makeDb();
    for (const id of ['f1', 'f2', 'f3']) addBook(db, { id, title: `Book ${id}` });
    for (const id of ['f1', 'f2', 'f3']) embedFresh(db, id);

    const result = callTool('find_similar', deps(db), { bookId: 'f1' });
    const ids = result.results.map((r: { book: { id: string } }) => r.book.id);
    expect(ids).not.toContain('f1');
    expect(ids.sort()).toEqual(['f2', 'f3']);
  });

  it('propagates NotFoundError for an unknown anchor, not an empty list', () => {
    const db = makeDb();
    expect(() => callTool('find_similar', deps(db), { bookId: 'missing' })).toThrow(NotFoundError);
  });

  it('propagates AppError when the anchor has never been embedded, not an empty list', () => {
    const db = makeDb();
    addBook(db, { id: 'no-embed', title: 'Never Embedded' });
    expect(() => callTool('find_similar', deps(db), { bookId: 'no-embed' })).toThrow(AppError);
  });
});

describe('tag_coverage', () => {
  it('classifies present / absent / unaudited across the three-state model', () => {
    const db = makeDb();
    addBook(db, { id: 't1', title: 'Has The Trope' });
    addBook(db, { id: 't2', title: 'Audited, No Trope' });
    addBook(db, { id: 't3', title: 'Never Audited' });
    db.replaceBookTags('t1', [{ tag: 'chosen-one', category: 'trope', confidence: 0.9, source: 'vocab' }], Date.now());
    db.recordTagRun('t1', ['trope'], 1, Date.now());
    db.recordTagRun('t2', ['trope'], 1, Date.now());
    // t3 gets no tag_runs row at all — never audited for anything.

    const report = callTool('tag_coverage', deps(db), { tags: [{ tag: 'chosen-one', category: 'trope' }] });
    const entry = report.entries[0];
    expect(entry.present.bookIds).toEqual(['t1']);
    expect(entry.absent.bookIds).toEqual(['t2']);
    expect(entry.unaudited.bookIds).toEqual(['t3']);
  });

  it('scopes the report to bookIds when given', () => {
    const db = makeDb();
    addBook(db, { id: 'x1', title: 'In Scope' });
    addBook(db, { id: 'x2', title: 'Out Of Scope' });

    const report = callTool('tag_coverage', deps(db), {
      tags: [{ tag: 'chosen-one', category: 'trope' }],
      bookIds: ['x1'],
    });
    const entry = report.entries[0];
    expect([...entry.present.bookIds, ...entry.absent.bookIds, ...entry.unaudited.bookIds]).toEqual(['x1']);
  });
});
