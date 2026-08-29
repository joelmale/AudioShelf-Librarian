/**
 * Taste profile — several centroids, not one (plan §6 as amended 2026-08-28,
 * and `docs/recommendation-data-model.md` §6).
 *
 * WHY NOT ONE CENTROID. §6 originally specified "a taste centroid — mean
 * embedding of finished-and-liked books". A single mean over a library
 * holding sci-fi, cozy mystery and history lands in empty embedding space:
 * it is close to nothing anybody wrote, so it attracts books that are mildly
 * like everything and strongly like nothing. Clustering the positives into a
 * few modes and scoring against the NEAREST mode preserves the fact that a
 * person has several distinct appetites rather than one averaged one. Netflix
 * does not hold "a user vector" either — the rows on its homepage are these
 * modes made visible.
 *
 * ── The cold-start gate (§10.J) ────────────────────────────────────────────
 * {@link buildTasteProfile} returns `null` below {@link MIN_PROFILE_BOOKS}
 * positives, and a single mode is dropped below {@link MIN_MODE_MEMBERS}.
 * Null is not "score everything 0" — a caller with no profile must leave the
 * taste term out of the blend entirely (see `ranker.ts`, where the taste
 * weight defaults to 0), because scoring an unknown as 0 would systematically
 * sink every book for a user the system has not learned yet. Same argument as
 * the ranker's neutral reception prior.
 *
 * ── Negatives are rarer and more precious than positives ───────────────────
 * A personal library is a positive-only dataset: every book in it was chosen.
 * The only true negatives are an explicit rejection and an early abandon, so
 * they are kept as their own vector set and applied as a penalty against the
 * nearest one, rather than being folded into the centroids as anti-weight.
 * Averaging a negative into a positive centroid would move the centroid
 * somewhere neither liked nor disliked.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * k-means seeding is farthest-point, never random: same inputs must give the
 * same profile, or two runs of the acceptance harness would disagree about
 * ranking for reasons unrelated to the change under test. No clock reads
 * either — `now` is a parameter.
 */
import { cosineSimilarity, type EmbeddingStore } from '../retrieval/embeddings.js';
import type { ListeningProgress, RecFeedback } from '../types.js';

/** Below this many positive signals there is no profile at all (§10.J). */
export const MIN_PROFILE_BOOKS = 5;
/** A cluster this small is noise, not an appetite. */
export const MIN_MODE_MEMBERS = 2;
/** Upper bound on modes — beyond this they stop being distinct appetites. */
export const MAX_MODES = 6;
/** k-means iterations. Converges well before this at personal-library scale. */
const MAX_ITERATIONS = 25;
/** Days after which a signal counts half as much toward a centroid. */
const RECENCY_HALF_LIFE_DAYS = 180;
const MS_PER_DAY = 86_400_000;
/** How hard the nearest negative pulls a candidate's taste score down. */
const NEGATIVE_PENALTY_WEIGHT = 0.5;

export interface TasteMode {
  /** L2-normalized centroid. */
  centroid: Float32Array;
  memberIds: string[];
}

export interface TasteProfile {
  modes: TasteMode[];
  /** Book ids that fed the centroids, with their recency-decayed weights. */
  positiveIds: string[];
  /** Vectors of rejected / early-abandoned books. */
  negatives: Float32Array[];
  negativeIds: string[];
}

interface WeightedVector {
  bookId: string;
  vector: Float32Array;
  weight: number;
}

function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector.slice();
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i]! / norm;
  return out;
}

/** Exponential decay so last month's taste outweighs a signal from two years ago. */
function recencyWeight(createdAt: number, now: number): number {
  const ageDays = Math.max(0, (now - createdAt) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * How many modes to fit for `n` positives. Grows slowly: 5 books is one
 * appetite, not three, and asking k-means for more clusters than the data
 * supports produces singleton modes that {@link MIN_MODE_MEMBERS} then drops.
 */
function modeCountFor(n: number): number {
  // sqrt(n) is the standard rule of thumb for k, and it behaves correctly at
  // both ends here: 6 positives split into 2 candidate modes rather than
  // averaging two clearly separate appetites into one, while 100+ positives
  // stay capped at MAX_MODES. MIN_MODE_MEMBERS then drops whatever came out
  // as a singleton, so over-asking is self-correcting and under-asking is not.
  return Math.max(1, Math.min(MAX_MODES, Math.round(Math.sqrt(n))));
}

/**
 * Farthest-point seeding: start from the vector nearest the global mean, then
 * repeatedly take the vector least similar to anything already chosen.
 * Deterministic by construction — see the module docblock.
 */
function seedCentroids(vectors: readonly WeightedVector[], k: number): Float32Array[] {
  const dim = vectors[0]!.vector.length;
  const mean = new Float32Array(dim);
  for (const v of vectors) for (let i = 0; i < dim; i += 1) mean[i] = mean[i]! + v.vector[i]!;
  const meanUnit = l2Normalize(mean);

  let best = 0;
  let bestSim = -Infinity;
  vectors.forEach((v, index) => {
    const sim = cosineSimilarity(v.vector, meanUnit);
    // Ties break on index so the result cannot depend on iteration order.
    if (sim > bestSim) {
      bestSim = sim;
      best = index;
    }
  });

  const seeds: Float32Array[] = [vectors[best]!.vector];
  while (seeds.length < k) {
    let pick = -1;
    let pickScore = Infinity;
    vectors.forEach((v, index) => {
      let nearest = -Infinity;
      for (const seed of seeds) nearest = Math.max(nearest, cosineSimilarity(v.vector, seed));
      if (nearest < pickScore) {
        pickScore = nearest;
        pick = index;
      }
    });
    if (pick < 0) break;
    seeds.push(vectors[pick]!.vector);
  }
  return seeds;
}

/** Spherical k-means: assign by cosine, recompute as the weighted mean, renormalize. */
function kMeans(vectors: readonly WeightedVector[], k: number): TasteMode[] {
  const dim = vectors[0]!.vector.length;
  let centroids = seedCentroids(vectors, k);
  let assignment = new Array<number>(vectors.length).fill(0);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const next = vectors.map((v) => {
      let bestIndex = 0;
      let bestSim = -Infinity;
      centroids.forEach((c, index) => {
        const sim = cosineSimilarity(v.vector, c);
        if (sim > bestSim) {
          bestSim = sim;
          bestIndex = index;
        }
      });
      return bestIndex;
    });

    const stable = next.every((value, index) => value === assignment[index]);
    assignment = next;
    if (stable && iteration > 0) break;

    const sums = centroids.map(() => new Float32Array(dim));
    const counts = centroids.map(() => 0);
    vectors.forEach((v, index) => {
      const target = sums[assignment[index]!]!;
      for (let i = 0; i < dim; i += 1) target[i] = target[i]! + v.vector[i]! * v.weight;
      counts[assignment[index]!] = counts[assignment[index]!]! + 1;
    });
    // An emptied cluster keeps its previous centroid rather than collapsing to
    // the zero vector, which would then match nothing and never recover.
    centroids = sums.map((sum, index) => (counts[index]! === 0 ? centroids[index]! : l2Normalize(sum)));
  }

  return centroids.map((centroid, index) => ({
    centroid,
    memberIds: vectors.filter((_, i) => assignment[i] === index).map((v) => v.bookId),
  }));
}

export interface BuildTasteProfileInput {
  feedback: readonly RecFeedback[];
  progress: readonly ListeningProgress[];
  store: EmbeddingStore;
  /** Passed in, never read from the clock — see the module docblock. */
  now: number;
}

/**
 * Build the profile, or `null` when there is not enough signal (§10.J).
 *
 * Positives: `accepted` and `finished`. Negatives: `rejected` and
 * `abandoned`. A book with no stored embedding contributes nothing — it
 * cannot be placed in embedding space at all — which is one more reason the
 * embedding backfill in §10.M gates this phase.
 */
export function buildTasteProfile(input: BuildTasteProfileInput): TasteProfile | null {
  const { store, now } = input;
  if (store.size === 0) return null;

  const positives: WeightedVector[] = [];
  const negatives: WeightedVector[] = [];
  const seen = new Set<string>();

  for (const row of input.feedback) {
    if (row.bookId === null || seen.has(row.bookId)) continue;
    const vector = store.vectorFor(row.bookId);
    if (vector === null) continue;
    seen.add(row.bookId);
    const weight = row.weight * recencyWeight(row.createdAt, now);
    if (weight <= 0) continue;
    const entry: WeightedVector = { bookId: row.bookId, vector, weight };
    if (row.verdict === 'accepted' || row.verdict === 'finished') positives.push(entry);
    else negatives.push(entry);
  }

  // A finished book with no feedback row is still a positive — the listening
  // data is the signal, and requiring a matching rec_feedback row would miss
  // everything the user found on their own rather than through a suggestion.
  for (const row of input.progress) {
    if (!row.isFinished || seen.has(row.bookId)) continue;
    const vector = store.vectorFor(row.bookId);
    if (vector === null) continue;
    seen.add(row.bookId);
    const stamp = row.finishedAt ?? row.lastPlayedAt ?? row.updatedAt;
    const weight = recencyWeight(stamp, now);
    if (weight > 0) positives.push({ bookId: row.bookId, vector, weight });
  }

  if (positives.length < MIN_PROFILE_BOOKS) return null;

  const modes = kMeans(positives, modeCountFor(positives.length))
    .filter((mode) => mode.memberIds.length >= MIN_MODE_MEMBERS);
  if (modes.length === 0) return null;

  return {
    modes,
    positiveIds: positives.map((p) => p.bookId),
    negatives: negatives.map((n) => n.vector),
    negativeIds: negatives.map((n) => n.bookId),
  };
}

/**
 * Affinity of one book to the profile, in `[0,1]`, or `null` when the book
 * has no embedding — `null` means "no signal", exactly as the ranker's
 * reception prior does, and must not be read as dislike.
 *
 * Scored against the NEAREST mode rather than an average of them: matching
 * one appetite strongly is what should win, not being mediocre across all of
 * them.
 */
export function tasteScoreFor(profile: TasteProfile, store: EmbeddingStore, bookId: string): number | null {
  const vector = store.vectorFor(bookId);
  if (vector === null) return null;

  let best = -Infinity;
  for (const mode of profile.modes) best = Math.max(best, cosineSimilarity(vector, mode.centroid));

  let worst = -Infinity;
  for (const negative of profile.negatives) worst = Math.max(worst, cosineSimilarity(vector, negative));

  const penalty = worst === -Infinity ? 0 : NEGATIVE_PENALTY_WEIGHT * Math.max(0, worst);
  const score = Math.max(0, best) - penalty;
  return Math.min(1, Math.max(0, score));
}
