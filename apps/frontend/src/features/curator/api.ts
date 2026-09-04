/**
 * Typed REST client + TanStack Query hooks. The UI talks ONLY to /api — it never
 * imports from src/core (architecture boundary). Types here are local mirrors of
 * the API responses, intentionally decoupled from the server's internal types.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clearAccessToken, withAuthHeaders } from '../../auth/session.js';
import type { GroundingResidualView, LibraryReadinessView } from './readiness.js';

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

/** One disclosed rewrite of a supplied tag filter — see the backend's
 *  `core/retrieval/tagResolution.ts`. */
export interface TagResolutionNote {
  field: string;
  from: string;
  to: string[];
  reason: string;
}

export interface RecommendationResult {
  interpretation: string;
  constraints: { maxDurationHours: number | null; genres: string[]; moods: string[] };
  scope: RecommendationScope;
  /** Groups this slate's impression rows; send it back with feedback. */
  slateId: string;
  /** What retrieval actually ran, for honest disclosure of any rewrite. */
  retrieval: {
    candidateCount: number;
    evidenceCount: number;
    tagResolution: TagResolutionNote[];
    /** Whether a taste profile blended into this ranking. */
    personalized: boolean;
  };
  onShelf: Array<Book & {
    reason: string;
    tags: BookTag[];
    /** The tags the ranker scored this book on — render these, not `tags`. */
    matchedTags: string[];
    /** The model's sentence was about a different book and was replaced. */
    reasonReplaced?: boolean;
  }>;
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

export interface RecFeedbackRow {
  id: number;
  bookId: string | null;
  externalKey: string | null;
  queryText: string;
  verdict: 'accepted' | 'rejected' | 'finished' | 'abandoned';
  source: 'explicit' | 'implicit';
  weight: number;
  createdAt: number;
}

export interface ListeningSyncResult {
  progressStored: number;
  progressSkippedUnknownBook: number;
  sessionsInserted: number;
  sessionsSkippedUnknownBook: number;
  feedbackWritten: number;
  feedbackDeferred: number;
}

/** `available: false` is the honest cold start — not "you like nothing". */
export interface TasteProfileView {
  available: boolean;
  reason?: string;
  modes: Array<{
    index: number;
    memberCount: number;
    members: Array<{ id: string; title: string; author: string | null; affinity: number | null }>;
  }>;
  positiveCount?: number;
  negativeCount?: number;
}

// ── Vocabulary promotion queue ──────────────────────────────────────────────

export type VocabTermStatus = 'seed' | 'proposed' | 'promoted' | 'rejected';

/** Which pass proposed a term: the LLM tagger's llm-open output, or R1's
 *  cached-provider-subjects promotion. An 'enrichment' row never has a
 *  `sampleBooks` entry — R1 writes no `book_tags` rows, so there is nothing
 *  of `source: 'llm-open'` for the sample-titles query to find — see
 *  `VocabularySuggestionsPanel`. */
export type VocabTermOrigin = 'tagger' | 'enrichment';

/** A proposed tag awaiting a promote/reject/alias decision — from the LLM
 *  tagger's llm-open output ('tagger') or R1's cached-provider-subjects
 *  promotion ('enrichment'); see {@link VocabTermOrigin}. */
export interface ProposedVocabTerm {
  term: string;
  category: TagCategory;
  status: VocabTermStatus;
  bookCount: number;
  firstSeen: number;
  sampleBooks: string[];
  origin: VocabTermOrigin;
  /** True when the same term is live in another category; bulk promotion is blocked. */
  categoryCollision: boolean;
  /** Conservative spelling/plural/hyphen matches to existing canonical terms. */
  aliasSuggestions: string[];
}

export interface ProposedVocabBook {
  id: string;
  title: string;
  author: string | null;
  description: string | null;
  descriptionSource: string | null;
}

export interface VocabBatchResult {
  action: 'promote' | 'reject';
  reviewed: number;
  retagged: number;
  affectedBooks: number;
  reembed: unknown | null;
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
  /**
   * Enrichment only: continue the re-check campaign that began at this epoch
   * (ms) instead of starting a fresh sweep. Books whose row for a provider was
   * written at or after it count as already re-checked.
   *
   * A library-sized re-check does not fit in one run — Google Books' free tier
   * allows 1000 queries/day against ~2-6 per book — and without this each
   * attempt re-listed every book in title order, re-spending the budget on the
   * same alphabetical head.
   */
  refreshBefore?: number;
  concurrency?: number;
}

/**
 * An in-progress re-check of the whole library, which routinely spans several
 * runs because the external providers' daily quotas cannot cover a library in
 * one. `remaining` is the union across providers — what the next run picks up.
 */
export interface RefreshCampaign {
  refreshBefore: number;
  startedAt: number;
  remaining: number;
}

/** Local mirror of `ProviderStats & { hitRate }` (core/enrichment/types.ts) —
 *  the curator frontend keeps its own API types, decoupled from backend internals. */
export interface EnrichmentProviderStats {
  fetched: number;
  ok: number;
  notFound: number;
  errors: number;
  /** Abandoned because the provider was rate-limiting us — our request rate,
   *  not the provider's knowledge of the book. Excluded from `fetched`. */
  throttled: number;
  /** `ok / fetched`, or null when nothing was fetched. Null means "not asked"
   *  — rendering it as 0% claims a total failure that never happened. */
  hitRate: number | null;
}

/** Local mirror of `EnrichmentQualityReport`. */
export interface EnrichmentQualityReport {
  sampled: number;
  candidatesTotal: number;
  providers: Record<string, EnrichmentProviderStats>;
  entityCoverage: {
    withEntities: number;
    withoutEntities: number;
    avgEntitiesPerBook: number;
    withNotableEntities: number;
    avgNotablePerBook: number;
  };
  examples: Array<{
    bookId: string;
    title: string;
    providers: Record<string, 'ok' | 'not-found' | 'error'>;
    /** Notable first — see the backend docblock. */
    entities: Array<{ entity: string; kind: string; notable: boolean }>;
    entityCounts: { total: number; notable: number };
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
  /**
   * Providers retired mid-run on a per-DAY quota. Present only when non-empty.
   * The run still completes — the remaining providers carry on — so this is the
   * only signal that the run covered less ground than its status suggests.
   */
  quotaExhausted?: string[];
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

// Local mirrors of the librarian realignment and health API contracts. Keep
// these explicit: both surfaces make safety decisions from Unknown/coverage
// state and must not silently accept a differently shaped response.
export type LibraryMeasurementStatus = 'Great' | 'Good' | 'Attention' | 'Unknown';

export interface LibraryMeasurement {
  libraryId: string;
  name: string;
  status: LibraryMeasurementStatus;
  score: number;
  total: number | null;
  observed: number;
  configuredObserved: number;
  eligible: number;
  matched: number;
  issues: number | null;
  coverage: number;
}

export interface RealignCandidate {
  bookId: string;
  libraryId: string;
  title: string;
  author: string;
  currentPath: string;
  proposedPath: string;
}

export interface RealignPlan {
  planId: string;
  createdAt: string;
  expiresAt: string;
  libraries: LibraryMeasurement[];
  candidates: RealignCandidate[];
}

export interface RealignExecution {
  success: true;
  moved: number;
  failed: number;
  errors: string[];
  scanErrors: string[];
  historyBatchId: string | null;
}

export interface LibraryHealth {
  success: true;
  health: {
    metadata: { score: number; status: LibraryMeasurementStatus };
    files: { score: number; status: LibraryMeasurementStatus; note?: string };
    structure: Omit<LibraryMeasurement, 'libraryId' | 'name'> & { note?: string };
    duplicates: { score: number; status: LibraryMeasurementStatus };
  };
  overallScore: number;
  totals: {
    books: number;
    completeMetadata: number;
    m4b: number;
    structureIssues: number | null;
    duplicates: number;
  };
  unmeasured: string[];
  generatedAt: number;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid ${context} response`);
  return value as Record<string, unknown>;
}
function stringField(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${context} response`);
  return value;
}
function dateField(value: unknown, context: string): string {
  const text = stringField(value, context);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`Invalid ${context} response`);
  return text;
}
function numberField(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${context} response`);
  return value;
}
function nullableNumberField(value: unknown, context: string): number | null {
  return value === null ? null : numberField(value, context);
}
function stringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`Invalid ${context} response`);
  return value;
}
function measurementStatus(value: unknown, context: string): LibraryMeasurementStatus {
  if (value !== 'Great' && value !== 'Good' && value !== 'Attention' && value !== 'Unknown') throw new Error(`Invalid ${context} response`);
  return value;
}
function parseMeasurement(value: unknown, context: string, identity: boolean): LibraryMeasurement | Omit<LibraryMeasurement, 'libraryId' | 'name'> {
  const item = record(value, context);
  const measurement = {
    status: measurementStatus(item.status, context), score: numberField(item.score, context),
    total: nullableNumberField(item.total, context), observed: numberField(item.observed, context),
    configuredObserved: numberField(item.configuredObserved, context), eligible: numberField(item.eligible, context),
    matched: numberField(item.matched, context), issues: nullableNumberField(item.issues, context),
    coverage: numberField(item.coverage, context),
  };
  return identity ? { libraryId: stringField(item.libraryId, context), name: stringField(item.name, context), ...measurement } : measurement;
}

export function parseRealignPlan(value: unknown): RealignPlan {
  const body = record(value, 'realignment plan');
  if (!Array.isArray(body.libraries) || !Array.isArray(body.candidates)) throw new Error('Invalid realignment plan response');
  return {
    planId: stringField(body.planId, 'realignment plan'), createdAt: dateField(body.createdAt, 'realignment plan'), expiresAt: dateField(body.expiresAt, 'realignment plan'),
    libraries: body.libraries.map((entry) => parseMeasurement(entry, 'realignment plan', true) as LibraryMeasurement),
    candidates: body.candidates.map((entry) => {
      const candidate = record(entry, 'realignment plan');
      return { bookId: stringField(candidate.bookId, 'realignment plan'), libraryId: stringField(candidate.libraryId, 'realignment plan'), title: stringField(candidate.title, 'realignment plan'), author: stringField(candidate.author, 'realignment plan'), currentPath: stringField(candidate.currentPath, 'realignment plan'), proposedPath: stringField(candidate.proposedPath, 'realignment plan') };
    }),
  };
}

export function parseRealignExecution(value: unknown): RealignExecution {
  const body = record(value, 'realignment execution');
  if (body.success !== true) throw new Error('Invalid realignment execution response');
  return { success: true, moved: numberField(body.moved, 'realignment execution'), failed: numberField(body.failed, 'realignment execution'), errors: stringArray(body.errors, 'realignment execution'), scanErrors: stringArray(body.scanErrors, 'realignment execution'), historyBatchId: body.historyBatchId === null ? null : stringField(body.historyBatchId, 'realignment execution') };
}

export function parseLibraryHealth(value: unknown): LibraryHealth {
  const body = record(value, 'library health'); const health = record(body.health, 'library health'); const totals = record(body.totals, 'library health');
  const scored = (entry: unknown) => { const item = record(entry, 'library health'); return { score: numberField(item.score, 'library health'), status: measurementStatus(item.status, 'library health'), ...(typeof item.note === 'string' ? { note: item.note } : {}) }; };
  const structureRecord = record(health.structure, 'library health');
  if (body.success !== true || !Array.isArray(body.unmeasured)) throw new Error('Invalid library health response');
  return {
    success: true,
    health: { metadata: scored(health.metadata), files: scored(health.files), structure: { ...(parseMeasurement(structureRecord, 'library health', false) as Omit<LibraryMeasurement, 'libraryId' | 'name'>), ...(typeof structureRecord.note === 'string' ? { note: structureRecord.note } : {}) }, duplicates: scored(health.duplicates) },
    overallScore: numberField(body.overallScore, 'library health'),
    totals: { books: numberField(totals.books, 'library health'), completeMetadata: numberField(totals.completeMetadata, 'library health'), m4b: numberField(totals.m4b, 'library health'), structureIssues: nullableNumberField(totals.structureIssues, 'library health'), duplicates: numberField(totals.duplicates, 'library health') },
    unmeasured: stringArray(body.unmeasured, 'library health'), generatedAt: numberField(body.generatedAt, 'library health'),
  };
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
  libraryHealth: async () => parseLibraryHealth(await http<unknown>('/librarian/health/library')),
  downloadsQueue: () => http<any>('/librarian/downloads/queue'),
  acquisitionPipeline: () => http<AcquisitionPipeline>('/librarian/downloads/pipeline'),
  recommendations: (body: { prompt: string; seedBookIds: string[]; scope?: RecommendationScope }) =>
    http<RecommendationResult>('/recommendations', { method: 'POST', body: JSON.stringify(body) }),

  // ── Phase 5 feedback ─────────────────────────────────────────────────────
  // Only `accepted`/`rejected` are sendable: `finished`/`abandoned` are
  // derived from listening data server-side and must not be forgeable here,
  // or the taste profile could be shaped by something other than behaviour.
  sendFeedback: (body: {
    bookId?: string;
    externalKey?: string;
    queryText: string;
    verdict: 'accepted' | 'rejected';
  }) => http<{ id: number }>('/feedback', { method: 'POST', body: JSON.stringify(body) }),

  listFeedback: (params: { since?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.since !== undefined) query.set('since', String(params.since));
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return http<RecFeedbackRow[]>(`/feedback${suffix ? `?${suffix}` : ''}`);
  },

  syncListening: () => http<ListeningSyncResult>('/listening/sync', { method: 'POST' }),

  taste: () => http<TasteProfileView>('/taste'),
  recentlyAdded: () => http<any>('/librarian/recently-added'),
  // Library-readiness signal (plan §10.D). A curator route, so no
  // /librarian prefix — see api.routes.test.ts for why that matters.
  readiness: () => http<LibraryReadinessView>('/readiness'),
  groundingResidual: () => http<GroundingResidualView>('/readiness/grounding-residual'),
  realignScan: async () => parseRealignPlan(await http<unknown>('/librarian/realign/scan')),
  realignExecute: async (request: { planId: string; bookIds: string[] }) =>
    parseRealignExecution(await http<unknown>('/librarian/realign/execute', { method: 'POST', body: JSON.stringify(request) })),
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
  /** The re-check campaign still in progress, if any, and how many books of it
   *  are left. `campaign` is null when none was ever started. */
  enrichmentRefreshCampaign: () =>
    http<{ campaign: RefreshCampaign | null }>('/enrichment/refresh-campaign'),
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
  proposedVocabBooks: (term: string, category: TagCategory) => {
    const query = new URLSearchParams({ term, category });
    return http<{ term: string; category: TagCategory; total: number; books: ProposedVocabBook[] }>(
      `/vocab/proposed/books?${query.toString()}`
    );
  },
  reviewVocabBatch: (action: 'promote' | 'reject', terms: Array<{ term: string; category: TagCategory }>) =>
    http<VocabBatchResult>('/vocab/batch', { method: 'POST', body: JSON.stringify({ action, terms }) }),
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
/** Full-library read-only census; fetch only after its Desk disclosure opens. */
export const useGroundingResidual = (enabled: boolean) =>
  useQuery({ queryKey: ['groundingResidual'], queryFn: api.groundingResidual, enabled, staleTime: 60_000 });
export const useLog = () => useQuery({ queryKey: ['log'], queryFn: api.log });
export const useTemplates = () => useQuery({ queryKey: ['templates'], queryFn: api.templates });
export const useCollections = (status?: string) =>
  useQuery({ queryKey: ['collections', status], queryFn: () => api.collections(status) });
export const useCollection = (id: number) =>
  useQuery({ queryKey: ['collection', id], queryFn: () => api.collection(id) });
export const useVocabulary = () => useQuery({ queryKey: ['vocabulary'], queryFn: api.vocabulary });
export const useProposedVocabTerms = () =>
  useQuery({ queryKey: ['proposedVocabTerms'], queryFn: api.proposedVocabTerms });
export const useProposedVocabBooks = (term: string | null, category: TagCategory | null) =>
  useQuery({
    queryKey: ['proposedVocabBooks', term, category],
    queryFn: () => api.proposedVocabBooks(term as string, category as TagCategory),
    enabled: Boolean(term && category),
  });

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
