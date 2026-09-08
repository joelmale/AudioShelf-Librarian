/**
 * Route-level tests for per-book tag suppression. The store's own semantics
 * (compose filtering, hashing, surviving a re-tag) are covered in
 * core/tagging/compose.test.ts and core/tagging/reground.test.ts — these
 * cover only what lives in the route: validation, the derived-tag refusal,
 * 404 mapping, and whether the response tells the truth about what was
 * actually applied.
 */
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../../core/db.js';
import { createStubEmbeddingCreator } from '../../core/retrieval/fixtures/stubEmbedder.js';
import { composeBookTags, evaluableTagCategories } from '../../core/tagging/compose.js';
import {
  serializeProposals,
  tagComposeHash,
  tagPromptHash,
  vocabularyFingerprint,
} from '../../core/tagging/tagInputs.js';
import { TAG_SCHEMA_VERSION, type Book, type GeneratedTag } from '../../core/types.js';
import { errorHandler } from '../http.js';
import type { ApiServices } from '../services.js';
import { createTagsRouter } from './tags.js';

const MODEL = 'claude-test';

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
  lastSyncedAt: 1000,
};

const PROPOSALS: GeneratedTag[] = [
  { tag: 'HardSciFi', category: 'genre', confidence: 0.9 },
  { tag: 'noblebright', category: 'mood', confidence: 0.7 },
];

const databases: CuratorDb[] = [];
const servers: import('node:http').Server[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function makeDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

/** Tag a book the way `tagger.ts` does, without calling a model. */
function tagAsTaggerWould(db: CuratorDb, book: Book, proposals: GeneratedTag[], at: number): void {
  const entities = db.getEntitiesForBook(book.id);
  const fingerprint = vocabularyFingerprint(db.getVocabFingerprintRows());
  db.replaceBookTags(book.id, composeBookTags(book, proposals, db), at);
  db.recordTagRun(book.id, evaluableTagCategories(book, entities), TAG_SCHEMA_VERSION, at, {
    proposals: serializeProposals(proposals),
    promptHash: tagPromptHash(book, MODEL, TAG_SCHEMA_VERSION),
    composeHash: tagComposeHash(book, entities, fingerprint, db.getTagSuppressionsForBook(book.id)),
  });
}

function buildApp(db: CuratorDb) {
  const app = express();
  app.use(express.json());
  const noop = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
  const services = {
    db,
    config: { embeddingModel: 'stub-model', taggingConcurrency: 2, taggingModel: MODEL },
    logger: noop,
    actionLog: { record: () => {} },
    operations: { create: () => ({ id: 'op', status: 'running' }) },
    embeddingCreator: createStubEmbeddingCreator(),
  } as unknown as ApiServices;
  app.use('/api', createTagsRouter(services));
  app.use(errorHandler(noop as never));
  return app;
}

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

function tagStrings(db: CuratorDb, bookId: string): string[] {
  return db
    .getTagsForBook(bookId)
    .map((t) => `${t.category}:${t.tag}`)
    .sort();
}

describe('POST /books/:id/tags/suppress', () => {
  it('retracts the tag from this book and applies it in the same request', async () => {
    const db = makeDb();
    db.upsertBook(BOOK);
    tagAsTaggerWould(db, BOOK, PROPOSALS, 1000);
    expect(tagStrings(db, 'it')).toContain('genre:hard-sci-fi');

    const res = await fetch(`${await listen(buildApp(db))}/api/books/it/tags/suppress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: 'hard-sci-fi', category: 'genre', note: 'horror, not sci-fi' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bookId: 'it', term: 'hard-sci-fi', suppressed: true, applied: true });
    // The curator clicked and the tag is gone — not gone on some later sweep.
    expect(tagStrings(db, 'it')).not.toContain('genre:hard-sci-fi');
    expect(tagStrings(db, 'it')).toContain('mood:noblebright');
  });

  it('refuses a derived tag instead of recording a verdict the derive pass would reverse', async () => {
    const db = makeDb();
    db.upsertBook(BOOK);
    tagAsTaggerWould(db, BOOK, PROPOSALS, 1000);

    const res = await fetch(`${await listen(buildApp(db))}/api/books/it/tags/suppress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: 'short', category: 'length' }),
    });

    expect(res.status).toBe(400);
    expect(db.getTagSuppressionsForBook('it')).toEqual([]);
    expect(tagStrings(db, 'it')).toContain('length:short');
  });

  it('reports applied:false when the book kept no proposals to recompose from', async () => {
    // The verdict is durable either way — it is a human decision — but the
    // response must not claim a retraction that has not happened yet.
    const db = makeDb();
    db.upsertBook(BOOK);
    db.replaceBookTags('it', [{ tag: 'hard-sci-fi', category: 'genre', confidence: 0.9, source: 'vocab' }], 1000);

    const res = await fetch(`${await listen(buildApp(db))}/api/books/it/tags/suppress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: 'hard-sci-fi', category: 'genre' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ suppressed: true, applied: false });
    expect(db.getTagSuppressionsForBook('it')).toHaveLength(1);
    expect(tagStrings(db, 'it')).toContain('genre:hard-sci-fi');
  });

  it('404s for a book that does not exist, and 400s on a bad category', async () => {
    const db = makeDb();
    db.upsertBook(BOOK);
    const base = await listen(buildApp(db));

    const missing = await fetch(`${base}/api/books/nope/tags/suppress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: 'hard-sci-fi', category: 'genre' }),
    });
    expect(missing.status).toBe(404);

    const bad = await fetch(`${base}/api/books/it/tags/suppress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: 'hard-sci-fi', category: 'not-a-category' }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('DELETE /books/:id/tags/suppress', () => {
  it('lifts the verdict and restores the tag', async () => {
    const db = makeDb();
    db.upsertBook(BOOK);
    tagAsTaggerWould(db, BOOK, PROPOSALS, 1000);
    const base = await listen(buildApp(db));

    await fetch(`${base}/api/books/it/tags/suppress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: 'hard-sci-fi', category: 'genre' }),
    });
    expect(tagStrings(db, 'it')).not.toContain('genre:hard-sci-fi');

    const res = await fetch(`${base}/api/books/it/tags/suppress`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: 'hard-sci-fi', category: 'genre' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ suppressed: false, applied: true });
    expect(tagStrings(db, 'it')).toContain('genre:hard-sci-fi');
  });

  it('404s when nothing was suppressed, so an undo cannot silently no-op', async () => {
    const db = makeDb();
    db.upsertBook(BOOK);
    const res = await fetch(`${await listen(buildApp(db))}/api/books/it/tags/suppress`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: 'hard-sci-fi', category: 'genre' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /books/:id/tags/suppress', () => {
  it('lists the decisions already made on a book', async () => {
    const db = makeDb();
    db.upsertBook(BOOK);
    db.addTagSuppression('it', 'hard-sci-fi', 'genre', 1500, 'horror, not sci-fi');

    const res = await fetch(`${await listen(buildApp(db))}/api/books/it/tags/suppress`);
    expect(await res.json()).toEqual([
      { bookId: 'it', tag: 'hard-sci-fi', category: 'genre', suppressedAt: 1500, note: 'horror, not sci-fi' },
    ]);
  });
});
