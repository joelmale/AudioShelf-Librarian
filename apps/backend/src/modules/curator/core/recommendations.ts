import { buildTagSummary } from './collectionEngine.js';
import type { CuratorDb } from './db.js';
import { normalizeForMatching } from './externalKey.js';
import type { LlmClient } from './llmClient.js';
import type { Book, RecommendationResponse } from './types.js';

export type RecommendationScope = 'both' | 'shelf' | 'discover';

export interface ShelfRecommendation extends Book {
  reason: string;
  tags: ReturnType<CuratorDb['getTagsForBook']>;
}

export interface ExternalRecommendation {
  title: string;
  author: string;
  reason: string;
  description: string | null;
  durationSeconds: number | null;
  genre: string | null;
  coverUrl: string | null;
  storeUrl: string | null;
}

export interface RecommendationResult {
  interpretation: string;
  constraints: RecommendationResponse['constraints'];
  scope: RecommendationScope;
  onShelf: ShelfRecommendation[];
  available: ExternalRecommendation[];
}

interface ItunesAudiobook {
  collectionName?: string;
  artistName?: string;
  description?: string;
  trackTimeMillis?: number;
  primaryGenreName?: string;
  artworkUrl100?: string;
  collectionViewUrl?: string;
}

function candidateMatches(candidate: { title: string; author: string }, result: ItunesAudiobook): boolean {
  const wantedTitle = normalizeForMatching(candidate.title);
  const foundTitle = normalizeForMatching(result.collectionName ?? '');
  const wantedAuthor = normalizeForMatching(candidate.author);
  const foundAuthor = normalizeForMatching(result.artistName ?? '');
  return Boolean(wantedTitle && foundTitle && wantedAuthor && foundAuthor)
    && (wantedTitle === foundTitle || wantedTitle.includes(foundTitle) || foundTitle.includes(wantedTitle))
    && (wantedAuthor === foundAuthor || wantedAuthor.includes(foundAuthor) || foundAuthor.includes(wantedAuthor));
}

async function verifyExternal(
  candidate: RecommendationResponse['external'][number],
  maxDurationHours: number | null,
  fetchImpl: typeof fetch,
): Promise<ExternalRecommendation | null> {
  const term = encodeURIComponent(`${candidate.title} ${candidate.author}`);
  const response = await fetchImpl(`https://itunes.apple.com/search?term=${term}&media=audiobook&limit=5`);
  if (!response.ok) return null;
  const payload = await response.json() as { results?: ItunesAudiobook[] };
  const match = (payload.results ?? []).find((item) => candidateMatches(candidate, item));
  if (!match?.collectionName || !match.artistName) return null;
  const durationSeconds = typeof match.trackTimeMillis === 'number' ? Math.round(match.trackTimeMillis / 1000) : null;
  if (maxDurationHours !== null
    && (durationSeconds === null || durationSeconds > maxDurationHours * 3600)) return null;
  return {
    title: match.collectionName.replace(/\s*\((?:Unabridged|Abridged)\)\s*$/i, ''),
    author: match.artistName,
    reason: candidate.reason,
    description: match.description ?? null,
    durationSeconds,
    genre: match.primaryGenreName ?? null,
    coverUrl: match.artworkUrl100?.replace('100x100bb', '300x300bb') ?? null,
    storeUrl: match.collectionViewUrl ?? null,
  };
}

export async function recommendBooks(input: {
  db: CuratorDb;
  llmClient: LlmClient;
  prompt: string;
  seedBookIds: string[];
  scope: RecommendationScope;
  fetchImpl?: typeof fetch;
}): Promise<RecommendationResult> {
  const { recommendations } = await input.llmClient.generateRecommendations(
    buildTagSummary(input.db),
    input.prompt,
    input.seedBookIds,
    input.scope,
  );
  const seedIds = new Set(input.seedBookIds);
  const maxSeconds = recommendations.constraints.maxDurationHours === null
    ? null
    : recommendations.constraints.maxDurationHours * 3600;

  const shelfBooks = new Map(input.db
    .getBooksByIds(recommendations.shelf.map((entry) => entry.bookId))
    .map((book) => [book.id, book]));
  const onShelf = input.scope === 'discover'
    ? []
    : recommendations.shelf.flatMap((entry) => {
      const book = shelfBooks.get(entry.bookId);
      if (!book || seedIds.has(book.id)) return [];
      if (maxSeconds !== null
        && (book.durationSeconds === null || book.durationSeconds > maxSeconds)) return [];
      return [{ ...book, reason: entry.reason, tags: input.db.getTagsForBook(book.id) }];
    });

  let available: ExternalRecommendation[] = [];
  if (input.scope !== 'shelf') {
    const owned = input.db.getAllBooks();
    const verified = await Promise.all(recommendations.external.map((candidate) =>
      verifyExternal(candidate, recommendations.constraints.maxDurationHours, input.fetchImpl ?? fetch).catch(() => null)));
    const seen = new Set<string>();
    available = verified.filter((candidate): candidate is ExternalRecommendation => {
      if (!candidate) return false;
      // Not `externalBookKey`: this is an in-memory dedupe key scoped to a single
      // request, not a persisted `book_edges.to_book` value, and the `ext:` prefix
      // would only add noise here. See externalKey.ts for the persisted convention.
      const key = `${normalizeForMatching(candidate.title)}|${normalizeForMatching(candidate.author)}`;
      const alreadyOwned = owned.some((book) => normalizeForMatching(book.title) === normalizeForMatching(candidate.title)
        && (!book.author || normalizeForMatching(book.author) === normalizeForMatching(candidate.author)));
      if (alreadyOwned || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return {
    interpretation: recommendations.interpretation,
    constraints: recommendations.constraints,
    scope: input.scope,
    onShelf,
    available,
  };
}
