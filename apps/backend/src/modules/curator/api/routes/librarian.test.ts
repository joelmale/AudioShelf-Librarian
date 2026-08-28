import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../../core/db.js';
import type { MessageCreator, MessageRequest, RawCompletion } from '../../core/llmClient.js';
import type { Book } from '../../core/types.js';
import { errorHandler } from '../http.js';
import { createCuratorApiRouter } from '../server.js';
import type { ApiServices } from '../services.js';

const databases: CuratorDb[] = [];
const servers: import('node:http').Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

class ScriptedCreator implements MessageCreator {
  readonly requests: MessageRequest[] = [];

  constructor(private readonly completions: RawCompletion[]) {}

  async create(request: MessageRequest): Promise<RawCompletion> {
    this.requests.push(request);
    const completion = this.completions.shift();
    if (!completion) throw new Error('ScriptedCreator ran out of completions');
    return completion;
  }

  createStream(): AsyncIterableIterator<string> {
    throw new Error('not used');
  }
}

const nullLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

function addBook(db: CuratorDb): void {
  db.upsertBook({
    id: 'ocean-1',
    title: 'The Ocean at Night',
    author: 'A. Reader',
    series: null,
    seriesSequence: null,
    durationSeconds: 28_800,
    publishedYear: 2020,
    genres: ['Mystery'],
    description: 'A quiet mystery on a winter coast.',
    coverPath: null,
    absAddedAt: 1_000,
    lastSyncedAt: 1_000,
  } as Book);
}

async function listen(db: CuratorDb, creator: MessageCreator): Promise<string> {
  const services = {
    db,
    messageCreator: creator,
    config: { collectionModel: 'test-model', embeddingModel: '' },
    logger: nullLogger,
    embeddingCreator: { create: async () => [] },
    actionLog: {},
    operations: {},
    absClient: {},
    absSocketClient: {},
    llmClient: {},
    encodeHub: {},
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

function frameTypes(body: string): string[] {
  return [...body.matchAll(/^event: (.+)$/gm)].map((match) => match[1] as string);
}

const done = (status: 'answered' | 'exhausted' | 'failed' = 'answered') => ({
  type: 'done' as const,
  status,
  rounds: 1,
  tokensUsed: { inputTokens: 1, outputTokens: 1 },
});

describe('POST /api/librarian/chat', () => {
  it('is mounted, streams the loop through SSE, and persists the same terminal feed', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db);
    const creator = new ScriptedCreator([
      {
        text: JSON.stringify({
          kind: 'tool_calls',
          calls: [{ tool: 'search_library', input: { title: 'Ocean', limit: 5 } }],
        }),
        usage: { inputTokens: 10, outputTokens: 4 },
      },
      {
        text: JSON.stringify({
          kind: 'answer',
          answer: {
            recommendations: [{
              bookId: 'ocean-1',
              title: 'The Ocean at Night',
              author: 'A. Reader',
              reason: 'A quiet coastal mystery that fits the request.',
            }],
          },
        }),
        usage: { inputTokens: 30, outputTokens: 8 },
      },
    ]);

    const response = await fetch(`${await listen(db, creator)}/api/librarian/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '  A quiet mystery for a winter coast  ' }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const conversationId = response.headers.get('x-conversation-id');
    expect(conversationId).toBeTruthy();
    expect(frameTypes(body)).toEqual(['action', 'pile', 'answer', 'done']);
    expect(body).toContain('"status":"answered"');
    expect(body).toContain('"inputTokens":40');
    expect(creator.requests).toHaveLength(2);
    expect(creator.requests[1]?.user).toContain('The Ocean at Night');

    const record = db.getConversation(conversationId as string);
    expect(record?.status).toBe('answered');
    expect(record?.question).toBe('  A quiet mystery for a winter coast  ');
    expect(db.getConversationEvents(conversationId as string).map((row) => row.event.type)).toEqual([
      'action',
      'pile',
      'answer',
      'done',
    ]);
  });

  it('continues a reopened thread using successful prose only and requires fresh evidence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-librarian-route-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'curator.db');
    const initial = new CuratorDb(file);
    addBook(initial);
    initial.createConversationTurn('thread-1', 'thread-1', 'A coastal mystery', 100);
    initial.appendConversationEvent('thread-1', {
      type: 'action', tool: 'search_library', label: 'search', detail: 'RAW_SECRET_PAYLOAD', resultSummary: 'one',
    }, 101);
    initial.appendConversationEvent('thread-1', {
      type: 'answer', recommendations: [{ bookId: 'ocean-1', title: 'The Ocean at Night', reason: 'Earlier answer prose.' }],
    }, 102);
    initial.appendConversationEvent('thread-1', done(), 103);
    initial.createConversationTurn('failed-turn', 'thread-1', 'FAILED QUESTION MUST STAY OUT', 110);
    initial.appendConversationEvent('failed-turn', done('failed'), 111);
    initial.createConversationTurn('cut-turn', 'thread-1', 'INTERRUPTED QUESTION MUST STAY OUT', 120);
    initial.reconcileInterruptedConversations(121);
    initial.close();

    const reopened = new CuratorDb(file);
    databases.push(reopened);
    const creator = new ScriptedCreator([
      {
        text: JSON.stringify({ kind: 'tool_calls', calls: [{ tool: 'get_book', input: { id: 'ocean-1' } }] }),
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        text: JSON.stringify({
          kind: 'answer',
          answer: { recommendations: [{ bookId: 'ocean-1', reason: 'Freshly checked.' }] },
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    const response = await fetch(`${await listen(reopened, creator)}/api/librarian/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What about that one?', conversationId: 'thread-1' }),
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('x-conversation-id')).toBe('thread-1');
    expect(response.headers.get('x-conversation-turn-id')).toBeTruthy();
    expect(response.headers.get('x-conversation-turn-id')).not.toBe('thread-1');
    const prompt = creator.requests[0]?.user ?? '';
    expect(prompt).toContain('A coastal mystery');
    expect(prompt).toContain('Earlier answer prose.');
    expect(prompt).not.toContain('RAW_SECRET_PAYLOAD');
    expect(prompt).not.toContain('FAILED QUESTION MUST STAY OUT');
    expect(prompt).not.toContain('INTERRUPTED QUESTION MUST STAY OUT');
    expect(reopened.getConversationThread('thread-1')?.turns).toHaveLength(4);
    expect(reopened.getConversationThread('thread-1')?.turns.at(-1)).toMatchObject({
      question: 'What about that one?',
      status: 'answered',
      turnIndex: 3,
    });
  });

  it('rejects an unknown follow-up before opening SSE or writing a turn', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    const creator = new ScriptedCreator([]);
    const response = await fetch(`${await listen(db, creator)}/api/librarian/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Continue', conversationId: 'missing-thread' }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    expect(response.headers.get('x-conversation-id')).toBeNull();
    expect(creator.requests).toHaveLength(0);
    expect(db.listConversationThreads(10).items).toEqual([]);
  });
});

describe('GET /api/librarian/conversations', () => {
  it('returns stable bounded pages and paginated detail after reload', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    for (const id of ['thread-a', 'thread-b', 'thread-c']) {
      db.createConversationTurn(id, id, `${id} question`, 100);
      db.appendConversationEvent(id, done(), id === 'thread-a' ? 100 : 200);
    }
    for (let index = 1; index < 3; index += 1) {
      db.createConversationTurn(`thread-b-${index}`, 'thread-b', `follow-up ${index}`, 200 + index);
      db.appendConversationEvent(`thread-b-${index}`, done(), 200 + index);
    }
    const base = await listen(db, new ScriptedCreator([]));

    const first = await fetch(`${base}/api/librarian/conversations?limit=2`).then((response) => response.json()) as {
      conversations: Array<{ id: string }>;
      nextCursor: string;
    };
    expect(first.conversations.map((item) => item.id)).toEqual(['thread-c', 'thread-b']);
    db.createConversationTurn('thread-a-later', 'thread-a', 'updated between pages', 500);
    const second = await fetch(`${base}/api/librarian/conversations?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
      .then((response) => response.json()) as { conversations: Array<{ id: string }>; nextCursor: null };
    expect(second.conversations.map((item) => item.id)).toEqual(['thread-a']);
    expect(second.nextCursor).toBeNull();

    const detail1 = await fetch(`${base}/api/librarian/conversations/thread-b?limit=2`).then((response) => response.json()) as {
      turns: Array<{ question: string; events: Array<{ event: { type: string } }> }>;
      nextCursor: string;
    };
    expect(detail1.turns.map((turn) => turn.question)).toEqual(['thread-b question', 'follow-up 1']);
    expect(detail1.turns.flatMap((turn) => turn.events.map((event) => event.event.type))).toEqual(['done', 'done']);
    expect((await fetch(
      `${base}/api/librarian/conversations/thread-c?limit=2&cursor=${encodeURIComponent(detail1.nextCursor)}`
    )).status).toBe(400);
    const detail2 = await fetch(
      `${base}/api/librarian/conversations/thread-b?limit=2&cursor=${encodeURIComponent(detail1.nextCursor)}`
    ).then((response) => response.json()) as { turns: Array<{ question: string }>; nextCursor: null };
    expect(detail2.turns.map((turn) => turn.question)).toEqual(['follow-up 2']);
    expect(detail2.nextCursor).toBeNull();
  });

  it('rejects corrupt/cross-endpoint cursors and malformed ids, and returns 404 for unknown threads', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    const base = await listen(db, new ScriptedCreator([]));
    const listCursor = Buffer.from(JSON.stringify({ createdAt: 1, id: 'thread' })).toString('base64url');

    expect((await fetch(`${base}/api/librarian/conversations?cursor=%%%`)).status).toBe(400);
    expect((await fetch(`${base}/api/librarian/conversations/thread?cursor=${listCursor}`)).status).toBe(400);
    expect((await fetch(`${base}/api/librarian/conversations/%20bad`)).status).toBe(400);
    expect((await fetch(`${base}/api/librarian/conversations/unknown`)).status).toBe(404);
  });
});
