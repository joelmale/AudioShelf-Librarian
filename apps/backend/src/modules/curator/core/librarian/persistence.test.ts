/**
 * Conversation persistence (readiness item F, plan §10.F).
 *
 * Every test here uses a FILE-backed database in an `os.tmpdir()` sandbox and
 * proves survival by closing the connection and opening a new `CuratorDb`
 * against the same file. That is the whole point of the item: a test that
 * kept one instance alive would prove only that a Map works, and item F was
 * written because a real mid-run reboot cost this project a conversation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book } from '../types.js';
import type { LibrarianEvent, LibrarianEventSink } from './events.js';
import { RecordingLibrarianEventSink } from './events.js';
import { runConversation, type TurnDriver } from './conversation.js';
import { createPersistingEventSink, type ConversationStore } from './persistence.js';
import { createStubEmbeddingCreator } from '../retrieval/fixtures/stubEmbedder.js';
import type { LibrarianToolDeps } from './tools.js';

const tempDirs: string[] = [];
let dbPath: string;
let db: CuratorDb;

/** Close the live connection and open a new one against the same file — the
 *  closest a unit test gets to a process restart. */
function restart(): CuratorDb {
  db.close();
  db = new CuratorDb(dbPath);
  return db;
}

function addBook(target: CuratorDb, input: Pick<Book, 'id' | 'title'> & Partial<Book>): void {
  target.upsertBook({
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
    ...input,
  });
}

function deps(target: CuratorDb): LibrarianToolDeps {
  return { db: target, embeddingModel: 'stub-model', embeddingCreator: createStubEmbeddingCreator() };
}

/** Fans one run's events out to several sinks — the composition the eventual
 *  `POST /librarian/chat` route needs (SSE plus persistence). */
function tee(...sinks: LibrarianEventSink[]): LibrarianEventSink {
  return { emit: (event) => sinks.forEach((sink) => sink.emit(event)) };
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-librarian-persistence-'));
  tempDirs.push(dir);
  dbPath = path.join(dir, 'curator.db');
  db = new CuratorDb(dbPath);
});

afterEach(() => {
  db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('conversation persistence — surviving a restart', () => {
  it('replays a full conversation, in order, from a database reopened after close', async () => {
    addBook(db, { id: 'b1', title: 'The First' });
    addBook(db, { id: 'b2', title: 'The Second' });

    let round = 0;
    const driver: TurnDriver = {
      next: async () => {
        round += 1;
        if (round === 1) {
          // A real tool call against real rows, so the recorded feed contains
          // the events a Desk reload actually has to render — `action` and
          // `pile` — not just the terminal one.
          return {
            kind: 'tool_calls',
            calls: [{ tool: 'search_library', input: {} }],
            usage: { inputTokens: 5, outputTokens: 5 },
          };
        }
        return {
          kind: 'answer',
          answer: { recommendations: [{ bookId: 'b2', reason: 'the closest fit on the shelf' }] },
          usage: { inputTokens: 7, outputTokens: 3 },
        };
      },
    };

    const outcome = await runConversation({
      driver,
      sink: createPersistingEventSink({ store: db, conversationId: 'conv-1' }),
      toolDeps: deps(db),
    });
    expect(outcome.status).toBe('answered');

    // ── the restart ─────────────────────────────────────────────────────────
    const reopened = restart();

    const conversation = reopened.getConversation('conv-1');
    expect(conversation).not.toBeNull();
    // Resolved from the recorded `done` event, in the same transaction that
    // wrote it — not left at 'running' for a run that plainly finished.
    expect(conversation?.status).toBe('answered');

    const recorded = reopened.getConversationEvents('conv-1');
    // Ordinals are gapless and start at 0, so a caller can resume a replay
    // from a known point.
    expect(recorded.map((e) => e.seq)).toEqual(recorded.map((_, i) => i));

    // The whole feed survived, in emission order — not just the terminal
    // event. Derived from what the run actually emitted rather than compared
    // against a list this test hardcodes.
    expect(recorded.map((e) => e.event.type)).toEqual(['action', 'pile', 'answer', 'done']);

    const pile = recorded[1]?.event;
    expect(pile?.type === 'pile' && pile.added).toEqual(['b1', 'b2']);

    const answer = recorded[2]?.event;
    expect(answer?.type === 'answer' && answer.recommendations).toEqual([
      { bookId: 'b2', reason: 'the closest fit on the shelf' },
    ]);

    const done = recorded[3]?.event;
    expect(done?.type === 'done' && done.status).toBe('answered');
    expect(done?.type === 'done' && done.tokensUsed).toEqual({ inputTokens: 12, outputTokens: 8 });
  });

  it('disables a duplicate sink after restart so it cannot append to the existing turn', () => {
    let clock = 1_000;
    const first = createPersistingEventSink({ store: db, conversationId: 'conv-2', now: () => clock });
    first.emit({ type: 'token', text: 'thinking' });
    clock = 2_000;
    first.emit({ type: 'token', text: ' harder' });

    const opened = db.getConversation('conv-2');
    expect(opened?.status).toBe('running');
    expect(opened?.startedAt).toBe(1_000);
    // A non-terminal event still advances updated_at — "when did this last
    // move" is the only signal a stalled conversation gives off.
    expect(opened?.updatedAt).toBe(2_000);

    first.emit({ type: 'done', status: 'answered', rounds: 1, tokensUsed: { inputTokens: 1, outputTokens: 1 } });
    const reopened = restart();
    clock = 3_000;
    const second = createPersistingEventSink({ store: reopened, conversationId: 'conv-2', now: () => clock });
    second.emit({ type: 'token', text: ' still' });

    const recorded = reopened.getConversationEvents('conv-2');
    expect(recorded.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(recorded[2]?.event.type).toBe('done');
    expect(reopened.getConversation('conv-2')?.startedAt).toBe(1_000);
  });
});

describe('conversation persistence — a run whose end nobody saw', () => {
  it('reports an interrupted conversation as interrupted, never as a terminal status', () => {
    const sink = createPersistingEventSink({ store: db, conversationId: 'conv-cut' });
    sink.emit({ type: 'action', tool: 'search_library', label: 'search_library', detail: '(no filters)', resultSummary: '2 book(s)' });
    sink.emit({ type: 'pile', added: ['b1'], removed: [] });
    // …and the process dies here. No `done` was ever recorded.

    const reopened = restart();

    // Before reconciliation the stored fact is exactly what was observed:
    // started, no terminal event.
    expect(reopened.getConversation('conv-cut')?.status).toBe('running');

    expect(reopened.reconcileInterruptedConversations(9_999)).toBe(1);

    const conversation = reopened.getConversation('conv-cut');
    // DECISION #13 (docs/architecture/decisions.md): a measurement that
    // cannot be taken reports Unknown, never a confident zero. Nobody observed how this run
    // ended, so it must not claim to have failed (an error nobody saw) or to
    // have answered (an answer nobody produced) — and it must not go on
    // reading 'running' either, which is §10.E's silent feed in persisted
    // form.
    expect(conversation?.status).not.toBe('failed');
    expect(conversation?.status).not.toBe('answered');
    expect(conversation?.status).not.toBe('exhausted');
    expect(conversation?.status).not.toBe('running');
    expect(conversation?.status).toBe('interrupted');
    expect(conversation?.updatedAt).toBe(9_999);

    // The partial feed is still readable — an interrupted conversation is
    // worth reloading, which is the point of recording it at all.
    expect(reopened.getConversationEvents('conv-cut').map((e) => e.event.type)).toEqual(['action', 'pile']);
  });

  it('leaves a conversation that really did finish alone', () => {
    // The mirror-image failure: a reconciliation that stomped every row would
    // pass the test above and destroy real outcomes to tidy up unreal ones.
    const finished = createPersistingEventSink({ store: db, conversationId: 'conv-done' });
    finished.emit({ type: 'done', status: 'failed', rounds: 2, tokensUsed: { inputTokens: 1, outputTokens: 1 } });
    const cut = createPersistingEventSink({ store: db, conversationId: 'conv-cut' });
    cut.emit({ type: 'pile', added: ['b1'], removed: [] });

    const reopened = restart();
    expect(reopened.reconcileInterruptedConversations(9_999)).toBe(1);

    // 'failed' here is an observed outcome — the run reported it — and stays.
    expect(reopened.getConversation('conv-done')?.status).toBe('failed');
    expect(reopened.getConversation('conv-cut')?.status).toBe('interrupted');
  });

  it('refuses to serve a conversation whose recorded event no longer parses', () => {
    const sink = createPersistingEventSink({ store: db, conversationId: 'conv-bad' });
    sink.emit({ type: 'pile', added: ['b1'], removed: [] });
    db.close();

    // Corrupt one payload behind the API's back — schema skew or a damaged
    // file, the two ways this can really happen.
    const raw = new Database(dbPath);
    raw.prepare("UPDATE conversation_events SET payload = '{\"type\":\"pile\"}' WHERE seq = 0").run();
    raw.close();

    db = new CuratorDb(dbPath);
    // Loud, not short. A feed silently missing a step renders as a complete
    // conversation and nothing about it looks wrong.
    expect(() => db.getConversationEvents('conv-bad')).toThrow(/unreadable event at seq 0/);
  });
});

describe('conversation persistence — write failures', () => {
  it('opens a follow-up with exact thread/question metadata and reports creation failure without throwing', () => {
    const opened: unknown[][] = [];
    const failures: string[] = [];
    let appendCalls = 0;
    const store: ConversationStore = {
      createConversation: () => {
        throw new Error('legacy creation must not be used for a thread turn');
      },
      createConversationTurn: (...args) => {
        opened.push(args);
        throw new Error('database is read-only');
      },
      appendConversationEvent: () => {
        appendCalls += 1;
        return 99;
      },
    };

    const sink = createPersistingEventSink({
      store,
      conversationId: 'turn-2',
      threadId: 'thread-1',
      question: '  Preserve my exact spacing?  ',
      now: () => 123,
      onWriteError: (_err, event) => failures.push(event?.type ?? 'record'),
    });
    expect(() => sink.emit({ type: 'token', text: 'still live' })).not.toThrow();

    expect(opened).toEqual([['turn-2', 'thread-1', '  Preserve my exact spacing?  ', 123]]);
    expect(appendCalls).toBe(0);
    expect(failures).toEqual(['record']);
  });

  it('never lets a storage fault take down the conversation it is recording', async () => {
    const failures: string[] = [];
    const brokenStore: ConversationStore = {
      createConversation: () => {
        throw new Error('disk is full');
      },
      appendConversationEvent: () => {
        throw new Error('disk is full');
      },
    };

    const recording = new RecordingLibrarianEventSink();
    const persisting = createPersistingEventSink({
      store: brokenStore,
      conversationId: 'conv-broken',
      onWriteError: (_err, event: LibrarianEvent | null) => failures.push(event?.type ?? 'record'),
    });

    const driver: TurnDriver = {
      next: async () => ({
        kind: 'answer',
        answer: { recommendations: [{ bookId: 'b1', reason: 'still delivered' }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    const outcome = await runConversation({
      driver,
      sink: tee(recording, persisting),
      toolDeps: deps(db),
    });

    // The conversation is unharmed: the user still gets the answer and the
    // one guaranteed terminal event.
    expect(outcome.status).toBe('answered');
    const doneEvents = recording.events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    expect(recording.events[recording.events.length - 1]).toBe(doneEvents[0]);

    // Specifically NOT reported as a driver failure. A throw escaping `emit`
    // would be caught by runConversation's own catch and blamed on the
    // driver — a database fault masquerading as a broken librarian.
    expect(recording.events.filter((e) => e.type === 'error')).toHaveLength(0);

    // And the fault is not swallowed silently: every failed write is reported.
    expect(failures).toEqual(['record']);
  });
});
