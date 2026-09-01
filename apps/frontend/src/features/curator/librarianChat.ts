import { clearAccessToken, withAuthHeaders } from '../../auth/session.js';

export interface LibrarianRecommendation {
  bookId: string;
  title?: string;
  author?: string;
  reason: string;
  /** Card-parity display fields (surface-unification plan §2.2 step 2). Both
   *  optional: a turn persisted before they existed, or a book the ranker
   *  never scored, simply carries less to render — never a fabricated zero. */
  durationSeconds?: number | null;
  matchedTags?: string[];
  /** The model's sentence described a different book in the same answer and
   *  was replaced with one built from `matchedTags` (`core/reasonGuard.ts`).
   *  Carried on the event so a replayed turn discloses it too. */
  reasonReplaced?: boolean;
}

/** What one retrieval call measured — the Scout audit line's data, arriving
 *  on the Desk as its own event rather than being re-derived here. */
export interface LibrarianRetrieval {
  tool: string;
  candidateCount: number;
  evidenceCount: number;
  semanticScored: number;
  personalized: boolean;
  /** Absent, not empty, when nothing was rewritten. */
  tagResolution?: Array<{ field: string; from: string; to: string[]; reason: string }>;
  relaxation: { demotedTags: Array<{ tag: string; category?: string }> } | null;
}

export interface LibrarianAction {
  tool: string;
  label: string;
  detail: string;
  resultSummary: string;
}

export interface LibrarianAudit {
  note: string;
  flaggedBookIds: string[];
}

export interface LibrarianConversationSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  latestStatus: string;
  latestQuestion: string | null;
}

export interface LibrarianPersistedEvent {
  seq: number;
  event: LibrarianChatEvent;
  recordedAt: number;
}

export interface LibrarianPersistedTurn {
  id: string;
  threadId: string;
  question: string | null;
  turnIndex: number;
  status: string;
  startedAt: number;
  updatedAt: number;
  events: LibrarianPersistedEvent[];
}

export interface LibrarianConversationListPage {
  conversations: LibrarianConversationSummary[];
  nextCursor: string | null;
}

export interface LibrarianConversationDetailPage {
  id: string;
  createdAt: number;
  updatedAt: number;
  turns: LibrarianPersistedTurn[];
  nextCursor: string | null;
}

export interface MergedLibrarianConversationDetail extends Omit<LibrarianConversationDetailPage, 'turns'> {
  turns: LibrarianPersistedTurn[];
}

export type LibrarianChatEvent =
  | ({ type: 'action' } & LibrarianAction)
  | { type: 'answer'; recommendations: LibrarianRecommendation[] }
  | { type: 'error'; stage: 'tool' | 'driver'; message: string; recoverable: boolean }
  | { type: 'done'; status: 'answered' | 'exhausted' | 'failed'; rounds: number; tokensUsed: { inputTokens: number; outputTokens: number } }
  | { type: 'interpretation'; chips: unknown[] }
  | { type: 'pile'; added: string[]; removed: Array<{ bookId: string; reason: string }> }
  | { type: 'audit'; note: string; flaggedBookIds?: string[] }
  | ({ type: 'retrieval' } & LibrarianRetrieval)
  | { type: 'token'; text: string };

const EVENT_TYPES = new Set<LibrarianChatEvent['type']>([
  'interpretation',
  'action',
  'pile',
  'answer',
  'audit',
  'retrieval',
  'token',
  'error',
  'done',
]);

function decodeFrame(frame: string): LibrarianChatEvent | null {
  let eventName = '';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!eventName || data.length === 0) return null;
  if (!EVENT_TYPES.has(eventName as LibrarianChatEvent['type'])) {
    throw new Error(`Unknown librarian event: ${eventName}`);
  }
  const payload: unknown = JSON.parse(data.join('\n'));
  return validateLibrarianEvent({ ...(payload as Record<string, unknown>), type: eventName });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecommendation(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const row = item as Record<string, unknown>;
  return typeof row.bookId === 'string'
    && typeof row.reason === 'string'
    && (row.title === undefined || typeof row.title === 'string')
    && (row.author === undefined || typeof row.author === 'string')
    && (row.durationSeconds === undefined || row.durationSeconds === null || typeof row.durationSeconds === 'number')
    && (row.matchedTags === undefined || isStringArray(row.matchedTags))
    && (row.reasonReplaced === undefined || typeof row.reasonReplaced === 'boolean');
}

function isTagResolutionNote(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const row = item as Record<string, unknown>;
  return typeof row.field === 'string' && typeof row.from === 'string' && typeof row.reason === 'string' && isStringArray(row.to);
}

function isRelaxation(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const demoted = (value as Record<string, unknown>).demotedTags;
  return Array.isArray(demoted) && demoted.every((entry) => Boolean(entry) && typeof entry === 'object' && typeof (entry as Record<string, unknown>).tag === 'string');
}

function validateLibrarianEvent(value: unknown): LibrarianChatEvent {
  if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') throw new Error('Malformed librarian event');
  const event = value as Record<string, unknown>;
  if (event.type === 'action' && ['tool', 'label', 'detail', 'resultSummary'].every((key) => typeof event[key] === 'string')) return event as LibrarianChatEvent;
  if (event.type === 'answer' && Array.isArray(event.recommendations) && event.recommendations.every(isRecommendation)) return event as LibrarianChatEvent;
  if (event.type === 'retrieval' && typeof event.tool === 'string' && ['candidateCount', 'evidenceCount', 'semanticScored'].every((key) => typeof event[key] === 'number') && typeof event.personalized === 'boolean' && (event.tagResolution === undefined || (Array.isArray(event.tagResolution) && event.tagResolution.every(isTagResolutionNote))) && isRelaxation(event.relaxation)) return event as LibrarianChatEvent;
  if (event.type === 'error' && (event.stage === 'tool' || event.stage === 'driver') && typeof event.message === 'string' && typeof event.recoverable === 'boolean') return event as LibrarianChatEvent;
  if (event.type === 'done' && ['answered', 'exhausted', 'failed'].includes(String(event.status)) && Number.isInteger(event.rounds) && !!event.tokensUsed && typeof (event.tokensUsed as { inputTokens?: unknown }).inputTokens === 'number' && typeof (event.tokensUsed as { outputTokens?: unknown }).outputTokens === 'number') return event as LibrarianChatEvent;
  if (event.type === 'token' && typeof event.text === 'string') return event as LibrarianChatEvent;
  if (event.type === 'interpretation' && Array.isArray(event.chips)) return event as LibrarianChatEvent;
  if (event.type === 'pile' && Array.isArray(event.added) && event.added.every((id) => typeof id === 'string') && Array.isArray(event.removed) && event.removed.every((item) => item && typeof item === 'object' && typeof (item as { bookId?: unknown }).bookId === 'string' && typeof (item as { reason?: unknown }).reason === 'string')) return event as LibrarianChatEvent;
  if (event.type === 'audit' && typeof event.note === 'string' && (event.flaggedBookIds === undefined || (Array.isArray(event.flaggedBookIds) && event.flaggedBookIds.every((id) => typeof id === 'string')))) return event as LibrarianChatEvent;
  throw new Error(`Malformed librarian ${String(event.type)} event`);
}

function validateConversationList(value: unknown): LibrarianConversationListPage {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { conversations?: unknown }).conversations) || !('nextCursor' in value)) throw new Error('Malformed librarian conversation list');
  const page = value as LibrarianConversationListPage;
  if (page.nextCursor !== null && typeof page.nextCursor !== 'string') throw new Error('Malformed librarian conversation cursor');
  for (const item of page.conversations) if (!item || typeof item !== 'object' || typeof (item as LibrarianConversationSummary).id !== 'string' || typeof (item as LibrarianConversationSummary).createdAt !== 'number' || typeof (item as LibrarianConversationSummary).updatedAt !== 'number' || typeof (item as LibrarianConversationSummary).turnCount !== 'number' || typeof (item as LibrarianConversationSummary).latestStatus !== 'string' || ((item as LibrarianConversationSummary).latestQuestion !== null && typeof (item as LibrarianConversationSummary).latestQuestion !== 'string')) throw new Error('Malformed librarian conversation summary');
  return page;
}

function validateConversationDetail(value: unknown): LibrarianConversationDetailPage {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { turns?: unknown }).turns) || !('nextCursor' in value) || typeof (value as { id?: unknown }).id !== 'string' || typeof (value as LibrarianConversationDetailPage).createdAt !== 'number' || typeof (value as LibrarianConversationDetailPage).updatedAt !== 'number') throw new Error('Malformed librarian conversation detail');
  const page = value as LibrarianConversationDetailPage;
  if (page.nextCursor !== null && typeof page.nextCursor !== 'string') throw new Error('Malformed librarian detail cursor');
  for (const turn of page.turns) { if (!turn || typeof turn !== 'object' || typeof (turn as LibrarianPersistedTurn).id !== 'string' || typeof (turn as LibrarianPersistedTurn).threadId !== 'string' || ((turn as LibrarianPersistedTurn).question !== null && typeof (turn as LibrarianPersistedTurn).question !== 'string') || typeof (turn as LibrarianPersistedTurn).turnIndex !== 'number' || typeof (turn as LibrarianPersistedTurn).status !== 'string' || typeof (turn as LibrarianPersistedTurn).startedAt !== 'number' || typeof (turn as LibrarianPersistedTurn).updatedAt !== 'number' || !Array.isArray((turn as LibrarianPersistedTurn).events)) throw new Error('Malformed librarian turn'); for (const item of (turn as LibrarianPersistedTurn).events) { if (!item || typeof item !== 'object' || typeof (item as LibrarianPersistedEvent).seq !== 'number' || typeof (item as LibrarianPersistedEvent).recordedAt !== 'number') throw new Error('Malformed librarian event record'); validateLibrarianEvent((item as LibrarianPersistedEvent).event); } }
  return page;
}

/** Incremental parser because fetch streams may split an SSE frame anywhere,
 * including halfway through a CRLF pair or JSON string. */
export function createLibrarianSseParser(onEvent: (event: LibrarianChatEvent) => void) {
  let buffer = '';

  const drain = (flush: boolean): void => {
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = decodeFrame(frame);
      if (event) onEvent(event);
      boundary = buffer.indexOf('\n\n');
    }
    if (flush && buffer.trim()) {
      const event = decodeFrame(buffer);
      buffer = '';
      if (event) onEvent(event);
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      drain(false);
    },
    finish(): void {
      drain(true);
    },
  };
}

export async function streamLibrarianChat(
  message: string,
  onEvent: (event: LibrarianChatEvent) => void,
  signal?: AbortSignal,
  conversationId?: string,
  /** "Inspired by" shelf anchors picked in the composer (§2.2 step 1). */
  seedBookIds?: readonly string[]
): Promise<{ conversationId: string | null; turnId: string | null }> {
  const response = await fetch('/api/librarian/chat', {
    method: 'POST',
    headers: withAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      message,
      ...(conversationId ? { conversationId } : {}),
      ...(seedBookIds && seedBookIds.length > 0 ? { seedBookIds: [...seedBookIds] } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    if (response.status === 401) clearAccessToken();
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Librarian request failed (${response.status})`);
  }
  if (!response.body) throw new Error('The librarian response did not include an event stream');

  let terminalSeen = false;
  const parser = createLibrarianSseParser((event) => {
    if (event.type === 'done') terminalSeen = true;
    onEvent(event);
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.finish();
  if (!terminalSeen) throw new Error('The librarian stream ended before a terminal status arrived');
  return {
    conversationId: response.headers.get('X-Conversation-Id'),
    turnId: response.headers.get('X-Conversation-Turn-Id'),
  };
}

async function librarianJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: withAuthHeaders(), signal });
  if (!response.ok) {
    if (response.status === 401) clearAccessToken();
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Librarian request failed (${response.status})`);
  }
  const value = await response.json() as unknown;
  return value as T;
}

export function listLibrarianConversations(limit = 20, cursor?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return librarianJson<unknown>(`/api/librarian/conversations?${params}`, signal).then(validateConversationList);
}

export function getLibrarianConversation(id: string, limit = 20, cursor?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return librarianJson<unknown>(`/api/librarian/conversations/${encodeURIComponent(id)}?${params}`, signal).then(validateConversationDetail);
}

export function mergeLibrarianConversationPages(
  current: MergedLibrarianConversationDetail | null,
  page: LibrarianConversationDetailPage
): MergedLibrarianConversationDetail {
  const byId = new Map((current?.turns ?? []).map((turn) => [turn.id, turn]));
  for (const incoming of page.turns) {
    const existing = byId.get(incoming.id);
    if (!existing) { byId.set(incoming.id, { ...incoming, events: [...incoming.events].sort((a, b) => a.seq - b.seq) }); continue; }
    const events = new Map(existing.events.map((event) => [event.seq, event]));
    for (const event of incoming.events) events.set(event.seq, event);
    byId.set(incoming.id, { ...existing, ...incoming, events: [...events.values()].sort((a, b) => a.seq - b.seq) });
  }
  return { ...page, turns: [...byId.values()].sort((a, b) => a.turnIndex - b.turnIndex) };
}

export function hydratePersistedTurn(turn: LibrarianPersistedTurn): LibrarianChatState {
  let state = beginLibrarianChat(turn.question ?? '');
  for (const { event } of [...turn.events].sort((a, b) => a.seq - b.seq)) state = reduceLibrarianChat(state, event);
  if (state.phase === 'running' || turn.status === 'interrupted') {
    // Two different situations, and the difference is actionable: an
    // `interrupted` turn was reconciled at startup, so the server restarted
    // underneath it and asking again will usually just work. A turn still
    // replaying as `running` reached no terminal event for some other reason.
    // Neither keeps its recommendations — a half-finished answer has not been
    // through the evidence check — but the research trail and candidate pile
    // survive above the bubble, and the retry control acts on either.
    const error = turn.status === 'interrupted'
      ? 'The server restarted while this request was running, so it never finished. Asking again should work.'
      : 'This librarian request did not complete.';
    return { ...state, phase: 'failed', recommendations: [], error };
  }
  return state;
}

export type LibrarianChatPhase = 'idle' | 'running' | 'answered' | 'exhausted' | 'failed';

export interface LibrarianChatState {
  phase: LibrarianChatPhase;
  question: string;
  actions: LibrarianAction[];
  pendingRecommendations: LibrarianRecommendation[];
  recommendations: LibrarianRecommendation[];
  error: string | null;
  tokens: string[];
  audits: LibrarianAudit[];
  candidateBookIds: string[];
  /** One entry per retrieval call that reported a measurement, in order. */
  retrievals: LibrarianRetrieval[];
}

export const EMPTY_LIBRARIAN_CHAT: LibrarianChatState = {
  phase: 'idle',
  question: '',
  actions: [],
  pendingRecommendations: [],
  recommendations: [],
  error: null,
  tokens: [],
  audits: [],
  candidateBookIds: [],
  retrievals: [],
};

export function beginLibrarianChat(question: string): LibrarianChatState {
  return { ...EMPTY_LIBRARIAN_CHAT, phase: 'running', question };
}

/** `answer` is intentionally provisional until `done`. This prevents a
 * forced answer from an exhausted run being rendered as a successful one. */
export function reduceLibrarianChat(state: LibrarianChatState, event: LibrarianChatEvent): LibrarianChatState {
  switch (event.type) {
    case 'action':
      return { ...state, actions: [...state.actions, event] };
    case 'answer':
      return { ...state, pendingRecommendations: event.recommendations };
    case 'error':
      return { ...state, error: event.message };
    case 'token':
      return { ...state, tokens: [...state.tokens, event.text] };
    case 'audit':
      return {
        ...state,
        audits: [...state.audits, { note: event.note, flaggedBookIds: event.flaggedBookIds ?? [] }],
      };
    case 'retrieval': {
      const { type: _type, ...retrieval } = event;
      return { ...state, retrievals: [...state.retrievals, retrieval] };
    }
    case 'pile': {
      const candidateBookIds = [...state.candidateBookIds];
      for (const id of event.added) {
        if (!candidateBookIds.includes(id) && candidateBookIds.length < 15) candidateBookIds.push(id);
      }
      return { ...state, candidateBookIds };
    }
    case 'done':
      if (event.status === 'answered') {
        return {
          ...state,
          phase: 'answered',
          recommendations: state.pendingRecommendations,
          error: null,
        };
      }
      if (event.status === 'exhausted') {
        return {
          ...state,
          phase: 'exhausted',
          recommendations: [],
          error: 'The librarian reached its research limit before completing a fully supported answer.',
        };
      }
      return {
        ...state,
        phase: 'failed',
        recommendations: [],
        error: state.error ?? 'The librarian could not complete this request.',
      };
    default:
      return state;
  }
}
