/** HTTP transport for the prompt-backed librarian conversation loop. */
import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { runConversation } from '../../core/librarian/conversation.js';
import { createPromptTurnDriver } from '../../core/librarian/driver.js';
import type { LibrarianEvent, LibrarianEventSink, LibrarianEventType } from '../../core/librarian/events.js';
import { createPersistingEventSink } from '../../core/librarian/persistence.js';
import { createSseEventSink } from '../librarianEventSink.js';
import type { ApiServices } from '../services.js';
import { SseChannel } from '../sse.js';
import { asyncHandler } from '../http.js';

const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
});

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

  router.post('/librarian/chat', asyncHandler(async (req, res) => {
    const { message } = chatRequestSchema.parse(req.body);
    const conversationId = randomUUID();
    res.setHeader('X-Conversation-Id', conversationId);

    const channel = new SseChannel<LibrarianEventType>(req, res);
    const sink = fanOut(
      createPersistingEventSink({ store: services.db, conversationId }),
      createSseEventSink(channel)
    );
    const driver = createPromptTurnDriver({
      creator: services.messageCreator,
      model: services.config.collectionModel,
      question: message,
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
