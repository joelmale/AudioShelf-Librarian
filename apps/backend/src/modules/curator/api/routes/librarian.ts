/** HTTP transport for the prompt-backed librarian conversation loop. */
import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { runConversation } from '../../core/librarian/conversation.js';
import { createPromptTurnDriver, type ConversationHistoryTurn, type SeedBook } from '../../core/librarian/driver.js';
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
  /** "Inspired by" anchors (surface-unification plan §2.2 step 1). Same cap
   *  as `POST /recommendations`. Resolved against the library below — the
   *  model receives ids that are known to exist, never raw client strings. */
  seedBookIds: z.array(z.string().trim().min(1).max(512)).max(8).optional(),
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

/**
 * Turn requested seed ids into resolved shelf anchors.
 *
 * An id the library does not have is rejected rather than dropped: a silently
 * ignored anchor produces an answer that looks like it honoured the user's
 * "inspired by" choice and did not. Duplicates are collapsed; the client's
 * order is kept, since a picked list is an ordered thing to its picker.
 *
 * `POST /recommendations` drops an unknown seed silently instead. That
 * divergence is deliberate — this path can afford to fail loudly because the
 * composer only ever offers ids it just read back from the library.
 */
function resolveSeeds(services: ApiServices, seedBookIds: string[] | undefined): SeedBook[] {
  if (!seedBookIds || seedBookIds.length === 0) return [];
  const unique = [...new Set(seedBookIds)];
  const found = new Map(services.db.getBooksByIds(unique).map((book) => [book.id, book]));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ValidationError(`No book with id ${missing[0] as string}`, { missingSeedBookIds: missing });
  }
  return unique.map((id) => {
    const book = found.get(id) as { id: string; title: string; author: string | null };
    return { bookId: book.id, title: book.title, author: book.author };
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
    const { message, conversationId: requestedThreadId, seedBookIds } = parseRequest(
      chatRequestSchema,
      req.body,
      'Invalid librarian chat request'
    );
    const seeds = resolveSeeds(services, seedBookIds);
    const history = requestedThreadId ? historyForThread(services, requestedThreadId) : [];
    const threadId = requestedThreadId ?? randomUUID();
    const turnId = requestedThreadId ? randomUUID() : threadId;
    res.setHeader('X-Conversation-Id', threadId);
    res.setHeader('X-Conversation-Turn-Id', turnId);

    const channel = new SseChannel<LibrarianEventType>(req, res);
    const sseSink = createSseEventSink(channel);
    /**
     * Whether the client had already gone when the terminal event landed.
     * Sampled here rather than after the run because `createSseEventSink`
     * closes the channel on `done` — reading `channel.isClosed` afterwards
     * reports "closed" for every healthy turn and would make the flag a lie.
     */
    let clientGoneAtTerminal: boolean | null = null;
    const sink = fanOut(
      createPersistingEventSink({
        store: services.db,
        conversationId: turnId,
        threadId,
        question: message,
      }),
      {
        emit(event) {
          if (event.type === 'done') clientGoneAtTerminal = channel.isClosed;
          sseSink.emit(event);
        },
      }
    );
    const driver = createPromptTurnDriver({
      creator: services.messageCreator,
      model: services.config.collectionModel,
      question: message,
      history,
      seeds,
      logger: services.logger,
    });

    /**
     * Operator-facing turn diagnostics (surface-unification plan §5 item 2).
     * Until this existed the librarian path reached neither
     * `GET /api/system/logs` nor the activity feed, and the loop's measured
     * `tokensUsed` was discarded — so a Desk turn that died mid-flight was
     * indistinguishable from one that never started.
     *
     * `operationId` is the TURN id, not the thread id: one turn is one unit of
     * work, and `GET /api/system/logs?operationId=<turn>` is then the whole
     * story of that turn. Records ids, counts, and timings — never the
     * question text, a tool's input, or a recommendation, all of which are
     * library/user content that has no business in a log line. The one piece
     * of free text it does record is a failing tool's own error message; see
     * `ConversationToolLog` for why that exception is worth its cost.
     */
    const turnLog = services.actionLog.forOperation(turnId);
    const startedAt = Date.now();
    turnLog.record('info', 'librarian_turn_started', 'Librarian turn started', {
      threadId,
      turnId,
      followUp: requestedThreadId !== undefined,
      historyTurns: history.length,
      seedCount: seeds.length,
      questionChars: message.length,
    });

    try {
      const outcome = await runConversation({
        driver,
        sink,
        log: {
          toolCall: (info) => turnLog.record(
            info.ok ? 'debug' : 'warn',
            'librarian_tool_call',
            `Librarian ${info.ok ? 'ran' : 'failed'} ${info.tool} in round ${info.round}`,
            info
          ),
        },
        toolDeps: {
          db: services.db,
          embeddingModel: services.config.embeddingModel,
          embeddingCreator: services.embeddingCreator,
        },
      });

      const common = {
        threadId,
        turnId,
        status: outcome.status,
        rounds: outcome.rounds,
        tokensUsed: outcome.tokensUsed,
        recommendationCount: outcome.answer?.recommendations.length ?? 0,
        durationMs: Date.now() - startedAt,
        // "The answer landed after the reader left" — distinct from the loop
        // never reaching a terminal event at all, which shows up as a
        // `librarian_turn_started` with no `_finished`/`_failed` after it.
        clientDisconnected: clientGoneAtTerminal ?? channel.isClosed,
      };
      if (outcome.status === 'failed') {
        turnLog.record('warn', 'librarian_turn_failed', 'Librarian turn failed', common);
      } else {
        turnLog.record('info', 'librarian_turn_finished', `Librarian turn ${outcome.status}`, common);
      }
    } catch (err) {
      // `runConversation` converts a driver throw into `status: 'failed'`, so
      // reaching here means the loop itself could not complete — exactly the
      // case that previously left no trace anywhere.
      turnLog.record('error', 'librarian_turn_failed', 'Librarian turn threw', {
        threadId,
        turnId,
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
        clientDisconnected: clientGoneAtTerminal ?? channel.isClosed,
      });
      // End the stream before rethrowing. The headers are long since sent, so
      // `errorHandler` cannot write a response body and returns without
      // touching it — leaving the client on heartbeats forever, waiting for a
      // terminal event that is never coming. Closing turns that silent hang
      // into the client's "stream ended before a terminal status" error, which
      // is the honest report. Deliberately NOT `channel.fail(err)`: that emits
      // an `error` frame in the generic `{code,message}` shape, which is not
      // the librarian `error` event the Desk's decoder validates against.
      channel.close();
      throw err;
    }
  }));

  return router;
}
