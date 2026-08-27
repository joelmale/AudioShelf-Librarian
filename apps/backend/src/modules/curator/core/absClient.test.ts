import { describe, expect, it, vi } from 'vitest';

import { ABSClient } from './absClient.js';
import { nullLogger } from './logger.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Build a client over a scripted fetch. `routes` maps a path suffix to the
 * response (or an Error to throw); anything unmatched 404s, so a test that
 * silently hits an endpoint it did not script fails loudly.
 */
function client(routes: Record<string, Response | Error | (() => Response)>) {
  const calls: Array<{ method: string; path: string }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ method: init?.method ?? 'GET', path });
    const route = routes[path];
    if (route instanceof Error) throw route;
    if (typeof route === 'function') return route();
    return route ?? new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return {
    abs: new ABSClient('http://abs.local', 'token', { fetchImpl, logger: nullLogger }),
    calls,
    fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
  };
}

const ENCODE_PATH = '/api/tools/item/book-1/encode-m4b';

describe('ABSClient.getServerVersion', () => {
  it('reads serverVersion from /status', async () => {
    const { abs } = client({ '/status': jsonResponse({ isInit: true, serverVersion: '2.17.4' }) });
    expect(await abs.getServerVersion()).toBe('2.17.4');
  });

  it('accepts the alternate `version` spelling', async () => {
    const { abs } = client({ '/status': jsonResponse({ version: '2.9.0' }) });
    expect(await abs.getServerVersion()).toBe('2.9.0');
  });

  it('caches a successful probe instead of asking on every call', async () => {
    const { abs, calls } = client({ '/status': () => jsonResponse({ serverVersion: '2.17.4' }) });

    await abs.getServerVersion();
    await abs.getServerVersion();
    await abs.getServerVersion();

    expect(calls.filter((c) => c.path === '/status')).toHaveLength(1);
  });

  it('returns null rather than throwing when ABS is unreachable', async () => {
    const { abs } = client({ '/status': new Error('ECONNREFUSED') });
    expect(await abs.getServerVersion()).toBeNull();
  });

  it('returns null when ABS reports no version at all', async () => {
    const { abs } = client({ '/status': jsonResponse({ isInit: true }) });
    expect(await abs.getServerVersion()).toBeNull();
  });

  /**
   * A failed probe must not be cached: one blip while ABS restarts would
   * otherwise downgrade every later version check for the life of the process.
   */
  it('retries after a failed probe rather than caching the failure', async () => {
    let attempt = 0;
    const { abs } = client({
      '/status': () => {
        attempt += 1;
        return attempt === 1 ? new Response('down', { status: 503 }) : jsonResponse({ serverVersion: '2.17.4' });
      },
    });

    expect(await abs.getServerVersion()).toBeNull();
    expect(await abs.getServerVersion()).toBe('2.17.4');
  });
});

/**
 * Regression guard for the queue that did nothing. The gate used to read
 * `process.env.ABS_COMPAT_VERSION`, which was set in no compose file,
 * Dockerfile, or config — so it was always `''`, always failed the
 * `startsWith('2.')` test, and threw before any request reached ABS.
 */
describe('ABSClient.encodeBookToM4b', () => {
  it('posts the encode request when ABS reports 2.x', async () => {
    const { abs, calls } = client({
      '/status': jsonResponse({ serverVersion: '2.17.4' }),
      [ENCODE_PATH]: new Response('OK', { status: 200 }),
    });

    await abs.encodeBookToM4b('book-1');

    expect(calls).toContainEqual({ method: 'POST', path: ENCODE_PATH });
  });

  it('does not depend on ABS_COMPAT_VERSION being set', async () => {
    const previous = process.env.ABS_COMPAT_VERSION;
    delete process.env.ABS_COMPAT_VERSION;
    try {
      const { abs, calls } = client({
        '/status': jsonResponse({ serverVersion: '2.17.4' }),
        [ENCODE_PATH]: new Response('OK', { status: 200 }),
      });

      await abs.encodeBookToM4b('book-1');

      expect(calls).toContainEqual({ method: 'POST', path: ENCODE_PATH });
    } finally {
      if (previous === undefined) delete process.env.ABS_COMPAT_VERSION;
      else process.env.ABS_COMPAT_VERSION = previous;
    }
  });

  it('refuses on a server that reports 1.x, naming the version it saw', async () => {
    const { abs, calls } = client({
      '/status': jsonResponse({ serverVersion: '1.7.2' }),
      [ENCODE_PATH]: new Response('OK', { status: 200 }),
    });

    await expect(abs.encodeBookToM4b('book-1')).rejects.toThrow(/reports version 1\.7\.2/);
    expect(calls.some((c) => c.path === ENCODE_PATH)).toBe(false);
  });

  /**
   * An unknown version proceeds. If the endpoint really is missing, ABS's own
   * 404 says so; refusing locally would be indistinguishable from the feature
   * being switched off, which is exactly the failure this replaced.
   */
  it('attempts the encode when the version cannot be determined', async () => {
    const { abs, calls } = client({
      '/status': new Error('ECONNREFUSED'),
      [ENCODE_PATH]: new Response('OK', { status: 200 }),
    });

    await abs.encodeBookToM4b('book-1');

    expect(calls).toContainEqual({ method: 'POST', path: ENCODE_PATH });
  });

  it('surfaces the ABS error when the endpoint is absent on an unknown version', async () => {
    const { abs } = client({
      '/status': jsonResponse({ isInit: true }),
      [ENCODE_PATH]: new Response('not found', { status: 404 }),
    });

    await expect(abs.encodeBookToM4b('book-1')).rejects.toThrow(/404/);
  });
});
