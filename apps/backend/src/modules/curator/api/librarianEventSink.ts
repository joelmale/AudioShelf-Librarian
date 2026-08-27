/**
 * Adapts `runConversation`'s `LibrarianEventSink` seam (`core/librarian/
 * events.ts`) onto the wire — an `SseChannel<LibrarianEventType>` (readiness
 * item E's widening of `sse.ts`). The SSE `event:` frame name is the
 * event's own `type`; `data:` carries everything else (the `type` field is
 * not duplicated into the payload — it's already the frame name, same as
 * every other `SseChannel` caller never re-states `progress`/`complete`
 * inside its own data).
 *
 * Closes the channel once a `done` event has gone out — `done` is the
 * conversation's one guaranteed-terminal event (see conversation.ts), so
 * nothing else is coming after it.
 *
 * `api/routes/librarian.ts` constructs one of these per chat request and
 * fans the same event into the SQLite persistence sink first.
 */
import type { LibrarianEvent, LibrarianEventSink, LibrarianEventType } from '../core/librarian/events.js';
import type { SseChannel } from './sse.js';

export function createSseEventSink(channel: SseChannel<LibrarianEventType>): LibrarianEventSink {
  return {
    emit(event: LibrarianEvent): void {
      const { type, ...data } = event;
      channel.send(type, data);
      if (type === 'done') channel.close();
    },
  };
}
