import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book, BookEmbedding, BookTag, TagCategory, TagSource } from '../types.js';
import {
  evaluateExpectations,
  parseAcceptanceQueryFile,
  matchesSqliteLike,
  percentile,
  runAcceptanceHarness,
  type AcceptanceSnapshot,
} from './acceptance.js';

function book(id: string, title = id): Book {
  return {
    id,
    title,
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: 3600,
    publishedYear: 2020,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: 1,
  };
}

function embedding(bookId: string, vector: number[]): BookEmbedding {
  return { bookId, model: 'fixture-model', cardHash: `hash-${bookId}`, vector: Float32Array.from(vector) };
}

function tag(bookId: string, value: string, source: TagSource = 'vocab', category: TagCategory = 'mood'): BookTag {
  return { id: 1, bookId, tag: value, category, confidence: 1, taggedAt: 1, source };
}

const BASE_FILE = {
  version: 1 as const,
  embeddingModel: 'fixture-model',
  topK: 3,
  weightGrid: [
    { semantic: 1, tag: 0, reception: 0 },
    { semantic: 0, tag: 1, reception: 0 },
  ],
  queries: [{ id: 'q1', query: 'fixture prose', queryVector: [1, 0] }],
};

describe('acceptance harness', () => {
  it('uses deterministic linear interpolation for percentiles', () => {
    expect(percentile([4, 1, 3, 2], 0)).toBe(1);
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(percentile([4, 1, 3, 2], 0.9)).toBeCloseTo(3.7);
    expect(percentile([4, 1, 3, 2], 1)).toBe(4);
  });

  it('reports missing vectors without silently dropping their books', () => {
    const snapshot: AcceptanceSnapshot = {
      books: [book('a'), book('b'), book('missing')],
      tags: [],
      embeddings: [embedding('a', [1, 0]), embedding('b', [0, 1])],
    };
    const report = runAcceptanceHarness(snapshot, BASE_FILE);
    expect(report.summary).toMatchObject({ dimension: 2, bookCount: 3, embeddedCount: 2, missingVectorCount: 1 });
    expect(report.queries[0]!.candidateCount).toBe(3);
    expect(report.queries[0]!.runs[0]!.rankings).toHaveLength(3);
    expect(report.queries[0]!.runs[0]!.rankings.find((row) => row.bookId === 'missing')?.components.semantic).toBe(0);
  });

  it('rejects stored and query vectors with the wrong dimension', () => {
    const mismatched: AcceptanceSnapshot = {
      books: [book('a'), book('b')],
      tags: [],
      embeddings: [embedding('a', [1, 0]), embedding('b', [1, 0, 0])],
    };
    expect(() => runAcceptanceHarness(mismatched, BASE_FILE)).toThrow('embedding dimension mismatch');

    const valid = { ...mismatched, embeddings: [embedding('a', [1, 0]), embedding('b', [0, 1])] };
    expect(() =>
      runAcceptanceHarness(valid, { ...BASE_FILE, queries: [{ id: 'q1', query: 'fixture prose', queryVector: [1] }] })
    ).toThrow('wrong query vector dimension for q1');
  });

  it('rejects unconfigured models, missing vectors, and unbounded or invalid weights', () => {
    expect(() => parseAcceptanceQueryFile({ ...BASE_FILE, embeddingModel: '' })).toThrow();
    expect(() => parseAcceptanceQueryFile({ ...BASE_FILE, queries: [{ id: 'q1', query: 'x' }] })).toThrow();
    expect(() => parseAcceptanceQueryFile({ ...BASE_FILE, weightGrid: [{ semantic: 2, tag: 0, reception: 0 }] })).toThrow();
    expect(() => parseAcceptanceQueryFile({ ...BASE_FILE, weightGrid: [{ semantic: 0.5, tag: 0.2, reception: 0.1 }] })).toThrow();
    expect(() => parseAcceptanceQueryFile({ ...BASE_FILE, weightGrid: Array(33).fill(BASE_FILE.weightGrid[0]) })).toThrow();
  });

  it('rejects unknown keys at every user-input object boundary', () => {
    expect(() => parseAcceptanceQueryFile({ ...BASE_FILE, typo: true })).toThrow();
    expect(() => parseAcceptanceQueryFile({ ...BASE_FILE, weightGrid: [{ ...BASE_FILE.weightGrid[0], typo: 1 }] })).toThrow();
    expect(() => parseAcceptanceQueryFile({ ...BASE_FILE, queries: [{ ...BASE_FILE.queries[0], expectation: {} }] })).toThrow();
    expect(() => parseAcceptanceQueryFile({ ...BASE_FILE, queries: [{ ...BASE_FILE.queries[0], hardFilters: { excludeTag: [] } }] })).toThrow();
    expect(() => parseAcceptanceQueryFile({ ...BASE_FILE, queries: [{ ...BASE_FILE.queries[0], hardFilters: { excludeTags: [{ tag: 'x', typo: true }] } }] })).toThrow();
    expect(() => parseAcceptanceQueryFile({ ...BASE_FILE, queries: [{ ...BASE_FILE.queries[0], softFilters: { typo: true } }] })).toThrow();
    expect(() => parseAcceptanceQueryFile({ ...BASE_FILE, queries: [{ ...BASE_FILE.queries[0], softFilters: { preferredTags: [{ tag: 'x', typo: true }] } }] })).toThrow();
    expect(() => parseAcceptanceQueryFile({ ...BASE_FILE, queries: [{ ...BASE_FILE.queries[0], expectations: { topBookIds: ['a'], typo: true } }] })).toThrow();
  });

  it('rejects zero-norm stored and query vectors', () => {
    const valid: AcceptanceSnapshot = { books: [book('a')], tags: [], embeddings: [embedding('a', [1, 0])] };
    expect(() => runAcceptanceHarness({ ...valid, embeddings: [embedding('a', [0, 0])] }, BASE_FILE)).toThrow('embedding vector has zero norm');
    expect(() => runAcceptanceHarness(valid, { ...BASE_FILE, queries: [{ ...BASE_FILE.queries[0], queryVector: [0, 0] }] })).toThrow(
      'query vector for q1 has zero norm'
    );
  });

  it.each([
    ['empty book id', (value: any) => { value.books[0].id = ''; }],
    ['duplicate book id', (value: any) => { value.books.push({ ...value.books[0] }); }],
    ['wrong nullable field type', (value: any) => { value.books[0].author = 42; }],
    ['non-finite book number', (value: any) => { value.books[0].durationSeconds = Number.NaN; }],
    ['non-integer timestamp', (value: any) => { value.books[0].lastSyncedAt = 1.5; }],
    ['non-string genre', (value: any) => { value.books[0].genres = ['valid', 42]; }],
    ['invalid tag id', (value: any) => { value.tags[0].id = '1'; }],
    ['orphan tag', (value: any) => { value.tags[0].bookId = 'orphan'; }],
    ['duplicate tag', (value: any) => { value.tags.push({ ...value.tags[0], id: 2 }); }],
    ['empty embedding model', (value: any) => { value.embeddings[0].model = ''; }],
    ['empty card hash', (value: any) => { value.embeddings[0].cardHash = ''; }],
    ['orphan embedding', (value: any) => { value.embeddings[0].bookId = 'orphan'; }],
    ['duplicate embedding', (value: any) => { value.embeddings.push({ ...value.embeddings[0] }); }],
  ])('fails closed on a pure snapshot with %s', (_label, mutate) => {
    const value: any = {
      books: [book('a')],
      tags: [tag('a', 'cozy')],
      embeddings: [embedding('a', [1, 0])],
    };
    mutate(value);
    expect(() => runAcceptanceHarness(value, BASE_FILE)).toThrow();
  });

  it('matches CuratorDb author LIKE semantics, including wildcards and ASCII-only NOCASE', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-author-parity-'));
    const db = new CuratorDb(path.join(directory, 'parity.db'));
    const authors = ['Nadia Petrov', 'NADIA', 'Élodie', 'élodie', 'A_B', 'A%B'];
    const books = authors.map((author, index) => ({ ...book(`author-${index}`), author }));
    try {
      for (const item of books) db.upsertBook(item);
      for (const input of ['nadia', 'NADIA', 'é', 'É', '_', '%', 'A_B', 'A%B']) {
        const expected = db.queryBooks({ author: input, limit: 100 }).books.map((item) => item.id).sort();
        const matched = books.filter((item) => matchesSqliteLike(item.author!, `%${input}%`)).map((item) => item.id).sort();
        expect(matched, input).toEqual(expected);

        const report = runAcceptanceHarness(
          { books, tags: [], embeddings: books.map((item) => embedding(item.id, [1, 0])) },
          { ...BASE_FILE, topK: 20, weightGrid: [{ semantic: 1, tag: 0, reception: 0 }], queries: [{ ...BASE_FILE.queries[0], hardFilters: { author: input } }] }
        );
        expect(report.queries[0]!.runs[0]!.rankings.map((row) => row.bookId).sort(), input).toEqual(expected);
      }
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps all-provenance hard exclusions out of every weight-grid ranking', () => {
    const sources: TagSource[] = ['vocab', 'derived', 'abs', 'external:fixture', 'llm-open'];
    const excludedBooks = sources.map((_, index) => book(`excluded-${index}`));
    const snapshot: AcceptanceSnapshot = {
      books: [book('allowed'), ...excludedBooks],
      tags: [tag('allowed', 'cozy'), ...sources.map((source, index) => tag(`excluded-${index}`, 'forbidden', source))],
      embeddings: [embedding('allowed', [0, 1]), ...excludedBooks.map((item) => embedding(item.id, [1, 0]))],
    };
    const report = runAcceptanceHarness(snapshot, {
      ...BASE_FILE,
      queries: [
        {
          ...BASE_FILE.queries[0],
          hardFilters: { excludeTags: [{ tag: 'forbidden' }], trustedOnly: true },
          softFilters: { preferredTags: [{ tag: 'cozy' }] },
        },
      ],
    });
    expect(report.queries[0]!.runs).toHaveLength(2);
    for (const run of report.queries[0]!.runs) expect(run.rankings.map((row) => row.bookId)).toEqual(['allowed']);
  });

  it('does not infer expectations and fails a real ordering assertion when order changes', () => {
    expect(evaluateExpectations(['a', 'b'], undefined)).toEqual({ status: 'not-configured', failures: [] });
    expect(evaluateExpectations(['a', 'b'], { topBookIds: ['a', 'b'] }).status).toBe('passed');
    const changed = evaluateExpectations(['b', 'a'], { topBookIds: ['a', 'b'] });
    expect(changed.status).toBe('failed');
    expect(changed.failures).toContain('rank 1: expected a, got b');

    const snapshot: AcceptanceSnapshot = {
      books: [book('a'), book('b')],
      tags: [],
      embeddings: [embedding('a', [1, 0]), embedding('b', [0, 1])],
    };
    const report = runAcceptanceHarness(snapshot, {
      ...BASE_FILE,
      weightGrid: [{ semantic: 1, tag: 0, reception: 0 }],
      queries: [{ ...BASE_FILE.queries[0], queryVector: [0, 1], expectations: { topBookIds: ['a'] } }],
    });
    expect(report.expectations).toMatchObject({ configuredRuns: 1, failedRuns: 1 });
    expect(report.expectations.failures[0]!.messages[0]).toBe('rank 1: expected a, got b');
  });

  it('produces a component-rich fixture report in deterministic score order', () => {
    const snapshot: AcceptanceSnapshot = {
      books: [book('semantic'), book('tagged')],
      tags: [tag('tagged', 'cozy')],
      embeddings: [embedding('semantic', [1, 0]), embedding('tagged', [0, 1])],
    };
    const report = runAcceptanceHarness(snapshot, {
      ...BASE_FILE,
      weightGrid: [{ semantic: 0.6, tag: 0.4, reception: 0 }],
      queries: [{ ...BASE_FILE.queries[0], softFilters: { preferredTags: [{ tag: 'cozy' }] } }],
    });
    expect(report.queries[0]!.runs[0]!.rankings.map((row) => row.bookId)).toEqual(['semantic', 'tagged']);
    expect(report.queries[0]!.runs[0]!.rankings[0]!.components).toEqual({ semantic: 1, tag: 0, reception: 0.5 });
    expect(report.queries[0]!.runs[0]!.topGaps[0]).toBeCloseTo(0.2);
  });
});
