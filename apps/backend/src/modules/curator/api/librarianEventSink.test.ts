/**
 * `createSseEventSink` (readiness item E) — the adapter from `runConversation`'s
 * `LibrarianEventSink` seam onto an `SseChannel<LibrarianEventType>`. Exercised
 * against a fake Express response capturing raw `write()`/`end()` calls, no
 * real HTTP involved — the `POST /librarian/chat` route that would construct
 * a real one of these is Phase 4 proper (see this adapter's own docblock).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';

import type { LibrarianEventType } from '../core/librarian/events.js';
import { createSseEventSink } from './librarianEventSink.js';
import { SseChannel } from './sse.js';

const openChannels: SseChannel<LibrarianEventType>[] = [];

afterEach(() => {
  // Every channel owns a heartbeat `setInterval`; close it even for channels
  // a test deliberately left open, so a leaked timer never outlives the test.
  for (const channel of openChannels.splice(0)) channel.close();
});

interface FakeRes {
  writes: string[];
  ended: boolean;
}

function makeChannel(): { channel: SseChannel<LibrarianEventType>; fake: FakeRes } {
  const fake: FakeRes = { writes: [], ended: false };
  const req = { on: () => {} } as unknown as Request;
  const res = {
    status: () => res,
    setHeader: () => {},
    flushHeaders: () => {},
    write: (chunk: string) => {
      fake.writes.push(chunk);
      return true;
    },
    end: () => {
      fake.ended = true;
    },
  } as unknown as Response;

  const channel = new SseChannel<LibrarianEventType>(req, res);
  openChannels.push(channel);
  return { channel, fake };
}

describe('createSseEventSink', () => {
  it('writes each event as an SSE frame named by its `type`, with `type` not duplicated into the data payload', () => {
    const { channel, fake } = makeChannel();
    const sink = createSseEventSink(channel);

    sink.emit({
      type: 'action',
      tool: 'search_library',
      label: 'search_library',
      detail: 'title: foo',
      resultSummary: '3 book(s)',
    });

    const frame = fake.writes.join('');
    expect(frame).toContain('event: action\n');
    expect(frame).toContain(
      JSON.stringify({ tool: 'search_library', label: 'search_library', detail: 'title: foo', resultSummary: '3 book(s)' })
    );
  });

  it('the `done` frame reaches the wire and the channel closes after it', () => {
    const { channel, fake } = makeChannel();
    const sink = createSseEventSink(channel);

    sink.emit({ type: 'action', tool: 'get_book', label: 'get_book', detail: 'id: b1', resultSummary: '1 book' });
    expect(channel.isClosed).toBe(false);
    expect(fake.ended).toBe(false);

    sink.emit({ type: 'done', status: 'answered', rounds: 1, tokensUsed: { inputTokens: 1, outputTokens: 1 } });

    const frame = fake.writes.join('');
    expect(frame).toContain('event: done\n');
    expect(frame).toContain(JSON.stringify({ status: 'answered', rounds: 1, tokensUsed: { inputTokens: 1, outputTokens: 1 } }));

    expect(channel.isClosed).toBe(true);
    expect(fake.ended).toBe(true);
  });

  it('a stray emit after `done` never reaches the wire (SseChannel.send no-ops once closed)', () => {
    const { channel, fake } = makeChannel();
    const sink = createSseEventSink(channel);

    sink.emit({ type: 'done', status: 'failed', rounds: 2, tokensUsed: { inputTokens: 0, outputTokens: 0 } });
    const writesAtDone = fake.writes.length;
    expect(channel.isClosed).toBe(true);

    sink.emit({ type: 'error', stage: 'driver', message: 'too late', recoverable: false });

    expect(fake.writes.length).toBe(writesAtDone);
  });
});
