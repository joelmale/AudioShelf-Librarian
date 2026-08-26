/**
 * Conversation persistence (librarian engine plan §5.3/§10.F, readiness item
 * F — "decided: SQLite").
 *
 * A `LibrarianEventSink` that writes every event a run emits to the
 * `conversations` / `conversation_events` tables, so a conversation survives
 * the process that produced it. It plugs into the same injected seam
 * `runConversation` already emits through (`events.ts`), which is why nothing
 * in the loop had to change to persist: a run can be given the SSE sink, this
 * one, or both, and the loop cannot tell.
 *
 * The event stream is the record, deliberately — not the transcript. What the
 * Desk reloads is the feed the user was watching (`interpretation`, `action`,
 * `pile`, `answer`, `done`), and that feed is a public, versioned contract
 * (§8.1) with a schema to validate it on the way back out. The internal
 * `TranscriptEntry` shape is none of those things: it carries raw tool inputs
 * and raw results, it exists to be fed to a driver rather than rendered, and
 * it is the thing §8.3 says must never reach the wire.
 *
 * NOT INCLUDED HERE: resuming a persisted conversation into a NEW run (adding
 * more rounds to one that already ended). That needs a `TurnDriver` capable of
 * rebuilding its own context from a stored feed, which is Phase 4 proper. What
 * this provides is the storage half — a conversation that survives, and reads
 * back in order, with a status that never overstates what was observed.
 */
import type { LibrarianEvent, LibrarianEventSink } from './events.js';

/**
 * The narrow slice of `CuratorDb` this sink needs (same idiom as
 * `readiness.ts`'s `ReadinessDb`, and for the same reason: a test double here
 * should not have to impersonate the whole database).
 */
export interface ConversationStore {
  createConversation(id: string, startedAt: number): void;
  appendConversationEvent(conversationId: string, event: LibrarianEvent, recordedAt: number): number;
}

export interface PersistingEventSinkOptions {
  store: ConversationStore;
  /** Caller-chosen id; also what a Desk reload asks for. */
  conversationId: string;
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Notified when a write fails. Defaults to a `console.warn` — `index.ts`
   * buffers console output into `GET /api/system/logs`, so a silently
   * unrecorded conversation still surfaces somewhere. Deliberately given the
   * event's `type` and the error only, never the payload: an `answer` event
   * carries library content that has no business in a log line.
   */
  onWriteError?: (err: unknown, event: LibrarianEvent | null) => void;
}

function defaultOnWriteError(conversationId: string) {
  return (err: unknown, event: LibrarianEvent | null): void => {
    const what = event ? `${event.type} event` : 'record';
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[librarian] failed to persist ${what} for conversation ${conversationId}: ${message}`);
  };
}

/**
 * Builds the persisting sink and opens the conversation record immediately —
 * `conversation_events` has a real foreign key to `conversations` and the
 * connection runs with `foreign_keys = ON`, so there is no window in which
 * events could be appended against a row that does not exist yet.
 *
 * EVERY WRITE IS BEST-EFFORT WITH RESPECT TO THE LIVE CONVERSATION. A throw
 * out of `emit` would be caught by `runConversation`'s own `catch` and
 * reported as `error{stage:'driver'}` — blaming the driver for a database
 * fault and killing a conversation that was working — or, from the `finally`
 * that emits `done`, would escape `runConversation` altogether and break the
 * exactly-one-terminal-event guarantee that item E exists to provide. Losing
 * the recording is bad; losing the answer the user is waiting for, and the
 * event that tells them anything happened at all, is worse. So failures are
 * reported through `onWriteError` and the conversation continues.
 */
export function createPersistingEventSink(options: PersistingEventSinkOptions): LibrarianEventSink {
  const { store, conversationId } = options;
  const now = options.now ?? (() => Date.now());
  const onWriteError = options.onWriteError ?? defaultOnWriteError(conversationId);

  try {
    store.createConversation(conversationId, now());
  } catch (err) {
    onWriteError(err, null);
  }

  return {
    emit(event: LibrarianEvent): void {
      try {
        store.appendConversationEvent(conversationId, event, now());
      } catch (err) {
        onWriteError(err, event);
      }
    },
  };
}
