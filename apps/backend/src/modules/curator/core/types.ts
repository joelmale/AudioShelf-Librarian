/**
 * Shared contract for the entire project.
 *
 * Per the plan this file is the single source of truth consumed by `core/`,
 * `api/`, and `mcp/`. It FREEZES at the end of Phase 3 — after that, any change
 * here is a breaking change requiring explicit review.
 *
 * Contents:
 *   1. Domain interfaces mirroring the SQLite schema.
 *   2. Zod schemas for runtime validation of ABS API responses.
 *   3. Zod schemas + interfaces for Claude tagging / collection IO.
 *   4. Operation result + progress types shared across api/mcp.
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Tag taxonomy
// ─────────────────────────────────────────────────────────────────────────────

export const TAG_CATEGORIES = [
  'genre',
  'mood',
  'theme',
  'era',
  'pacing',
  'length',
  'audience',
] as const;

export type TagCategory = (typeof TAG_CATEGORIES)[number];

/** Categories every well-tagged book must populate (Task 2.6). */
export const REQUIRED_TAG_CATEGORIES: readonly TagCategory[] = [
  'genre',
  'mood',
  'pacing',
  'length',
] as const;

export const tagCategorySchema = z.enum(TAG_CATEGORIES);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Domain interfaces (SQLite mirror)
// ─────────────────────────────────────────────────────────────────────────────

export interface Book {
  id: string; // ABS book ID
  title: string;
  author: string | null;
  series: string | null;
  seriesSequence: number | null;
  durationSeconds: number | null;
  publishedYear: number | null;
  genres: string[]; // decoded from the JSON column
  description: string | null;
  coverPath: string | null;
  absAddedAt: number | null;
  lastSyncedAt: number;
  libraryId?: string | null;
  itemPath?: string | null;
  asin?: string | null;
  isbn?: string | null;
  absUpdatedAt?: number | null;
  lastSeenSyncId?: string | null;
  syncStatus?: 'active' | 'deleted';
  deletedAt?: number | null;
}

export interface BookTag {
  id: number;
  bookId: string;
  tag: string;
  category: TagCategory;
  confidence: number; // 0.0–1.0
  taggedAt: number;
}

export type CollectionStatus = 'proposed' | 'approved' | 'pushed' | 'rejected';

export interface Collection {
  id: number;
  name: string;
  description: string | null;
  theme: string; // template id or custom prompt used to generate
  status: CollectionStatus;
  absCollectionId: string | null;
  createdAt: number;
  pushedAt: number | null;
  libraryId?: string | null;
  ownershipMarker?: string | null;
}

export interface CollectionBook {
  collectionId: number;
  bookId: string;
  sortOrder: number | null;
}

export type SyncOperation = 'sync' | 'tag' | 'generate' | 'push' | 'encode';
export type SyncStatus = 'running' | 'success' | 'error';

export interface SyncLogEntry {
  id: number;
  operation: SyncOperation;
  status: SyncStatus;
  detail: unknown | null; // decoded from the JSON column
  startedAt: number;
  finishedAt: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ABS API response schemas (runtime validation)
//
// ABS response shapes vary across versions and between "minified"/"expanded"
// payloads, so item internals are validated leniently (.passthrough(), optional
// fields) while the *envelopes* (results array, pagination counters) are strict
// — those are what the pagination + sync logic depends on.
// ─────────────────────────────────────────────────────────────────────────────

export const absLibrarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    mediaType: z.string().optional(),
  })
  .passthrough();
export type ABSLibrary = z.infer<typeof absLibrarySchema>;

export const absLibrariesResponseSchema = z.object({
  libraries: z.array(absLibrarySchema),
});

export const absSeriesEntrySchema = z
  .object({
    name: z.string(),
    sequence: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();

export const absBookMetadataSchema = z
  .object({
    title: z.string().nullable().optional(),
    subtitle: z.string().nullable().optional(),
    authorName: z.string().nullable().optional(),
    narratorName: z.string().nullable().optional(),
    seriesName: z.string().nullable().optional(),
    series: z.array(absSeriesEntrySchema).optional(),
    genres: z.array(z.string()).nullable().optional(),
    publishedYear: z.union([z.string(), z.number()]).nullable().optional(),
    description: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    asin: z.string().nullable().optional(),
    isbn: z.string().nullable().optional(),
  })
  .passthrough();

export const absMediaSchema = z
  .object({
    metadata: absBookMetadataSchema,
    coverPath: z.string().nullable().optional(),
    duration: z.number().nullable().optional(),
  })
  .passthrough();

export const absLibraryItemSchema = z
  .object({
    id: z.string(),
    mediaType: z.string().optional(),
    media: absMediaSchema,
    addedAt: z.number().nullable().optional(),
    updatedAt: z.number().nullable().optional(),
    path: z.string().nullable().optional(),
  })
  .passthrough();
export type ABSLibraryItem = z.infer<typeof absLibraryItemSchema>;

export const absLibraryItemsResponseSchema = z
  .object({
    results: z.array(absLibraryItemSchema),
    total: z.number(),
    limit: z.number(),
    page: z.number(),
  })
  .passthrough();

export const absCollectionSchema = z
  .object({
    id: z.string(),
    libraryId: z.string().optional(),
    name: z.string(),
    description: z.string().nullable().optional(),
  })
  .passthrough();
export type ABSCollection = z.infer<typeof absCollectionSchema>;

export const absCollectionsResponseSchema = z.object({
  collections: z.array(absCollectionSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Claude IO schemas
// ─────────────────────────────────────────────────────────────────────────────

export const generatedTagSchema = z.object({
  tag: z.string().min(1).max(60),
  category: tagCategorySchema,
  confidence: z.number().min(0).max(1),
});
export type GeneratedTag = z.infer<typeof generatedTagSchema>;

/** Required JSON shape Claude must return for tagging a single book. */
export const tagResponseSchema = z.object({
  tags: z.array(generatedTagSchema),
});
export type TagResponse = z.infer<typeof tagResponseSchema>;

/** Required JSON shape Claude must return for a custom collection. */
export const collectionProposalSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().default(''),
  bookIds: z.array(z.string()),
  reasoning: z.string().optional(),
});
export type CollectionProposal = z.infer<typeof collectionProposalSchema>;

export const recommendationCandidateSchema = z.object({
  title: z.string().min(1).max(200),
  author: z.string().min(1).max(160),
  reason: z.string().min(1).max(500),
});

export const recommendationResponseSchema = z.object({
  interpretation: z.string().min(1).max(500),
  constraints: z.object({
    maxDurationHours: z.number().positive().max(100).nullable(),
    genres: z.array(z.string().min(1).max(60)).max(8),
    moods: z.array(z.string().min(1).max(60)).max(8),
  }),
  shelf: z.array(z.object({
    bookId: z.string().min(1),
    reason: z.string().min(1).max(500),
  })).max(12),
  external: z.array(recommendationCandidateSchema).max(12),
});
export type RecommendationResponse = z.infer<typeof recommendationResponseSchema>;

export const multiCollectionProposalSchema = z.object({
  collections: z.array(collectionProposalSchema),
});
export type MultiCollectionProposal = z.infer<typeof multiCollectionProposalSchema>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export interface BookTagResult {
  bookId: string;
  tags: GeneratedTag[];
  usage: TokenUsage;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Operation result + progress types
// ─────────────────────────────────────────────────────────────────────────────

export interface OperationError {
  /** Identifier of the unit that failed (bookId, libraryId, …) when applicable. */
  id?: string;
  code: string;
  message: string;
}

export interface SyncResult {
  added: number;
  updated: number;
  unchanged: number;
  total: number;
  errors: OperationError[];
  tombstoned?: number;
  restored?: number;
  libraries?: Array<{ libraryId: string; status: 'success' | 'error'; total: number; tombstoned: number }>;
}

export interface TaggingResult {
  processed: number;
  skipped: number;
  failed: number;
  errors: OperationError[];
  tokensUsed: TokenUsage;
  dryRun: boolean;
  /** Present on a dry run: the books that would have been tagged. */
  plan?: TaggingPlanEntry[];
  /** True when the run was cancelled before completing all candidates. */
  cancelled?: boolean;
}

/** Per-book entry returned by a dry run (no API calls made). */
export interface TaggingPlanEntry {
  bookId: string;
  title: string;
}

/** Compact, token-efficient book representation fed to Claude for collections. */
export interface TagSummaryBook {
  id: string;
  title: string;
  author: string | null;
  durationHr: number | null;
  tags: Partial<Record<TagCategory, string[]>>;
}

export type TagSummary = TagSummaryBook[];

export type ConflictPolicy = 'skip' | 'overwrite' | 'rename';

export interface PushResult {
  collectionId: number;
  absCollectionId: string;
  action: 'created' | 'updated' | 'skipped' | 'renamed';
  finalName: string;
}

/** Progress callback shared by core ops; api wraps as SSE, mcp as notifications. */
export interface ProgressUpdate {
  phase: string;
  current: number;
  total: number;
  message?: string;
}

export type ProgressCallback = (update: ProgressUpdate) => void;
