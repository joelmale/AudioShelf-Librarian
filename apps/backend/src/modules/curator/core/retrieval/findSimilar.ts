/**
 * Embedding-neighbour lookup (librarian engine plan §4.3, §5.2 archetype 2).
 *
 * `findSimilar` answers "more like this" from the embedding store. Its reason
 * for existing beyond a bare cosine top-K is the `acrossGenre` mode, which is
 * what powers the cross-domain archetype:
 *
 *   "I love the world-building and political intrigue of The Expanse, but I'm
 *    looking for a low-stakes fantasy novel with similar smart dialogue."
 *
 * The naive implementation of that query — subtract the anchor's genre from
 * its vector — does not work; embedding arithmetic does not cleanly encode
 * "but not sci-fi". So the split is the same one the whole retrieval layer
 * uses (plan §4.3): **embeddings supply attraction, SQL supplies rejection.**
 * `acrossGenre` drops every candidate sharing a `genre` tag with the anchor
 * as a hard set operation, and cosine then ranks what survives on the
 * structural qualities that transferred — multi-POV, political, witty
 * dialogue — because those are in the card text too.
 *
 * `sharedTags` on each result exists so the caller can explain itself. It
 * deliberately omits `genre` tags: under `acrossGenre` there are none by
 * construction, and without it the genre match is the least interesting thing
 * the two books have in common.
 */
import { AppError, NotFoundError } from '../errors.js';
import type { CuratorDb } from '../db.js';
import type { Book, BookTag } from '../types.js';
import { EmbeddingStore } from './embeddings.js';

export interface FindSimilarOptions {
  /** How many neighbours to return. Default 10. */
  k?: number;
  /**
   * Exclude every book sharing a `genre` tag with the anchor, so similarity
   * is judged on structure and mood rather than shelf. Default false.
   */
  acrossGenre?: boolean;
  /**
   * Restrict candidates to these book ids (e.g. the result of a `queryBooks`
   * call that already applied the user's hard filters and exclusions).
   * Absent means "every embedded book".
   */
  candidateIds?: ReadonlySet<string>;
  /** Prebuilt store; built from the db when absent. */
  store?: EmbeddingStore;
  /** Embedding model to load when building the store. */
  model?: string;
}

export interface SimilarBook {
  book: Book;
  /** Cosine similarity to the anchor, in [-1, 1]. */
  score: number;
  /** Non-genre tags this book shares with the anchor — the "why". */
  sharedTags: string[];
}

const DEFAULT_K = 10;

function tagKey(t: Pick<BookTag, 'tag' | 'category'>): string {
  return `${t.category}:${t.tag}`;
}

/**
 * Neighbours of `bookId` by embedding similarity.
 *
 * Throws `NotFoundError` when the book does not exist, and an `AppError` when
 * the anchor has no embedding — an empty result would be indistinguishable
 * from "nothing is similar", and the caller's fix (run the embedding
 * operation) is entirely different.
 */
export function findSimilar(
  db: CuratorDb,
  bookId: string,
  options: FindSimilarOptions = {}
): SimilarBook[] {
  const anchor = db.getBook(bookId);
  if (!anchor) throw new NotFoundError(`No book with id ${bookId}`);

  const store = options.store ?? EmbeddingStore.fromDb(db, options.model);
  const anchorEmbedding = db.getBookEmbedding(bookId);
  if (!anchorEmbedding) {
    throw new AppError(
      'INTERNAL',
      `Book ${bookId} has no embedding — run the embedding operation before asking for neighbours`,
      { detail: { bookId } }
    );
  }

  const anchorTags = db.getTagsForBook(bookId);
  const anchorGenres = new Set(
    anchorTags.filter((t) => t.category === 'genre').map((t) => t.tag)
  );
  const anchorNonGenre = new Set(
    anchorTags.filter((t) => t.category !== 'genre').map(tagKey)
  );

  // Rejection is a set operation, never vector arithmetic (see docblock).
  const exclude = new Set<string>([bookId]);
  if (options.acrossGenre && anchorGenres.size > 0) {
    for (const candidate of db.getAllBooks()) {
      if (candidate.id === bookId) continue;
      const shares = db
        .getTagsForBook(candidate.id)
        .some((t) => t.category === 'genre' && anchorGenres.has(t.tag));
      if (shares) exclude.add(candidate.id);
    }
  }

  const neighbours = store.topK(anchorEmbedding.vector, options.k ?? DEFAULT_K, {
    include: options.candidateIds,
    exclude,
  });

  const results: SimilarBook[] = [];
  for (const n of neighbours) {
    const book = db.getBook(n.bookId);
    if (!book) continue; // embedded row for a deleted book — skip, don't throw
    const sharedTags = db
      .getTagsForBook(n.bookId)
      .filter((t) => t.category !== 'genre' && anchorNonGenre.has(tagKey(t)))
      .map((t) => t.tag)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    results.push({ book, score: n.score, sharedTags });
  }
  return results;
}
