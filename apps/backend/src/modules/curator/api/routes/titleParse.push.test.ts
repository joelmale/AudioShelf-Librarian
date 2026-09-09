/**
 * Route-level tests for `POST /title-parse/push` — the only place in the
 * system that renames a book in ABS, which has no undo.
 *
 * The parser's own semantics live in core/enrichment/titleParse.test.ts.
 * These cover only what the route decides: which books make the plan, and
 * what actually reaches `updateBookMetadata`.
 */
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../../core/db.js';
import { parseTitle } from '../../core/enrichment/titleParse.js';
import type { Book } from '../../core/types.js';
import { errorHandler } from '../http.js';
import type { ApiServices } from '../services.js';
import { createTitleParseRouter } from './titleParse.js';

/** The real shape, with the real (wrong) author ABS carries for this shelf. */
const XANTH: Book = {
  id: 'xanth-29',
  title: 'Piers Anthony- Xanth- 29- Pet Peeve',
  author: 'Xanth Series',
  series: null,
  seriesSequence: null,
  durationSeconds: 3600,
  publishedYear: null,
  genres: [],
  description: null,
  coverPath: null,
  absAddedAt: null,
  lastSyncedAt: 1000,
};

const databases: CuratorDb[] = [];
const servers: import('node:http').Server[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

interface AbsCall {
  bookId: string;
  metadata: Record<string, string>;
}

function buildApp(db: CuratorDb, subtitle: string | null, calls: AbsCall[]) {
  const app = express();
  app.use(express.json());
  const noop = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
  const services = {
    db,
    config: { taggingConcurrency: 2 },
    logger: noop,
    actionLog: { record: () => {} },
    operations: { create: () => ({ id: 'op', status: 'running' }) },
    absClient: {
      getBook: () => Promise.resolve({ id: XANTH.id, media: { metadata: { subtitle } } }),
      updateBookMetadata: (bookId: string, metadata: Record<string, string>) => {
        calls.push({ bookId, metadata });
        return Promise.resolve();
      },
    },
  } as unknown as ApiServices;
  app.use('/api', createTitleParseRouter(services));
  app.use(errorHandler(noop as never));
  return app;
}

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

function seed(subtitle: string | null): { db: CuratorDb; calls: AbsCall[]; app: express.Express } {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  db.upsertBook(XANTH);
  db.updateTitleParse(XANTH.id, parseTitle(XANTH.title, XANTH.author));
  const calls: AbsCall[] = [];
  return { db, calls, app: buildApp(db, subtitle, calls) };
}

async function push(app: express.Express, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${await listen(app)}/api/title-parse/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe('POST /title-parse/push — the Xanth shape', () => {
  it('plans nothing at default confidence, because the parse is inferred', async () => {
    const { app, calls } = seed(null);
    const body = await push(app, { dryRun: true });
    expect(body.planned).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('writes title, author and a Series NN subtitle when low confidence is included', async () => {
    const { app, calls } = seed(null);
    const plan = await push(app, { dryRun: true, includeLowConfidence: true });
    expect(plan.changes[0]).toMatchObject({
      from: 'Piers Anthony- Xanth- 29- Pet Peeve',
      to: 'Pet Peeve',
      series: 'Xanth',
      sequence: 29,
      author: 'Piers Anthony',
      subtitle: 'Xanth 29',
    });

    const { app: app2, calls: calls2 } = seed(null);
    await push(app2, { dryRun: false, includeLowConfidence: true });
    expect(calls2).toHaveLength(1);
    expect(calls2[0]!.metadata).toEqual({
      title: 'Pet Peeve',
      series: 'Xanth',
      sequence: '29',
      author: 'Piers Anthony',
      subtitle: 'Xanth 29',
    });
    // The route's contract is the flat shape; absClient is what reshapes
    // `series` into ABS's array. Covered directly in absClient.series.test.ts.

    expect(calls).toHaveLength(0);
  });

  it('never clobbers a subtitle someone already set', async () => {
    const { app } = seed('A Xanth Novel');
    const plan = await push(app, { dryRun: true, includeLowConfidence: true });
    expect(plan.changes[0].subtitle).toBeUndefined();
    expect(plan.changes[0].subtitleKept).toBe('A Xanth Novel');
    // The rename still happens — only the subtitle is left alone.
    expect(plan.changes[0].to).toBe('Pet Peeve');
  });

  it('overwrites an existing subtitle only when explicitly told to', async () => {
    const { app } = seed('A Xanth Novel');
    const plan = await push(app, { dryRun: true, includeLowConfidence: true, overwriteSubtitle: true });
    expect(plan.changes[0].subtitle).toBe('Xanth 29');
    expect(plan.changes[0].subtitleKept).toBeUndefined();
  });

  it('leaves an already-correct subtitle out of the write', async () => {
    const { app } = seed('Xanth 29');
    const plan = await push(app, { dryRun: true, includeLowConfidence: true });
    expect(plan.changes[0].subtitle).toBeUndefined();
    expect(plan.changes[0].subtitleKept).toBeUndefined();
  });

  it('honours pushSubtitle: false', async () => {
    const { app } = seed(null);
    const plan = await push(app, { dryRun: true, includeLowConfidence: true, pushSubtitle: false });
    expect(plan.changes[0].subtitle).toBeUndefined();
    expect(plan.changes[0].to).toBe('Pet Peeve');
  });
});

/**
 * The state a partial failure leaves behind: the title landed, the series did
 * not. The parse still knows the series; the renamed title no longer does.
 */
describe('POST /title-parse/push — resuming after a partial push', () => {
  function seedApplied(absSeries: string | null): { calls: AbsCall[]; app: express.Express } {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    // Parse the ORIGINAL title, then record the world as it is after the
    // title push landed but the series did not.
    const parse = parseTitle(XANTH.title, XANTH.author);
    db.upsertBook(XANTH);
    db.updateTitleParse(XANTH.id, parse);
    db.upsertBook({ ...XANTH, title: 'Pet Peeve', author: 'Piers Anthony', series: absSeries });
    const calls: AbsCall[] = [];
    return { calls, app: buildApp(db, 'Xanth 29', calls) };
  }

  it('repairs the series without counting the parse as stale', async () => {
    const { app } = seedApplied(null);
    const plan = await push(app, { dryRun: true, includeLowConfidence: true });
    expect(plan.skippedStaleParse).toBe(0);
    expect(plan.planned).toBe(1);
    expect(plan.changes[0]).toMatchObject({ series: 'Xanth', sequence: 29 });
  });

  it('does not resend the title it already set', async () => {
    const { app, calls } = seedApplied(null);
    await push(app, { dryRun: false, includeLowConfidence: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.metadata).not.toHaveProperty('title');
    expect(calls[0]!.metadata.series).toBe('Xanth');
  });

  it('replaces a doubled series rather than adding to it', async () => {
    const { app, calls } = seedApplied('Xanth Series, Xanth');
    await push(app, { dryRun: false, includeLowConfidence: true });
    expect(calls[0]!.metadata.series).toBe('Xanth');
    expect(calls[0]!.metadata.sequence).toBe('29');
  });

  it('still refuses a genuinely stale parse', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    db.upsertBook(XANTH);
    db.updateTitleParse(XANTH.id, parseTitle(XANTH.title, XANTH.author));
    // Someone renamed it to something that is NOT this parse's output.
    db.upsertBook({ ...XANTH, title: 'Pet Peeve: A Xanth Novel' });
    const calls: AbsCall[] = [];
    const plan = await push(buildApp(db, null, calls), { dryRun: true, includeLowConfidence: true });
    expect(plan.skippedStaleParse).toBe(1);
    expect(plan.planned).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
