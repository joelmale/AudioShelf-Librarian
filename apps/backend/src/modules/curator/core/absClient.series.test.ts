/**
 * `updateBookMetadata` is the only thing in the system that writes to ABS.
 *
 * These exist because a wrong payload shape here does not fail loudly: ABS
 * answers 200, applies the fields it recognises, and silently drops the rest.
 * A 23-book push reported 23 successes and set the series on 5.
 */
import { describe, expect, it, vi } from 'vitest';

import { ABSClient } from './absClient.js';

function clientWithCapture(): { client: ABSClient; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchMock = vi.fn(async (_url: string, init: { body?: string }) => {
    bodies.push(JSON.parse(init.body ?? '{}'));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new ABSClient('http://abs.test', 'token');
  return { client, bodies };
}

describe('ABSClient.updateBookMetadata', () => {
  it('sends series as an array of { name, sequence }, the shape ABS models', async () => {
    const { client, bodies } = clientWithCapture();
    await client.updateBookMetadata('b1', {
      title: 'Pet Peeve',
      subtitle: 'Xanth 29',
      author: 'Piers Anthony',
      series: 'Xanth',
      sequence: '29',
    });
    expect(bodies[0]).toEqual({
      metadata: {
        title: 'Pet Peeve',
        subtitle: 'Xanth 29',
        author: 'Piers Anthony',
        series: [{ name: 'Xanth', sequence: '29' }],
      },
    });
  });

  it('never sends a bare `sequence` key, which ABS does not model', async () => {
    const { client, bodies } = clientWithCapture();
    await client.updateBookMetadata('b1', { series: 'Xanth', sequence: '29' });
    expect(bodies[0]).not.toHaveProperty('metadata.sequence');
  });

  it('omits the sequence from the entry when there is none', async () => {
    const { client, bodies } = clientWithCapture();
    await client.updateBookMetadata('b1', { series: 'Xanth' });
    expect(bodies[0]).toEqual({ metadata: { series: [{ name: 'Xanth' }] } });
  });

  it('leaves series untouched when the caller did not supply one', async () => {
    const { client, bodies } = clientWithCapture();
    await client.updateBookMetadata('b1', { title: 'Pet Peeve' });
    expect(bodies[0]).toEqual({ metadata: { title: 'Pet Peeve' } });
  });

  it('sends nothing at all when there is nothing to change', async () => {
    const { client, bodies } = clientWithCapture();
    await client.updateBookMetadata('b1', {});
    expect(bodies).toHaveLength(0);
  });
});
