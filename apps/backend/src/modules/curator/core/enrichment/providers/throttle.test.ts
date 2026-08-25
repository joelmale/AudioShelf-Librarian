import { describe, expect, it } from 'vitest';

import { RateLimiter, isRateLimited, markRateLimited, parseRetryAfter } from './throttle.js';

describe('RateLimiter', () => {
  it('spaces sequential acquisitions by at least the interval', async () => {
    const limiter = new RateLimiter(40);
    const start = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    // Two gaps of 40ms between three acquisitions.
    expect(Date.now() - start).toBeGreaterThanOrEqual(70);
  });

  it('spaces CONCURRENT acquisitions too — the pool shares one gate', async () => {
    const limiter = new RateLimiter(30);
    const start = Date.now();
    // Four books hitting the same provider at once, as the p-limit pool does.
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });

  it('does not delay the very first acquisition', async () => {
    const limiter = new RateLimiter(1_000);
    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('penalize() delays the next slot for every caller', async () => {
    const limiter = new RateLimiter(0);
    await limiter.acquire();
    limiter.penalize(60);
    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('penalize() only ever pushes the deadline later', async () => {
    const limiter = new RateLimiter(0);
    limiter.penalize(120);
    limiter.penalize(1); // must not pull the deadline in
    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });

  it('ignores non-positive and non-finite penalties', async () => {
    const limiter = new RateLimiter(0);
    limiter.penalize(0);
    limiter.penalize(-500);
    limiter.penalize(Number.NaN);
    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('a zero interval imposes no delay', async () => {
    const limiter = new RateLimiter(0);
    const start = Date.now();
    for (let i = 0; i < 20; i += 1) await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
  });

  it('parses an HTTP-date relative to now', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(parseRetryAfter(new Date(now + 20_000).toUTCString(), now)).toBe(20_000);
  });

  it('clamps to five minutes so a bad header cannot stall a run', () => {
    expect(parseRetryAfter('99999')).toBe(300_000);
  });

  it('never returns a negative delay for a past date', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(parseRetryAfter(new Date(now - 60_000).toUTCString(), now)).toBe(0);
  });

  it('returns null when absent or unparseable', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('soon-ish')).toBeNull();
  });
});

describe('rate-limit marking', () => {
  it('round-trips through mark/is', () => {
    const err = markRateLimited(new Error('429'));
    expect(isRateLimited(err)).toBe(true);
  });

  it('is false for ordinary errors and non-objects', () => {
    expect(isRateLimited(new Error('boom'))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
    expect(isRateLimited('429')).toBe(false);
  });

  it('does not make the marker enumerable (it must not leak into JSON)', () => {
    const err = markRateLimited(new Error('429'));
    expect(Object.keys(err)).toHaveLength(0);
  });
});
