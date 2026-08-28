import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  beginLibrarianChat,
  createLibrarianSseParser,
  reduceLibrarianChat,
  getLibrarianConversation,
  hydratePersistedTurn,
  listLibrarianConversations,
  mergeLibrarianConversationPages,
  streamLibrarianChat,
  type LibrarianChatEvent,
} from './librarianChat.js';
import { resetAccessTokenCache, setAccessToken } from '../../auth/session.js';

afterEach(() => { vi.restoreAllMocks(); setAccessToken(null); resetAccessTokenCache(); });

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

  it('keeps audits and an additive, unique, capped candidate pile for live and replayed events', () => {
    let state = beginLibrarianChat('Show my shelf');
    state = reduceLibrarianChat(state, { type: 'audit', note: 'Tag coverage for “chosen-one” (trope): 1 present, 1 confirmed absent, 1 unaudited.', flaggedBookIds: ['unknown'] });
    state = reduceLibrarianChat(state, { type: 'pile', added: ['a', 'b', 'a'], removed: [] });
    state = reduceLibrarianChat(state, { type: 'pile', added: Array.from({ length: 20 }, (_, index) => `id-${index}`), removed: [] });

    expect(state.audits).toEqual([{ note: 'Tag coverage for “chosen-one” (trope): 1 present, 1 confirmed absent, 1 unaudited.', flaggedBookIds: ['unknown'] }]);
    expect(state.candidateBookIds).toEqual(['a', 'b', ...Array.from({ length: 13 }, (_, index) => `id-${index}`)]);

    const replay = hydratePersistedTurn({ id: 't', threadId: 'c', question: 'Show my shelf', turnIndex: 0, status: 'answered', startedAt: 1, updatedAt: 2, events: [
      { seq: 1, recordedAt: 1, event: { type: 'audit', note: 'Coverage is recorded.', flaggedBookIds: ['a'] } },
      { seq: 2, recordedAt: 2, event: { type: 'pile', added: ['a', 'a'], removed: [] } },
      { seq: 3, recordedAt: 3, event: { type: 'done', status: 'answered', rounds: 1, tokensUsed: { inputTokens: 1, outputTokens: 1 } } },
    ] });
    expect(replay.audits).toEqual([{ note: 'Coverage is recorded.', flaggedBookIds: ['a'] }]);
    expect(replay.candidateBookIds).toEqual(['a']);
  });

  it('lists and details use auth, bounded cursors, encoded ids, and retain cursors', async () => {
    setAccessToken('test-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ conversations: [], nextCursor: 'next' }), { status: 200 }));
    await listLibrarianConversations(7, 'a cursor');
    expect(fetchMock.mock.calls[0]?.[0]).toContain('limit=7');
    expect(fetchMock.mock.calls[0]?.[0]).toContain('cursor=a+cursor');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-token' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'thread', createdAt: 1, updatedAt: 2, turns: [], nextCursor: 'detail-next' }), { status: 200 }));
    const detail = await getLibrarianConversation('thread/id', 3, 'c');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/thread%2Fid?');
    expect(detail.nextCursor).toBe('detail-next');
  });

  it('merges repeated turn segments by id and event sequence in order', () => {
    const event = (seq: number, type: LibrarianChatEvent['type']) => ({ seq, recordedAt: seq, event: type === 'done' ? { type, status: 'answered', rounds: 1, tokensUsed: { inputTokens: 1, outputTokens: 1 } } as LibrarianChatEvent : { type } as LibrarianChatEvent });
    const base = { id: 'c', createdAt: 1, updatedAt: 2, nextCursor: 'x', turns: [{ id: 't', threadId: 'c', question: 'q', turnIndex: 0, status: 'answered', startedAt: 1, updatedAt: 2, events: [event(1, 'action')] }] };
    const merged = mergeLibrarianConversationPages(base, { ...base, nextCursor: null, turns: [{ ...base.turns[0], events: [event(1, 'action'), event(2, 'done')] }] });
    expect(merged.turns[0]?.events.map((x) => x.seq)).toEqual([1, 2]);
  });

  it('passes a selected conversation id and returns response headers', async () => {
    const body = 'event: done\ndata: {"status":"answered","rounds":1,"tokensUsed":{"inputTokens":1,"outputTokens":1}}\n\n';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Conversation-Id': 'thread', 'X-Conversation-Turn-Id': 'turn' } }));
    const result = await streamLibrarianChat('follow up', () => undefined, undefined, 'thread');
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ message: 'follow up', conversationId: 'thread' });
    expect(result).toEqual({ conversationId: 'thread', turnId: 'turn' });
  });

  it('clears auth and rejects non-OK responses', async () => {
    setAccessToken('stale');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status: 401 }));
    await expect(listLibrarianConversations()).rejects.toThrow('nope');
  });

  it('hydrates only answered persisted turns and keeps legacy/null or interrupted turns honest', () => {
    const done = { seq: 2, recordedAt: 2, event: { type: 'done', status: 'answered', rounds: 1, tokensUsed: { inputTokens: 1, outputTokens: 1 } } as LibrarianChatEvent };
    const answer = { seq: 1, recordedAt: 1, event: { type: 'answer', recommendations: [{ bookId: 'b1', reason: 'supported' }] } as LibrarianChatEvent };
    const make = (question: string | null, status: string, events: Array<typeof answer | typeof done> = []) => hydratePersistedTurn({ id: 't', threadId: 'c', question, turnIndex: 0, status, startedAt: 1, updatedAt: 2, events });
    expect(make('q', 'answered', [answer, done]).recommendations).toHaveLength(1);
    expect(make('q', 'exhausted', [answer]).recommendations).toEqual([]);
    expect(make('q', 'interrupted', [answer]).phase).toBe('failed');
    expect(make(null, 'answered', [done]).question).toBe('');
  });

  it('rejects malformed SSE actions and malformed detail event records', async () => {
    const malformedSse = new Response('event: action\ndata: {"tool":"search"}\n\n', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(malformedSse);
    await expect(streamLibrarianChat('q', () => undefined)).rejects.toThrow('Malformed librarian action event');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ id: 'c', createdAt: 1, updatedAt: 2, turns: [{ id: 't', threadId: 'c', question: 'q', turnIndex: 0, status: 'answered', startedAt: 1, updatedAt: 2, events: [{ seq: 1, recordedAt: 1, event: null }] }], nextCursor: null }), { status: 200 }));
    await expect(getLibrarianConversation('c')).rejects.toThrow('Malformed librarian event');
  });

  it('rejects malformed conversation lists and answer recommendation items', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ conversations: [{ id: 'c' }], nextCursor: null }), { status: 200 }));
    await expect(listLibrarianConversations()).rejects.toThrow('Malformed librarian conversation summary');
    const sse = new Response('event: answer\ndata: {"recommendations":[{"bookId":"b"}]}\n\n', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sse);
    await expect(streamLibrarianChat('q', () => undefined)).rejects.toThrow('Malformed librarian answer event');
  });

  it('rejects external-looking answer recommendations without an owned book id', async () => {
    const sse = new Response('event: answer\ndata: {"recommendations":[{"title":"Outside","reason":"unsupported"}]}\n\n', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sse);
    await expect(streamLibrarianChat('q', () => undefined)).rejects.toThrow('Malformed librarian answer event');
  });

  it('rejects malformed live and persisted pile payloads before they reach the reducer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('event: pile\ndata: {"added":["b1",4],"removed":[]}\n\n', { status: 200 }));
    await expect(streamLibrarianChat('q', () => undefined)).rejects.toThrow('Malformed librarian pile event');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ id: 'c', createdAt: 1, updatedAt: 2, turns: [{ id: 't', threadId: 'c', question: 'q', turnIndex: 0, status: 'answered', startedAt: 1, updatedAt: 2, events: [{ seq: 1, recordedAt: 1, event: { type: 'pile', added: ['b1'], removed: [{ bookId: 'b2' }] } }] }], nextCursor: null }), { status: 200 }));
    await expect(getLibrarianConversation('c')).rejects.toThrow('Malformed librarian pile event');
  });
});
