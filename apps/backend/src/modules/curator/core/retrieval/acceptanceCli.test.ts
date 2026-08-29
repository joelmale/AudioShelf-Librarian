import { describe, expect, it } from 'vitest';

import type { Book, BookEmbedding } from '../types.js';
import type { AcceptanceSnapshot } from './acceptance.js';
import { runAcceptanceCli } from './acceptanceCli.js';

const fixtureBook: Book = {
  id: 'a',
  title: 'Fixture',
  author: null,
  series: null,
  seriesSequence: null,
  durationSeconds: null,
  publishedYear: null,
  genres: [],
  description: null,
  coverPath: null,
  absAddedAt: null,
  lastSyncedAt: 1,
};
const fixtureEmbedding: BookEmbedding = {
  bookId: 'a',
  model: 'fixture-model',
  cardHash: 'hash',
  vector: Float32Array.from([1, 0]),
};
const snapshot: AcceptanceSnapshot = { books: [fixtureBook], tags: [], embeddings: [fixtureEmbedding] };

function queryFile(expectations?: { topBookIds: string[] }): string {
  return JSON.stringify({
    version: 1,
    embeddingModel: 'fixture-model',
    topK: 1,
    weightGrid: [{ semantic: 1, tag: 0, reception: 0 }],
    queries: [{ id: 'q', query: 'fixture', queryVector: [1, 0], ...(expectations ? { expectations } : {}) }],
  });
}

function invoke(file: string): { status: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const status = runAcceptanceCli(['--snapshot', 'fixture-snapshot.db', '--queries', 'queries.json'], {
    readFile: () => file,
    loadSnapshot: () => snapshot,
    writeOut: (text) => { stdout += text; },
    writeError: (text) => { stderr += text; },
  });
  return { status, stdout, stderr };
}

describe('retrieval acceptance CLI', () => {
  it('exits zero for passing configured expectations', () => {
    const result = invoke(queryFile({ topBookIds: ['a'] }));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).expectations).toMatchObject({ configuredRuns: 1, failedRuns: 0 });
    expect(result.stderr).toBe('');
  });

  it('prints the report and exits two for failing configured expectations', () => {
    const mixedFile = JSON.stringify({
      version: 1,
      embeddingModel: 'fixture-model',
      topK: 1,
      weightGrid: [
        { semantic: 1, tag: 0, reception: 0 },
        { semantic: 0, tag: 1, reception: 0 },
      ],
      queries: [
        { id: 'passing', query: 'fixture', queryVector: [1, 0], expectations: { topBookIds: ['a'] } },
        { id: 'failing', query: 'fixture', queryVector: [1, 0], expectations: { topBookIds: ['wrong'] } },
        { id: 'not-configured', query: 'fixture', queryVector: [1, 0] },
      ],
    });
    const result = invoke(mixedFile);
    expect(result.status).toBe(2);
    const expectations = JSON.parse(result.stdout).expectations;
    expect(expectations).toMatchObject({ configuredRuns: 4, failedRuns: 2 });
    expect(expectations.failures).toEqual([
      {
        queryId: 'failing',
        weights: { semantic: 1, tag: 0, reception: 0, taste: 0 },
        messages: ['rank 1: expected wrong, got a'],
      },
      {
        queryId: 'failing',
        weights: { semantic: 0, tag: 1, reception: 0, taste: 0 },
        messages: ['rank 1: expected wrong, got a'],
      },
    ]);
    expect(result.stderr).toContain('2 configured ranking expectation run(s) failed');
  });

  it('exits zero when expectations are not configured', () => {
    const result = invoke(queryFile());
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).expectations).toMatchObject({ configuredRuns: 0, failedRuns: 0 });
  });

  it('rejects malformed argument shapes instead of ignoring writable or unknown flags', () => {
    expect(() => runAcceptanceCli(['--snapshot', 'x-snapshot.db', '--queries', 'q.json', '--writable'])).toThrow('Usage:');
  });
});
