/**
 * Deterministic, offline, network-free EmbeddingCreator used across
 * downstream retrieval tests. It lives here (not under a test-local
 * `__fixtures__`) because it is production source: later phases import it
 * directly to embed the fixture library without touching Ollama.
 *
 * A random or whole-string-hash stub would be useless for this purpose,
 * because downstream tests need to assert vibe-ordering — e.g. that the
 * query "melancholic coastal autumn" ranks a melancholic coastal autumn book
 * above one that shares none of those words. So this is a deterministic
 * hashing-trick bag-of-words embedder: cosine similarity genuinely tracks
 * lexical token overlap between two texts.
 *
 * Weighting is presence-based (binary), NOT term-frequency: a token counts
 * once per document no matter how many times it repeats. Raw term-frequency
 * weighting was tried first and measured to fail the fixture library's own
 * "melancholic coastal autumn" regression target — a book that merely
 * repeats one facet word several times ("autumn" x4) outscored the book that
 * matches every facet once each (melancholic + coastal-town + autumn),
 * because repetition dominated coverage. That is the exact opposite of the
 * ranking behaviour this fixture exists to test, so rewarding facet coverage
 * over word repetition is the deliberate choice here.
 *
 * The bucket space is also sized to keep hash collisions rare: at dim 256
 * the ~1300-token fixture-card vocabulary collided badly enough (e.g.
 * "coastal" sharing a bucket with the "genre:" label emitted on every card)
 * that unrelated books scored spurious hits. 1024 buckets keeps collisions
 * rare for a fixture-library-sized vocabulary.
 */
import type { EmbeddingCreator, EmbeddingRequest } from '../embeddings.js';

/** Vector dimension of the stub space. */
export const STUB_EMBEDDING_DIM = 1024;

const TOKEN_PATTERN = /[^a-z0-9]+/;

// FNV-1a 32-bit constants.
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit hash of a string, as an unsigned 32-bit integer. */
function fnv1a32(str: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // Multiply by the FNV prime using Math.imul to stay within int32 and
    // match the 32-bit unsigned overflow behaviour of the reference algorithm.
    hash = Math.imul(hash, FNV_PRIME);
  }
  // Coerce to unsigned 32-bit.
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(TOKEN_PATTERN)
    .filter((token) => token.length > 1);
}

/**
 * The same transform as a pure function, for tests that need to embed a bare
 * query string without going through the creator.
 */
export function stubEmbed(text: string, dim: number = STUB_EMBEDDING_DIM): Float32Array {
  const vec = new Float32Array(dim);
  // Dedupe tokens first so a repeated word contributes to its bucket once —
  // presence, not frequency (see the module docblock for why).
  const uniqueTokens = new Set(tokenize(text));
  for (const token of uniqueTokens) {
    const bucket = fnv1a32(token) % dim;
    vec[bucket] = Math.fround(vec[bucket]! + 1);
  }

  let normSq = 0;
  for (let i = 0; i < dim; i++) normSq += vec[i]! * vec[i]!;
  if (normSq === 0) return vec;

  const norm = Math.sqrt(normSq);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = Math.fround(vec[i]! / norm);
  return out;
}

/**
 * Deterministic, offline, network-free EmbeddingCreator whose cosine
 * similarity tracks lexical overlap between texts, so vibe-ordering
 * regressions over the fixture library are meaningful rather than random.
 */
export function createStubEmbeddingCreator(dim: number = STUB_EMBEDDING_DIM): EmbeddingCreator {
  return {
    async create(req: EmbeddingRequest): Promise<Float32Array[]> {
      return req.input.map((text) => stubEmbed(text, dim));
    },
  };
}
