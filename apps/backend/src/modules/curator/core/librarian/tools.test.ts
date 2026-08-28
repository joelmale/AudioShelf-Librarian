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

import { CuratorDb, type BookQueryResult } from '../db.js';
import { AppError, NotFoundError } from '../errors.js';
import { composeBookCardFromDb } from '../retrieval/bookCard.js';
import { composeEmbeddingCard } from '../retrieval/embedder.js';
import type { EmbeddingCreator } from '../retrieval/embeddings.js';
import { FIXTURE_BOOKS, seedFixtureLibrary } from '../retrieval/fixtures/library.js';
import { createStubEmbeddingCreator, stubEmbed } from '../retrieval/fixtures/stubEmbedder.js';
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

function deps(
  db: CuratorDb,
  embeddingModel = 'stub-model',
  embeddingCreator: EmbeddingCreator = createStubEmbeddingCreator()
): LibrarianToolDeps {
  return { db, embeddingModel, embeddingCreator };
}

/** Embed every fixture book through the real bookCard/stubEmbed pipeline
 *  (never a hand-rolled vector) — the same approach ranker.test.ts's
 *  `buildRealisticStore` uses, so search_semantic's vibe-ordering
 *  assertions are meaningful rather than testing a fake. */
function embedFixtureLibrary(db: CuratorDb, model = 'stub-model'): void {
  for (const b of FIXTURE_BOOKS) {
    const card = composeBookCardFromDb(db, b.id);
    if (!card) throw new Error(`expected a card for ${b.id}`);
    db.upsertBookEmbedding({ bookId: b.id, model, cardHash: card.hash, vector: stubEmbed(card.text) });
  }
}

/** Invoke a registered tool by name. The registry is deliberately typed as a
 *  union of concrete tool shapes (see tools.ts), so dispatch-by-name needs an
 *  escape hatch here — fine in a test file, where `no-explicit-any` is off. */
function callTool(name: string, toolDeps: LibrarianToolDeps, input: unknown): any {
  const tool = LIBRARIAN_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no librarian tool named ${name}`);
  return (tool.handler as any)(toolDeps, input);
}

function parseToolInput(name: string, input: unknown): unknown {
  const tool = LIBRARIAN_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no librarian tool named ${name}`);
  return tool.inputSchema.parse(input);
}

describe('librarian tool input schemas', () => {
  it.each([
    ['search_library', { limit: 0 }],
    ['search_library', { limit: -1 }],
    ['search_library', { limit: 1.5 }],
    ['search_library', { limit: 101 }],
    ['search_library', { title: ' '.repeat(10) }],
    ['search_library', { title: 'x'.repeat(501) }],
    ['search_library', { author: ' ' }],
    ['search_library', { tag: 'x'.repeat(129) }],
    ['search_library', { minDurationHours: -1 }],
    ['search_library', { maxDurationHours: 10_001 }],
    ['search_library', { minDurationHours: 10, maxDurationHours: 9 }],
    ['search_library', { publishedFrom: 2020.5 }],
    ['search_library', { publishedFrom: 2025, publishedTo: 2024 }],
    ['get_book', { id: '' }],
    ['get_book', { id: 'x'.repeat(513) }],
    ['find_similar', { bookId: 'b', k: 0 }],
    ['find_similar', { bookId: 'b', k: 1.5 }],
    ['find_similar', { bookId: 'b', k: 101 }],
    ['search_semantic', { query: ' ' }],
    ['search_semantic', { query: 'x'.repeat(4_001) }],
    ['search_semantic', { query: 'q', author: ' ' }],
    ['search_semantic', { query: 'q', author: 'x'.repeat(301) }],
    ['search_semantic', { query: 'q', limit: -1 }],
    ['search_semantic', { query: 'q', limit: 1.5 }],
    ['search_semantic', { query: 'q', limit: 101 }],
    ['search_semantic', { query: 'q', allTags: Array.from({ length: 51 }, () => ({ tag: 'x' })) }],
    ['search_semantic', { query: 'q', anyTags: Array.from({ length: 51 }, () => ({ tag: 'x' })) }],
    ['search_semantic', { query: 'q', preferredTags: Array.from({ length: 51 }, () => ({ tag: 'x' })) }],
    ['search_semantic', { query: 'q', excludeTags: Array.from({ length: 51 }, () => ({ tag: 'x' })) }],
    ['search_semantic', { query: 'q', softExcludeTags: Array.from({ length: 51 }, () => ({ tag: 'x' })) }],
    ['search_semantic', { query: 'q', allTags: [{ tag: ' ' }] }],
    ['search_semantic', { query: 'q', preferredTags: [{ tag: 'x', weight: 0 }] }],
    ['search_semantic', { query: 'q', preferredTags: [{ tag: 'x', weight: 101 }] }],
    ['search_semantic', { query: 'q', weights: { semantic: -1 } }],
    ['search_semantic', { query: 'q', weights: { semantic: 2 } }],
    ['search_semantic', { query: 'q', weights: { semantic: Number.POSITIVE_INFINITY } }],
    ['search_semantic', { query: 'q', weights: { semantic: Number.NaN } }],
    ['search_semantic', { query: 'q', weights: { semantic: 1, tag: 1, reception: 0 } }],
    ['search_semantic', { query: 'q', minDurationHours: 2, maxDurationHours: 1 }],
    ['search_semantic', { query: 'q', publishedFrom: 2025, publishedTo: 2024 }],
    ['tag_coverage', { tags: [] }],
    ['tag_coverage', { tags: Array.from({ length: 51 }, () => ({ tag: 'x' })) }],
    ['tag_coverage', { tags: [{ tag: 'x', minConfidence: 1.1 }] }],
    ['tag_coverage', { tags: [{ tag: 'x' }], bookIds: Array.from({ length: 501 }, (_, i) => `b-${i}`) }],
    ['tag_coverage', { tags: [{ tag: 'x' }], bookIds: ['x'.repeat(513)] }],
  ] as const)('rejects invalid %s input %#', (name, input) => {
    expect(() => parseToolInput(name, input)).toThrow();
  });

  it('accepts the documented upper bounds and trims string inputs', () => {
    expect(parseToolInput('search_library', { title: '  A title  ', limit: 100 })).toMatchObject({
      title: 'A title',
      limit: 100,
    });
    expect(parseToolInput('find_similar', { bookId: ' book ', k: 100 })).toEqual({ bookId: 'book', k: 100 });
    expect(parseToolInput('search_semantic', {
      query: ' query ',
      weights: { semantic: 1, tag: 0, reception: 0 },
      limit: 100,
    })).toMatchObject({ query: 'query', limit: 100 });
  });
});

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

describe('search_semantic', () => {
  it('ranks the melancholic-coastal-autumn cluster the way the fixture docblock describes', async () => {
    const db = makeDb();
    seedFixtureLibrary(db);
    embedFixtureLibrary(db);

    const result = await callTool('search_semantic', deps(db), {
      query: 'melancholic coastal autumn',
      limit: 30,
    });

    const byId = new Map<string, any>(result.results.map((r: any): [string, any] => [r.book.id, r]));
    // fx-01 matches all three facets, fx-02 is missing autumn, fx-03 is missing melancholic —
    // same ordering ranker.test.ts's semantic-only regression asserts.
    expect(byId.get('fx-01').components.semantic).toBeGreaterThan(byId.get('fx-02').components.semantic);
    expect(byId.get('fx-02').components.semantic).toBeGreaterThan(byId.get('fx-03').components.semantic);
    expect(result.results[0].book.id).toBe('fx-01');
  });

  it("pages past db.queryBooks's 500-row cap so the whole library is reachable, not just the alphabetically-first page", async () => {
    const db = makeDb();
    const total = 520;
    for (let i = 0; i < total; i++) {
      const id = `pg-${String(i).padStart(4, '0')}`;
      addBook(db, { id, title: `Book ${String(i).padStart(4, '0')}` });
    }
    // The very last book by title — unreachable under a single 500-row page.
    const lastId = `pg-${String(total - 1).padStart(4, '0')}`;

    const result = await callTool('search_semantic', deps(db), { query: 'anything', limit: total });

    expect(result.total).toBe(total);
    expect(result.results.map((r: any) => r.book.id)).toContain(lastId);
  });

  /**
   * `queryBooks` sorts by `ORDER BY b.title` with no tiebreaker, and SQLite
   * promises no stable order among equal titles ACROSS SEPARATE QUERIES — so
   * two books sharing a title either side of a page boundary can be handed
   * back by two consecutive offset pages. That is not reproducible from real
   * SQLite on demand (the whole problem is that the order is unspecified),
   * so the overlap is injected here: every other method still runs against
   * the real database, only `queryBooks` is scripted to return the straddle.
   *
   * Without the id-keyed dedup in `queryAllBooks` this fails on BOTH
   * assertions: `total` reads 4 for a 3-book library, and the repeated book
   * is ranked twice.
   */
  it('deduplicates a book returned by two pages when equal titles straddle the boundary', async () => {
    const real = makeDb();
    addBook(real, { id: 'dup-a', title: 'Same Title' });
    addBook(real, { id: 'dup-b', title: 'Same Title' });
    addBook(real, { id: 'dup-c', title: 'Same Title' });
    const book = (id: string) => real.getBook(id)!;

    // Page 1 ends with dup-b; page 2 begins with it again — the straddle.
    const pages: BookQueryResult[] = [
      { books: [book('dup-a'), book('dup-b')], total: 3, limit: 500, offset: 0 },
      { books: [book('dup-b'), book('dup-c')], total: 3, limit: 500, offset: 2 },
    ];
    let call = 0;
    const flaky = new Proxy(real, {
      get(target, prop) {
        if (prop === 'queryBooks') return () => pages[Math.min(call++, pages.length - 1)];
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as CuratorDb;

    const result = await callTool('search_semantic', deps(flaky), { query: 'anything', limit: 10 });

    const ids = result.results.map((r: any) => r.book.id);
    expect(result.total).toBe(3);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('runs hard filters before scoring: an excluded book never returns even when its text strongly matches the query', async () => {
    const db = makeDb();
    seedFixtureLibrary(db);
    embedFixtureLibrary(db);

    const result = await callTool('search_semantic', deps(db), {
      query: 'melancholic coastal autumn',
      excludeTags: [{ tag: 'melancholic', category: 'mood' }],
      limit: 30,
    });

    // fx-01 is the strongest possible textual match for this query, but it
    // carries the excluded tag — the hard filter must win regardless.
    expect(result.results.map((r: any) => r.book.id)).not.toContain('fx-01');
  });

  it('excludeTags ignores trustedOnly for both tag provenances (readiness invariant 1)', async () => {
    const db = makeDb();
    seedFixtureLibrary(db);
    embedFixtureLibrary(db);

    const result = await callTool('search_semantic', deps(db), {
      query: 'a war fought on a loop through a chronal rift',
      trustedOnly: true,
      excludeTags: [{ tag: 'time-travel', category: 'trope' }],
      limit: 30,
    });

    const ids = result.results.map((r: any) => r.book.id);
    // fx-07 carries time-travel only as an llm-open tag; fx-11 carries the
    // SAME tag as a trusted (vocab) one. excludeTags must drop both — a
    // version that let trustedOnly narrow the exclusion to trusted tags only
    // would let fx-07 back in, which is exactly the bug this guards against.
    // (Invariant 1, docs/phase-4-readiness.md: "excludeTags ignores
    // trustedOnly deliberately". Invariant 7 — applied by writing this test
    // so it fails without the behaviour under test — is why this exists at
    // all, not what it's citing.)
    expect(ids).not.toContain('fx-07');
    expect(ids).not.toContain('fx-11');
  });

  it('trustedOnly DOES narrow inclusion (allTags/anyTags/tag) to non-llm-open tags', async () => {
    const db = makeDb();
    seedFixtureLibrary(db);
    embedFixtureLibrary(db);

    // fx-11 carries time-travel as a trusted (vocab) tag; fx-07 carries the
    // SAME tag only as llm-open (see fixtures/library.ts's provenance
    // pairing). Under trustedOnly, an inclusion predicate must match fx-11
    // and must NOT match fx-07 — the mirror image of the exclusion test
    // above, and the half of invariant 1 that was previously unproven here.
    const result = await callTool('search_semantic', deps(db), {
      query: 'a war fought on a loop through a chronal rift',
      trustedOnly: true,
      allTags: [{ tag: 'time-travel', category: 'trope' }],
      limit: 30,
    });

    const ids = result.results.map((r: any) => r.book.id);
    expect(ids).toContain('fx-11');
    expect(ids).not.toContain('fx-07');
  });

  it('softExcludeTags demotes but never drops the book', async () => {
    const db = makeDb();
    addBook(db, { id: 'sd1', title: 'Melancholic Book' });
    addBook(db, { id: 'sd2', title: 'Cheerful Book' });
    db.replaceBookTags('sd1', [{ tag: 'melancholic', category: 'mood', confidence: 0.9, source: 'vocab' }], Date.now());
    db.replaceBookTags('sd2', [{ tag: 'hopeful', category: 'mood', confidence: 0.9, source: 'vocab' }], Date.now());

    const preferredTags = [{ tag: 'melancholic', category: 'mood' as const }];
    // embeddingModel: '' isolates the tag component — no semantic term to
    // compete with it — so the demotion is unambiguous.
    const withoutSoft = await callTool('search_semantic', deps(db, ''), {
      query: 'placeholder',
      preferredTags,
    });
    expect(withoutSoft.results[0].book.id).toBe('sd1');
    expect(withoutSoft.results.find((r: any) => r.book.id === 'sd1').components.tag).toBeGreaterThan(0);

    const withSoft = await callTool('search_semantic', deps(db, ''), {
      query: 'placeholder',
      preferredTags,
      softExcludeTags: [{ tag: 'melancholic', category: 'mood', weight: 10 }],
    });
    const sd1 = withSoft.results.find((r: any) => r.book.id === 'sd1');
    expect(sd1).toBeDefined(); // demoted, never dropped
    expect(sd1.components.tag).toBe(0); // clamped to the floor, not negative
  });

  it('the author hard filter actually narrows the candidate set', async () => {
    const db = makeDb();
    addBook(db, { id: 'au1', title: 'By Match', author: 'Iris Vance' });
    addBook(db, { id: 'au2', title: 'By Other', author: 'Someone Else' });

    const result = await callTool('search_semantic', deps(db), { query: 'anything', author: 'Iris Vance' });
    expect(result.results.map((r: any) => r.book.id)).toEqual(['au1']);
  });

  it('allTags requires every listed tag to be present (AND semantics)', async () => {
    const db = makeDb();
    addBook(db, { id: 'at1', title: 'Has Both' });
    addBook(db, { id: 'at2', title: 'Has One' });
    db.replaceBookTags(
      'at1',
      [
        { tag: 'cozy', category: 'mood', confidence: 0.9, source: 'vocab' },
        { tag: 'found-family', category: 'theme', confidence: 0.9, source: 'vocab' },
      ],
      Date.now()
    );
    db.replaceBookTags('at2', [{ tag: 'cozy', category: 'mood', confidence: 0.9, source: 'vocab' }], Date.now());

    const result = await callTool('search_semantic', deps(db), {
      query: 'anything',
      allTags: [
        { tag: 'cozy', category: 'mood' },
        { tag: 'found-family', category: 'theme' },
      ],
    });
    expect(result.results.map((r: any) => r.book.id)).toEqual(['at1']);
  });

  it('anyTags matches a book carrying only one of the listed tags (OR semantics)', async () => {
    const db = makeDb();
    addBook(db, { id: 'an1', title: 'Cozy Only' });
    addBook(db, { id: 'an2', title: 'Neither' });
    db.replaceBookTags('an1', [{ tag: 'cozy', category: 'mood', confidence: 0.9, source: 'vocab' }], Date.now());
    db.replaceBookTags('an2', [{ tag: 'gritty', category: 'mood', confidence: 0.9, source: 'vocab' }], Date.now());

    const result = await callTool('search_semantic', deps(db), {
      query: 'anything',
      anyTags: [
        { tag: 'cozy', category: 'mood' },
        { tag: 'found-family', category: 'theme' },
      ],
    });
    expect(result.results.map((r: any) => r.book.id)).toEqual(['an1']);
  });

  it('applies the duration/series/published-year post-query filters, not just the raw SQL query', async () => {
    const db = makeDb();
    addBook(db, { id: 'pf1', title: 'Long Enough', durationSeconds: 3600 * 20 });
    addBook(db, { id: 'pf2', title: 'Too Short', durationSeconds: 3600 * 2 });

    const result = await callTool('search_semantic', deps(db), { query: 'anything', minDurationHours: 10 });
    expect(result.results.map((r: any) => r.book.id)).toEqual(['pf1']);
  });

  it('total reports the full candidate count, not the post-limit result count', async () => {
    const db = makeDb();
    for (const id of ['tl1', 'tl2', 'tl3', 'tl4', 'tl5']) addBook(db, { id, title: `Book ${id}` });

    const result = await callTool('search_semantic', deps(db), { query: 'anything', limit: 2 });
    expect(result.results).toHaveLength(2);
    expect(result.total).toBe(5);
  });

  it('defaults to more than a single result when the candidate set is small', async () => {
    const db = makeDb();
    for (const id of ['dl1', 'dl2', 'dl3']) addBook(db, { id, title: `Book ${id}` });

    const result = await callTool('search_semantic', deps(db), { query: 'anything' });
    expect(result.results).toHaveLength(3);
  });

  it('weights passthrough actually changes which book wins the blend', async () => {
    const db = makeDb();
    addBook(db, { id: 'w-sem', title: 'Semantic Winner' });
    addBook(db, { id: 'w-tag', title: 'Tag Winner' });
    db.replaceBookTags('w-tag', [{ tag: 'blend-test', category: 'theme', confidence: 1, source: 'vocab' }], Date.now());

    // Hand-crafted 2D vectors (exact cosine arithmetic), same approach
    // ranker.test.ts's "blend changes the winner" case uses.
    db.upsertBookEmbedding({ bookId: 'w-sem', model: 'stub-model', cardHash: 'h1', vector: new Float32Array([1, 0]) });
    db.upsertBookEmbedding({ bookId: 'w-tag', model: 'stub-model', cardHash: 'h2', vector: new Float32Array([0, 1]) });
    const fixedVectorCreator: EmbeddingCreator = {
      async create() {
        return [new Float32Array([1, 0])];
      },
    };
    const weightTestDeps = deps(db, 'stub-model', fixedVectorCreator);
    const preferredTags = [{ tag: 'blend-test', category: 'theme' as const }];

    const semanticHeavy = await callTool('search_semantic', weightTestDeps, {
      query: 'placeholder',
      preferredTags,
      weights: { semantic: 1, tag: 0, reception: 0 },
    });
    const tagHeavy = await callTool('search_semantic', weightTestDeps, {
      query: 'placeholder',
      preferredTags,
      weights: { semantic: 0, tag: 1, reception: 0 },
    });

    expect(semanticHeavy.results[0].book.id).toBe('w-sem');
    expect(tagHeavy.results[0].book.id).toBe('w-tag');
  });

  it('throws when the embedding creator returns no vector for the query, rather than silently degrading', async () => {
    const db = makeDb();
    addBook(db, { id: 'ev1', title: 'Anything' });

    const emptyResponseCreator: EmbeddingCreator = {
      async create() {
        return [];
      },
    };

    await expect(
      callTool('search_semantic', deps(db, 'stub-model', emptyResponseCreator), { query: 'anything' })
    ).rejects.toThrow(AppError);
  });

  it('semanticScored is 0 and nothing throws when no book has ever been embedded', async () => {
    const db = makeDb();
    addBook(db, { id: 'ne1', title: 'Never Embedded' });
    db.replaceBookTags('ne1', [{ tag: 'cozy', category: 'mood', confidence: 0.8, source: 'vocab' }], Date.now());

    const result = await callTool('search_semantic', deps(db), { query: 'cozy vibes' });
    expect(result.semanticScored).toBe(0);
    expect(result.results.map((r: any) => r.book.id)).toEqual(['ne1']);
  });

  it('never calls the embedding creator when embeddingModel is unconfigured', async () => {
    const db = makeDb();
    addBook(db, { id: 'uc1', title: 'Unconfigured Model Book' });

    let calls = 0;
    const countingCreator: EmbeddingCreator = {
      async create(req) {
        calls += 1;
        return req.input.map(() => new Float32Array([1]));
      },
    };

    const result = await callTool('search_semantic', deps(db, '', countingCreator), { query: 'anything' });
    expect(calls).toBe(0);
    expect(result.results.map((r: any) => r.book.id)).toEqual(['uc1']);
  });

  it('attaches libraryCoverage the same way search_library does', async () => {
    const db = makeDb();
    for (const id of ['lc1', 'lc2', 'lc3', 'lc4']) addBook(db, { id, title: `Book ${id}` });

    const result = await callTool('search_semantic', deps(db), { query: 'anything' });
    expect(result.libraryCoverage).toBeDefined();
    expect(result.libraryCoverage.disclosure).toEqual(expect.any(String));
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
