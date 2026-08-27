import { describe, expect, it } from 'vitest';

import {
  beginLibrarianChat,
  createLibrarianSseParser,
  reduceLibrarianChat,
  type LibrarianChatEvent,
} from './librarianChat.js';

describe('librarian SSE client', () => {
  it('parses frames split across arbitrary chunks and CRLF boundaries', () => {
    const events: LibrarianChatEvent[] = [];
    const parser = createLibrarianSseParser((event) => events.push(event));

    parser.push('retry: 3000\r\n\r\nevent: action\r');
    parser.push('\ndata: {"tool":"search_semantic","label":"search_semantic",');
    parser.push('"detail":"query: rain","resultSummary":"4 result(s)"}\r\n\r\n');
    parser.push('event: done\ndata: {"status":"answered","rounds":2,"tokensUsed":{"inputTokens":10,"outputTokens":3}}\n\n');
    parser.finish();

    expect(events.map((event) => event.type)).toEqual(['action', 'done']);
    expect(events[0]).toMatchObject({ tool: 'search_semantic', resultSummary: '4 result(s)' });
  });

  it('does not expose a forced answer when the terminal status is exhausted', () => {
    let state = beginLibrarianChat('Pick something short');
    state = reduceLibrarianChat(state, {
      type: 'answer',
      recommendations: [{ bookId: 'b1', title: 'Too Soon', reason: 'Forced by the budget.' }],
    });

    expect(state.phase).toBe('running');
    expect(state.recommendations).toEqual([]);

    state = reduceLibrarianChat(state, {
      type: 'done',
      status: 'exhausted',
      rounds: 6,
      tokensUsed: { inputTokens: 100, outputTokens: 10 },
    });

    expect(state.phase).toBe('exhausted');
    expect(state.recommendations).toEqual([]);
  });

  it('publishes the buffered answer only after done reports answered', () => {
    let state = beginLibrarianChat('Pick something short');
    state = reduceLibrarianChat(state, {
      type: 'answer',
      recommendations: [{ bookId: 'b1', title: 'Ready', reason: 'Supported by the shelf data.' }],
    });
    state = reduceLibrarianChat(state, {
      type: 'done',
      status: 'answered',
      rounds: 2,
      tokensUsed: { inputTokens: 100, outputTokens: 10 },
    });

    expect(state.phase).toBe('answered');
    expect(state.recommendations.map((recommendation) => recommendation.bookId)).toEqual(['b1']);
  });
});
