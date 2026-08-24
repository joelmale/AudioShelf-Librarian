import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../db.js';
import { AppError } from '../errors.js';
import type { Book, BookEmbedding } from '../types.js';
import {
  cosineSimilarity,
  createOllamaEmbeddingCreator,
  EmbeddingStore,
} from './embeddings.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeBook(overrides: Partial<Book> = {}): Pick<Book, 'id' | 'title'> {
  return { id: 'book-1', title: 'It', ...overrides };
}

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

/** Build a Float32Array of varied non-integer values, seeded through
 *  Math.fround so values are exact float32 (matches db.embeddings.test.ts). */
function fakeVector(length: number, seed = 0): Float32Array {
  const vec = new Float32Array(length);
  for (let i = 0; i < length; i++) vec[i] = Math.fround(Math.sin(i + seed) * (i + 1));
  return vec;
}

const databases: CuratorDb[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('createOllamaEmbeddingCreator', () => {
  it('happy path: posts to /api/embed and returns Float32Arrays in order', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://ollama:11434/api/embed');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'nomic-embed-text',
        input: ['a book about dragons', 'a book about space'],
      });
      return jsonResponse(200, {
        model: 'nomic-embed-text',
        embeddings: [
          [1, 2, 3],
          [4, 5, 6],
        ],
      });
    }) as unknown as typeof fetch;

    const creator = createOllamaEmbeddingCreator({ ollamaUrl: 'http://ollama:11434', fetchImpl });
    const vectors = await creator.create({
      model: 'nomic-embed-text',
      input: ['a book about dragons', 'a book about space'],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vectors).toHaveLength(2);
    expect(Array.from(vectors[0]!)).toEqual([1, 2, 3]);
    expect(Array.from(vectors[1]!)).toEqual([4, 5, 6]);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
  });

  it('strips a trailing slash on ollamaUrl so the path has no double slash', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('http://ollama:11434/api/embed');
      return jsonResponse(200, { embeddings: [[1]] });
    }) as unknown as typeof fetch;

    const creator = createOllamaEmbeddingCreator({ ollamaUrl: 'http://ollama:11434/', fetchImpl });
    await creator.create({ model: 'm', input: ['x'] });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns [] without making a request when input is empty', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const creator = createOllamaEmbeddingCreator({ ollamaUrl: 'http://ollama:11434', fetchImpl });

    const result = await creator.create({ model: 'm', input: [] });

    expect(result).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects with AppError LLM_REQUEST on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'boom' })) as unknown as typeof fetch;
    const creator = createOllamaEmbeddingCreator({ ollamaUrl: 'http://ollama:11434', fetchImpl });

    await expect(creator.create({ model: 'm', input: ['x'] })).rejects.toMatchObject({
      code: 'LLM_REQUEST',
    });
    await expect(creator.create({ model: 'm', input: ['x'] })).rejects.toBeInstanceOf(AppError);
  });

  it('rejects with AppError LLM_INVALID_RESPONSE on a malformed body (empty object)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch;
    const creator = createOllamaEmbeddingCreator({ ollamaUrl: 'http://ollama:11434', fetchImpl });

    await expect(creator.create({ model: 'm', input: ['x'] })).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
    });
  });

  it('rejects with AppError LLM_INVALID_RESPONSE on a malformed body (wrong type)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { embeddings: 'nope' })) as unknown as typeof fetch;
    const creator = createOllamaEmbeddingCreator({ ollamaUrl: 'http://ollama:11434', fetchImpl });

    await expect(creator.create({ model: 'm', input: ['x'] })).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
    });
  });

  it('rejects with AppError LLM_INVALID_RESPONSE on a row-count mismatch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { embeddings: [[1, 2]] })) as unknown as typeof fetch;
    const creator = createOllamaEmbeddingCreator({ ollamaUrl: 'http://ollama:11434', fetchImpl });

    await expect(creator.create({ model: 'm', input: ['a', 'b'] })).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
    });
  });

  it('rejects with AppError LLM_REQUEST and preserves cause on a thrown network error', async () => {
    const networkError = new Error('fetch failed: ECONNREFUSED');
    const fetchImpl = vi.fn(async () => {
      throw networkError;
    }) as unknown as typeof fetch;
    const creator = createOllamaEmbeddingCreator({ ollamaUrl: 'http://ollama:11434', fetchImpl });

    try {
      await creator.create({ model: 'm', input: ['x'] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('LLM_REQUEST');
      expect((err as AppError).cause).toBe(networkError);
    }
  });

  it('rejects with AppError LLM_REQUEST when the request aborts on timeout, and actually attaches an abort signal', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;
    const creator = createOllamaEmbeddingCreator({
      ollamaUrl: 'http://ollama:11434',
      fetchImpl,
      timeoutMs: 5,
    });

    await expect(creator.create({ model: 'm', input: ['x'] })).rejects.toMatchObject({
      code: 'LLM_REQUEST',
    });
    // Closes the gap where this test would pass even if timeoutMs were never
    // wired up to an actual AbortSignal.
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects with AppError LLM_INVALID_RESPONSE when a response value is Infinity (zod .finite() boundary)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { embeddings: [[1, Infinity, 3]] })) as unknown as typeof fetch;
    const creator = createOllamaEmbeddingCreator({ ollamaUrl: 'http://ollama:11434', fetchImpl });

    await expect(creator.create({ model: 'm', input: ['x'] })).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
    });
  });

  it('rejects with AppError LLM_INVALID_RESPONSE on a ragged (inconsistent-length) embeddings array', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { embeddings: [[1, 2, 3], [1, 2]] })
    ) as unknown as typeof fetch;
    const creator = createOllamaEmbeddingCreator({ ollamaUrl: 'http://ollama:11434', fetchImpl });

    await expect(creator.create({ model: 'm', input: ['a', 'b'] })).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
    });
  });

  it('classifies a mid-body transport failure (TypeError from a terminated stream) as LLM_REQUEST, not LLM_INVALID_RESPONSE', async () => {
    const transportError = new TypeError('terminated: aborted');
    const brokenResponse = {
      ok: true,
      status: 200,
      json: () => Promise.reject(transportError),
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => brokenResponse) as unknown as typeof fetch;
    const creator = createOllamaEmbeddingCreator({ ollamaUrl: 'http://ollama:11434', fetchImpl });

    try {
      await creator.create({ model: 'm', input: ['x'] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('LLM_REQUEST');
      expect((err as AppError).cause).toBe(transportError);
    }
  });

  it('classifies a genuinely malformed JSON body (SyntaxError) as LLM_INVALID_RESPONSE, distinct from a transport failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json{{{', { status: 200 })) as unknown as typeof fetch;
    const creator = createOllamaEmbeddingCreator({ ollamaUrl: 'http://ollama:11434', fetchImpl });

    await expect(creator.create({ model: 'm', input: ['x'] })).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
    });
  });

  it('does not echo the response body into AppError.detail on a non-2xx (only the status code)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(500, { secretUpstreamDetail: 'must not leak into logs or API responses' })
    ) as unknown as typeof fetch;
    const creator = createOllamaEmbeddingCreator({ ollamaUrl: 'http://ollama:11434', fetchImpl });

    try {
      await creator.create({ model: 'm', input: ['x'] });
      expect.unreachable('should have thrown');
    } catch (err) {
      const detail = JSON.stringify((err as AppError).detail);
      expect(detail).not.toContain('secretUpstreamDetail');
      expect((err as AppError).detail).toEqual({ status: 500 });
    }
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const a = Float32Array.from([1, 2, 3]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('returns 0 when either vector is zero', () => {
    const zero = Float32Array.from([0, 0, 0]);
    const other = Float32Array.from([1, 2, 3]);
    expect(cosineSimilarity(zero, other)).toBe(0);
    expect(cosineSimilarity(other, zero)).toBe(0);
  });

  it('throws AppError VALIDATION on a length mismatch', () => {
    const a = Float32Array.from([1, 2]);
    const b = Float32Array.from([1, 2, 3]);
    expect(() => cosineSimilarity(a, b)).toThrow(AppError);
    try {
      cosineSimilarity(a, b);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe('VALIDATION');
    }
  });
});

function embedding(bookId: string, vector: Float32Array, model = 'nomic-embed-text'): BookEmbedding {
  return { bookId, model, cardHash: `hash-${bookId}`, vector };
}

describe('EmbeddingStore', () => {
  it('normalizes at construction: a vector scaled by 10 scores identically to the unscaled one', () => {
    const base = Float32Array.from([1, 2, 3]);
    const scaled = Float32Array.from([10, 20, 30]);
    const storeBase = new EmbeddingStore([embedding('b1', base)]);
    const storeScaled = new EmbeddingStore([embedding('b1', scaled)]);

    const query = Float32Array.from([0.5, 1, 2]);
    const scoreBase = storeBase.scoreAll(query).get('b1')!;
    const scoreScaled = storeScaled.scoreAll(query).get('b1')!;
    expect(scoreScaled).toBeCloseTo(scoreBase, 5);
  });

  it('normalizes the query too, not just the stored matrix (kills the "raw dot product against an un-normalized query" mutant)', () => {
    // A store that normalizes only the matrix and takes a raw dot product
    // with an un-normalized query would return 3*0.6=... actually the raw
    // dot of [1,0,0] . [3,4,0] = 3, not the cosine 0.6. Every other
    // assertion in this file either uses a unit-length query or compares two
    // stores against the same query, so the scale factor cancels out and a
    // store that forgot to normalize the query would still pass them all.
    // This one pins the absolute score.
    const store = new EmbeddingStore([embedding('a', Float32Array.from([1, 0, 0]))]);
    const query = Float32Array.from([3, 4, 0]); // norm 5, unit vector [0.6, 0.8, 0]

    expect(store.scoreAll(query).get('a')).toBeCloseTo(0.6, 6);
    expect(store.topK(query, 1)[0]!.score).toBeCloseTo(0.6, 6);
  });

  it('topK orders by score DESC then bookId ASC on ties', () => {
    // b1 and b2 share the exact same (normalized) vector -> tie.
    const v = Float32Array.from([1, 0, 0]);
    const store = new EmbeddingStore([
      embedding('zeta', v),
      embedding('alpha', v),
      embedding('mid', Float32Array.from([0, 1, 0])),
    ]);

    const results = store.topK(Float32Array.from([1, 0, 0]), 3);
    expect(results.map((r) => r.bookId)).toEqual(['alpha', 'zeta', 'mid']);
    expect(results[0]!.score).toBeCloseTo(results[1]!.score, 5);
  });

  it('include/exclude filter candidates', () => {
    const v = Float32Array.from([1, 0]);
    const store = new EmbeddingStore([
      embedding('a', v),
      embedding('b', v),
      embedding('c', v),
    ]);

    const included = store.topK(v, 10, { include: new Set(['a', 'b']) });
    expect(included.map((r) => r.bookId).sort()).toEqual(['a', 'b']);

    const excluded = store.topK(v, 10, { exclude: new Set(['a']) });
    expect(excluded.map((r) => r.bookId).sort()).toEqual(['b', 'c']);
  });

  it('clamps k larger than the candidate count and returns [] for k <= 0', () => {
    const v = Float32Array.from([1, 0]);
    const store = new EmbeddingStore([embedding('a', v), embedding('b', v)]);

    expect(store.topK(v, 100)).toHaveLength(2);
    expect(store.topK(v, 0)).toEqual([]);
    expect(store.topK(v, -1)).toEqual([]);
  });

  it('topK(query, 0) validates the query dimension the same way scoreAll does, rather than short-circuiting silently', () => {
    const store = new EmbeddingStore([embedding('a', Float32Array.from([1, 2, 3]))]);
    const mismatched = Float32Array.from([1, 2]);

    expect(() => store.topK(mismatched, 0)).toThrow(AppError);
    expect(() => store.scoreAll(mismatched)).toThrow(AppError);
  });

  it('a non-finite value that survives to a stored vector does not poison the row to NaN/null', () => {
    // 1e40 is finite in float64 (so it would pass a naive z.number() schema)
    // but overflows to Infinity once narrowed to Float32Array — the exact
    // path createOllamaEmbeddingCreator's `Float32Array.from(row)` takes.
    // Simulate a vector that already made it past that narrowing.
    const poisoned = Float32Array.from([1e40, 1, 1]); // -> [Infinity, 1, 1]
    expect(poisoned[0]).toBe(Infinity);

    const store = new EmbeddingStore([
      embedding('poisoned', poisoned),
      embedding('good', Float32Array.from([1, 0, 0])),
    ]);

    const results = store.topK(Float32Array.from([1, 0, 0]), 2);
    const poisonedEntry = results.find((r) => r.bookId === 'poisoned')!;
    const goodEntry = results.find((r) => r.bookId === 'good')!;

    expect(Number.isNaN(poisonedEntry.score)).toBe(false);
    expect(JSON.stringify(poisonedEntry.score)).not.toBe('null');
    // The perfect match must win — the poisoned row must not rank above it.
    expect(results[0]!.bookId).toBe('good');
    expect(goodEntry.score).toBeCloseTo(1, 5);
  });

  it('empty store: size/dim are 0, topK and scoreAll return empty without throwing', () => {
    const store = new EmbeddingStore([]);
    expect(store.size).toBe(0);
    expect(store.dim).toBe(0);
    expect(store.topK(Float32Array.from([1, 2, 3]), 5)).toEqual([]);
    expect(store.scoreAll(Float32Array.from([1, 2, 3])).size).toBe(0);
  });

  it('throws AppError VALIDATION on constructor dimension mismatch', () => {
    expect(() =>
      new EmbeddingStore([
        embedding('a', Float32Array.from([1, 2, 3])),
        embedding('b', Float32Array.from([1, 2])),
      ])
    ).toThrow(AppError);
    try {
      new EmbeddingStore([
        embedding('a', Float32Array.from([1, 2, 3])),
        embedding('b', Float32Array.from([1, 2])),
      ]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe('VALIDATION');
      expect(String((err as AppError).message)).toContain('b');
    }
  });

  it('throws AppError VALIDATION on a query dimension mismatch', () => {
    const store = new EmbeddingStore([embedding('a', Float32Array.from([1, 2, 3]))]);
    expect(() => store.topK(Float32Array.from([1, 2]), 1)).toThrow(AppError);
    try {
      store.scoreAll(Float32Array.from([1, 2]));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe('VALIDATION');
    }
  });

  it('duplicate bookId in entries: last one wins, size counts it once', () => {
    const store = new EmbeddingStore([
      embedding('a', Float32Array.from([1, 0])),
      embedding('a', Float32Array.from([0, 1])),
    ]);
    expect(store.size).toBe(1);
    expect(store.bookIds()).toEqual(['a']);
    const score = store.scoreAll(Float32Array.from([0, 1])).get('a')!;
    expect(score).toBeCloseTo(1, 5);
  });

  it('does not mutate the caller-supplied query array', () => {
    const query = Float32Array.from([3, 4, 0]);
    const original = Float32Array.from(query);
    const store = new EmbeddingStore([embedding('a', Float32Array.from([1, 0, 0]))]);

    store.topK(query, 1);

    expect(Array.from(query)).toEqual(Array.from(original));
  });

  it('has() and vectorFor() reflect stored (normalized) state', () => {
    const store = new EmbeddingStore([embedding('a', Float32Array.from([3, 4]))]);
    expect(store.has('a')).toBe(true);
    expect(store.has('missing')).toBe(false);
    expect(store.vectorFor('missing')).toBeNull();
    const vec = store.vectorFor('a')!;
    expect(Math.hypot(vec[0]!, vec[1]!)).toBeCloseTo(1, 5);
  });
});

describe('EmbeddingStore.fromDb', () => {
  it('loads only rows for the given model and round-trips vectors byte-for-byte before normalization', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-embeddings-'));
    tempDirs.push(dir);
    const db = new CuratorDb(path.join(dir, 'lib.db'));
    databases.push(db);

    addBook(db, makeBook({ id: 'b1', title: 'Book One' }));
    addBook(db, makeBook({ id: 'b2', title: 'Book Two' }));

    const vecA = fakeVector(8, 1);
    const vecB = fakeVector(8, 2);
    db.upsertBookEmbedding(embedding('b1', vecA, 'model-a'));
    db.upsertBookEmbedding(embedding('b2', vecB, 'model-b'));

    const storeA = EmbeddingStore.fromDb(db, 'model-a');
    expect(storeA.size).toBe(1);
    expect(storeA.bookIds()).toEqual(['b1']);

    // Round-trip check: pull the raw stored embedding straight from the db
    // accessor (pre-normalization) and confirm it matches the original
    // Math.fround-clean values exactly.
    const raw = db.getAllBookEmbeddings('model-a');
    expect(raw).toHaveLength(1);
    expect(Array.from(raw[0]!.vector)).toEqual(Array.from(vecA));

    const storeAll = EmbeddingStore.fromDb(db);
    expect(storeAll.bookIds().sort()).toEqual(['b1', 'b2']);
  });
});
