import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from './db.js';

const tempDirs: string[] = [];
const databases: CuratorDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-conversation-db-'));
  tempDirs.push(dir);
  return path.join(dir, 'curator.db');
}

function open(file: string): CuratorDb {
  const db = new CuratorDb(file);
  databases.push(db);
  return db;
}

const answered = {
  type: 'done' as const,
  status: 'answered' as const,
  rounds: 1,
  tokensUsed: { inputTokens: 1, outputTokens: 1 },
};

describe('conversation thread storage', () => {
  it('upgrades the legacy schema into honest one-turn threads and stays stable after another reopen', () => {
    const file = tempDbPath();
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE conversation_events (
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      );
    `);
    legacy.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)').run('legacy-1', 'answered', 100, 200);
    legacy.prepare('INSERT INTO conversation_events VALUES (?, ?, ?, ?, ?)').run(
      'legacy-1', 0, 'done', JSON.stringify(answered), 200
    );
    legacy.close();

    const upgraded = open(file);
    const thread = upgraded.getConversationThread('legacy-1');
    expect(thread?.turns).toHaveLength(1);
    expect(thread?.turns[0]).toMatchObject({
      id: 'legacy-1',
      threadId: 'legacy-1',
      question: null,
      turnIndex: 0,
      status: 'answered',
    });
    upgraded.createConversationTurn('turn-2', 'legacy-1', 'Exact follow-up?', 300);
    upgraded.appendConversationEvent('turn-2', answered, 400);
    upgraded.close();
    databases.splice(databases.indexOf(upgraded), 1);

    const reopened = open(file);
    expect(reopened.listConversationThreads(10).items.map((item) => item.id)).toEqual(['legacy-1']);
    expect(reopened.getConversationThread('legacy-1')?.turns.map((turn) => turn.question)).toEqual([
      null,
      'Exact follow-up?',
    ]);
    expect(() => reopened.createConversationTurn('orphan-turn', 'missing-thread', 'No orphan', 500)).toThrow();
    expect(reopened.hasConversationThread('missing-thread')).toBe(false);
    reopened.close();
    databases.splice(databases.indexOf(reopened), 1);

    const inspected = new Database(file);
    const foreignKeys = inspected.prepare('PRAGMA foreign_key_list(conversations)').all() as Array<{
      table: string;
      from: string;
    }>;
    expect(foreignKeys).toContainEqual(expect.objectContaining({ table: 'conversation_threads', from: 'thread_id' }));
    expect(inspected.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM conversation_events').get()).toEqual({ count: 2 });
    inspected.close();
  });

  it('orders list pages deterministically and paginates thread details by immutable turn identity', () => {
    const db = open(':memory:');
    for (const id of ['thread-a', 'thread-b', 'thread-c']) {
      db.createConversationTurn(id, id, `${id} question 0`, 100);
      db.appendConversationEvent(id, answered, id === 'thread-a' ? 100 : 200);
    }

    const first = db.listConversationThreads(2);
    expect(first.items.map((item) => item.id)).toEqual(['thread-c', 'thread-b']);
    expect(first.nextCursor).toEqual({ createdAt: 100, id: 'thread-b' });
    db.createConversationTurn('thread-a-followup', 'thread-a', 'updated between pages', 500);
    const second = db.listConversationThreads(2, first.nextCursor ?? undefined);
    expect(second.items.map((item) => item.id)).toEqual(['thread-a']);
    expect(second.nextCursor).toBeNull();

    for (let index = 1; index < 4; index += 1) {
      db.createConversationTurn(`thread-a-${index}`, 'thread-a', `question ${index}`, 200 + index);
      db.appendConversationEvent(`thread-a-${index}`, answered, 200 + index);
    }
    const detail1 = db.getConversationThread('thread-a', 2);
    expect(detail1?.turns.map((turn) => turn.turnIndex)).toEqual([0, 1]);
    const detail2 = db.getConversationThread('thread-a', 2, detail1?.nextCursor ?? undefined);
    expect(detail2?.turns.map((turn) => turn.turnIndex)).toEqual([2, 3]);
    const detail3 = db.getConversationThread('thread-a', 2, detail2?.nextCursor ?? undefined);
    expect(detail3?.turns.map((turn) => turn.turnIndex)).toEqual([4]);
    expect(detail3?.nextCursor).toBeNull();
  });

  it('bounds detail by event rows and resumes within a turn without loss', () => {
    const db = open(':memory:');
    db.createConversationTurn('thread-events', 'thread-events', 'Many events', 100);
    for (let index = 0; index < 5; index += 1) {
      db.appendConversationEvent('thread-events', { type: 'token', text: `token-${index}` }, 101 + index);
    }

    const first = db.getConversationThread('thread-events', 2);
    expect(first?.turns[0]?.events.map((event) => event.seq)).toEqual([0, 1]);
    expect(first?.nextCursor).toEqual({ threadId: 'thread-events', turnIndex: 0, id: 'thread-events', eventSeq: 1 });
    const second = db.getConversationThread('thread-events', 2, first?.nextCursor ?? undefined);
    expect(second?.turns[0]?.events.map((event) => event.seq)).toEqual([2, 3]);
    const third = db.getConversationThread('thread-events', 2, second?.nextCursor ?? undefined);
    expect(third?.turns[0]?.events.map((event) => event.seq)).toEqual([4]);
    expect(third?.nextCursor).toBeNull();
  });

  it('rolls back new-thread creation on collision and refuses to mutate a terminal turn', () => {
    const db = open(':memory:');
    db.createConversationTurn('occupied', 'occupied', 'Finished', 100);
    db.appendConversationEvent('occupied', answered, 101);

    expect(() => db.createConversationTurn('occupied', 'phantom', 'Collision', 200)).toThrow();
    expect(db.hasConversationThread('phantom')).toBe(false);
    expect(() => db.appendConversationEvent('occupied', { type: 'token', text: 'corruption' }, 300)).toThrow();
    expect(db.getConversationEvents('occupied').map((event) => event.event.type)).toEqual(['done']);
  });

  it('keeps each turn terminal status truthful and updates the thread summary after reconciliation', () => {
    const db = open(':memory:');
    db.createConversationTurn('thread', 'thread', 'answered question', 100);
    db.appendConversationEvent('thread', answered, 110);
    db.createConversationTurn('turn-exhausted', 'thread', 'exhausted question', 120);
    db.appendConversationEvent('turn-exhausted', { ...answered, status: 'exhausted' }, 130);
    db.createConversationTurn('turn-failed', 'thread', 'failed question', 140);
    db.appendConversationEvent('turn-failed', { ...answered, status: 'failed' }, 150);
    db.createConversationTurn('turn-running', 'thread', 'cut question', 160);

    expect(db.getConversation('turn-running')?.status).toBe('running');

    expect(db.reconcileInterruptedConversations(200)).toBe(1);
    expect(db.getConversationThread('thread')?.turns.map((turn) => turn.status)).toEqual([
      'answered',
      'exhausted',
      'failed',
      'interrupted',
    ]);
    expect(db.listConversationThreads(1).items[0]).toMatchObject({
      id: 'thread',
      latestStatus: 'interrupted',
      latestQuestion: 'cut question',
      updatedAt: 200,
    });
  });
});
