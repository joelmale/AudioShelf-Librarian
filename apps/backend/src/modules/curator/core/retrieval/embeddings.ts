/**
 * Embedding retrieval layer: an injectable Ollama-backed embedder, a cosine
 * helper, and a brute-force in-memory nearest-neighbour store.
 *
 * A personal library is hundreds to low-thousands of books, not millions —
 * a flat `Float32Array` matrix plus a linear dot-product scan is the correct
 * engineering choice here (sub-millisecond for realistic library sizes) and
 * avoids the operational cost of standing up a vector DB or ANN index for a
 * problem size that does not need one. If the library ever grows into the
 * regime where that tradeoff flips, `EmbeddingStore` is the seam to replace.
 */
import { z } from 'zod';

import type { CuratorDb } from '../db.js';
import { AppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { BookEmbedding } from '../types.js';

// ── Injectable embedder ─────────────────────────────────────────────────────

export interface EmbeddingRequest {
  model: string;
  /** One or more texts to embed in a single call. */
  input: readonly string[];
}

/**
 * The single low-level operation; injectable so tests never touch the
 * network. Mirrors `MessageCreator` in `core/llmClient.ts`.
 */
export interface EmbeddingCreator {
  /** Returns one vector per input, in input order. */
  create(req: EmbeddingRequest): Promise<Float32Array[]>;
}

export interface OllamaEmbeddingOptions {
  ollamaUrl: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Request timeout in ms. Default 30_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// `.finite()` rejects NaN AND Infinity at the zod boundary. This alone is not
// sufficient — a value like 1e40 is finite in float64 and only overflows to
// Infinity when narrowed to float32 below — but it stops the common case
// (a provider that returns Infinity/NaN directly) before it ever reaches the
// store. `.min(1)` rejects an empty embedding row (dimension-0 garbage).
const ollamaEmbedResponseSchema = z.object({
  model: z.string().optional(),
  embeddings: z.array(z.array(z.number().finite()).min(1)),
});

/**
 * Default production EmbeddingCreator backed by a local Ollama server's
 * `/api/embed` endpoint. No retry logic here — retries belong to the
 * operation layer that calls this, not to the low-level HTTP adapter.
 */
export function createOllamaEmbeddingCreator(options: OllamaEmbeddingOptions): EmbeddingCreator {
  const baseUrl = options.ollamaUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? nullLogger;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async create(req: EmbeddingRequest): Promise<Float32Array[]> {
      if (req.input.length === 0) return [];

      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: req.model, input: req.input }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        logger.error('Ollama embedding request failed', {
          model: req.model,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new AppError('LLM_REQUEST', `Ollama embedding request failed: ${req.model}`, {
          cause: err,
        });
      }

      if (!res.ok) {
        // Deliberately do NOT read/buffer the body here: it can be arbitrarily
        // large (a misconfigured proxy or an HTML error page in front of
        // Ollama), and AppError.detail is serialized across every boundary
        // (API responses, GET /api/system/logs, the WebSocket log broadcast —
        // see AGENTS.md) so upstream response text must never ride along in
        // it. The status code is the actionable part; log it, don't echo it.
        logger.error('Ollama embedding request returned non-2xx', {
          model: req.model,
          status: res.status,
        });
        throw new AppError('LLM_REQUEST', `Ollama embedding request failed with status ${res.status}`, {
          detail: { status: res.status },
        });
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        throw classifyBodyReadError(err);
      }

      const parsed = ollamaEmbedResponseSchema.safeParse(json);
      if (!parsed.success) {
        logger.error('Ollama embedding response failed schema validation', {
          model: req.model,
          issues: parsed.error.issues,
        });
        throw new AppError('LLM_INVALID_RESPONSE', 'Ollama embedding response did not match the expected shape', {
          detail: { issues: parsed.error.issues },
        });
      }

      const { embeddings } = parsed.data;
      if (embeddings.length !== req.input.length) {
        throw new AppError(
          'LLM_INVALID_RESPONSE',
          `Ollama returned ${embeddings.length} embeddings for ${req.input.length} inputs`,
          { detail: { requested: req.input.length, received: embeddings.length } }
        );
      }
      const rowLength = embeddings[0]!.length;
      const raggedIndex = embeddings.findIndex((row) => row.length !== rowLength);
      if (raggedIndex !== -1) {
        throw new AppError(
          'LLM_INVALID_RESPONSE',
          `Ollama returned embeddings with inconsistent dimension (row 0 has ${rowLength}, row ${raggedIndex} has ${embeddings[raggedIndex]!.length})`,
          { detail: { expectedDim: rowLength, offendingRow: raggedIndex } }
        );
      }

      return embeddings.map((row) => Float32Array.from(row));
    },
  };
}

/**
 * `res.json()` fails two very different ways and they must not share a
 * classification: the server can send genuinely malformed JSON (permanent,
 * LLM_INVALID_RESPONSE — retrying won't help), or the connection/stream can
 * die mid-body (a transient transport failure — undici surfaces this as a
 * TypeError, and our own AbortSignal.timeout firing mid-read surfaces as an
 * AbortError/TimeoutError). The operation layer keys its retry decision off
 * the error code, so a timeout misclassified as "malformed" would silently
 * stop being retried.
 */
function classifyBodyReadError(err: unknown): AppError {
  const name = err instanceof Error ? err.name : undefined;
  const isTransportFailure =
    name === 'AbortError' || name === 'TimeoutError' || err instanceof TypeError;
  if (isTransportFailure) {
    return new AppError('LLM_REQUEST', 'Ollama embedding response stream failed', { cause: err });
  }
  return new AppError('LLM_INVALID_RESPONSE', 'Ollama embedding response was not valid JSON', {
    cause: err,
  });
}

// ── Cosine similarity ───────────────────────────────────────────────────────

/** Clamp to [-1, 1] — floating-point rounding in the dot product/norm can
 *  push a mathematically-bounded cosine value fractionally outside the
 *  range (self-similarity measured as high as 1.0000000320237743 on random
 *  64-dim float32 vectors), and downstream ranking code relies on the bound
 *  actually holding. */
function clampUnit(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

/**
 * Cosine similarity of two equal-length vectors, clamped to [-1, 1]. Returns
 * 0 when either is a zero vector. Throws AppError('VALIDATION') on a length
 * mismatch.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new AppError('VALIDATION', `Cannot compare vectors of different length: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return clampUnit(dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

/**
 * L2-normalize `vec`. A zero vector (or one whose squared norm is not
 * finite — e.g. a component that overflowed to Infinity during a float64 ->
 * float32 narrowing, which `.finite()` at the zod boundary cannot catch
 * because the source value was still finite in float64) normalizes to all
 * zeros rather than propagating Infinity/NaN into every downstream score.
 */
function l2Normalize(vec: Float32Array): Float32Array {
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) normSq += vec[i]! * vec[i]!;
  if (normSq === 0 || !Number.isFinite(normSq)) return new Float32Array(vec.length);
  const norm = Math.sqrt(normSq);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / norm;
  return out;
}

// ── In-memory brute-force store ─────────────────────────────────────────────

export interface EmbeddingNeighbour {
  bookId: string;
  /** Cosine similarity in [-1, 1]. */
  score: number;
}

export interface TopKOptions {
  /** When present, only these book ids are considered. */
  include?: ReadonlySet<string>;
  /** These book ids are never returned (e.g. the anchor book itself). */
  exclude?: ReadonlySet<string>;
}

/**
 * Brute-force cosine-similarity store over every embedding for one model.
 * Vectors are L2-normalized once at construction so similarity search is a
 * plain dot product against a single contiguous matrix — see the module
 * docblock for why a flat scan (rather than a vector DB / ANN index) is the
 * right call at personal-library scale.
 */
export class EmbeddingStore {
  private readonly matrix: Float32Array;
  private readonly ids: string[];
  private readonly idToRow: Map<string, number>;
  readonly size: number;
  /** Vector dimension, or 0 when the store is empty. */
  readonly dim: number;

  /**
   * Build from every stored embedding, optionally restricted to one model.
   * Restricting by model is what keeps the matrix dimensionally homogeneous
   * after a model change.
   */
  static fromDb(db: CuratorDb, model?: string): EmbeddingStore {
    return new EmbeddingStore(db.getAllBookEmbeddings(model));
  }

  constructor(entries: readonly BookEmbedding[]) {
    // Deduplicate by bookId first (last one wins) so we never allocate two
    // matrix rows for the same book.
    const byId = new Map<string, BookEmbedding>();
    for (const entry of entries) byId.set(entry.bookId, entry);
    const deduped = [...byId.values()];

    const dim = deduped.length > 0 ? deduped[0]!.vector.length : 0;
    for (const entry of deduped) {
      if (entry.vector.length !== dim) {
        throw new AppError(
          'VALIDATION',
          `Embedding dimension mismatch for book ${entry.bookId}: expected ${dim}, got ${entry.vector.length}`,
          { detail: { bookId: entry.bookId, expectedDim: dim, actualDim: entry.vector.length } }
        );
      }
    }

    this.dim = dim;
    this.size = deduped.length;
    this.ids = new Array(deduped.length);
    this.idToRow = new Map();
    this.matrix = new Float32Array(deduped.length * dim);

    deduped.forEach((entry, row) => {
      this.ids[row] = entry.bookId;
      this.idToRow.set(entry.bookId, row);
      const normalized = l2Normalize(entry.vector);
      this.matrix.set(normalized, row * dim);
    });
  }

  has(bookId: string): boolean {
    return this.idToRow.has(bookId);
  }

  /** The stored (L2-normalized) vector for a book, or null. */
  vectorFor(bookId: string): Float32Array | null {
    const row = this.idToRow.get(bookId);
    if (row === undefined) return null;
    return this.matrix.slice(row * this.dim, (row + 1) * this.dim);
  }

  /** Book ids in matrix order. */
  bookIds(): string[] {
    return [...this.ids];
  }

  /** Brute-force cosine top-K, sorted by score DESC then bookId ASC. */
  topK(query: Float32Array, k: number, options?: TopKOptions): EmbeddingNeighbour[] {
    // Query-dimension validation happens before the `k <= 0` short-circuit
    // (but after the empty-store short-circuit, matching `scoreAll`) so the
    // two methods agree on the same bad input instead of one throwing and
    // the other silently returning [].
    const normalizedQuery = this.validateAndNormalizeQuery(query);
    if (normalizedQuery === null || k <= 0) return [];

    const scores = this.scoreNormalized(normalizedQuery, options);
    const neighbours: EmbeddingNeighbour[] = [...scores.entries()].map(([bookId, score]) => ({
      bookId,
      score,
    }));
    neighbours.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.bookId < b.bookId) return -1;
      if (a.bookId > b.bookId) return 1;
      return 0;
    });
    return neighbours.slice(0, k);
  }

  /** Cosine score for every (filtered) book. Same filtering as topK. */
  scoreAll(query: Float32Array, options?: TopKOptions): Map<string, number> {
    const normalizedQuery = this.validateAndNormalizeQuery(query);
    if (normalizedQuery === null) return new Map();
    return this.scoreNormalized(normalizedQuery, options);
  }

  /**
   * Empty store: returns null so callers short-circuit to an empty result
   * without throwing, regardless of the query's dimension (there is nothing
   * to compare it against). Non-empty store: validates the query's dimension
   * against `this.dim` and returns the L2-normalized query (copied — never
   * mutates the caller's array).
   */
  private validateAndNormalizeQuery(query: Float32Array): Float32Array | null {
    if (this.size === 0) return null;
    if (query.length !== this.dim) {
      throw new AppError('VALIDATION', `Query vector dimension ${query.length} does not match store dimension ${this.dim}`);
    }
    return l2Normalize(query);
  }

  /** Assumes `normalizedQuery` is already validated/normalized. */
  private scoreNormalized(normalizedQuery: Float32Array, options?: TopKOptions): Map<string, number> {
    const result = new Map<string, number>();
    const include = options?.include;
    const exclude = options?.exclude;

    for (let row = 0; row < this.size; row++) {
      const bookId = this.ids[row]!;
      if (include && !include.has(bookId)) continue;
      if (exclude?.has(bookId)) continue;
      let dot = 0;
      const offset = row * this.dim;
      for (let i = 0; i < this.dim; i++) {
        dot += this.matrix[offset + i]! * normalizedQuery[i]!;
      }
      result.set(bookId, clampUnit(dot));
    }
    return result;
  }
}
