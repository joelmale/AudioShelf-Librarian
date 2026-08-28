import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../../core/db.js';
import type { RecommendationInterpreter } from '../../core/llmClient.js';
import type { Book } from '../../core/types.js';
import { errorHandler } from '../http.js';
import type { ApiServices } from '../services.js';
import { createRecommendationsRouter } from './recommendations.js';

const databases: CuratorDb[] = [];
const servers: import('node:http').Server[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.restoreAllMocks();
});

function addBook(db: CuratorDb): void {
  db.upsertBook({
    id: 'shelf-1',
    title: 'Shelf Mystery',
    author: 'A. Writer',
    series: null,
    seriesSequence: null,
    durationSeconds: 18_000,
    publishedYear: 2020,
    genres: ['Mystery'],
    description: 'A beach mystery.',
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
  } as Book);
}

async function listen(): Promise<{ baseUrl: string; interpreter: RecommendationInterpreter }> {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  addBook(db);
  const interpreter: RecommendationInterpreter = {
    async planRecommendations(request) {
      return {
        plan: {
          semanticQuery: request || 'similar to selected seed',
          maxDurationHours: null,
          requiredTags: [],
          excludeTags: [],
          preferredTags: [],
          softExcludeTags: [],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async generateCandidateRecommendations() {
      return {
        recommendations: {
          interpretation: 'A beach mystery.',
          constraints: { maxDurationHours: null, genres: ['mystery'], moods: [] },
          shelf: [{ bookId: 'shelf-1', reason: 'It is a beach mystery.' }],
          external: [],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const services = {
    db,
    llmClient: interpreter,
    config: { embeddingModel: '' },
    embeddingCreator: { create: async () => { throw new Error('must not run without a configured model'); } },
  } as unknown as ApiServices;
  const app = express();
  app.use(express.json());
  app.use('/api', createRecommendationsRouter(services));
  app.use(errorHandler({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as never));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
    interpreter,
  };
}

async function post(scope?: 'both' | 'shelf' | 'discover') {
  const { baseUrl } = await listen();
  const response = await fetch(`${baseUrl}/api/recommendations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'A murder mystery at the beach', seedBookIds: [], ...(scope ? { scope } : {}) }),
  });
  return { response, body: await response.json() as { scope: string; onShelf: Book[]; available: unknown[] } };
}

async function postBody(body: unknown) {
  const { baseUrl } = await listen();
  const response = await fetch(`${baseUrl}/api/recommendations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

describe('POST /api/recommendations', () => {
  it('defaults omitted scope to both and keeps shelf results visible', async () => {
    const { response, body } = await post();
    expect(response.status).toBe(200);
    expect(body.scope).toBe('both');
    expect(body.onShelf.map((book) => book.id)).toEqual(['shelf-1']);
  });

  it('honors explicit discover scope', async () => {
    const { body } = await post('discover');
    expect(body.scope).toBe('discover');
    expect(body.onShelf).toEqual([]);
  });

  it('honors explicit shelf scope', async () => {
    const { body } = await post('shelf');
    expect(body.scope).toBe('shelf');
    expect(body.onShelf.map((book) => book.id)).toEqual(['shelf-1']);
    expect(body.available).toEqual([]);
  });

  it('rejects a blank prompt when trimmed seed ids do not resolve', async () => {
    const { response } = await postBody({ prompt: ' ', seedBookIds: ['   ', 'missing'] });
    expect(response.status).toBe(400);
  });

  it('hydrates trimmed ids and accepts a seed-only request', async () => {
    const { response, body } = await postBody({ prompt: ' ', seedBookIds: [' shelf-1 '] });
    expect(response.status).toBe(200);
    expect(body.scope).toBe('both');
  });
});
