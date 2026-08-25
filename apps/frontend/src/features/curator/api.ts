/**
 * Typed REST client + TanStack Query hooks. The UI talks ONLY to /api — it never
 * imports from src/core (architecture boundary). Types here are local mirrors of
 * the API responses, intentionally decoupled from the server's internal types.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clearAccessToken, withAuthHeaders } from '../../auth/session.js';
import type { LibraryReadinessView } from './readiness.js';

export type TagCategory =
  | 'genre'
  | 'mood'
  | 'theme'
  | 'era'
  | 'pacing'
  | 'length'
  | 'audience'
  | 'trope'
  | 'structure'
  | 'character'
  | 'setting';

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

export interface AcquisitionPipelineEntry {
  id: string;
  title: string;
  detail: string;
  updatedAt?: number;
  progress?: number;
  eta?: number;
}

export interface AcquisitionPipeline {
  downloading: AcquisitionPipelineEntry[];
  processing: AcquisitionPipelineEntry[];
  requiresInput: AcquisitionPipelineEntry[];
  shelved24h: AcquisitionPipelineEntry[];
}

export type RecommendationScope = 'both' | 'shelf' | 'discover';

export interface RecommendationResult {
  interpretation: string;
  constraints: { maxDurationHours: number | null; genres: string[]; moods: string[] };
  scope: RecommendationScope;
  onShelf: Array<Book & { reason: string; tags: BookTag[] }>;
  available: Array<{
    title: string;
    author: string;
    reason: string;
    description: string | null;
    durationSeconds: number | null;
    genre: string | null;
    coverUrl: string | null;
    storeUrl: string | null;
  }>;
}

// ── Vocabulary promotion queue ──────────────────────────────────────────────

export type VocabTermStatus = 'seed' | 'proposed' | 'promoted' | 'rejected';

/** A proposed (llm-open) tag awaiting a promote/reject/alias decision. */
export interface ProposedVocabTerm {
  term: string;
  category: TagCategory;
  status: VocabTermStatus;
  bookCount: number;
  firstSeen: number;
  sampleBooks: string[];
}

export interface Template {
  id: string;
  name: string;
  description: string;
  usesClaude: boolean;
}

// ── Enrichment + embedding pipeline runs ────────────────────────────────────

export interface PipelineRunBody {
  dryRun?: boolean;
  sample?: boolean;
  sampleSize?: number;
  bookIds?: string[];
  /**
   * Title-parse only: re-parse books that already carry a parse. Required
   * after the parser itself improves — an already-parsed library has no
   * candidates left, so the run would otherwise silently do nothing.
   */
  reparse?: boolean;
  /**
   * Enrichment only: ignore the cache TTLs and re-look-up every active book.
   * The cache is keyed on the book, not the query sent, so after a title fix
   * every cached 'not-found' row is stale in a way no timestamp captures —
   * without this a re-run can report 0 candidates even though every book is
   * now findable. Expensive: it re-fetches the whole library from external
   * providers.
   */
  refresh?: boolean;
  concurrency?: number;
}

/** Local mirror of `ProviderStats & { hitRate }` (core/enrichment/types.ts) —
 *  the curator frontend keeps its own API types, decoupled from backend internals. */
export interface EnrichmentProviderStats {
  fetched: number;
  ok: number;
  notFound: number;
  errors: number;
  hitRate: number;
}

/** Local mirror of `EnrichmentQualityReport`. */
export interface EnrichmentQualityReport {
  sampled: number;
  candidatesTotal: number;
  providers: Record<string, EnrichmentProviderStats>;
  entityCoverage: { withEntities: number; withoutEntities: number; avgEntitiesPerBook: number };
  examples: Array<{
    bookId: string;
    title: string;
    providers: Record<string, 'ok' | 'not-found' | 'error'>;
    entities: Array<{ entity: string; kind: string }>;
    subjects: string[];
  }>;
}

/** Local mirror of `EnrichmentResult` (only the fields the panel reads). */
export interface EnrichmentRunResult {
  processed: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  cancelled?: boolean;
  entitiesWritten: number;
  sample?: boolean;
  /** Present on a dry run: the books that would have been fetched. */
  plan?: Array<{ bookId: string; title: string }>;
  qualityReport?: EnrichmentQualityReport;
}

/** Local mirror of `EmbeddingResult` (only the fields the panel reads). */
export interface EmbeddingRunResult {
  processed: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  cancelled?: boolean;
  sample?: boolean;
  embedded: number;
  unchanged: number;
  /** Present on a dry run: the books that would have been (re-)embedded. */
  plan?: Array<{ bookId: string; title: string }>;
}

/** Local mirror of `TitleParseReviewEntry` (core/enrichment/types.ts). */
export interface TitleParseReviewEntry {
  bookId: string;
  originalTitle: string;
  normalizedTitle: string;
  /** What the book already carries — distinguishes "found nothing" from
   *  "found something we already had". */
  existingAuthor: string | null;
  existingYear: number | null;
  parsedAuthor: string | null;
  parsedYear: number | null;
  ordinal: number | null;
  confidence: 'high' | 'low';
  wouldFill: string[];
}

/** Local mirror of `TitleParseResult` (only the fields the panel reads). */
export interface TitleParseRunResult {
  processed: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  cancelled?: boolean;
  sample?: boolean;
  /** Present on a dry run: up to REVIEW_CAP rows, for eyeballing. */
  review?: TitleParseReviewEntry[];
  /** Present on a dry run: the true row count behind `review`, independent of its cap. */
  reviewTotal?: number;
  filledAuthorCount: number;
  filledYearCount: number;
  lowConfidenceCount: number;
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
    headers: withAuthHeaders({ 'Content-Type': 'application/json', ...(init?.headers ?? {}) }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    // A stale or rejected token must not leave the app retrying with it
    // forever; drop it so the UI can prompt for a new one.
    if (res.status === 401) clearAccessToken();
    const message = (body && (body.error as string)) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  // `/health` is mounted on the app root, not under /api — see index.ts.
  health: () => fetch('/health').then((r) => r.json()),
  // Everything below tagged `/librarian/` lives on the librarian router, which
  // mounts at /api/librarian (index.ts: `api.use("/librarian", ...)`). Without
  // the prefix the request 404s into the SPA fallback and the caller gets
  // index.html back, so `await res.json()` dies on "Unexpected token '<'".
  // That is why the Desk health panel never had data. acquisitionPipeline
  // always carried the prefix, which is what makes the rest an omission
  // rather than a convention.
  libraryHealth: () => http<any>('/librarian/health/library'),
  downloadsQueue: () => http<any>('/librarian/downloads/queue'),
  acquisitionPipeline: () => http<AcquisitionPipeline>('/librarian/downloads/pipeline'),
  recommendations: (body: { prompt: string; seedBookIds: string[]; scope?: RecommendationScope }) =>
    http<RecommendationResult>('/recommendations', { method: 'POST', body: JSON.stringify(body) }),
  recentlyAdded: () => http<any>('/librarian/recently-added'),
  // Library-readiness signal (plan §10.D). A curator route, so no
  // /librarian prefix — see api.routes.test.ts for why that matters.
  readiness: () => http<LibraryReadinessView>('/readiness'),
  realignScan: () => http<any>('/librarian/realign/scan'),
  realignExecute: (candidates: any[]) => http<any>('/librarian/realign/execute', { method: 'POST', body: JSON.stringify({ candidates }) }),
  sync: () => http<unknown>('/sync', { method: 'POST' }),
  log: () => http<LogEntry[]>('/log'),

  books: (params: Record<string, string>) =>
    http<{ books: Book[]; total: number; limit: number; offset: number }>(
      `/books?${new URLSearchParams(params).toString()}`
    ),
  bookTitles: () => http<string[]>('/books/titles'),
  book: (id: string) => http<Book>(`/books/${id}`),

  tagStats: () =>
    http<{
      totalBooks: number;
      taggedBooks: number;
      untaggedBooks: number;
      vocabularySize: number;
      avgTagTokens: { inputTokensPerBook: number; outputTokensPerBook: number; sampleSize: number } | null;
    }>('/tags/stats'),
  vocabulary: () => http<{ tag: string; category: TagCategory; count: number }[]>('/tags/vocabulary'),
  tagQuality: () => http<{ totalTagged: number; ok: boolean; booksMissingRequiredCategories: unknown[]; outOfVocabulary: unknown[] }>('/tags/quality'),
  tagRun: (body: { dryRun?: boolean; sample?: boolean; concurrency?: number }) =>
    http<{ operationId: string; status: string }>('/tags/run', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  retag: (bookIds: string[]) =>
    http<{ operationId: string }>('/tags/retag', { method: 'POST', body: JSON.stringify({ bookIds }) }),
  retagAll: (body: { dryRun?: boolean; sample?: boolean; concurrency?: number }) =>
    http<{ operationId: string; status: string }>('/tags/retag-all', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteBookTags: (id: string) => http<unknown>(`/books/${id}/tags`, { method: 'DELETE' }),

  enrichmentRun: (body: PipelineRunBody) =>
    http<{ operationId: string; status: string }>('/enrichment/run', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  embeddingsRun: (body: PipelineRunBody) =>
    http<{ operationId: string; status: string }>('/embeddings/run', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  titleParseRun: (body: PipelineRunBody) =>
    http<{ operationId: string; status: string }>('/title-parse/run', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  proposedVocabTerms: () => http<ProposedVocabTerm[]>('/vocab/proposed'),
  promoteVocabTerm: (term: string, category: TagCategory) =>
    http<{ term: string; category: TagCategory; status: 'promoted'; retagged: number }>('/vocab/promote', {
      method: 'POST',
      body: JSON.stringify({ term, category }),
    }),
  rejectVocabTerm: (term: string, category: TagCategory) =>
    http<{ term: string; category: TagCategory; status: VocabTermStatus; bookCount: number; firstSeen: number }>(
      '/vocab/reject',
      { method: 'POST', body: JSON.stringify({ term, category }) }
    ),
  aliasVocabTerm: (alias: string, canonical: string, category: TagCategory) =>
    http<{ alias: string; canonical: string; category: TagCategory; retagged: number }>('/vocab/alias', {
      method: 'POST',
      body: JSON.stringify({ alias, canonical, category }),
    }),

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
// 5 minutes, not 30 seconds. /health/library fetches every item from every ABS
// library and then runs a full filesystem realign scan; at 30s that ran twice a
// minute for as long as the Desk stayed open — a lot of load for a number that
// moves when you import books, not when you blink. `retry: false` so a failure
// surfaces as an error state instead of hammering the endpoint.
export const useLibraryHealth = () =>
  useQuery({
    queryKey: ['libraryHealth'],
    queryFn: api.libraryHealth,
    refetchInterval: 300_000,
    retry: false,
  });
export const useDownloadsQueue = () =>
  useQuery({ queryKey: ['downloadsQueue'], queryFn: api.downloadsQueue, refetchInterval: 5000 });
export const useAcquisitionPipeline = () =>
  useQuery({ queryKey: ['acquisitionPipeline'], queryFn: api.acquisitionPipeline, refetchInterval: 5000 });
export const useRecentlyAdded = () =>
  useQuery({ queryKey: ['recentlyAdded'], queryFn: api.recentlyAdded, refetchInterval: 60_000 });
export const useRealignScan = () =>
  useQuery({ queryKey: ['realignScan'], queryFn: api.realignScan, enabled: false });
export const useTagStats = () => useQuery({ queryKey: ['tagStats'], queryFn: api.tagStats });
// Cheap by construction — a few indexed COUNT(DISTINCT) queries over the local
// mirror, no ABS call — so unlike libraryHealth this can refresh often.
export const useReadiness = () =>
  useQuery({ queryKey: ['readiness'], queryFn: api.readiness, refetchInterval: 60_000 });
export const useLog = () => useQuery({ queryKey: ['log'], queryFn: api.log });
export const useTemplates = () => useQuery({ queryKey: ['templates'], queryFn: api.templates });
export const useCollections = (status?: string) =>
  useQuery({ queryKey: ['collections', status], queryFn: () => api.collections(status) });
export const useCollection = (id: number) =>
  useQuery({ queryKey: ['collection', id], queryFn: () => api.collection(id) });
export const useVocabulary = () => useQuery({ queryKey: ['vocabulary'], queryFn: api.vocabulary });
export const useProposedVocabTerms = () =>
  useQuery({ queryKey: ['proposedVocabTerms'], queryFn: api.proposedVocabTerms });

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
  useQuery({
    queryKey: ['operations'],
    queryFn: api.operations,
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasActive = data?.some((op) => !['completed', 'cancelled', 'error'].includes(op.status));
      return hasActive ? 800 : 3000;
    },
  });

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
