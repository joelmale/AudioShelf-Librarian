import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CuratorDb } from '../db.js';
import { OperationRegistry } from '../operations.js';
import type { ABSClient } from '../absClient.js';
import type { AbsSocketClient } from '../absSocketClient.js';
import { EncodeQueueWorker } from './encodeEngine.js';

const HOUR = 60 * 60 * 1000;

describe('EncodeQueueWorker run limit', () => {
  let dir: string;
  let db: CuratorDb;
  let clock: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-encode-'));
    db = new CuratorDb(path.join(dir, 'curator.db'));
    clock = 1_000_000;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function build() {
    const absClient = {
      isItemEncoded: vi.fn().mockResolvedValue(false),
      getBook: vi.fn().mockResolvedValue({}),
      encodeBookToM4b: vi.fn().mockResolvedValue(undefined),
    } as unknown as ABSClient;
    const absSocketClient = { watchItem: vi.fn(), unwatchItem: vi.fn(), forceComplete: vi.fn() } as unknown as AbsSocketClient;
    const operations = new OperationRegistry();
    const worker = new EncodeQueueWorker({
      config: {}, db, absClient, absSocketClient, operations, now: () => clock, maxRunMs: 2 * HOUR,
    });
    return { worker, operations };
  }

  const enqueue = (id: string, order: number) => db.insertEncodeQueueItem({
    id, libraryId: 'lib', name: id, author: 'A', totalBytes: 10, sortOrder: order, addedAt: clock,
  });

  it('abandons an encode Audiobookshelf never finishes and moves on to the next book', async () => {
    enqueue('lost', 1);
    enqueue('next', 2);
    const { worker } = build();
    const tick = () => (worker as unknown as { tick(): Promise<void> }).tick();

    await tick();
    expect(db.listEncodeQueue().find((q) => q.id === 'lost')?.status).toBe('running');

    clock += HOUR;
    await tick();
    expect(db.listEncodeQueue().find((q) => q.id === 'lost')?.status).toBe('running');

    clock += 2 * HOUR;
    await tick();
    const lost = db.listEncodeHistory().find((h) => h.libraryItemId === 'lost');
    expect(lost?.status).toBe('error');
    expect(db.listEncodeQueue().find((q) => q.id === 'lost')).toBeUndefined();
    expect(db.listEncodeQueue().find((q) => q.id === 'next')?.status).toBe('running');
  });
});
