import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { CuratorDb } from './db.js';
import type { Book } from './types.js';

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

/** Build a Float32Array of varied non-integer values, seeded through
 *  Math.fround so the expectation is stored as an actual float32 value
 *  rather than the more precise float64 `Math.sin` would produce. */
function fakeVector(length: number): Float32Array {
  const vec = new Float32Array(length);
  for (let i = 0; i < length; i++) vec[i] = Math.fround(Math.sin(i) * (i + 1));
  return vec;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('book_embeddings', () => {
  it('round-trips a Float32Array vector through the BLOB column', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    const vector = fakeVector(384);
    db.upsertBookEmbedding({ bookId: 'b1', model: 'nomic-embed-text', cardHash: 'hash1', vector });

    const rec = db.getBookEmbedding('b1');
    expect(rec).not.toBeNull();
    expect(rec?.vector).toHaveLength(384);
    for (let i = 0; i < vector.length; i++) {
      expect(rec?.vector[i]).toBe(vector[i]);
    }
  });

  it('survives a misaligned buffer read', () => {
    // better-sqlite3 returns Buffers that may be views into a shared, pooled
    // allocation with a non-multiple-of-4 byteOffset. Writing several BLOBs
    // in a row and reading them all back is the regression scenario for the
    // RangeError this would throw on an un-copied Float32Array view.
    const db = new CuratorDb(':memory:');
    databases.push(db);

    const vectors = new Map<string, Float32Array>();
    for (let i = 0; i < 5; i++) {
      const bookId = `book-${i}`;
      addBook(db, { id: bookId, title: `Book ${i}` });
      // Odd lengths help provoke non-4-aligned byteOffsets in the pooled buffer.
      const vector = fakeVector(37 + i);
      vectors.set(bookId, vector);
      db.upsertBookEmbedding({ bookId, model: 'nomic-embed-text', cardHash: `hash-${i}`, vector });
    }

    const all = db.getAllBookEmbeddings();
    expect(all).toHaveLength(5);
    for (const rec of all) {
      const expected = vectors.get(rec.bookId);
      expect(expected).toBeDefined();
      expect(rec.vector).toHaveLength(expected!.length);
      for (let i = 0; i < expected!.length; i++) {
        expect(rec.vector[i]).toBe(expected![i]);
      }
    }
  });

  it('upsert replaces model, card_hash and vector for the same book', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    db.upsertBookEmbedding({
      bookId: 'b1',
      model: 'nomic-embed-text',
      cardHash: 'hash-old',
      vector: fakeVector(4),
    });
    const secondVector = fakeVector(8);
    db.upsertBookEmbedding({
      bookId: 'b1',
      model: 'mxbai-embed-large',
      cardHash: 'hash-new',
      vector: secondVector,
    });

    expect(db.countBookEmbeddings()).toBe(1);
    const rec = db.getBookEmbedding('b1');
    expect(rec?.model).toBe('mxbai-embed-large');
    expect(rec?.cardHash).toBe('hash-new');
    expect(rec?.vector).toHaveLength(8);
    expect(Array.from(rec!.vector)).toEqual(Array.from(secondVector));
  });

  it('getEmbeddingCardHashes returns model and hash without loading vectors', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    db.upsertBookEmbedding({ bookId: 'b1', model: 'nomic-embed-text', cardHash: 'h1', vector: fakeVector(4) });
    db.upsertBookEmbedding({ bookId: 'b2', model: 'nomic-embed-text', cardHash: 'h2', vector: fakeVector(4) });

    const hashes = db.getEmbeddingCardHashes();
    expect(hashes.size).toBe(2);
    expect(hashes.get('b1')).toEqual({ model: 'nomic-embed-text', cardHash: 'h1' });
    expect(hashes.get('b2')).toEqual({ model: 'nomic-embed-text', cardHash: 'h2' });
  });

  it('getAllBookEmbeddings filters by model when given one', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    db.upsertBookEmbedding({ bookId: 'b1', model: 'nomic-embed-text', cardHash: 'h1', vector: fakeVector(4) });
    db.upsertBookEmbedding({ bookId: 'b2', model: 'mxbai-embed-large', cardHash: 'h2', vector: fakeVector(4) });

    const nomic = db.getAllBookEmbeddings('nomic-embed-text');
    expect(nomic.map((r) => r.bookId)).toEqual(['b1']);

    const all = db.getAllBookEmbeddings();
    expect(all.map((r) => r.bookId).sort()).toEqual(['b1', 'b2']);
  });

  it('deleteBookEmbedding removes the row and reports the change count', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    db.upsertBookEmbedding({ bookId: 'b1', model: 'nomic-embed-text', cardHash: 'h1', vector: fakeVector(4) });

    expect(db.deleteBookEmbedding('b1')).toBe(1);
    expect(db.getBookEmbedding('b1')).toBeNull();
    expect(db.deleteBookEmbedding('b1')).toBe(0);
  });

  it('migration is idempotent against an existing database file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-db-embeddings-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'lib.db');

    const first = new CuratorDb(dbPath);
    addBook(first, { id: 'b1', title: 'Book One' });
    first.upsertBookEmbedding({ bookId: 'b1', model: 'nomic-embed-text', cardHash: 'h1', vector: fakeVector(16) });
    first.replaceBookEdges('b1', 'similar', 'embedding', [{ toBook: 'b2', score: 0.9 }]);
    first.close();

    // Re-opening the same file must not throw and must run the additive
    // migration idempotently, preserving what was already written.
    const reopened = new CuratorDb(dbPath);
    databases.push(reopened);

    const rec = reopened.getBookEmbedding('b1');
    expect(rec?.cardHash).toBe('h1');
    expect(rec?.vector).toHaveLength(16);

    const edges = reopened.getEdgesForBook('b1');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ fromBook: 'b1', toBook: 'b2', relation: 'similar', source: 'embedding' });
  });
});

describe('book_edges', () => {
  it('replaceBookEdges replaces rather than appends for the same relation+source', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    db.replaceBookEdges('b1', 'similar', 'embedding', [
      { toBook: 'b2', score: 0.9 },
      { toBook: 'b3', score: 0.8 },
      { toBook: 'b4', score: 0.7 },
    ]);
    expect(db.getEdgesForBook('b1')).toHaveLength(3);

    db.replaceBookEdges('b1', 'similar', 'embedding', [
      { toBook: 'b5', score: 0.6 },
      { toBook: 'b6', score: 0.5 },
    ]);

    const edges = db.getEdgesForBook('b1');
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.toBook).sort()).toEqual(['b5', 'b6']);
  });

  it('keeps edges of a different relation when replacing one relation', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    db.replaceBookEdges('b1', 'similar', 'embedding', [{ toBook: 'b2', score: 0.9 }]);
    db.replaceBookEdges('b1', 'comparable', 'llm', [{ toBook: 'external-work', score: null }]);

    db.replaceBookEdges('b1', 'similar', 'embedding', [{ toBook: 'b3', score: 0.5 }]);

    const similar = db.getEdgesForBook('b1', 'similar');
    expect(similar.map((e) => e.toBook)).toEqual(['b3']);

    const comparable = db.getEdgesForBook('b1', 'comparable');
    expect(comparable).toHaveLength(1);
    expect(comparable[0]).toMatchObject({ toBook: 'external-work', relation: 'comparable', source: 'llm', score: null });

    expect(db.getEdgesForBook('b1')).toHaveLength(2);
  });

  it('stores an edge to a book id that does not exist in books', () => {
    // book_edges.to_book intentionally has no foreign key: it may reference a
    // non-owned work (readalike from an external provider), so this must
    // succeed rather than fail an FK check.
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    expect(() =>
      db.replaceBookEdges('b1', 'comparable', 'llm', [{ toBook: 'not-in-library|some-author', score: null }])
    ).not.toThrow();

    const edges = db.getEdgesForBook('b1', 'comparable');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.toBook).toBe('not-in-library|some-author');
  });
});

describe('embeddingModel config', () => {
  it('defaults to nomic-embed-text', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.embeddingModel).toBe('nomic-embed-text');
  });

  it('is overridable via EMBEDDING_MODEL', () => {
    const config = loadConfig({ EMBEDDING_MODEL: 'mxbai-embed-large' } as NodeJS.ProcessEnv);
    expect(config.embeddingModel).toBe('mxbai-embed-large');
  });
});
