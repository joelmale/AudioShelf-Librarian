import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../db.js';
import { AppError, OperationCancelledError } from '../errors.js';
import type { OperationController } from '../operations.js';
import type { Book } from '../types.js';
import { enrichBooks } from './enricher.js';
import { markRateLimited } from './providers/throttle.js';
import type { EnrichedEntity, EnrichmentPayload, EnrichmentProvider } from './types.js';

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

function payload(entities: EnrichedEntity[] = [], subjects: string[] = []): EnrichmentPayload {
  return { raw: { entities, subjects }, entities, subjects };
}

/** A stub provider whose `lookup` is a spy, so tests can assert call counts. */
function stubProvider(
  name: string,
  impl: (book: Book) => Promise<EnrichmentPayload | null>
): EnrichmentProvider {
  return { name, lookup: vi.fn(async (book: Book, _fetchImpl: typeof fetch) => impl(book)) };
}

const noNetworkFetch = vi.fn() as unknown as typeof fetch;

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe('enrichBooks', () => {
  it('happy path: unions entities across providers case-insensitively, merges sorted sources, counts entitiesWritten', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    const providerA = stubProvider('providerA', async () => payload([{ entity: 'Alice', kind: 'person' }]));
    const providerB = stubProvider('providerB', async () =>
      payload([
        { entity: 'alice', kind: 'person' }, // case-insensitive dupe of providerA's "Alice"
        { entity: 'Derry', kind: 'place' },
      ])
    );

    const result = await enrichBooks(db, [providerA, providerB], {
      concurrency: 2,
      now: () => 1_000,
      fetchImpl: noNetworkFetch,
    });

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.entitiesWritten).toBe(2);
    expect(result.providerStats.providerA).toEqual({ fetched: 1, ok: 1, notFound: 0, errors: 0, throttled: 0 });
    expect(result.providerStats.providerB).toEqual({ fetched: 1, ok: 1, notFound: 0, errors: 0, throttled: 0 });

    const rows = db.getExternalMetadata('b1');
    expect(rows).toHaveLength(2);
    const rowA = rows.find((r) => r.provider === 'providerA');
    expect(rowA?.status).toBe('ok');
    // The FULL EnrichmentPayload is stored (raw/entities/subjects), not the bare provider response.
    expect(rowA?.payload).toEqual(payload([{ entity: 'Alice', kind: 'person' }]));

    const entities = db.getEntitiesForBook('b1');
    expect(entities).toHaveLength(2);
    expect(entities.find((e) => e.entity === 'Alice')).toMatchObject({
      kind: 'person',
      sources: ['providerA', 'providerB'], // merged, sorted; first-seen surface form "Alice" wins over "alice"
    });
    expect(entities.find((e) => e.entity === 'Derry')).toMatchObject({ kind: 'place', sources: ['providerB'] });
  });

  it('a rate-limit writes NO row, is counted apart from errors, and lets the run continue', async () => {
    // A throttle is a fact about our request rate, not about the book. Writing
    // 'error' would leave a row claiming we asked and were refused, and would
    // report our own pacing as the provider's failure rate — on a live run
    // that rendered Wikidata as "20 errors / 39" when it had never actually
    // been asked about most of them.
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    const healthy = stubProvider('healthy', async () => payload([{ entity: 'Alice', kind: 'person' }]));
    const throttling: EnrichmentProvider = {
      name: 'throttling',
      lookup: vi.fn(async () => {
        throw markRateLimited(new AppError('INTERNAL', 'Wikimedia is throttling us (HTTP 429)'));
      }),
    };

    const result = await enrichBooks(db, [healthy, throttling], {
      concurrency: 1,
      now: () => 2_000,
      fetchImpl: noNetworkFetch,
    });

    // The run does NOT stop, unlike a daily quota: a throttle is transient and
    // the provider's own limiter has already spaced every caller out.
    expect(result.processed).toBe(2);
    expect(result.quotaStopped).toBeUndefined();

    expect(result.providerStats.throttling).toEqual({ fetched: 0, ok: 0, notFound: 0, errors: 0, throttled: 2 });
    expect(result.providerStats.healthy).toEqual({ fetched: 2, ok: 2, notFound: 0, errors: 0, throttled: 0 });

    for (const id of ['b1', 'b2']) {
      // No row at all — the book stays a candidate for the next run.
      expect(db.getExternalMetadataForProvider(id, 'throttling')).toBeNull();
      expect(db.getExternalMetadataForProvider(id, 'healthy')?.status).toBe('ok');
    }

    // Nothing fetched means the hit rate is unknown, not zero.
    expect(result.qualityReport?.providers.throttling?.hitRate).toBeNull();
  });


  it('one provider throwing records a status "error" row but the other provider\'s result still lands, and the run continues to the next book', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    const providerA = stubProvider('providerA', async () => payload([{ entity: 'Alice', kind: 'person' }]));
    const providerB: EnrichmentProvider = {
      name: 'providerB',
      lookup: vi.fn(async () => {
        throw new AppError('INTERNAL', 'boom');
      }),
    };

    const result = await enrichBooks(db, [providerA, providerB], {
      concurrency: 1,
      now: () => 2_000,
      fetchImpl: noNetworkFetch,
    });

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.providerStats.providerA).toEqual({ fetched: 2, ok: 2, notFound: 0, errors: 0, throttled: 0 });
    expect(result.providerStats.providerB).toEqual({ fetched: 2, ok: 0, notFound: 0, errors: 2, throttled: 0 });

    for (const id of ['b1', 'b2']) {
      const rowA = db.getExternalMetadataForProvider(id, 'providerA');
      const rowB = db.getExternalMetadataForProvider(id, 'providerB');
      expect(rowA?.status).toBe('ok');
      expect(rowB).toMatchObject({ status: 'error', payload: null });

      // The failed provider dropped nothing of the surviving provider's data.
      expect(db.getEntitiesForBook(id)).toEqual([
        { bookId: id, entity: 'Alice', kind: 'person', sources: ['providerA'], notable: true },
      ]);
    }
  });

  it('caches a null lookup as status "not-found" with a null payload and writes no entities', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    const provider = stubProvider('providerA', async () => null);

    const result = await enrichBooks(db, [provider], {
      concurrency: 1,
      now: () => 3_000,
      fetchImpl: noNetworkFetch,
    });

    expect(result.processed).toBe(1);
    expect(result.entitiesWritten).toBe(0);
    expect(result.providerStats.providerA).toEqual({ fetched: 1, ok: 0, notFound: 1, errors: 0, throttled: 0 });

    const rec = db.getExternalMetadataForProvider('b1', 'providerA');
    expect(rec).toMatchObject({ status: 'not-found', payload: null, fetchedAt: 3000 });
    expect(db.getEntitiesForBook('b1')).toEqual([]);
  });

  it('skips a book whose cached "ok" row is still fresh (within OK_TTL_MS), never calling lookup', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    const NOW = 1_000_000;
    db.upsertExternalMetadata({
      bookId: 'b1',
      provider: 'providerA',
      payload: payload(),
      fetchedAt: NOW - 1_000,
      status: 'ok',
    });

    const provider = stubProvider('providerA', async () => payload([{ entity: 'Should Not Appear', kind: 'person' }]));

    const result = await enrichBooks(db, [provider], {
      concurrency: 1,
      now: () => NOW,
      fetchImpl: noNetworkFetch,
    });

    expect(provider.lookup).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(result.entitiesWritten).toBe(0);
  });

  it('dry run reports the plan (bookId, title, due providers) without calling any provider', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    const providerA = stubProvider('providerA', async () => payload());
    const providerB = stubProvider('providerB', async () => payload());

    const result = await enrichBooks(db, [providerA, providerB], {
      dryRun: true,
      concurrency: 2,
      now: () => 4_000,
      fetchImpl: noNetworkFetch,
    });

    expect(result.dryRun).toBe(true);
    expect(result.plan).toHaveLength(2);
    const entryB1 = result.plan?.find((p) => p.bookId === 'b1');
    expect(entryB1?.title).toBe('Book One');
    expect(entryB1?.providers.slice().sort()).toEqual(['providerA', 'providerB']);
    expect(providerA.lookup).not.toHaveBeenCalled();
    expect(providerB.lookup).not.toHaveBeenCalled();
  });

  it('stops after cancellation, leaving the already-processed book intact and skipping the rest', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    const provider = stubProvider('providerA', async () => payload([{ entity: 'Alice', kind: 'person' }]));

    // Minimal fake controller satisfying the surface enrichBooks actually calls:
    // checkpoint/setProgress/markCompleted/markCancelled/id (see core/operations.ts).
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

    const result = await enrichBooks(db, [provider], {
      concurrency: 1, // deterministic ordering: book1 then book2
      now: () => 5_000,
      fetchImpl: noNetworkFetch,
      controller: fakeController as unknown as OperationController,
    });

    expect(result.cancelled).toBe(true);
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(provider.lookup).toHaveBeenCalledTimes(1);
    expect(fakeController.markCancelled).toHaveBeenCalledTimes(1);
    expect(fakeController.markCompleted).not.toHaveBeenCalled();
  });
});

describe('enrichBooks sample mode + quality report', () => {
  function addBooks(db: CuratorDb, count: number): void {
    for (let i = 0; i < count; i += 1) {
      addBook(db, { id: `b${String(i).padStart(2, '0')}`, title: `Book ${String(i).padStart(2, '0')}` });
    }
  }

  it('sample: true over ~30 fixture books runs max(20, 5%) = 20 of them', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBooks(db, 30);

    const provider = stubProvider('providerA', async () => payload());

    const result = await enrichBooks(db, [provider], {
      sample: true,
      concurrency: 5,
      now: () => 10_000,
      fetchImpl: noNetworkFetch,
    });

    expect(result.sample).toBe(true);
    expect(result.processed).toBe(20);
    expect(provider.lookup).toHaveBeenCalledTimes(20);
    expect(result.qualityReport?.sampled).toBe(20);
    expect(result.qualityReport?.candidatesTotal).toBe(30);
  });

  it('sampleSize override is honored even without sample: true', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBooks(db, 30);

    const provider = stubProvider('providerA', async () => payload());

    const result = await enrichBooks(db, [provider], {
      sampleSize: 5,
      concurrency: 5,
      now: () => 11_000,
      fetchImpl: noNetworkFetch,
    });

    expect(result.sample).toBe(true);
    expect(result.processed).toBe(5);
    expect(provider.lookup).toHaveBeenCalledTimes(5);
    expect(result.qualityReport?.sampled).toBe(5);
    expect(result.qualityReport?.candidatesTotal).toBe(30);
  });

  it('qualityReport.providers hitRate: one provider ok for every book, one not-found for every book', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBooks(db, 3);

    const providerA = stubProvider('providerA', async () => payload([{ entity: 'Alice', kind: 'person' }]));
    const providerB = stubProvider('providerB', async () => null);

    const result = await enrichBooks(db, [providerA, providerB], {
      concurrency: 3,
      now: () => 12_000,
      fetchImpl: noNetworkFetch,
    });

    expect(result.qualityReport?.providers.providerA).toEqual({ fetched: 3, ok: 3, notFound: 0, errors: 0, throttled: 0, hitRate: 1 });
    expect(result.qualityReport?.providers.providerB).toEqual({ fetched: 3, ok: 0, notFound: 3, errors: 0, throttled: 0, hitRate: 0 });
  });

  it('qualityReport.entityCoverage counts books with and without grounded entities', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBooks(db, 3);

    // b00 and b01 get an entity from the provider; b02 gets nothing (not-found).
    const provider = stubProvider('providerA', async (book) =>
      book.id === 'b02' ? null : payload([{ entity: 'Alice', kind: 'person' }])
    );

    const result = await enrichBooks(db, [provider], {
      concurrency: 3,
      now: () => 13_000,
      fetchImpl: noNetworkFetch,
    });

    expect(result.qualityReport?.entityCoverage).toEqual({
      withEntities: 2,
      withoutEntities: 1,
      avgEntitiesPerBook: 2 / 3,
      // A single-entity list is under SMALL_LIST, so it is trusted wholesale
      // and both books' entities are notable.
      withNotableEntities: 2,
      avgNotablePerBook: 2 / 3,
    });
  });

  it('qualityReport.examples is capped at 10 books, each with entities capped at 8', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBooks(db, 12);

    // 9 distinct entities per book, so the per-book rebuild writes 9 but the
    // example view must cap at 8.
    const nineEntities: EnrichedEntity[] = Array.from({ length: 9 }, (_, i) => ({
      entity: `Person ${i}`,
      kind: 'person' as const,
    }));
    const provider = stubProvider('providerA', async () => payload(nineEntities, ['adventure', 'fantasy']));

    const result = await enrichBooks(db, [provider], {
      concurrency: 4,
      now: () => 14_000,
      fetchImpl: noNetworkFetch,
    });

    expect(result.processed).toBe(12);
    const examples = result.qualityReport?.examples ?? [];
    expect(examples).toHaveLength(10);
    for (const example of examples) {
      expect(example.entities.length).toBeLessThanOrEqual(8);
      expect(example.entities).toHaveLength(8);
      expect(example.subjects).toEqual(['adventure', 'fantasy']);
      expect(example.providers).toEqual({ providerA: 'ok' });
    }
  });

  it('a full run (no sample flag) still produces a qualityReport, with `sample` left unset', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    const provider = stubProvider('providerA', async () => payload([{ entity: 'Alice', kind: 'person' }]));

    const result = await enrichBooks(db, [provider], {
      concurrency: 1,
      now: () => 15_000,
      fetchImpl: noNetworkFetch,
    });

    expect(result.sample).toBeFalsy();
    expect(result.qualityReport).toBeDefined();
    expect(result.qualityReport?.sampled).toBe(1);
    expect(result.qualityReport?.candidatesTotal).toBe(1);
  });
});
