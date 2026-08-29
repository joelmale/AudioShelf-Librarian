/**
 * Route test for the curator.db download.
 *
 * The thing worth proving is not that bytes come back — it is that what comes
 * back is a *usable, complete* SQLite database. A plain file copy of a live
 * WAL-mode database returns a plausible file that silently omits the most
 * recent writes, which is the exact failure this endpoint uses `VACUUM INTO`
 * to avoid. So the test opens the downloaded bytes as a database and reads a
 * row written moments before the request.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../../core/db.js';
import type { Book } from '../../core/types.js';
import { errorHandler } from '../http.js';
import type { ApiServices } from '../services.js';
import { createCuratorApiRouter } from '../server.js';

const databases: CuratorDb[] = [];
const servers: import('node:http').Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const nullLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

function addBook(db: CuratorDb, id: string, title: string): void {
  db.upsertBook({
    id,
    title,
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: 1_000,
  } as Book);
}

async function listen(db: CuratorDb): Promise<string> {
  const services = {
    db,
    config: { embeddingModel: 'test-model', taggingConcurrency: 2 },
    logger: nullLogger,
    actionLog: { record: () => {} },
    operations: { list: () => [] },
    absClient: {},
    absSocketClient: {},
    llmClient: {},
    embeddingCreator: {},
    encodeHub: { subscribe: () => () => {} },
    encodeWorker: {},
  } as unknown as ApiServices;

  const app = express();
  app.use(express.json());
  app.use('/api', createCuratorApiRouter(services));
  app.use(errorHandler(nullLogger as never));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

/** A real on-disk WAL database, so the WAL-omission failure is reachable. */
function onDiskDb(): CuratorDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asl-snapshot-src-'));
  tempDirs.push(dir);
  const db = new CuratorDb(path.join(dir, 'curator.db'));
  databases.push(db);
  return db;
}

describe('GET /api/database/snapshot', () => {
  it('returns a complete, openable database including writes still in the WAL', async () => {
    const db = onDiskDb();
    addBook(db, 'b1', 'Written Before The Request');
    const base = await listen(db);

    const res = await fetch(`${base}/api/database/snapshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/filename="curator-snapshot-\d{4}-\d{2}-\d{2}\.db"/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asl-snapshot-out-'));
    tempDirs.push(dir);
    const out = path.join(dir, 'downloaded-snapshot.db');
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));

    const copy = new Database(out, { readonly: true });
    try {
      const row = copy.prepare('SELECT title FROM books WHERE id = ?').get('b1') as { title: string } | undefined;
      // A plain `cp` of a WAL-mode database would plausibly miss this row.
      expect(row?.title).toBe('Written Before The Request');
    } finally {
      copy.close();
    }
  });

  it('advertises a filename the acceptance harness will accept', async () => {
    // `retrieval/acceptanceSnapshot.ts` refuses any basename without
    // "snapshot" in it, so the download must be usable as-is.
    const db = onDiskDb();
    const base = await listen(db);

    const res = await fetch(`${base}/api/database/snapshot`);
    const disposition = res.headers.get('content-disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? '';
    await res.arrayBuffer();

    expect(filename.toLowerCase()).toContain('snapshot');
    expect(filename).not.toBe('curator.db');
  });

  it('leaves no temp database behind after the download', async () => {
    // Counts only the endpoint's own prefix; this test's scratch dirs use a
    // different one so the check cannot count itself.
    const db = onDiskDb();
    const base = await listen(db);
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('curator-snapshot-')).length;

    const res = await fetch(`${base}/api/database/snapshot`);
    await res.arrayBuffer();

    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('curator-snapshot-')).length;
    expect(after).toBe(before);
  });
});
