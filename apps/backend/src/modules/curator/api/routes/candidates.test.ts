import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../../core/db.js';
import { errorHandler } from '../http.js';
import type { ApiServices } from '../services.js';
import { createCandidatesRouter } from './candidates.js';

const databases: CuratorDb[] = [];
const servers: import('node:http').Server[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.restoreAllMocks();
});

async function setupServer(): Promise<{ baseUrl: string; db: CuratorDb }> {
  const db = new CuratorDb(':memory:');
  databases.push(db);

  const services = {
    db,
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  } as unknown as ApiServices;

  const app = express();
  app.use(express.json());
  app.use('/api', createCandidatesRouter(services));
  app.use(errorHandler(services.logger));

  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  return { baseUrl, db };
}

describe('Candidates API Router', () => {
  it('handles candidate intent creation, duplicate requests, and revision conflicts', async () => {
    const { baseUrl, db } = await setupServer();

    // Create a candidate first
    db.upsertCandidate({
      id: 'cand_audible_b0123',
      source: 'audible',
      sourceItemId: 'B0123',
      sourceUrl: 'https://audible.com/pd/B0123',
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      narrator: 'Ray Porter',
      coverUrl: null,
      description: 'Science fiction adventure',
    });

    // 1. Set intent to 'want'
    const res1 = await fetch(`${baseUrl}/api/candidates/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidateId: 'cand_audible_b0123',
        intent: 'want',
      }),
    });

    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.success).toBe(true);
    expect(body1.intent.candidateId).toBe('cand_audible_b0123');
    expect(body1.intent.intent).toBe('want');
    expect(body1.intent.revision).toBe(1);

    // 2. Duplicate submission with same intent is idempotent (not an error, returns duplicate: true)
    const resDuplicate = await fetch(`${baseUrl}/api/candidates/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidateId: 'cand_audible_b0123',
        intent: 'want',
      }),
    });
    expect(resDuplicate.status).toBe(200);
    const bodyDuplicate = await resDuplicate.json();
    expect(bodyDuplicate.duplicate).toBe(true);
    expect(bodyDuplicate.intent.revision).toBe(1);

    // 3. Stale revision conflict (expectedRevision: 0 when current is 1)
    const resConflict = await fetch(`${baseUrl}/api/candidates/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidateId: 'cand_audible_b0123',
        intent: 'later',
        expectedRevision: 0,
      }),
    });
    expect(resConflict.status).toBe(409);
    const bodyConflict = await resConflict.json();
    expect(bodyConflict.error).toBe('revision_conflict');
    expect(bodyConflict.currentRevision).toBe(1);

    // 4. Successful update to 'pass' with correct expectedRevision
    const res2 = await fetch(`${baseUrl}/api/candidates/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidateId: 'cand_audible_b0123',
        intent: 'pass',
        expectedRevision: 1,
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.intent.intent).toBe('pass');
    expect(body2.intent.revision).toBe(2);

    // 5. Undo intent
    const resUndo = await fetch(`${baseUrl}/api/candidates/intent/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidateId: 'cand_audible_b0123',
      }),
    });
    expect(resUndo.status).toBe(200);
    const bodyUndo = await resUndo.json();
    expect(bodyUndo.restoredIntent).toBe('want');
    expect(bodyUndo.intent.intent).toBe('want');
    expect(bodyUndo.intent.revision).toBe(3);
  });

  it('lists saved candidates by intent with totals', async () => {
    const { baseUrl, db } = await setupServer();

    db.upsertCandidate({
      id: 'cand_audible_book1',
      source: 'audible',
      title: 'Book 1',
      author: 'Author 1',
    });
    db.upsertCandidate({
      id: 'cand_apple_book2',
      source: 'apple',
      title: 'Book 2',
      author: 'Author 2',
    });

    db.setCandidateIntent({ actorId: 'internal', candidateId: 'cand_audible_book1', intent: 'want' });
    db.setCandidateIntent({ actorId: 'internal', candidateId: 'cand_apple_book2', intent: 'later' });

    // Query all
    const resAll = await fetch(`${baseUrl}/api/candidates/saved`);
    expect(resAll.status).toBe(200);
    const bodyAll = await resAll.json();
    expect(bodyAll.items).toHaveLength(2);
    expect(bodyAll.totals.all).toBe(2);
    expect(bodyAll.totals.want).toBe(1);
    expect(bodyAll.totals.later).toBe(1);
    expect(bodyAll.totals.pass).toBe(0);

    // Filter by want
    const resWant = await fetch(`${baseUrl}/api/candidates/saved?intent=want`);
    const bodyWant = await resWant.json();
    expect(bodyWant.items).toHaveLength(1);
    expect(bodyWant.items[0].candidate.id).toBe('cand_audible_book1');
    expect(bodyWant.items[0].intent.intent).toBe('want');
  });

  it('serves source freshness snapshots', async () => {
    const { baseUrl, db } = await setupServer();

    db.saveSourceSnapshot({
      source: 'audible',
      status: 'ready',
      lastAttemptAt: Date.now(),
      attributionUrl: 'https://audible.com/charts/best',
      itemCount: 20,
      errorMessage: null,
      snapshotJson: '[]',
      updatedAt: Date.now(),
    });

    const res = await fetch(`${baseUrl}/api/candidates/sources`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audible).toBeDefined();
    expect(body.audible.status).toBe('ready');
    expect(body.audible.itemCount).toBe(20);
  });
});
