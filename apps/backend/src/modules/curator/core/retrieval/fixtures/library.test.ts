import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../../db.js';
import { REQUIRED_TAG_CATEGORIES } from '../../types.js';
import { FIXTURE_BOOKS, FIXTURE_NOW, fixtureBook, seedFixtureLibrary } from './library.js';

const databases: CuratorDb[] = [];

function freshDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

function firstTag(db: CuratorDb) {
  const tags = db.getTagsForBook('fx-01');
  const tag = tags[0];
  if (!tag) throw new Error('expected fx-01 to have tags');
  return tag;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('FIXTURE_BOOKS', () => {
  it('exports exactly 30 books with unique ids', () => {
    expect(FIXTURE_BOOKS).toHaveLength(30);
    const ids = new Set(FIXTURE_BOOKS.map((b) => b.id));
    expect(ids.size).toBe(30);
  });

  it('gives every book the required tag categories', () => {
    for (const book of FIXTURE_BOOKS) {
      const categories = new Set(book.tags.map((t) => t.category));
      for (const required of REQUIRED_TAG_CATEGORIES) {
        expect(categories.has(required), `${book.id} is missing required category '${required}'`).toBe(true);
      }
    }
  });

  it('fixtureBook throws on an unknown id', () => {
    expect(() => fixtureBook('fx-99')).toThrow(/unknown fixture book id/i);
  });

  it('fixtureBook returns the matching book for a known id', () => {
    expect(fixtureBook('fx-01').title).toBe('The Lighthouse at Bell Harbor');
  });
});

describe('seedFixtureLibrary', () => {
  it('seeds books, tags and entities into a fresh database', () => {
    const db = freshDb();
    seedFixtureLibrary(db);

    expect(db.countBooks()).toBe(30);

    const expected = fixtureBook('fx-01');
    const tags = db.getTagsForBook('fx-01');
    expect(tags).toHaveLength(expected.tags.length);
    for (const expectedTag of expected.tags) {
      const actual = tags.find((t) => t.tag === expectedTag.tag);
      expect(actual, `missing tag '${expectedTag.tag}' on fx-01`).toBeDefined();
      expect(actual?.category).toBe(expectedTag.category);
      expect(actual?.confidence).toBe(expectedTag.confidence);
      expect(actual?.source).toBe(expectedTag.source);
    }

    const entities = db.getEntitiesForBook('fx-01');
    expect(entities).toHaveLength(expected.entities.length);
    for (const expectedEntity of expected.entities) {
      const actual = entities.find((e) => e.entity === expectedEntity.entity);
      expect(actual, `missing entity '${expectedEntity.entity}' on fx-01`).toBeDefined();
      expect(actual?.kind).toBe(expectedEntity.kind);
      expect(actual?.sources).toEqual(expectedEntity.sources);
    }
  });

  it('is idempotent — seeding twice leaves 30 books and no duplicate tags', () => {
    const db = freshDb();
    seedFixtureLibrary(db);
    seedFixtureLibrary(db);

    expect(db.countBooks()).toBe(30);
    for (const book of FIXTURE_BOOKS) {
      const tags = db.getTagsForBook(book.id);
      expect(tags).toHaveLength(book.tags.length);
      const entities = db.getEntitiesForBook(book.id);
      expect(entities).toHaveLength(book.entities.length);
    }
  });

  it('pairs an llm-open-only tag against a trusted instance of the same tag', () => {
    const db = freshDb();
    seedFixtureLibrary(db);

    const untrusted = db.getTagsForBook('fx-07').find((t) => t.tag === 'time-travel');
    expect(untrusted?.source).toBe('llm-open');

    const trusted = db.getTagsForBook('fx-11').find((t) => t.tag === 'time-travel');
    expect(trusted?.source).toBe('vocab');

    // The other two llm-open-only tags documented at the top of library.ts.
    const fx08 = db.getTagsForBook('fx-08').find((t) => t.tag === 'unreliable-narrator');
    expect(fx08?.source).toBe('llm-open');
    const fx09 = db.getTagsForBook('fx-09').find((t) => t.tag === 'anti-hero');
    expect(fx09?.source).toBe('llm-open');
  });

  it('places at least four books at the Bell Harbor entity', () => {
    const db = freshDb();
    seedFixtureLibrary(db);

    const booksAtBellHarbor = FIXTURE_BOOKS.filter((book) =>
      db.getEntitiesForBook(book.id).some((e) => e.entity === 'Bell Harbor')
    );
    expect(booksAtBellHarbor.length).toBeGreaterThanOrEqual(4);
  });

  it('uses a fixed timestamp so seeding is reproducible', () => {
    const dbA = freshDb();
    const dbB = freshDb();
    seedFixtureLibrary(dbA);
    seedFixtureLibrary(dbB);

    const tagA = firstTag(dbA);
    const tagB = firstTag(dbB);
    expect(tagA.taggedAt).toBe(FIXTURE_NOW);
    expect(tagB.taggedAt).toBe(FIXTURE_NOW);
    expect(tagA.taggedAt).toBe(tagB.taggedAt);
  });
});
