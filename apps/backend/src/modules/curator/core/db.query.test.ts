import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CuratorDb } from './db.js';
import type { TagFilter } from './db.js';
import { FIXTURE_BOOKS, seedFixtureLibrary } from './retrieval/fixtures/library.js';

const tempDirs: string[] = [];
let db: CuratorDb;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-db-query-'));
  tempDirs.push(dir);
  db = new CuratorDb(path.join(dir, 'test.db'));
  seedFixtureLibrary(db);
});

afterEach(() => {
  db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function ids(books: { id: string }[]): Set<string> {
  return new Set(books.map((b) => b.id));
}

/** Fixture books carrying every tag in `tags` (AND), derived from FIXTURE_BOOKS
 *  rather than hard-coded, so the expectation tracks the fixture data. */
function fixtureIdsWithAllTags(tags: TagFilter[]): Set<string> {
  return new Set(
    FIXTURE_BOOKS.filter((b) =>
      tags.every((f) =>
        b.tags.some(
          (t) =>
            t.tag === f.tag &&
            (!f.category || t.category === f.category) &&
            (f.minConfidence === undefined || t.confidence >= f.minConfidence)
        )
      )
    ).map((b) => b.id)
  );
}

describe('queryBooks — backwards compatibility', () => {
  it('with no filters, returns all 30 fixture books ordered by title with correct paging defaults', () => {
    const result = db.queryBooks({});
    expect(result.total).toBe(30);
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
    expect(result.books).toHaveLength(30);
    const expectedTitles = FIXTURE_BOOKS.map((b) => b.title)
      .slice()
      .sort();
    expect(result.books.map((b) => b.title)).toEqual(expectedTitles);
  });

  it('search still matches title/author substrings', () => {
    const result = db.queryBooks({ search: 'Kestrel', limit: 100 });
    expect(ids(result.books)).toEqual(new Set(['fx-24', 'fx-25', 'fx-26']));
  });

  it('author still matches an author substring', () => {
    const result = db.queryBooks({ author: 'Nadia Petrov', limit: 100 });
    expect(ids(result.books)).toEqual(new Set(['fx-24', 'fx-25', 'fx-26']));
  });

  it('tag still matches an exact tag', () => {
    const result = db.queryBooks({ tag: 'coastal-town', limit: 100 });
    expect(ids(result.books)).toEqual(new Set(['fx-01', 'fx-02', 'fx-03', 'fx-25']));
  });

  it('category still matches any tag in that category', () => {
    const result = db.queryBooks({ category: 'structure', limit: 100 });
    expect(ids(result.books)).toEqual(new Set(['fx-08', 'fx-10', 'fx-13', 'fx-20']));
  });

  it('minConfidence still narrows a tag filter', () => {
    const result = db.queryBooks({ tag: 'melancholic', minConfidence: 0.95, limit: 100 });
    // fx-01 carries melancholic at 0.97, fx-02 at 0.9 — only fx-01 clears the bar.
    expect(ids(result.books)).toEqual(new Set(['fx-01']));
  });

  it('untagged still finds books with no tags (none in this fully-tagged fixture)', () => {
    const result = db.queryBooks({ untagged: true });
    expect(result.books).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe('queryBooks — allTags (AND)', () => {
  it('returns exactly the fixture books carrying every listed tag', () => {
    const tags: TagFilter[] = [
      { tag: 'melancholic', category: 'mood' },
      { tag: 'coastal-town', category: 'setting' },
    ];
    const expected = fixtureIdsWithAllTags(tags);
    const result = db.queryBooks({ allTags: tags, limit: 100 });
    expect(ids(result.books)).toEqual(expected);
    expect(expected.has('fx-01')).toBe(true);
    expect(expected.has('fx-03')).toBe(false); // fx-03 lacks melancholic
  });
});

describe('queryBooks — anyTags (OR)', () => {
  it('returns the union, a strict superset of the equivalent allTags result', () => {
    const tags: TagFilter[] = [
      { tag: 'melancholic', category: 'mood' },
      { tag: 'coastal-town', category: 'setting' },
    ];
    const allResult = ids(db.queryBooks({ allTags: tags, limit: 100 }).books);
    const anyResult = ids(db.queryBooks({ anyTags: tags, limit: 100 }).books);
    for (const id of allResult) expect(anyResult.has(id)).toBe(true);
    expect(anyResult.size).toBeGreaterThan(allResult.size);
  });
});

describe('queryBooks — empty filter arrays are no-ops', () => {
  it('empty anyTags returns all 30', () => {
    expect(db.queryBooks({ anyTags: [] }).total).toBe(30);
  });

  it('empty excludeTags returns all 30', () => {
    expect(db.queryBooks({ excludeTags: [] }).total).toBe(30);
  });

  it('empty allTags returns all 30', () => {
    expect(db.queryBooks({ allTags: [] }).total).toBe(30);
  });

  it('empty allEntities returns all 30', () => {
    expect(db.queryBooks({ allEntities: [] }).total).toBe(30);
  });

  it('empty anyEntities returns all 30', () => {
    expect(db.queryBooks({ anyEntities: [] }).total).toBe(30);
  });
});

describe('queryBooks — excludeTags ignores trustedOnly (safety invariant)', () => {
  // Exclusions consider every tag regardless of provenance: an unverified
  // llm-open tag is weak evidence FOR a book and sufficient evidence AGAINST
  // one. Under-excluding violates a constraint the reader stated outright;
  // over-excluding merely costs them a candidate. See plan §5.4 rule 2.
  it('time-travel: both the vocab-sourced fx-11 and the llm-open-only fx-07 are excluded, with or without trustedOnly', () => {
    const trusted = db.queryBooks({ excludeTags: [{ tag: 'time-travel' }], trustedOnly: true, limit: 100 });
    expect(ids(trusted.books).has('fx-11')).toBe(false);
    expect(ids(trusted.books).has('fx-07')).toBe(false);

    const untrusted = db.queryBooks({ excludeTags: [{ tag: 'time-travel' }], limit: 100 });
    expect(ids(untrusted.books).has('fx-11')).toBe(false);
    expect(ids(untrusted.books).has('fx-07')).toBe(false);
  });

  it('unreliable-narrator: fx-08 is dropped even though its only tag instance is llm-open', () => {
    const trusted = db.queryBooks({
      excludeTags: [{ tag: 'unreliable-narrator' }],
      trustedOnly: true,
      limit: 100,
    });
    expect(ids(trusted.books).has('fx-08')).toBe(false);

    const untrusted = db.queryBooks({ excludeTags: [{ tag: 'unreliable-narrator' }], limit: 100 });
    expect(ids(untrusted.books).has('fx-08')).toBe(false);
  });

  it('trustedOnly still narrows INCLUSION filters in the same query — the asymmetry is intentional', () => {
    // fx-07's time-travel tag is llm-open only: excluded by excludeTags above,
    // and also not matched by an inclusion filter under trustedOnly.
    const included = db.queryBooks({ allTags: [{ tag: 'time-travel' }], trustedOnly: true, limit: 100 });
    expect(ids(included.books).has('fx-11')).toBe(true);
    expect(ids(included.books).has('fx-07')).toBe(false);
  });
});

describe('queryBooks — trustedOnly on inclusion filters', () => {
  it('allTags time-travel with trustedOnly returns fx-11 but not fx-07; without it, returns both', () => {
    const trusted = db.queryBooks({ allTags: [{ tag: 'time-travel' }], trustedOnly: true, limit: 100 });
    expect(ids(trusted.books)).toEqual(new Set(['fx-11']));

    const untrusted = db.queryBooks({ allTags: [{ tag: 'time-travel' }], limit: 100 });
    expect(ids(untrusted.books)).toEqual(new Set(['fx-07', 'fx-11']));
  });
});

describe('queryBooks — TagFilter.minConfidence', () => {
  it('a high threshold drops a lower-confidence carrier of the same tag', () => {
    // fx-01 carries melancholic at 0.97, fx-02 at 0.9.
    const result = db.queryBooks({ allTags: [{ tag: 'melancholic', minConfidence: 0.95 }], limit: 100 });
    expect(ids(result.books)).toEqual(new Set(['fx-01']));
  });
});

describe('queryBooks — entity filters', () => {
  it('anyEntities matches the four books carrying the Bell Harbor place entity', () => {
    const result = db.queryBooks({ anyEntities: [{ entity: 'Bell Harbor', kind: 'place' }], limit: 100 });
    expect(ids(result.books)).toEqual(new Set(['fx-01', 'fx-02', 'fx-03', 'fx-25']));
  });

  it('entity matching is case-insensitive', () => {
    const result = db.queryBooks({ anyEntities: [{ entity: 'bell harbor' }], limit: 100 });
    expect(ids(result.books)).toEqual(new Set(['fx-01', 'fx-02', 'fx-03', 'fx-25']));
  });

  it('allEntities intersects two entities that co-occur on exactly one book', () => {
    const result = db.queryBooks({
      allEntities: [{ entity: 'Bell Harbor' }, { entity: 'Maine' }],
      limit: 100,
    });
    expect(ids(result.books)).toEqual(new Set(['fx-01']));
  });

  it('a wrong kind returns no matches', () => {
    const result = db.queryBooks({ anyEntities: [{ entity: 'Bell Harbor', kind: 'person' }], limit: 100 });
    expect(result.books).toHaveLength(0);
  });
});

describe('queryBooks — composition', () => {
  it('tags AND entities AND excludeTags intersect correctly, and total matches under the limit', () => {
    const result = db.queryBooks({
      allTags: [{ tag: 'coastal-town' }],
      anyEntities: [{ entity: 'Bell Harbor' }],
      excludeTags: [{ tag: 'autumn' }],
      limit: 100,
    });
    // coastal-town + Bell Harbor: fx-01, fx-02, fx-03, fx-25. Excluding autumn drops fx-01 and fx-03.
    expect(ids(result.books)).toEqual(new Set(['fx-02', 'fx-25']));
    expect(result.total).toBe(result.books.length);
  });
});

describe('queryBooks — total correctness under paging', () => {
  it('total reports the full filtered count while books.length respects the limit', () => {
    // Cluster F (cozy fantasy) — fx-20..fx-23 all carry both tags, giving a
    // filtered set bigger than the page size so paging is a meaningful check.
    const filters = {
      allTags: [
        { tag: 'fantasy', category: 'genre' as const },
        { tag: 'cozy', category: 'mood' as const },
      ],
    };
    const full = db.queryBooks(filters);
    expect(full.total).toBeGreaterThan(2);

    const paged = db.queryBooks({ ...filters, limit: 2 });
    expect(paged.books).toHaveLength(2);
    expect(paged.total).toBe(full.total);
  });

  it('total stays correct under a small limit with every list filter combined at once', () => {
    // allTags + anyTags + excludeTags + trustedOnly + allEntities + anyEntities,
    // all in one call — the highest-risk configuration for params/fragment drift
    // between the COUNT(*) query and the row query.
    const filters = {
      allTags: [{ tag: 'coastal-town' }],
      anyTags: [{ tag: 'melancholic' }, { tag: 'wistful' }],
      excludeTags: [{ tag: 'time-travel' }],
      trustedOnly: true,
      allEntities: [{ entity: 'Bell Harbor', kind: 'place' as const }],
      anyEntities: [{ entity: 'Bell Harbor' }],
    };
    const full = db.queryBooks({ ...filters, limit: 500 });
    expect(full.books.length).toBeGreaterThan(2);

    const paged = db.queryBooks({ ...filters, limit: 2 });
    expect(paged.books).toHaveLength(2);
    expect(paged.total).toBe(full.books.length);
  });
});

describe('queryBooks — injection safety', () => {
  it('a malicious tag value in `tag` matches nothing and leaves the books table intact', () => {
    const payload = "'; DROP TABLE books; --";
    const result = db.queryBooks({ tag: payload, limit: 100 });
    expect(result.books).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(db.queryBooks({}).total).toBe(30);
  });

  it('a malicious tag value in allTags matches nothing and leaves the books table intact', () => {
    const payload = "'; DROP TABLE books; --";
    const result = db.queryBooks({ allTags: [{ tag: payload }], limit: 100 });
    expect(result.books).toHaveLength(0);
    expect(db.queryBooks({}).total).toBe(30);
  });
});
