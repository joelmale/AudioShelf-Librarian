/** HTTP transport for the prompt-backed librarian conversation loop. */
import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { runConversation } from '../../core/librarian/conversation.js';
import { createPromptTurnDriver, type ConversationHistoryTurn } from '../../core/librarian/driver.js';
import type { LibrarianEvent, LibrarianEventSink, LibrarianEventType } from '../../core/librarian/events.js';
import { createPersistingEventSink } from '../../core/librarian/persistence.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { createSseEventSink } from '../librarianEventSink.js';
import type { ApiServices } from '../services.js';
import { SseChannel } from '../sse.js';
import { asyncHandler } from '../http.js';

const chatRequestSchema = z.object({
  message: z.string().min(1).max(4_000).refine((value) => value.trim().length > 0, 'Message must not be blank'),
  conversationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
});

const detailQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

const idParamSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);

interface ListWireCursor {
  createdAt: number;
  id: string;
}

interface DetailWireCursor {
  threadId: string;
  turnIndex: number;
  id: string;
  eventSeq: number;
}

function parseRequest<S extends z.ZodTypeAny>(schema: S, value: unknown, message: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(message, parsed.error.issues);
  return parsed.data;
}

function encodeCursor(cursor: ListWireCursor | DetailWireCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor<S extends z.ZodTypeAny>(value: string | undefined, schema: S): z.output<S> | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new Error('Non-canonical cursor');
    return parseRequest(schema, JSON.parse(decoded), 'Invalid conversation cursor');
  } catch {
    throw new ValidationError('Invalid conversation cursor');
  }
}

function historyForThread(services: ApiServices, threadId: string): ConversationHistoryTurn[] {
  const turns = services.db.getConversationHistoryTurns(threadId, 8);
  if (!turns) throw new NotFoundError(`No librarian conversation ${threadId}`);
  return turns.flatMap((turn): ConversationHistoryTurn[] => {
    if (turn.question === null) return [];
    let answer: LibrarianEvent | undefined;
    for (let index = turn.events.length - 1; index >= 0; index -= 1) {
      const event = turn.events[index]?.event;
      if (event?.type === 'answer') {
        answer = event;
        break;
      }
    }
    if (!answer || answer.type !== 'answer') return [];
    const prose = answer.recommendations.map((recommendation) => ({
      ...(recommendation.title ? { title: recommendation.title } : {}),
      ...(recommendation.author ? { author: recommendation.author } : {}),
      reason: recommendation.reason,
    }));
    return [{ question: turn.question, answer: JSON.stringify(prose) }];
  });
}

function fanOut(first: LibrarianEventSink, second: LibrarianEventSink): LibrarianEventSink {
  return {
    emit(event: LibrarianEvent): void {
      // Persist first. A terminal SSE event closes the response immediately,
      // but the durable record must already contain that same terminal fact.
      first.emit(event);
      second.emit(event);
    },
  };
}

export function createLibrarianChatRouter(services: ApiServices): Router {
  const router = Router();

  router.get('/librarian/conversations', (req, res) => {
    const query = parseRequest(listQuerySchema, req.query, 'Invalid conversation list query');
    const cursor = decodeCursor(query.cursor, z.object({
      createdAt: z.number().int().nonnegative(),
      id: idParamSchema,
    }).strict());
    const page = services.db.listConversationThreads(query.limit, cursor);
    res.json({
      conversations: page.items,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    });
  });

  router.get('/librarian/conversations/:id', (req, res) => {
    const id = parseRequest(idParamSchema, req.params.id, 'Invalid conversation id');
    const query = parseRequest(detailQuerySchema, req.query, 'Invalid conversation detail query');
    const cursor = decodeCursor(query.cursor, z.object({
      threadId: idParamSchema,
      turnIndex: z.number().int().nonnegative(),
      id: idParamSchema,
      eventSeq: z.number().int().min(-1),
    }).strict());
    if (cursor && cursor.threadId !== id) throw new ValidationError('Conversation cursor belongs to another thread');
    const thread = services.db.getConversationThread(id, query.limit, cursor);
    if (!thread) throw new NotFoundError(`No librarian conversation ${id}`);
    res.json({
      ...thread,
      nextCursor: thread.nextCursor ? encodeCursor(thread.nextCursor) : null,
    });
  });

  router.post('/librarian/chat', asyncHandler(async (req, res) => {
    const { message, conversationId: requestedThreadId } = parseRequest(
      chatRequestSchema,
      req.body,
      'Invalid librarian chat request'
    );
    const history = requestedThreadId ? historyForThread(services, requestedThreadId) : [];
    const threadId = requestedThreadId ?? randomUUID();
    const turnId = requestedThreadId ? randomUUID() : threadId;
    res.setHeader('X-Conversation-Id', threadId);
    res.setHeader('X-Conversation-Turn-Id', turnId);

    const channel = new SseChannel<LibrarianEventType>(req, res);
    const sink = fanOut(
      createPersistingEventSink({
        store: services.db,
        conversationId: turnId,
        threadId,
        question: message,
      }),
      createSseEventSink(channel)
    );
    const driver = createPromptTurnDriver({
      creator: services.messageCreator,
      model: services.config.collectionModel,
      question: message,
      history,
      logger: services.logger,
    });

    await runConversation({
      driver,
      sink,
      toolDeps: {
        db: services.db,
        embeddingModel: services.config.embeddingModel,
        embeddingCreator: services.embeddingCreator,
      },
    });
  }));

  return router;
}
