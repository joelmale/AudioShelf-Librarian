// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibrarianChatPanel } from './LibrarianChatPanel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const list = (nextCursor: string | null = null) => ({ conversations: [{ id: 'thread-1', createdAt: 1, updatedAt: 2, turnCount: 1, latestStatus: 'answered', latestQuestion: 'Old question' }, { id: 'thread-2', createdAt: 3, updatedAt: 4, turnCount: 1, latestStatus: 'answered', latestQuestion: 'Second question' }], nextCursor });
const detail = () => ({ id: 'thread-1', createdAt: 1, updatedAt: 2, turns: [{ id: 'turn-1', threadId: 'thread-1', question: 'Old question', turnIndex: 0, status: 'answered', startedAt: 1, updatedAt: 2, events: [{ seq: 1, recordedAt: 1, event: { type: 'answer', recommendations: [{ bookId: 'book-1', reason: 'because' }] } }, { seq: 2, recordedAt: 2, event: { type: 'done', status: 'answered', rounds: 1, tokensUsed: { inputTokens: 1, outputTokens: 1 } } }] }], nextCursor: null });

function mount() { const element = document.createElement('div'); document.body.append(element); const root = createRoot(element); act(() => root.render(<LibrarianChatPanel />)); return { element, root }; }
function unmount(root: Root) { act(() => root.unmount()); document.body.replaceChildren(); }
function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe('LibrarianChatPanel history wiring', () => {
  it('renders persisted audits and additive candidates, and keeps the research trail collapsible', async () => {
    const audited = { ...detail(), turns: [{ ...detail().turns[0], events: [
      { seq: 1, recordedAt: 1, event: { type: 'action', tool: 'tag_coverage', label: 'tag_coverage', detail: 'tag: chosen-one', resultSummary: 'done' } },
      { seq: 2, recordedAt: 2, event: { type: 'audit', note: 'Tag coverage for “chosen-one” (trope): 0 present, 1 confirmed absent, 1 unaudited.', flaggedBookIds: ['unknown'] } },
      { seq: 3, recordedAt: 3, event: { type: 'pile', added: ['book-1', 'book-1'], removed: [] } },
      { seq: 4, recordedAt: 4, event: { type: 'done', status: 'answered', rounds: 1, tokensUsed: { inputTokens: 1, outputTokens: 1 } } },
    ] }] };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).includes('/thread-1?') ? json(audited) : json(list()));
    const { element, root } = mount(); await act(async () => undefined); await act(async () => (element.querySelector('.v2-librarian-history-item') as HTMLButtonElement).click());
    expect(element.textContent).toContain('Tag coverage for'); expect(element.textContent).toContain('Candidates found'); expect(element.querySelectorAll('.v2-librarian-candidate')).toHaveLength(1);
    const trail = element.querySelector('.v2-librarian-trace-toggle') as HTMLButtonElement; expect(trail.getAttribute('aria-expanded')).toBe('false'); expect(trail.textContent).toContain('1 action');
    await act(async () => trail.click()); expect(trail.getAttribute('aria-expanded')).toBe('true'); expect(element.textContent).toContain('Checked metadata coverage'); unmount(root);
  });

  it('selects/reopens a thread and exposes only explicit detail pagination', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).includes('/thread-1?') ? json(detail()) : json(list('next')));
    const { element, root } = mount();
    await act(async () => undefined);
    expect(element.textContent).toContain('Old question');
    const thread = element.querySelector('.v2-librarian-history-item') as HTMLButtonElement;
    await act(async () => thread.click());
    expect(element.textContent).toContain('because');
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/thread-1?')).length).toBe(1);
    expect(element.textContent).toContain('Load more conversations');
    await act(async () => (Array.from(element.querySelectorAll('button')).find((button) => button.textContent === 'Load more conversations') as HTMLButtonElement).click());
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/librarian/conversations?')).length).toBe(2);
    unmount(root);
  });

  it('new conversation clears reopened content and a selected follow-up sends its id', async () => {
    const stream = new Response('event: done\ndata: {"status":"answered","rounds":1,"tokensUsed":{"inputTokens":1,"outputTokens":1}}\n\n', { status: 200, headers: { 'X-Conversation-Id': 'thread-1', 'X-Conversation-Turn-Id': 'turn-2' } });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, _init) => { const url = String(input); if (url.endsWith('/chat')) return stream; if (url.includes('/thread-1?')) return json(detail()); return json(list()); });
    const { element, root } = mount(); await act(async () => undefined); await act(async () => (element.querySelector('.v2-librarian-history-item') as HTMLButtonElement).click());
    const textarea = element.querySelector('textarea') as HTMLTextAreaElement; await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(textarea, 'Follow up'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => (element.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    const chatCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/chat')); expect(JSON.parse((chatCall?.[1] as RequestInit).body as string)).toMatchObject({ message: 'Follow up', conversationId: 'thread-1' });
    await act(async () => (element.querySelector('.v2-librarian-history-head button') as HTMLButtonElement).click()); expect(element.textContent).not.toContain('because');
    unmount(root);
  });

  it('merges repeated detail segments only after explicit Load more turns', async () => {
    const first = { ...detail(), nextCursor: 'cursor-1' };
    const second = { ...detail(), nextCursor: null };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => { const url = String(input); if (url.includes('/thread-1?cursor=cursor-1')) return json(second); if (url.includes('/thread-1?')) return json(first); return json(list()); });
    const { element, root } = mount(); await act(async () => undefined); await act(async () => (element.querySelector('.v2-librarian-history-item') as HTMLButtonElement).click());
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/thread-1?')).length).toBe(1);
    await act(async () => (Array.from(element.querySelectorAll('button')).find((button) => button.textContent === 'Load more turns') as HTMLButtonElement).click());
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/thread-1?')).length).toBe(2);
    expect(element.querySelectorAll('.v2-librarian-history-turn').length).toBe(1);
    unmount(root);
  });

  it('suppresses a persisted live turn by returned turn id but retains it when detail is bounded out', async () => {
    const stream = () => new Response('event: done\ndata: {"status":"answered","rounds":1,"tokensUsed":{"inputTokens":1,"outputTokens":1}}\n\n', { status: 200, headers: { 'X-Conversation-Id': 'thread-1', 'X-Conversation-Turn-Id': 'turn-2' } });
    const persisted = { ...detail(), turns: [{ ...detail().turns[0], id: 'turn-2', question: 'Follow up' }] };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => { const url = String(input); if (url.endsWith('/chat')) return stream(); if (url.includes('/thread-1?')) return json(persisted); return json(list()); });
    const { element, root } = mount(); await act(async () => undefined); const textarea = element.querySelector('textarea') as HTMLTextAreaElement; await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(textarea, 'Follow up'); textarea.dispatchEvent(new Event('input', { bubbles: true })); }); await act(async () => (element.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(element.querySelectorAll('.v2-librarian-bubble.user').length).toBe(1);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/chat'))).toBe(true); unmount(root);
  });

  it('aborts stale detail requests and does not let their finally clear the replacement state', async () => {
    const oldDetail = deferred<Response>(); const newDetail = deferred<Response>(); let detailCalls = 0; let oldSignal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => { const url = String(input); if (url.includes('/thread-1?')) { detailCalls += 1; oldSignal ??= (init as RequestInit).signal; return detailCalls === 1 ? oldDetail.promise : newDetail.promise; } return json(list()); });
    const { element, root } = mount(); await act(async () => undefined); const item = element.querySelector('.v2-librarian-history-item') as HTMLButtonElement; await act(async () => item.click()); const newItem = item.cloneNode(true) as HTMLButtonElement; newItem.textContent = 'new'; newItem.onclick = () => undefined; expect(oldSignal).toBeDefined(); expect(oldSignal?.aborted).toBe(false); oldDetail.resolve(json(detail())); await act(async () => undefined); expect(element.textContent).toContain('Old question'); unmount(root);
  });

  it('retains a confirmed answer when terminal history refresh fails and exposes retry', async () => {
    const stream = new Response('event: answer\ndata: {"recommendations":[{"bookId":"book-1","reason":"supported"}]}\n\nevent: done\ndata: {"status":"answered","rounds":1,"tokensUsed":{"inputTokens":1,"outputTokens":1}}\n\n', { status: 200, headers: { 'X-Conversation-Id': 'thread-1', 'X-Conversation-Turn-Id': 'turn-2' } }); let refresh = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => { const url = String(input); if (url.endsWith('/chat')) return stream; if (url.includes('/thread-1?')) return refresh ? new Response('bad', { status: 500 }) : json(detail()); return json(list()); });
    const { element, root } = mount(); await act(async () => undefined); const textarea = element.querySelector('textarea') as HTMLTextAreaElement; await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(textarea, 'Question'); textarea.dispatchEvent(new Event('input', { bubbles: true })); }); await act(async () => (element.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); expect(element.textContent).toContain('book-1'); expect(element.textContent).toContain('history'); refresh = false; const retry = Array.from(element.querySelectorAll('button')).find((button) => button.textContent === 'Retry history refresh') as HTMLButtonElement; await act(async () => retry.click()); expect(element.textContent).not.toContain('The saved history could not be refreshed.'); unmount(root);
  });

  it('omits conversationId from the next POST after New conversation', async () => {
    const stream = () => new Response('event: done\ndata: {"status":"answered","rounds":1,"tokensUsed":{"inputTokens":1,"outputTokens":1}}\n\n', { status: 200, headers: { 'X-Conversation-Id': 'thread-1', 'X-Conversation-Turn-Id': 'turn-2' } });
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []; vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => { calls.push([input, init]); if (String(input).endsWith('/chat')) return stream(); if (String(input).includes('/thread-1?')) return json(detail()); return json(list()); });
    const { element, root } = mount(); await act(async () => undefined); await act(async () => (element.querySelector('.v2-librarian-history-item') as HTMLButtonElement).click()); await act(async () => (element.querySelector('.v2-librarian-history-head button') as HTMLButtonElement).click()); const textarea = element.querySelector('textarea') as HTMLTextAreaElement; await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(textarea, 'New thread'); textarea.dispatchEvent(new Event('input', { bubbles: true })); }); await act(async () => (element.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); const post = calls.filter(([input]) => String(input).endsWith('/chat')).at(-1); expect(JSON.parse((post?.[1]?.body as string))).toEqual({ message: 'New thread' }); unmount(root);
  });

  it('aborts detail A when selecting B and ignores late A resolution', async () => {
    const a = deferred<Response>(); const b = deferred<Response>(); let aSignal: AbortSignal | null | undefined; let detailCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => { const url = String(input); if (url.includes('/thread-1?')) { aSignal = (init as RequestInit).signal; return a.promise; } if (url.includes('/thread-2?')) { detailCount += 1; return b.promise; } return json(list()); });
    const { element, root } = mount(); await act(async () => undefined); const items = element.querySelectorAll('.v2-librarian-history-item'); await act(async () => (items[0] as HTMLButtonElement).click()); await act(async () => (items[1] as HTMLButtonElement).click()); expect(aSignal?.aborted).toBe(true); b.resolve(json({ ...detail(), id: 'thread-2', turns: [{ ...detail().turns[0], threadId: 'thread-2', question: 'Second question' }] })); await act(async () => undefined); a.resolve(json(detail())); await act(async () => undefined); const historyText = element.querySelector('.v2-librarian-history-main')?.textContent ?? ''; expect(historyText).toContain('Second question'); expect(historyText).not.toContain('Old question'); expect(detailCount).toBe(1); unmount(root);
  });

  it('keeps a bounded-out live turn after terminal detail refresh', async () => {
    const stream = new Response('event: answer\ndata: {"recommendations":[{"bookId":"live-book","reason":"supported"}]}\n\nevent: done\ndata: {"status":"answered","rounds":1,"tokensUsed":{"inputTokens":1,"outputTokens":1}}\n\n', { status: 200, headers: { 'X-Conversation-Id': 'thread-1', 'X-Conversation-Turn-Id': 'turn-new' } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => { const url = String(input); if (url.endsWith('/chat')) return stream; if (url.includes('/thread-1?')) return json(detail()); return json(list()); });
    const { element, root } = mount(); await act(async () => undefined); const textarea = element.querySelector('textarea') as HTMLTextAreaElement; await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(textarea, 'Bounded live'); textarea.dispatchEvent(new Event('input', { bubbles: true })); }); await act(async () => (element.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); expect(element.textContent).toContain('Bounded live'); expect(element.textContent).toContain('live-book'); unmount(root);
  });

  it('renders distinct same-turn detail segments once, including token and action content', async () => {
    const first = { ...detail(), nextCursor: 'cursor-segment', turns: [{ ...detail().turns[0], events: [{ seq: 1, recordedAt: 1, event: { type: 'action', tool: 'search_library', label: 'search_library', detail: 'first segment', resultSummary: 'one' } }] }] };
    const second = { ...detail(), nextCursor: null, turns: [{ ...first.turns[0], events: [{ seq: 1, recordedAt: 1, event: { type: 'action', tool: 'search_library', label: 'search_library', detail: 'first segment', resultSummary: 'one' } }, { seq: 2, recordedAt: 2, event: { type: 'token', text: 'second segment' } }] }] };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).includes('cursor-segment') ? json(second) : String(input).includes('/thread-1?') ? json(first) : json(list()));
    const { element, root } = mount(); await act(async () => undefined); await act(async () => (element.querySelector('.v2-librarian-history-item') as HTMLButtonElement).click()); await act(async () => (Array.from(element.querySelectorAll('button')).find((x) => x.textContent === 'Load more turns') as HTMLButtonElement).click()); const trail = element.querySelector('.v2-librarian-trace-toggle') as HTMLButtonElement; expect(trail.textContent).toContain('1 action'); expect(trail.textContent).not.toContain('second segment'); await act(async () => trail.click()); expect(element.textContent?.match(/first segment/g)?.length).toBe(1); expect(element.querySelector('.v2-librarian-prose')?.textContent).toContain('second segment'); unmount(root);
  });

  it('aborts an in-flight live stream on unmount', async () => {
    const pending = deferred<Response>(); let signal: AbortSignal | null | undefined; vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => { if (String(input).endsWith('/chat')) { signal = (init as RequestInit).signal; return pending.promise; } return json(list()); }); const { element, root } = mount(); await act(async () => undefined); const textarea = element.querySelector('textarea') as HTMLTextAreaElement; await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(textarea, 'Pending'); textarea.dispatchEvent(new Event('input', { bubbles: true })); }); await act(async () => (element.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); unmount(root); expect(signal?.aborted).toBe(true); pending.reject(new DOMException('Aborted', 'AbortError'));
  });

  it('retries a failed list load-more with the same cursor and preserves the first page', async () => {
    let attempt = 0; const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => { const url = String(input); if (url.includes('cursor=next')) { attempt += 1; if (attempt === 1) return new Response('failed', { status: 500 }); return json({ ...list(), nextCursor: null }); } return json(list('next')); });
    const { element, root } = mount(); await act(async () => undefined); await act(async () => (Array.from(element.querySelectorAll('button')).find((x) => x.textContent === 'Load more conversations') as HTMLButtonElement).click()); expect(element.textContent).toContain('Librarian request failed'); expect(element.textContent).toContain('Old question'); await act(async () => (Array.from(element.querySelectorAll('button')).find((x) => x.textContent === 'Retry') as HTMLButtonElement).click()); expect(element.textContent).toContain('Old question'); expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('cursor=next')).length).toBe(2); unmount(root);
  });

  it('retries failed detail load-more with the same cursor and preserves prior event content', async () => {
    let attempt = 0; const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => { const url = String(input); if (url.includes('cursor=next')) { attempt += 1; if (attempt === 1) return new Response('failed', { status: 500 }); return json({ ...detail(), nextCursor: null }); } if (url.includes('/thread-1?')) return json({ ...detail(), nextCursor: 'next' }); return json(list()); });
    const { element, root } = mount(); await act(async () => undefined); await act(async () => (element.querySelector('.v2-librarian-history-item') as HTMLButtonElement).click()); await act(async () => (Array.from(element.querySelectorAll('button')).find((x) => x.textContent === 'Load more turns') as HTMLButtonElement).click()); expect(element.textContent).toContain('because'); expect(element.textContent).toContain('Librarian request failed'); await act(async () => (Array.from(element.querySelectorAll('button')).find((x) => x.textContent === 'Retry') as HTMLButtonElement).click()); expect(element.textContent).toContain('because'); expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('cursor=next')).length).toBe(2); unmount(root);
  });

  it('clears a failed list retry when selecting a thread and aborts the old request', async () => {
    const pending = deferred<Response>(); let signal: AbortSignal | null | undefined; vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => { const url = String(input); if (url.includes('cursor=next')) { signal = (init as RequestInit).signal; return pending.promise; } if (url.includes('/thread-2?')) return json({ ...detail(), id: 'thread-2' }); return json(list('next')); });
    const { element, root } = mount(); await act(async () => undefined); await act(async () => (Array.from(element.querySelectorAll('button')).find((x) => x.textContent === 'Load more conversations') as HTMLButtonElement).click()); await act(async () => (element.querySelectorAll('.v2-librarian-history-item')[1] as HTMLButtonElement).click()); expect(signal?.aborted).toBe(true); expect(element.textContent).not.toContain('Retry'); pending.resolve(json(list())); unmount(root);
  });

  it('clears a failed detail retry when a follow-up stream starts', async () => {
    let detailAttempt = 0; const stream = new Response('event: done\ndata: {"status":"answered","rounds":1,"tokensUsed":{"inputTokens":1,"outputTokens":1}}\n\n', { status: 200, headers: { 'X-Conversation-Id': 'thread-1', 'X-Conversation-Turn-Id': 'turn-2' } }); vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => { const url = String(input); if (url.endsWith('/chat')) return stream; if (url.includes('/thread-1?')) { detailAttempt += 1; return detailAttempt === 2 ? new Response('failed', { status: 500 }) : json({ ...detail(), nextCursor: 'next' }); } return json(list()); });
    const { element, root } = mount(); await act(async () => undefined); await act(async () => (element.querySelector('.v2-librarian-history-item') as HTMLButtonElement).click()); await act(async () => (Array.from(element.querySelectorAll('button')).find((x) => x.textContent === 'Load more turns') as HTMLButtonElement).click()); expect(element.textContent).toContain('Retry'); const textarea = element.querySelector('textarea') as HTMLTextAreaElement; await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(textarea, 'Follow up'); textarea.dispatchEvent(new Event('input', { bubbles: true })); }); await act(async () => (element.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); expect(element.textContent).not.toContain('Could not load more turns'); unmount(root);
  });

  it('clears same-thread list retry before reselecting and lets the new detail request complete', async () => {
    let listMore = false; let detailCalls = 0; vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => { const url = String(input); if (url.includes('/thread-1?')) { detailCalls += 1; return json(detail()); } if (url.includes('cursor=next')) { listMore = true; return new Response('failed', { status: 500 }); } return json(list('next')); });
    const { element, root } = mount(); await act(async () => undefined); const thread = element.querySelector('.v2-librarian-history-item') as HTMLButtonElement; await act(async () => thread.click()); await act(async () => (Array.from(element.querySelectorAll('button')).find((x) => x.textContent === 'Load more conversations') as HTMLButtonElement).click()); expect(listMore).toBe(true); expect(element.textContent).toContain('Retry'); await act(async () => thread.click()); expect(element.textContent).not.toContain('Retry'); expect(detailCalls).toBe(2); unmount(root);
  });
});
