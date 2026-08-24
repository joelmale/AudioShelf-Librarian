import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../db.js';
import { OperationCancelledError } from '../errors.js';
import type { OperationController } from '../operations.js';
import type { Book } from '../types.js';
import { embedBooks, isEmbeddingStale } from './embedder.js';
import { composeBookCard } from './bookCard.js';
import { createStubEmbeddingCreator, stubEmbed } from './fixtures/stubEmbedder.js';
import type { EmbeddingCreator, EmbeddingRequest } from './embeddings.js';

const MODEL = 'stub-model';

const databases: CuratorDb[] = [];

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

function addBooks(db: CuratorDb, count: number): void {
  for (let i = 0; i < count; i += 1) {
    addBook(db, { id: `b${String(i).padStart(2, '0')}`, title: `Book ${String(i).padStart(2, '0')}` });
  }
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe('embedBooks', () => {
  it('happy path: writes an embedding for every stale book, matching the composed card hash', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    const creator = createStubEmbeddingCreator();
    const result = await embedBooks(db, creator, { model: MODEL, concurrency: 2, now: () => 1_000 });

    expect(result.processed).toBe(2);
    expect(result.embedded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.errors).toEqual([]);

    for (const id of ['b1', 'b2']) {
      const card = composeBookCard(db.getBook(id)!, db.getTagsForBook(id), db.getEntitiesForBook(id));
      const stored = db.getBookEmbedding(id);
      expect(stored).not.toBeNull();
      expect(stored?.model).toBe(MODEL);
      expect(stored?.cardHash).toBe(card.hash);
      expect(stored?.vector).toEqual(stubEmbed(card.text));
    }
  });

  it('a book whose card is unchanged is not re-embedded — the closed loop costs zero embed calls on re-run', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    const creator = createStubEmbeddingCreator();
    const first = await embedBooks(db, creator, { model: MODEL, concurrency: 2, now: () => 1_000 });
    expect(first.embedded).toBe(2);

    const spyCreator: EmbeddingCreator = {
      create: vi.fn((req: EmbeddingRequest) => creator.create(req)),
    };
    const second = await embedBooks(db, spyCreator, { model: MODEL, concurrency: 2, now: () => 2_000 });

    expect(second.processed).toBe(0);
    expect(second.embedded).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(spyCreator.create).not.toHaveBeenCalled();
  });

  it('one book failing to embed records the error and the run continues to the next book', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    const creator: EmbeddingCreator = {
      create: vi.fn(async (req: EmbeddingRequest) => {
        if (req.input[0]?.includes('Book One')) throw new Error('embed boom');
        return req.input.map((text) => stubEmbed(text));
      }),
    };

    const result = await embedBooks(db, creator, { model: MODEL, concurrency: 1, now: () => 3_000 });

    expect(result.processed).toBe(1);
    expect(result.embedded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.id).toBe('b1');

    expect(db.getBookEmbedding('b1')).toBeNull();
    expect(db.getBookEmbedding('b2')).not.toBeNull();
  });

  it('dry run reports the plan (bookId, title, reason) without calling the creator', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    const creator = createStubEmbeddingCreator();
    const spy = vi.spyOn(creator, 'create');

    const result = await embedBooks(db, creator, { model: MODEL, concurrency: 2, dryRun: true, now: () => 4_000 });

    expect(result.dryRun).toBe(true);
    expect(result.plan).toHaveLength(2);
    expect(result.plan?.every((p) => p.reason === 'never-embedded')).toBe(true);
    expect(result.skipped).toBe(2);
    expect(result.processed).toBe(0);
    expect(result.embedded).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(db.getBookEmbedding('b1')).toBeNull();
  });

  it('sample mode limits the set embedded to max(20, 5%) of the stale pool', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBooks(db, 30);

    const creator = createStubEmbeddingCreator();
    const result = await embedBooks(db, creator, { model: MODEL, concurrency: 5, sample: true, now: () => 5_000 });

    expect(result.sample).toBe(true);
    expect(result.processed).toBe(20);
    expect(result.embedded).toBe(20);
    expect(db.countBookEmbeddings(MODEL)).toBe(20);
  });

  it('sampleSize override is honored even without sample: true', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBooks(db, 30);

    const creator = createStubEmbeddingCreator();
    const result = await embedBooks(db, creator, { model: MODEL, concurrency: 5, sampleSize: 5, now: () => 6_000 });

    expect(result.sample).toBe(true);
    expect(result.processed).toBe(5);
    expect(result.embedded).toBe(5);
  });

  it('cancellation via the controller stops after the first book, leaving it embedded and skipping the rest', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    const creator = createStubEmbeddingCreator();

    // Minimal fake controller satisfying the surface embedBooks actually
    // calls: checkpoint/setProgress/markCompleted/markCancelled/id (see
    // core/operations.ts) — same shape as enricher.test.ts's fake controller.
    let checkpointCalls = 0;
    const fakeController = {
      id: 'op-fake',
      checkpoint: vi.fn(async () => {
        checkpointCalls += 1;
        if (checkpointCalls > 1) throw new OperationCancelledError('op-fake');
      }),
      setProgress: vi.fn(),
      markCompleted: vi.fn(),
      markCancelled: vi.fn(),
    };

    const result = await embedBooks(db, creator, {
      model: MODEL,
      concurrency: 1, // deterministic ordering: b1 then b2
      now: () => 7_000,
      controller: fakeController as unknown as OperationController,
    });

    expect(result.cancelled).toBe(true);
    expect(result.processed).toBe(1);
    expect(result.embedded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(db.getBookEmbedding('b1')).not.toBeNull();
    expect(db.getBookEmbedding('b2')).toBeNull();
    expect(fakeController.markCancelled).toHaveBeenCalledTimes(1);
    expect(fakeController.markCompleted).not.toHaveBeenCalled();
  });
});

describe('isEmbeddingStale', () => {
  it('is stale when never embedded, when the model changed, or when the card hash changed — and not stale otherwise', () => {
    const neverEmbedded = { book: {} as Book, storedModel: null, storedCardHash: null };
    expect(isEmbeddingStale(neverEmbedded, MODEL, 'hash-a')).toBe(true);

    const modelChanged = { book: {} as Book, storedModel: 'old-model', storedCardHash: 'hash-a' };
    expect(isEmbeddingStale(modelChanged, MODEL, 'hash-a')).toBe(true);

    const cardChanged = { book: {} as Book, storedModel: MODEL, storedCardHash: 'hash-old' };
    expect(isEmbeddingStale(cardChanged, MODEL, 'hash-new')).toBe(true);

    const upToDate = { book: {} as Book, storedModel: MODEL, storedCardHash: 'hash-a' };
    expect(isEmbeddingStale(upToDate, MODEL, 'hash-a')).toBe(false);
  });
});
