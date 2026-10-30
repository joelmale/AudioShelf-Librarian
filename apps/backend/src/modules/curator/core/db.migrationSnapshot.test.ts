import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CuratorDb } from './db.js';

describe('CuratorDb pre-migration snapshot', () => {
  let dir: string;
  let dbPath: string;
  const snapshots = () => fs.readdirSync(dir).filter((name) => name.startsWith('curator.db.pre-migrate-'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asl-migrate-'));
    dbPath = path.join(dir, 'curator.db');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Make an up-to-date database look like it predates the last migration. */
  function rewindLastMigration(): void {
    const raw = new Database(dbPath);
    raw.exec('DELETE FROM schema_migrations WHERE version = 3; DROP TABLE acquisitions;');
    raw.close();
  }

  it('writes no snapshot for a new database or an ordinary restart', () => {
    new CuratorDb(dbPath).close();
    new CuratorDb(dbPath).close();
    expect(snapshots()).toEqual([]);
  });

  it('snapshots the pre-migration data before a migration changes the schema', () => {
    const first = new CuratorDb(dbPath);
    first.close();
    rewindLastMigration();

    new CuratorDb(dbPath).close();
    const [snapshot] = snapshots();
    expect(snapshot).toBeDefined();
    const copy = new Database(path.join(dir, snapshot), { readonly: true });
    try {
      // The snapshot is the state BEFORE migrating: the rewound table is absent.
      expect(copy.prepare("SELECT name FROM sqlite_master WHERE name = 'acquisitions'").get()).toBeUndefined();
    } finally {
      copy.close();
    }
    // And the live database did migrate.
    const live = new Database(dbPath, { readonly: true });
    try {
      expect(live.prepare("SELECT name FROM sqlite_master WHERE name = 'acquisitions'").get()).toBeDefined();
    } finally {
      live.close();
    }
  });

  it('keeps only the newest three snapshots', () => {
    new CuratorDb(dbPath).close();
    for (let i = 0; i < 4; i += 1) {
      rewindLastMigration();
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1 + i)));
      new CuratorDb(dbPath).close();
    }
    vi.useRealTimers();
    expect(snapshots()).toHaveLength(3);
  });
});
