/**
 * Shared contract for the audio-encoding capability (mp3/m4a → m4b).
 *
 * Mirrors the conventions of the AI pipeline's `core/types.ts`: domain
 * interfaces match the SQLite mirror, Zod schemas validate untrusted input
 * (API/MCP), and result/progress types are reused by both `api/` and `mcp/`.
 *
 * This capability is intentionally independent of the tagging/collection
 * pipeline — it operates on the ABS library *directory*, not the ABS API — so
 * its types live here rather than polluting the frozen `core/types.ts`.
 */
import { z } from 'zod';

// Removed file-safety policy (EncodeMode) since ABS handles file operations natively.

/** Source audio formats the scanner treats as encodable. */
export const ENCODABLE_EXTENSIONS = ['.mp3', '.m4a', '.m4b'] as const;
export const LOOSE_AUDIO_EXTENSIONS = ['.mp3', '.m4a'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// 2. Probe + candidate (filesystem scan)
// ─────────────────────────────────────────────────────────────────────────────

/** ffprobe-derived summary of a candidate's audio (best-effort; may be partial). */
export interface AudioProbe {
  codec: string | null;
  /** Nominal bitrate in bits/sec, when reported. */
  bitRate: number | null;
  sampleRate: number | null;
  channels: number | null;
  /** Total duration across all source files, in seconds. */
  durationSeconds: number | null;
  /** Embedded chapter count, when present. */
  chapterCount: number;
}

export interface EncodeCandidate {
  /** The unique item ID inside your ABS server */
  libraryItemId: string;
  /** The parent ABS library container index */
  libraryId: string;
  /** Book Title */
  name: string;
  /** Book Author */
  author: string;
  /** List of loose MP3 track names reported by the API */
  files: string[];
  /** Sum of source file sizes in bytes */
  totalBytes: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Encode options (validated request from API/MCP)
// ─────────────────────────────────────────────────────────────────────────────

export const encodeOptionsSchema = z.object({
  /** IDs to encode, mapped to ABS library item IDs. */
  candidates: z.array(z.string().min(1)).optional(),
  /** The library ID to scan if candidates are empty. */
  libraryId: z.string().optional(),
  /** Report the plan without spawning any encode. */
  dryRun: z.boolean().default(false),
  /** Encode only the first N candidates (preview). 0 = all. */
  sample: z.number().int().min(0).default(0),
});
export type EncodeOptions = z.infer<typeof encodeOptionsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 4. Results
// ─────────────────────────────────────────────────────────────────────────────

export type EncodeItemStatus = 'encoded' | 'skipped' | 'failed';

export interface EncodeItemResult {
  libraryItemId: string;
  status: EncodeItemStatus;
  /** Failure reason (when failed). */
  error?: { code: string; message: string };
}

export interface EncodeResult {
  encoded: number;
  skipped: number;
  failed: number;
  items: EncodeItemResult[];
  dryRun: boolean;
  /** True when the run was cancelled before completing all candidates. */
  cancelled?: boolean;
  /** Present on a dry run: the candidates that would have been encoded. */
  plan?: EncodeCandidate[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Persisted job record (encode_jobs table)
// ─────────────────────────────────────────────────────────────────────────────

export type EncodeJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface EncodeQueueItem {
  id: string; // libraryItemId
  libraryId: string;
  name: string;
  author: string;
  totalBytes: number;
  status: EncodeJobStatus;
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

/** Row used to create an encode_jobs entry (id/timestamps assigned by db). */
export interface NewEncodeQueueItem {
  id: string;
  libraryId: string;
  name: string;
  author: string;
  totalBytes: number;
  sortOrder: number;
  addedAt: number;
}

export interface NewEncodeHistoryItem {
  libraryItemId: string;
  name: string;
  author: string;
  totalBytes: number;
  status: string;
  startedAt: number;
  detail?: unknown | null;
}
