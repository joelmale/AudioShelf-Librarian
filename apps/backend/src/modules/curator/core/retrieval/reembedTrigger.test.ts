import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book } from '../types.js';
import { composeBookCard } from './bookCard.js';
import { createStubEmbeddingCreator } from './fixtures/stubEmbedder.js';
import type { EmbeddingCreator, EmbeddingRequest } from './embeddings.js';
import { reembedAffectedBooks } from './reembedTrigger.js';

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

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe('reembedAffectedBooks', () => {
  it('embeds exactly the scoped bookIds, leaving other stale books untouched', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    const creator = createStubEmbeddingCreator();
    const outcome = await reembedAffectedBooks(db, creator, ['b1'], { model: MODEL, concurrency: 2 });

    expect(outcome.attempted).toBe(true);
    expect(outcome.result?.processed).toBe(1);
    expect(outcome.result?.embedded).toBe(1);
    expect(outcome.result?.failed).toBe(0);
    expect(db.getBookEmbedding('b1')).not.toBeNull();
    // Scoped: b2 was never passed in, so it's still unembedded.
    expect(db.getBookEmbedding('b2')).toBeNull();
  });

  it('an empty bookIds list is a no-op and reports attempted: false without calling the creator', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    const creator = createStubEmbeddingCreator();
    const spy = vi.spyOn(creator, 'create');

    const outcome = await reembedAffectedBooks(db, creator, [], { model: MODEL, concurrency: 2 });

    expect(outcome).toEqual({ attempted: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a book whose card is unchanged since its last embed is not re-embedded (unchanged, not attempted-but-failed)', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    const creator = createStubEmbeddingCreator();
    const first = await reembedAffectedBooks(db, creator, ['b1'], { model: MODEL, concurrency: 1 });
    expect(first.result?.embedded).toBe(1);

    const second = await reembedAffectedBooks(db, creator, ['b1'], { model: MODEL, concurrency: 1 });
    expect(second.attempted).toBe(true);
    expect(second.result?.processed).toBe(0);
    expect(second.result?.unchanged).toBe(1);
  });

  // ── Failure isolation (invariant: a failed re-embed must never fail or
  // roll back the tag mutation that preceded it) ────────────────────────────

  it('every book failing to embed (e.g. the embedder is unreachable) does not throw — it reports failed counts honestly', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    const alwaysFails: EmbeddingCreator = {
      create: vi.fn(async (_req: EmbeddingRequest) => {
        throw new Error('Ollama unreachable');
      }),
    };

    const outcome = await reembedAffectedBooks(db, alwaysFails, ['b1', 'b2'], { model: MODEL, concurrency: 2 });

    // The call resolved rather than throwing/rejecting to the caller.
    expect(outcome.attempted).toBe(true);
    expect(outcome.result?.processed).toBe(0);
    expect(outcome.result?.failed).toBe(2);
    // Both books are still stale — no embedding was ever written for them.
    expect(db.getBookEmbedding('b1')).toBeNull();
    expect(db.getBookEmbedding('b2')).toBeNull();
  });

  it('an exception from the embed operation itself (not a per-book failure) is caught and reported as attempted: false, never thrown', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    // Close the db so the internal getStaleEmbeddings/getTagsForBook calls
    // inside embedBooks throw synchronously — simulating a whole-operation
    // failure (e.g. a DB error) rather than a per-book embed failure.
    db.close();
    databases.splice(databases.indexOf(db), 1);

    const creator = createStubEmbeddingCreator();

    await expect(
      reembedAffectedBooks(db, creator, ['b1'], { model: MODEL, concurrency: 1 })
    ).resolves.toMatchObject({ attempted: false, error: expect.objectContaining({ code: expect.any(String) }) });
  });

  it('composeBookCard hash is what gets stored, confirming the scoped run actually wrote a real card, not a placeholder', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    db.replaceBookTags('b1', [{ tag: 'noir', category: 'genre', confidence: 0.9, source: 'vocab' }], Date.now());

    const creator = createStubEmbeddingCreator();
    await reembedAffectedBooks(db, creator, ['b1'], { model: MODEL, concurrency: 1 });

    const card = composeBookCard(db.getBook('b1')!, db.getTagsForBook('b1'), db.getEntitiesForBook('b1'));
    const stored = db.getBookEmbedding('b1');
    expect(stored?.cardHash).toBe(card.hash);
  });
});
