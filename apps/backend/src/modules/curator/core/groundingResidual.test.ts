import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from './db.js';
import { computeGroundingResidual } from './groundingResidual.js';

const databases: CuratorDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function addBook(
  db: CuratorDb,
  id: string,
  options: { series?: string | null; asin?: string | null; description?: string | null; enriched?: string | null } = {}
): void {
  db.upsertBook({
    id,
    title: `Title ${id}`,
    author: null,
    series: options.series ?? null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: options.description ?? null,
    descriptionEnriched: options.enriched ?? null,
    descriptionSource: options.enriched ? 'googlebooks' : null,
    coverPath: null,
    absAddedAt: null,
    asin: options.asin ?? null,
    lastSyncedAt: 1,
  });
  if (options.enriched) db.setEnrichedDescription(id, { text: options.enriched, source: 'googlebooks' });
}

describe('computeGroundingResidual', () => {
  it('groups only active ungrounded books and measures source-pilot inputs', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, 'grounded', { series: 'Coast', asin: 'A0', description: 'Has evidence' });
    addBook(db, 'a', { series: 'Coast', asin: 'A1', description: 'ABS blurb' });
    addBook(db, 'b', { series: 'Coast', enriched: 'Harvested blurb' });
    addBook(db, 'c', { series: 'Other', asin: 'A3' });
    addBook(db, 'standalone');
    addBook(db, 'deleted', { series: 'Coast', asin: 'A4' });
    db.tombstoneBook('deleted', 2);

    db.replaceBookEntities('grounded', [{ entity: 'Key West', kind: 'place', sources: ['openlibrary'] }]);
    db.upsertExternalMetadata({ bookId: 'a', provider: 'openlibrary', payload: {}, fetchedAt: 1, status: 'ok' });
    db.upsertExternalMetadata({ bookId: 'a', provider: 'wikidata', payload: null, fetchedAt: 1, status: 'not-found' });
    db.upsertExternalMetadata({ bookId: 'b', provider: 'openlibrary', payload: {}, fetchedAt: 1, status: 'ok' });
    db.upsertExternalMetadata({ bookId: 'c', provider: 'openlibrary', payload: null, fetchedAt: 1, status: 'error' });
    db.upsertExternalMetadata({ bookId: 'standalone', provider: 'openlibrary', payload: null, fetchedAt: 1, status: 'not-found' });

    const report = computeGroundingResidual(db, () => 42);

    expect(report).toMatchObject({
      generatedAt: 42,
      totalBooks: 5,
      groundedBooks: 1,
      ungroundedBooks: 4,
      withSeries: 3,
      withoutSeries: 1,
      withAsin: 2,
      withDescription: 2,
      withResolvedMetadata: 2,
    });
    expect(report.providers).toEqual([
      { provider: 'openlibrary', attempted: 4, resolved: 2, notFound: 1, errors: 1 },
      { provider: 'wikidata', attempted: 1, resolved: 0, notFound: 1, errors: 0 },
    ]);
    expect(report.series).toEqual([
      {
        series: 'Coast',
        books: 2,
        withAsin: 1,
        withDescription: 2,
        resolvedByProvider: { openlibrary: 2 },
      },
      {
        series: 'Other',
        books: 1,
        withAsin: 1,
        withDescription: 0,
        resolvedByProvider: {},
      },
    ]);
  });

  it('keeps a time-only entity in the character/place residual', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, 'time-only', { series: 'Historical Mysteries' });
    db.replaceBookEntities('time-only', [{ entity: '1958', kind: 'time', sources: ['openlibrary'] }]);
    db.upsertExternalMetadata({ bookId: 'time-only', provider: 'openlibrary', payload: {}, fetchedAt: 1, status: 'ok' });

    const report = computeGroundingResidual(db, () => 42);

    expect(report).toMatchObject({
      totalBooks: 1,
      groundedBooks: 0,
      ungroundedBooks: 1,
      withSeries: 1,
      withResolvedMetadata: 1,
      providers: [{ provider: 'openlibrary', attempted: 1, resolved: 1, notFound: 0, errors: 0 }],
    });
    expect(report.series[0]).toMatchObject({
      series: 'Historical Mysteries',
      books: 1,
      resolvedByProvider: { openlibrary: 1 },
    });
  });
});
