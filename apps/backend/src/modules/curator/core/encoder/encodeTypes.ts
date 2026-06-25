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

// ─────────────────────────────────────────────────────────────────────────────
// 1. File-safety policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a finished `.m4b` relates to its source files:
 *  - `output-dir`: write to a separate staging tree; NEVER touch the source.
 *  - `in-place`: replace the source folder's loose audio with the `.m4b`, after
 *    first moving originals to the backup dir (reversible, but mutates library).
 */
export const ENCODE_MODES = ['output-dir', 'in-place'] as const;
export type EncodeMode = (typeof ENCODE_MODES)[number];

export const encodeModeSchema = z.enum(ENCODE_MODES);

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

/** A single folder eligible to be encoded into one `.m4b`. */
export interface EncodeCandidate {
  /** Absolute path to the folder containing the loose audio. */
  sourceDir: string;
  /** Path relative to the configured library root (used to mirror output tree). */
  relativeDir: string;
  /** Display name (folder basename) — usually "Author/Title" tail. */
  name: string;
  /** Ordered absolute paths of the source audio files (track order). */
  files: string[];
  /** Sum of source file sizes in bytes. */
  totalBytes: number;
  probe: AudioProbe | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Encode options (validated request from API/MCP)
// ─────────────────────────────────────────────────────────────────────────────

export const encodeOptionsSchema = z.object({
  /** Folders to encode, as relativeDir values from a prior scan. */
  candidates: z.array(z.string().min(1)).optional(),
  mode: encodeModeSchema.default('output-dir'),
  /** Target audio codec passed to m4b-tool (default AAC via fdk if available). */
  audioCodec: z.string().default('aac'),
  /** Target bitrate string, e.g. "64k", "128k". Empty = let m4b-tool decide. */
  bitRate: z.string().default(''),
  /** Report the plan without spawning any encode. */
  dryRun: z.boolean().default(false),
  /** Encode only the first N candidates (preview). 0 = all. */
  sample: z.number().int().min(0).default(0),
  /** Trigger an ABS library rescan when the job finishes successfully. */
  rescanAfter: z.boolean().default(false),
});
export type EncodeOptions = z.infer<typeof encodeOptionsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 4. Results
// ─────────────────────────────────────────────────────────────────────────────

export type EncodeItemStatus = 'encoded' | 'skipped' | 'failed';

export interface EncodeItemResult {
  relativeDir: string;
  status: EncodeItemStatus;
  /** Absolute path of the produced .m4b (when encoded). */
  outputPath?: string;
  /** Output file size in bytes (when encoded). */
  outputBytes?: number;
  /** Failure reason (when failed). */
  error?: { code: string; message: string };
}

export interface EncodeResult {
  encoded: number;
  skipped: number;
  failed: number;
  mode: EncodeMode;
  items: EncodeItemResult[];
  dryRun: boolean;
  /** True when the run was cancelled before completing all candidates. */
  cancelled?: boolean;
  /** True when a rescan is needed but was not (or could not be) triggered. */
  rescanRequired?: boolean;
  /** True when an ABS rescan was successfully triggered. */
  rescanTriggered?: boolean;
  /** Present on a dry run: the candidates that would have been encoded. */
  plan?: EncodeCandidate[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Persisted job record (encode_jobs table)
// ─────────────────────────────────────────────────────────────────────────────

export type EncodeJobStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface EncodeJob {
  id: number;
  /** OperationController id, links the persisted row to the in-memory op. */
  operationId: string;
  mode: EncodeMode;
  status: EncodeJobStatus;
  audioCodec: string;
  bitRate: string | null;
  candidateCount: number;
  doneCount: number;
  startedAt: number;
  finishedAt: number | null;
  detail: unknown | null;
}

/** Row used to create an encode_jobs entry (id/timestamps assigned by db). */
export interface NewEncodeJob {
  operationId: string;
  mode: EncodeMode;
  audioCodec: string;
  bitRate: string | null;
  candidateCount: number;
  startedAt: number;
}
