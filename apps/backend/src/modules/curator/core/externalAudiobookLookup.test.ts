import { describe, expect, it, vi } from 'vitest';

import { createItunesAudiobookVerifier } from './externalAudiobookLookup.js';

const candidate = { title: 'Harbor Fog', author: 'M. Shore', reason: 'A coastal mystery.' };

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createItunesAudiobookVerifier', () => {
  it('returns verified iTunes metadata only when title and author match', async () => {
    const fetchImpl = vi.fn(async () => response({ results: [{
      collectionName: 'Harbor Fog (Unabridged)',
      artistName: 'M. Shore',
      trackTimeMillis: 18_000_000,
      artworkUrl100: 'https://example.test/100x100bb.jpg',
    }] })) as unknown as typeof fetch;
    const result = await createItunesAudiobookVerifier({ fetchImpl }).verify(candidate);

    expect(result).toMatchObject({
      title: 'Harbor Fog',
      author: 'M. Shore',
      durationSeconds: 18_000,
      coverUrl: 'https://example.test/300x300bb.jpg',
    });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('Harbor%20Fog%20M.%20Shore'), expect.any(Object));
  });

  it.each([
    ['404', async () => response({}, 404)],
    ['request rejection', async () => { throw new TypeError('offline'); }],
    ['garbage JSON', async () => response('{not-json')],
    ['invalid JSON shape', async () => response({ results: 'not-an-array' })],
    ['title mismatch', async () => response({ results: [{ collectionName: 'Mountain Fire', artistName: 'M. Shore' }] })],
    ['near-collision title', async () => response({ results: [{ collectionName: 'Harbor Fogbound', artistName: 'M. Shore' }] })],
    ['author mismatch', async () => response({ results: [{ collectionName: 'Harbor Fog', artistName: 'Someone Else' }] })],
    ['title prefix', async () => response({ results: [{ collectionName: 'Coastal Tales: Harbor Fog', artistName: 'M. Shore' }] })],
    ['title subtitle', async () => response({ results: [{ collectionName: 'Harbor Fog: A Novel', artistName: 'M. Shore' }] })],
    ['coauthor suffix', async () => response({ results: [{ collectionName: 'Harbor Fog', artistName: 'M. Shore & N. Bay' }] })],
  ])('drops a candidate on %s', async (_label, fetcher) => {
    const verifier = createItunesAudiobookVerifier({ fetchImpl: vi.fn(fetcher) as unknown as typeof fetch });
    await expect(verifier.verify(candidate)).resolves.toBeNull();
  });

  it('does not fold accents when verifying exact title and author identity', async () => {
    const verifier = createItunesAudiobookVerifier({
      fetchImpl: vi.fn(async () => response({ results: [{
        collectionName: 'Harbor Fóg', artistName: 'M. Shóre',
      }] })) as unknown as typeof fetch,
    });
    await expect(verifier.verify(candidate)).resolves.toBeNull();
  });

  it('rejects oversized payload declarations and streamed bodies', async () => {
    const declared = new Response(JSON.stringify({ results: [] }), {
      headers: { 'content-length': '999999' },
    });
    const cases: Response[] = [declared, response({ results: [] as unknown[], padding: 'x'.repeat(300) })];

    for (const item of cases) {
      const verifier = createItunesAudiobookVerifier({
        fetchImpl: vi.fn(async () => item) as unknown as typeof fetch,
        maxResponseBytes: 256,
      });
      await expect(verifier.verify(candidate)).resolves.toBeNull();
    }
  });

  it.each([
    ['result count', { results: Array.from({ length: 6 }, () => ({ collectionName: 'Harbor Fog', artistName: 'M. Shore' })) }],
    ['title length', { results: [{ collectionName: 'x'.repeat(501), artistName: 'M. Shore' }] }],
    ['description length', { results: [{ collectionName: 'Harbor Fog', artistName: 'M. Shore', description: 'x'.repeat(20_001) }] }],
  ])('rejects an oversized %s even within the response byte budget', async (_label, payload) => {
    const verifier = createItunesAudiobookVerifier({
      fetchImpl: vi.fn(async () => response(payload)) as unknown as typeof fetch,
    });
    await expect(verifier.verify(candidate)).resolves.toBeNull();
  });

  it('validates verifier options and per-call constraints', async () => {
    expect(() => createItunesAudiobookVerifier({ timeoutMs: 0 })).toThrow();
    expect(() => createItunesAudiobookVerifier({ maxResponseBytes: 2_000_001 })).toThrow();
    const verifier = createItunesAudiobookVerifier({
      fetchImpl: vi.fn(async () => response({ results: [] })) as unknown as typeof fetch,
    });
    await expect(verifier.verify(candidate, { maxDurationHours: -1 })).resolves.toBeNull();
  });

  it('drops a timed-out candidate without rejecting the batch caller', async () => {
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    const verifier = createItunesAudiobookVerifier({ fetchImpl, timeoutMs: 5 });

    await expect(verifier.verify(candidate)).resolves.toBeNull();
  });

  it('preserves unknown duration when unconstrained and drops it under a strict maximum', async () => {
    const fetchImpl = vi.fn(async () => response({ results: [{
      collectionName: 'Harbor Fog', artistName: 'M. Shore',
    }] })) as unknown as typeof fetch;
    const verifier = createItunesAudiobookVerifier({ fetchImpl });

    await expect(verifier.verify(candidate)).resolves.toMatchObject({ durationSeconds: null });
    await expect(verifier.verify(candidate, { maxDurationHours: 6 })).resolves.toBeNull();
  });

  it('drops a known runtime over a strict maximum', async () => {
    const fetchImpl = vi.fn(async () => response({ results: [{
      collectionName: 'Harbor Fog', artistName: 'M. Shore', trackTimeMillis: 30_000_000,
    }] })) as unknown as typeof fetch;

    await expect(createItunesAudiobookVerifier({ fetchImpl }).verify(candidate, { maxDurationHours: 6 }))
      .resolves.toBeNull();
  });
});
