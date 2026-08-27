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

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
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
      body: JSON.stringify({ message: 'A quiet mystery for a winter coast' }),
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
    expect(db.getConversationEvents(conversationId as string).map((row) => row.event.type)).toEqual([
      'action',
      'pile',
      'answer',
      'done',
    ]);
  });
});
