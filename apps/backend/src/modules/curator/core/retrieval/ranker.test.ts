import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book } from '../types.js';
import { EmbeddingStore } from './embeddings.js';
import { composeBookCardFromDb } from './bookCard.js';
import { FIXTURE_BOOKS, FIXTURE_NOW, fixtureBook, seedFixtureLibrary } from './fixtures/library.js';
import { stubEmbed } from './fixtures/stubEmbedder.js';
import { DEFAULT_WEIGHTS, rankBooks, type PreferredTag, type RankedBook } from './ranker.js';

const tempDirs: string[] = [];
let db: CuratorDb;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-ranker-'));
  tempDirs.push(dir);
  db = new CuratorDb(path.join(dir, 'test.db'));
  seedFixtureLibrary(db);
});

afterEach(() => {
  db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Every seeded fixture book, keyed by id. */
function allBooksById(): Map<string, Book> {
  return new Map(db.queryBooks({ limit: 500 }).books.map((b) => [b.id, b]));
}

/** Look up specific fixture books by id, in the order requested. */
function pickBooks(ids: readonly string[]): Book[] {
  const byId = allBooksById();
  return ids.map((id) => {
    const book = byId.get(id);
    if (!book) throw new Error(`expected a seeded book for ${id}`);
    return book;
  });
}

/** Compose + embed a fixture book's card through the real bookCard/stubEmbed
 *  pipeline (never a hand-rolled vector), so the vector is exactly what
 *  production would produce for it. `skipIds` simulates a book that was
 *  never embedded. */
function buildRealisticStore(skipIds: ReadonlySet<string> = new Set()): EmbeddingStore {
  const entries = FIXTURE_BOOKS.filter((b) => !skipIds.has(b.id)).map((b) => {
    const card = composeBookCardFromDb(db, b.id);
    if (!card) throw new Error(`expected a card for ${b.id}`);
    return { bookId: b.id, model: 'stub', cardHash: card.hash, vector: stubEmbed(card.text) };
  });
  return new EmbeddingStore(entries);
}

function ids(results: readonly RankedBook[]): string[] {
  return results.map((r) => r.book.id);
}

describe('rankBooks', () => {
  it('semantic-only: no preferred tags, ranks the vibe-cluster fixture books by cosine', () => {
    const store = buildRealisticStore();
    const candidates = pickBooks(FIXTURE_BOOKS.map((b) => b.id));

    const results = rankBooks({ candidates, queryVector: stubEmbed('melancholic coastal autumn'), store }, db);

    expect(results).toHaveLength(candidates.length);
    const byId = new Map(results.map((r) => [r.book.id, r]));
    // fx-01 matches all three facets, fx-02 is missing autumn, fx-03 is missing melancholic.
    expect(byId.get('fx-01')!.components.semantic).toBeGreaterThan(byId.get('fx-02')!.components.semantic);
    expect(byId.get('fx-02')!.components.semantic).toBeGreaterThan(byId.get('fx-03')!.components.semantic);
    expect(results[0]!.book.id).toBe('fx-01');

    // No preferredTags supplied at all -> tag component is 0 for every book.
    for (const r of results) expect(r.components.tag).toBe(0);
  });

  it('tag-only: no query vector, semantic contributes 0 and tag ordering follows confidence', () => {
    const preferredTags: PreferredTag[] = [
      { tag: 'melancholic', category: 'mood' },
      { tag: 'coastal-town', category: 'setting' },
      { tag: 'autumn', category: 'setting' },
    ];
    const candidates = pickBooks(FIXTURE_BOOKS.map((b) => b.id));

    const results = rankBooks({ candidates, preferredTags }, db);

    for (const r of results) expect(r.components.semantic).toBe(0);
    expect(results[0]!.book.id).toBe('fx-01');
    expect(results[0]!.components.tag).toBeGreaterThan(0);

    const fx01 = results.find((r) => r.book.id === 'fx-01')!;
    // fx-01 carries all three; ordering exactly matches the confidence-weighted formula.
    expect(fx01.matchedTags).toEqual(['autumn', 'coastal-town', 'melancholic']);
  });

  it('blend changes the winner versus either signal alone', () => {
    // Three hand-controlled books on a 2D toy embedding space (exact cosine
    // arithmetic, not the fixture library's lexical overlap) plus one
    // controlled tag each, so every component below is an exact, predictable
    // number instead of an emergent property of the stub embedder.
    //   A (fx-06): semantic 1.0, tag 0    (wins on semantic alone)
    //   B (fx-19): semantic 0.0, tag 1.0  (wins on tag alone)
    //   C (fx-29): semantic 0.8, tag 0.8  (strong on both, wins the blend)
    db.replaceBookTags('fx-19', [{ tag: 'blend-test', category: 'theme', confidence: 1.0, source: 'vocab' }], FIXTURE_NOW);
    db.replaceBookTags('fx-29', [{ tag: 'blend-test', category: 'theme', confidence: 0.8, source: 'vocab' }], FIXTURE_NOW);

    const candidates = pickBooks(['fx-06', 'fx-19', 'fx-29']);
    const store = new EmbeddingStore([
      { bookId: 'fx-06', model: 'test', cardHash: 'h1', vector: new Float32Array([1, 0]) },
      { bookId: 'fx-19', model: 'test', cardHash: 'h2', vector: new Float32Array([0, 1]) },
      { bookId: 'fx-29', model: 'test', cardHash: 'h3', vector: new Float32Array([4, 3]) }, // normalizes to [0.8, 0.6]
    ]);
    const queryVector = new Float32Array([1, 0]);
    const preferredTags: PreferredTag[] = [{ tag: 'blend-test', category: 'theme' }];

    const semanticOnly = rankBooks(
      { candidates, queryVector, store, preferredTags, weights: { semantic: 1, tag: 0, reception: 0 } },
      db
    );
    const tagOnly = rankBooks(
      { candidates, queryVector, store, preferredTags, weights: { semantic: 0, tag: 1, reception: 0 } },
      db
    );
    const blended = rankBooks({ candidates, queryVector, store, preferredTags }, db); // DEFAULT_WEIGHTS

    expect(ids(semanticOnly)).toEqual(['fx-06', 'fx-29', 'fx-19']); // A, C, B
    expect(ids(tagOnly)).toEqual(['fx-19', 'fx-29', 'fx-06']); // B, C, A
    // C wins the blend outright — a winner neither pure ranking picked.
    expect(ids(blended)[0]).toBe('fx-29');
    expect(ids(blended)[0]).not.toBe(ids(semanticOnly)[0]);
    expect(ids(blended)[0]).not.toBe(ids(tagOnly)[0]);
  });

  it('llm-open tags are weighted below trusted ones by the documented factor', () => {
    // fx-07 carries time-travel as llm-open (confidence 0.6); fx-11 carries
    // the same tag as vocab (confidence 0.75) — see fixtures/library.ts's
    // "Provenance pairing" note.
    expect(fixtureBook('fx-07').tags.find((t) => t.tag === 'time-travel')!.source).toBe('llm-open');
    expect(fixtureBook('fx-11').tags.find((t) => t.tag === 'time-travel')!.source).toBe('vocab');

    const candidates = pickBooks(['fx-07', 'fx-11']);
    const results = rankBooks({ candidates, preferredTags: [{ tag: 'time-travel', category: 'trope' }] }, db);

    const fx07 = results.find((r) => r.book.id === 'fx-07')!;
    const fx11 = results.find((r) => r.book.id === 'fx-11')!;
    // 0.6 * 0.5 (llm-open factor) = 0.3; 0.75 * 1 (vocab, full weight) = 0.75.
    expect(fx07.components.tag).toBeCloseTo(0.3, 10);
    expect(fx11.components.tag).toBeCloseTo(0.75, 10);
    expect(results[0]!.book.id).toBe('fx-11');
  });

  it('softExcludeTags demote a book without removing it from the results', () => {
    // fx-07 carries genre:science-fiction (0.85, vocab) and genre:thriller
    // (0.88, vocab).
    const candidates = pickBooks(['fx-07']);
    const preferredTags: PreferredTag[] = [{ tag: 'science-fiction', category: 'genre' }];
    const softExcludeTags: PreferredTag[] = [{ tag: 'thriller', category: 'genre' }];

    const withoutExclude = rankBooks({ candidates, preferredTags }, db);
    const withExclude = rankBooks({ candidates, preferredTags, softExcludeTags }, db);

    // Never removed — both calls still return the one candidate.
    expect(ids(withoutExclude)).toEqual(['fx-07']);
    expect(ids(withExclude)).toEqual(['fx-07']);

    expect(withoutExclude[0]!.components.tag).toBeCloseTo(0.85, 10);
    // 0.85 (preferred) - 0.88 (excluded) would be negative; clamped to the floor, 0.
    expect(withExclude[0]!.components.tag).toBe(0);
  });

  it('softExcludeTags only partially demote a book that partially matches the excluded facets', () => {
    // fx-16 "Nine Missed Calls" carries thriller (0.86, vocab) and horror
    // (0.72, llm-open) — matching only one of two soft-excluded tags at full
    // strength keeps some of the preferred-tag score intact.
    const candidates = pickBooks(['fx-16']);
    const preferredTags: PreferredTag[] = [{ tag: 'thriller', category: 'genre' }];
    const softExcludeTags: PreferredTag[] = [{ tag: 'dread', category: 'mood' }]; // 0.85, vocab

    const results = rankBooks({ candidates, preferredTags, softExcludeTags }, db);
    // preferred: 0.86; excluded: 0.85 -> clamp(0.86 - 0.85, 0, 1) = 0.01, not 0 and not 0.86.
    expect(results[0]!.components.tag).toBeCloseTo(0.01, 10);
  });

  it('unknown reception is neutral: a null prior does not rank below a poor one, all else equal', () => {
    const candidates = pickBooks(['fx-04', 'fx-05', 'fx-19']);
    const priors = new Map<string, number>([
      ['fx-05', 0.1], // poor
      ['fx-19', 1.5], // out of range, clamps to 1
      // fx-04 intentionally absent -> null
    ]);

    const results = rankBooks({ candidates, receptionPrior: (book) => priors.get(book.id) ?? null }, db);
    const byId = new Map(results.map((r) => [r.book.id, r]));

    expect(byId.get('fx-04')!.components.reception).toBe(0.5); // neutral, not 0
    expect(byId.get('fx-05')!.components.reception).toBeCloseTo(0.1, 10);
    expect(byId.get('fx-19')!.components.reception).toBe(1); // clamped

    // All else equal (no queryVector, no preferredTags): the neutral book
    // must not rank below the poor one.
    const rankOf = (id: string) => results.findIndex((r) => r.book.id === id);
    expect(rankOf('fx-04')).toBeLessThan(rankOf('fx-05'));
  });

  it('unknown reception is neutral even when receptionPrior is omitted entirely', () => {
    const candidates = pickBooks(['fx-04', 'fx-05']);
    const results = rankBooks({ candidates }, db);
    for (const r of results) expect(r.components.reception).toBe(0.5);
  });

  it('normalisation invariance: adding more (unmatched) preferred tags shrinks, never inflates, the tag score', () => {
    const candidates = pickBooks(['fx-01']);
    const exact: PreferredTag[] = [
      { tag: 'melancholic', category: 'mood' },
      { tag: 'coastal-town', category: 'setting' },
      { tag: 'autumn', category: 'setting' },
    ];
    // Same three matching tags, plus five fx-01 does not carry.
    const padded: PreferredTag[] = [
      ...exact,
      { tag: 'space-opera', category: 'genre' },
      { tag: 'horror', category: 'genre' },
      { tag: 'cozy', category: 'mood' },
      { tag: 'found-family', category: 'theme' },
      { tag: 'relentless', category: 'pacing' },
    ];

    const exactResult = rankBooks({ candidates, preferredTags: exact }, db)[0]!;
    const paddedResult = rankBooks({ candidates, preferredTags: padded }, db)[0]!;

    expect(exactResult.components.tag).toBeGreaterThan(0);
    expect(exactResult.components.tag).toBeLessThanOrEqual(1);
    expect(paddedResult.components.tag).toBeLessThan(exactResult.components.tag);
    expect(paddedResult.components.tag).toBeGreaterThanOrEqual(0);
  });

  it('a candidate absent from the embedding store is never dropped, just scored 0 semantically', () => {
    const store = buildRealisticStore(new Set(['fx-01']));
    expect(store.has('fx-01')).toBe(false);

    const candidates = pickBooks(['fx-01', 'fx-02']);
    const results = rankBooks({ candidates, queryVector: stubEmbed('melancholic coastal autumn'), store }, db);

    expect(results).toHaveLength(2);
    const fx01 = results.find((r) => r.book.id === 'fx-01')!;
    expect(fx01.components.semantic).toBe(0);
  });

  it('deterministic tiebreak: equal scores sort by book.id codepoint ASC, regardless of input order', () => {
    // No queryVector, no preferredTags/softExcludeTags, no receptionPrior:
    // every candidate scores an identical constant (weights.reception * 0.5).
    const forward = pickBooks(FIXTURE_BOOKS.map((b) => b.id));
    const reversed = [...forward].reverse();

    const forwardResult = rankBooks({ candidates: forward }, db);
    const reversedResult = rankBooks({ candidates: reversed }, db);

    const expectedIds = FIXTURE_BOOKS.map((b) => b.id)
      .slice()
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    expect(ids(forwardResult)).toEqual(expectedIds);
    expect(ids(reversedResult)).toEqual(expectedIds);
  });

  it('empty candidates returns an empty result without touching the db or throwing', () => {
    const results = rankBooks({ candidates: [] }, db);
    expect(results).toEqual([]);
  });

  it('DEFAULT_WEIGHTS matches the documented, justified values', () => {
    expect(DEFAULT_WEIGHTS).toEqual({ semantic: 0.55, tag: 0.35, reception: 0.1 });
  });
});
