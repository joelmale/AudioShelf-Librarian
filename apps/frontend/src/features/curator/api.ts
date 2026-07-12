/**
 * Typed REST client + TanStack Query hooks. The UI talks ONLY to /api — it never
 * imports from src/core (architecture boundary). Types here are local mirrors of
 * the API responses, intentionally decoupled from the server's internal types.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type TagCategory = 'genre' | 'mood' | 'theme' | 'era' | 'pacing' | 'length' | 'audience';

export interface BookTag {
  id: number;
  bookId: string;
  tag: string;
  category: TagCategory;
  confidence: number;
}

export interface Book {
  id: string;
  title: string;
  author: string | null;
  series: string | null;
  seriesSequence: number | null;
  durationSeconds: number | null;
  publishedYear: number | null;
  genres: string[];
  description: string | null;
  coverPath: string | null;
  tags?: BookTag[];
}

export interface Collection {
  id: number;
  name: string;
  description: string | null;
  theme: string;
  status: 'proposed' | 'approved' | 'pushed' | 'rejected';
  absCollectionId: string | null;
  createdAt: number;
  pushedAt: number | null;
  books?: Book[];
}

export interface OperationSnapshot {
  id: string;
  type: string;
  status: 'running' | 'paused' | 'cancelling' | 'cancelled' | 'completed' | 'error';
  progress: { phase: string; current: number; total: number; message?: string };
  createdAt: number;
  finishedAt: number | null;
  summary: unknown;
  error: { code: string; message: string } | null;
}

export interface ActionLogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  operationId?: string;
  event: string;
  message: string;
  detail?: unknown;
}

export interface LogEntry {
  id: number;
  operation: string;
  status: string;
  detail: unknown;
  startedAt: number;
  finishedAt: number | null;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  usesClaude: boolean;
}

// ── Encoder ────────────────────────────────────────────────────────────────────

export interface ABSLibrary {
  id: string;
  name: string;
}

export interface AudioProbe {
  codec: string | null;
  bitRate: number | null;
  sampleRate: number | null;
  channels: number | null;
  durationSeconds: number | null;
  chapterCount: number;
}

export interface EncodeCandidate {
  libraryItemId: string;
  libraryId: string;
  name: string;
  author: string;
  files: string[];
  totalBytes: number;
}

export interface EncoderConfig {
  enabled: boolean;
  rescanAvailable: boolean;
}

export interface EncodeQueueItem {
  id: string; // libraryItemId
  libraryId: string;
  name: string;
  author: string;
  totalBytes: number;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'error';
  sortOrder: number;
  addedAt: number;
  detail: unknown | null;
}

export interface EncodeHistoryItem {
  id: number;
  libraryItemId: string;
  name: string;
  author: string;
  totalBytes: number;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  detail: unknown | null;
}

export interface EncodeEnqueueRequest {
  candidates: string[];
  libraryId: string;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message = (body && (body.error as string)) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  health: () => fetch('/health').then((r) => r.json()),
  sync: () => http<unknown>('/sync', { method: 'POST' }),
  log: () => http<LogEntry[]>('/log'),

  books: (params: Record<string, string>) =>
    http<{ books: Book[]; total: number; limit: number; offset: number }>(
      `/books?${new URLSearchParams(params).toString()}`
    ),
  bookTitles: () => http<string[]>('/books/titles'),
  book: (id: string) => http<Book>(`/books/${id}`),

  tagStats: () =>
    http<{ totalBooks: number; taggedBooks: number; untaggedBooks: number; vocabularySize: number }>(
      '/tags/stats'
    ),
  vocabulary: () => http<{ tag: string; category: TagCategory; count: number }[]>('/tags/vocabulary'),
  tagQuality: () => http<{ totalTagged: number; ok: boolean; booksMissingRequiredCategories: unknown[]; outOfVocabulary: unknown[] }>('/tags/quality'),
  tagRun: (body: { dryRun?: boolean; sample?: boolean; concurrency?: number }) =>
    http<{ operationId: string; status: string }>('/tags/run', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  retag: (bookIds: string[]) =>
    http<{ operationId: string }>('/tags/retag', { method: 'POST', body: JSON.stringify({ bookIds }) }),
  deleteBookTags: (id: string) => http<unknown>(`/books/${id}/tags`, { method: 'DELETE' }),

  operations: () => http<OperationSnapshot[]>('/operations'),
  operation: (id: string) => http<OperationSnapshot>(`/operations/${id}`),
  pauseOp: (id: string) => http<unknown>(`/operations/${id}/pause`, { method: 'POST' }),
  resumeOp: (id: string) => http<unknown>(`/operations/${id}/resume`, { method: 'POST' }),
  cancelOp: (id: string) => http<unknown>(`/operations/${id}/cancel`, { method: 'POST' }),
  actionLogs: (params: Record<string, string>) =>
    http<ActionLogEntry[]>(`/logs/actions?${new URLSearchParams(params).toString()}`),
  setLogLevel: (level: string) =>
    http<unknown>('/settings/log-level', { method: 'PUT', body: JSON.stringify({ level }) }),

  templates: () => http<Template[]>('/collections/templates'),
  collections: (status?: string) =>
    http<Collection[]>(`/collections${status ? `?status=${status}` : ''}`),
  collection: (id: number) => http<Collection>(`/collections/${id}`),
  generate: (body: { templateIds?: string[]; customPrompt?: string }) =>
    http<{ collections: Collection[]; operationId?: string }>('/collections/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  discover: () => 
    http<{ operationId: string }>('/collections/discover', { method: 'POST' }),
  approve: (id: number) => http<Collection>(`/collections/${id}/approve`, { method: 'POST' }),
  reject: (id: number) => http<Collection>(`/collections/${id}/reject`, { method: 'POST' }),
  patchCollection: (id: number, body: { name?: string; description?: string }) =>
    http<Collection>(`/collections/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  reorder: (id: number, bookIds: string[]) =>
    http<Collection>(`/collections/${id}/reorder`, { method: 'POST', body: JSON.stringify({ bookIds }) }),
  push: (id: number, policy: string) =>
    http<{ action: string; finalName: string }>(`/collections/${id}/push`, {
      method: 'POST',
      body: JSON.stringify({ policy }),
    }),
  pushAll: (policy: string) =>
    http<{ results: unknown[]; errors: unknown[] }>('/collections/push-all', {
      method: 'POST',
      body: JSON.stringify({ policy }),
    }),
  deleteCollection: (id: number) => http<unknown>(`/collections/${id}`, { method: 'DELETE' }),

  encoderConfig: () => http<EncoderConfig>('/encode/config'),
  encodeLibraries: () => http<ABSLibrary[]>('/encode/libraries'),
  encodeCandidates: (libraryId: string) =>
    http<{ candidates: EncodeCandidate[]; total: number }>(`/encode/candidates?libraryId=${libraryId}`),
  encodeScan: (libraryId: string) =>
    http<{ candidates: EncodeCandidate[]; total: number }>(`/encode/scan?libraryId=${libraryId}`),
  encodeQueue: () => http<EncodeQueueItem[]>('/encode/queue'),
  encodeEnqueue: (body: EncodeEnqueueRequest) =>
    http<{ success: boolean; count: number }>('/encode/queue', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  encodeReorder: (id: string, sortOrder: number) =>
    http<{ success: boolean }>(`/encode/queue/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ sortOrder }),
    }),
  encodeRemove: (id: string) =>
    http<{ success: boolean }>(`/encode/queue/${id}`, { method: 'DELETE' }),
  /** Force-remove an item regardless of status (running items are detached; ABS finishes in background). */
  encodeForceRemove: (id: string) =>
    http<{ success: boolean; forced: boolean }>(`/encode/queue/${id}?force=true`, { method: 'DELETE' }),
  /** Explicit cancel with a human-readable explanation message returned in the response. */
  encodeCancel: (id: string) =>
    http<{ success: boolean; wasRunning: boolean; message: string }>(`/encode/queue/${id}/cancel`, { method: 'POST' }),
  /** Live diagnostic snapshot: worker state + ABS active tasks + current item encode status. */
  encodeStatus: () =>
    http<{
      worker: { isRunning: boolean; currentTaskId: string | null; queueLength: number };
      queue: EncodeQueueItem[];
      absActiveTasks: unknown[];
      currentItemAlreadyEncoded: boolean | null;
    }>('/encode/status'),
  encodeHistory: () => http<EncodeHistoryItem[]>('/encode/history'),
};

// ── Hooks ─────────────────────────────────────────────────────────────────────

export const useHealth = () =>
  useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 });
export const useTagStats = () => useQuery({ queryKey: ['tagStats'], queryFn: api.tagStats });
export const useLog = () => useQuery({ queryKey: ['log'], queryFn: api.log });
export const useTemplates = () => useQuery({ queryKey: ['templates'], queryFn: api.templates });
export const useCollections = (status?: string) =>
  useQuery({ queryKey: ['collections', status], queryFn: () => api.collections(status) });
export const useCollection = (id: number) =>
  useQuery({ queryKey: ['collection', id], queryFn: () => api.collection(id) });
export const useVocabulary = () => useQuery({ queryKey: ['vocabulary'], queryFn: api.vocabulary });

export const useOperation = (id: string | null) =>
  useQuery({
    queryKey: ['operation', id],
    queryFn: () => api.operation(id as string),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const data = query.state.data;
      const terminal = data && ['completed', 'cancelled', 'error'].includes(data.status);
      return terminal ? false : 800;
    },
  });

export const useOperations = () =>
  useQuery({ queryKey: ['operations'], queryFn: api.operations });

export const useEncoderConfig = () =>
  useQuery({ queryKey: ['encoderConfig'], queryFn: api.encoderConfig });
export const useEncodeLibraries = () =>
  useQuery({ queryKey: ['encodeLibraries'], queryFn: api.encodeLibraries });
export const useEncodeQueue = () =>
  useQuery({
    queryKey: ['encodeQueue'],
    queryFn: api.encodeQueue,
    // Poll so the queue stays live without a manual refresh
    refetchInterval: 3000,
  });

export const useEncodeStatus = () =>
  useQuery({
    queryKey: ['encodeStatus'],
    queryFn: api.encodeStatus,
    // Only useful on demand — caller can trigger manually
    enabled: false,
  });
export const useEncodeHistory = () =>
  useQuery({ queryKey: ['encodeHistory'], queryFn: api.encodeHistory, refetchInterval: 3000 });

export function useInvalidate() {
  const qc = useQueryClient();
  return (keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

export { useMutation };

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
