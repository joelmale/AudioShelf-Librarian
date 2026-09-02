import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../db.js';
import { rederiveFromCache } from './rederive.js';
import { createHardcoverProvider } from './providers/hardcover.js';
import type { EnrichmentPayload, EnrichmentProvider } from './types.js';

const databases: CuratorDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function makeDb(bookCount = 2): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  for (let i = 0; i < bookCount; i += 1) {
    db.upsertBook({
      id: `b0${i}`,
      title: `Book ${i}`,
      author: 'An Author',
      series: null,
      seriesSequence: null,
      durationSeconds: null,
      publishedYear: null,
      genres: [],
      description: null,
      coverPath: null,
      absAddedAt: null,
      lastSyncedAt: 0,
    });
  }
  return db;
}

/** Provider whose rederive splits on commas — stands in for the real subject fix. */
function splittingProvider(name = 'p'): EnrichmentProvider {
  return {
    name,
    lookup: async () => null,
    rederive(raw: unknown) {
      const cats = (raw as { categories?: string[] } | null)?.categories ?? [];
      return { entities: [], subjects: cats.flatMap((c) => c.split(',').map((t) => t.trim())) };
    },
  };
}

function payload(categories: string[], subjects: string[]): EnrichmentPayload {
  return { raw: { categories }, entities: [], subjects };
}

describe('rederiveFromCache', () => {
  it('recomputes subjects from cached raw and reports the change', async () => {
    const db = makeDb(1);
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'p',
      payload: payload(['Fiction, Horror'], ['Fiction, Horror']),
      fetchedAt: 1_000,
      status: 'ok',
    });

    const result = await rederiveFromCache(db, [splittingProvider()], { now: () => 5_000 });

    expect(result.rowsChanged).toBe(1);
    expect(result.byProvider.p).toEqual({ scanned: 1, changed: 1 });
    const row = db.getExternalMetadata('b00')[0];
    expect((row.payload as EnrichmentPayload).subjects).toEqual(['Fiction', 'Horror']);
  });

  it('NEVER advances fetched_at — re-deriving is not re-fetching', async () => {
    const db = makeDb(1);
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'p',
      payload: payload(['Fiction, Horror'], ['stale']),
      fetchedAt: 1_000,
      status: 'ok',
    });

    await rederiveFromCache(db, [splittingProvider()], { now: () => 9_999_999 });

    // Advancing this would silently extend the row's cache TTL, making a
    // library look freshly enriched when nothing was actually checked.
    expect(db.getExternalMetadata('b00')[0].fetchedAt).toBe(1_000);
  });

  it('preserves `raw` byte-for-byte', async () => {
    const db = makeDb(1);
    const raw = { categories: ['Fiction, Horror'], extra: { nested: [1, 2, 3] } };
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'p',
      payload: { raw, entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });

    await rederiveFromCache(db, [splittingProvider()], {});

    expect((db.getExternalMetadata('b00')[0].payload as EnrichmentPayload).raw).toEqual(raw);
  });

  it('makes no writes on a dry run but still reports what would change', async () => {
    const db = makeDb(1);
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'p',
      payload: payload(['Fiction, Horror'], ['Fiction, Horror']),
      fetchedAt: 1_000,
      status: 'ok',
    });

    const result = await rederiveFromCache(db, [splittingProvider()], { dryRun: true });

    expect(result.rowsChanged).toBe(1);
    expect(result.examples[0]).toMatchObject({
      provider: 'p',
      subjectsBefore: ['Fiction, Horror'],
      subjectsAfter: ['Fiction', 'Horror'],
    });
    expect((db.getExternalMetadata('b00')[0].payload as EnrichmentPayload).subjects).toEqual(['Fiction, Horror']);
  });

  it('counts an unchanged row as scanned but not changed', async () => {
    const db = makeDb(1);
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'p',
      payload: payload(['Fiction'], ['Fiction']),
      fetchedAt: 1_000,
      status: 'ok',
    });

    const result = await rederiveFromCache(db, [splittingProvider()], {});
    expect(result.rowsScanned).toBe(1);
    expect(result.rowsChanged).toBe(0);
  });

  it('skips providers with no rederive, and reports them as unsupported', async () => {
    const db = makeDb(1);
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'legacy',
      payload: payload(['Fiction, Horror'], ['Fiction, Horror']),
      fetchedAt: 1_000,
      status: 'ok',
    });

    const noRederive: EnrichmentProvider = { name: 'legacy', lookup: async () => null };
    const result = await rederiveFromCache(db, [noRederive], {});

    expect(result.rowsUnsupported).toBe(1);
    expect(result.rowsChanged).toBe(0);
    expect((db.getExternalMetadata('b00')[0].payload as EnrichmentPayload).subjects).toEqual(['Fiction, Horror']);
  });

  it('leaves a hardcover row alone — its verified hit is not recoverable from raw', async () => {
    // Regression: hardcover used to expose a `rederive` that recomputed
    // subjects from `hits[0]`, which is UNVERIFIED search output. On a row
    // whose real match was a later hit, a re-derive silently replaced the
    // verified subjects with an unrelated book's — and `hardcoverFacets` then
    // read that back as the uniquely-matching hit, promoting the wrong book's
    // moods with full confidence. The provider now exposes no rederive hook.
    const db = makeDb(1);
    const verified = ['Horror', 'dark'];
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'hardcover',
      payload: {
        raw: { data: { search: { results: { hits: [
          { document: { title: 'A Totally Different Book', genres: ['Comedy'], moods: ['funny'] } },
          { document: { title: 'Book 0', genres: ['Horror'], moods: ['dark'] } },
        ] } } } },
        entities: [],
        subjects: verified,
      },
      fetchedAt: 1000,
      status: 'ok',
    });

    const hardcover = createHardcoverProvider({ token: 't' })!;
    const result = await rederiveFromCache(db, [hardcover]);

    // The outcome first: the verified hit's subjects survived the run. This is
    // the assertion that fails if the hits[0] rederive ever comes back.
    const [row] = db.getExternalMetadata('b00');
    expect((row.payload as EnrichmentPayload).subjects).toEqual(verified);
    expect(result.rowsChanged).toBe(0);
    expect(result.rowsUnsupported).toBe(1);
  });

  it('ignores not-found and error rows, which carry no payload to re-derive', async () => {
    const db = makeDb(1);
    db.upsertExternalMetadata({ bookId: 'b00', provider: 'p', payload: null, fetchedAt: 1_000, status: 'not-found' });

    const result = await rederiveFromCache(db, [splittingProvider()], {});
    expect(result.rowsScanned).toBe(0);
    expect(result.rowsChanged).toBe(0);
  });

  it('never fetches — the signature has no fetchImpl and nothing calls out', async () => {
    const db = makeDb(1);
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'p',
      payload: payload(['Fiction, Horror'], ['x']),
      fetchedAt: 1_000,
      status: 'ok',
    });
    const globalFetch = vi.spyOn(globalThis, 'fetch');

    await rederiveFromCache(db, [splittingProvider()], {});

    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('honours bookIds and leaves other books untouched', async () => {
    const db = makeDb(2);
    for (const id of ['b00', 'b01']) {
      db.upsertExternalMetadata({
        bookId: id,
        provider: 'p',
        payload: payload(['Fiction, Horror'], ['Fiction, Horror']),
        fetchedAt: 1_000,
        status: 'ok',
      });
    }

    const result = await rederiveFromCache(db, [splittingProvider()], { bookIds: ['b00'] });

    expect(result.booksScanned).toBe(1);
    expect((db.getExternalMetadata('b01')[0].payload as EnrichmentPayload).subjects).toEqual(['Fiction, Horror']);
  });

  it('isolates a failing book and keeps going', async () => {
    const db = makeDb(2);
    for (const id of ['b00', 'b01']) {
      db.upsertExternalMetadata({
        bookId: id,
        provider: 'p',
        payload: payload(['Fiction, Horror'], ['x']),
        fetchedAt: 1_000,
        status: 'ok',
      });
    }
    let calls = 0;
    const flaky: EnrichmentProvider = {
      name: 'p',
      lookup: async () => null,
      rederive(raw: unknown) {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        const cats = (raw as { categories?: string[] }).categories ?? [];
        return { entities: [], subjects: cats.flatMap((c) => c.split(',').map((t) => t.trim())) };
      },
    };

    const result = await rederiveFromCache(db, [flaky], {});

    expect(result.failed).toBe(1);
    expect(result.rowsChanged).toBe(1);
    expect(result.booksScanned).toBe(2);
  });

  // R2 wiring: the entity rebuild after a change scores notability against
  // the RESOLVED (ABS-or-harvested) description, not `book.description`
  // directly — see `enrichment/descriptionText.ts#resolveDescription`.
  it('scores entity notability against a harvested description when ABS has none', async () => {
    const db = makeDb(1);
    db.setEnrichedDescription('b00', { text: 'A story about Anna Pigeon in the Dry Tortugas.', source: 'audnexus' });

    // A provider whose rederive() emits entities — above SMALL_LIST (12) so
    // they are actually scored rather than trusted wholesale.
    const entityProvider: EnrichmentProvider = {
      name: 'p',
      lookup: async () => null,
      rederive() {
        return {
          entities: [
            { entity: 'Anna Pigeon', kind: 'person' },
            ...Array.from({ length: 12 }, (_, i) => ({ entity: `Filler Person ${i}`, kind: 'person' as const })),
          ],
          subjects: ['new-subject'],
        };
      },
    };
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'p',
      payload: { raw: {}, entities: [], subjects: ['old-subject'] },
      fetchedAt: 1_000,
      status: 'ok',
    });

    await rederiveFromCache(db, [entityProvider], {});

    const stored = db.getEntitiesForBook('b00');
    expect(stored.find((e) => e.entity === 'Anna Pigeon')?.notable).toBe(true);
  });
});
