import type { CuratorDb } from './db.js';
import {
  createItunesAudiobookVerifier,
  type ExternalAudiobookVerifier,
  type VerifiedExternalAudiobook,
} from './externalAudiobookLookup.js';
import { normalizeForMatching } from './externalKey.js';
import { AppError } from './errors.js';
import {
  recommendationRetrievalPlanSchema,
  type RecommendationInterpreter,
  type RecommendationPromptCandidate,
  type RecommendationRetrievalPlan,
  type RecommendationSeedContext,
} from './llmClient.js';
import {
  LIBRARIAN_TOOLS,
  type LibrarianTool,
  type LibrarianToolDeps,
  type SearchSemanticInput,
  type SearchSemanticResult,
} from './librarian/tools.js';
import type { Book, RecommendationResponse } from './types.js';

export type RecommendationScope = 'both' | 'shelf' | 'discover';

export interface ShelfRecommendation extends Book {
  reason: string;
  tags: ReturnType<CuratorDb['getTagsForBook']>;
}

export type ExternalRecommendation = VerifiedExternalAudiobook;

export interface RecommendationResult {
  interpretation: string;
  constraints: RecommendationResponse['constraints'];
  scope: RecommendationScope;
  onShelf: ShelfRecommendation[];
  available: ExternalRecommendation[];
}

const RETRIEVAL_LIMIT = 20;
const MAX_DESCRIPTION_CHARS = 1_200;
const MAX_EVIDENCE_TAGS = 20;
const MAX_MATCHED_TAGS = 20;
const MAX_TAG_SOURCE_CHARS = 80;

const semanticSearchTool = (() => {
  const tool = LIBRARIAN_TOOLS.find((entry) => entry.name === 'search_semantic');
  if (!tool) throw new Error('search_semantic librarian tool is not registered');
  return tool as LibrarianTool<SearchSemanticInput, SearchSemanticResult>;
})();

function truncate(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

function candidateDto(result: SearchSemanticResult['results'][number]): RecommendationPromptCandidate {
  const { book } = result;
  return {
    id: book.id.slice(0, 256),
    title: book.title.slice(0, 200),
    author: truncate(book.author, 160),
    series: truncate(book.series, 160),
    seriesSequence: book.seriesSequence,
    durationSeconds: book.durationSeconds,
    publishedYear: book.publishedYear,
    description: truncate(book.description, MAX_DESCRIPTION_CHARS),
    tags: result.tags.slice(0, MAX_EVIDENCE_TAGS).map((tag) => ({
      tag: tag.tag.slice(0, 80),
      category: tag.category,
      confidence: tag.confidence,
      source: tag.source.slice(0, MAX_TAG_SOURCE_CHARS),
    })),
    score: result.score,
    matchedTags: result.matchedTags.slice(0, MAX_MATCHED_TAGS).map((tag) => tag.slice(0, 80)),
  };
}

function externalSatisfiesHardTags(
  candidate: VerifiedExternalAudiobook,
  plan: RecommendationRetrievalPlan,
): boolean {
  const genre = candidate.genre === null ? null : normalizeForMatching(candidate.genre);
  const required = plan.requiredTags.every((tag) =>
    tag.category === 'genre'
      && genre !== null
      && genre === normalizeForMatching(tag.tag));
  if (!required) return false;

  // iTunes exposes only a genre. An unscoped or non-genre hard exclusion
  // cannot be proven absent, so fail closed instead of presenting an external
  // result as if it had passed the same hard plan as shelf retrieval.
  return plan.excludeTags.every((tag) =>
    tag.category === 'genre'
      && genre !== null
      && genre !== normalizeForMatching(tag.tag));
}

function seedDto(db: CuratorDb, book: Book): RecommendationSeedContext {
  const candidate = candidateDto({
    book,
    tags: db.getTagsForBook(book.id),
    score: 0,
    components: { semantic: 0, tag: 0, reception: 0 },
    matchedTags: [],
  });
  return {
    id: candidate.id,
    title: candidate.title,
    author: candidate.author,
    series: candidate.series,
    seriesSequence: candidate.seriesSequence,
    durationSeconds: candidate.durationSeconds,
    publishedYear: candidate.publishedYear,
    description: candidate.description,
    tags: candidate.tags,
  };
}

async function retrieveCandidates(
  deps: LibrarianToolDeps,
  plan: RecommendationRetrievalPlan,
): Promise<SearchSemanticResult> {
  // Dispatch through the registered tool entry so Scout and the librarian
  // loop cannot grow independent ranking/filtering implementations.
  const toolInput = semanticSearchTool.inputSchema.parse({
    query: plan.semanticQuery,
    ...(plan.maxDurationHours !== null ? { maxDurationHours: plan.maxDurationHours } : {}),
    ...(plan.requiredTags.length > 0 ? { allTags: plan.requiredTags } : {}),
    ...(plan.excludeTags.length > 0 ? { excludeTags: plan.excludeTags } : {}),
    ...(plan.preferredTags.length > 0 ? { preferredTags: plan.preferredTags } : {}),
    ...(plan.softExcludeTags.length > 0 ? { softExcludeTags: plan.softExcludeTags } : {}),
    limit: RETRIEVAL_LIMIT,
  });
  return semanticSearchTool.handler(deps, toolInput);
}

export async function recommendBooks(input: {
  db: CuratorDb;
  interpreter: RecommendationInterpreter;
  embeddingModel: string;
  embeddingCreator: LibrarianToolDeps['embeddingCreator'];
  prompt: string;
  seedBookIds: string[];
  scope: RecommendationScope;
  externalVerifier?: ExternalAudiobookVerifier;
  fetchImpl?: typeof fetch;
}): Promise<RecommendationResult> {
  const prompt = input.prompt.trim();
  const requestedSeedIds = [...new Set(input.seedBookIds.map((id) => id.trim()).filter(Boolean))];
  const seedBooks = input.db.getBooksByIds(requestedSeedIds);
  if (!prompt && seedBooks.length === 0) {
    throw new AppError('VALIDATION', 'Enter a request or select at least one valid reference book');
  }
  const seeds = seedBooks.map((book) => seedDto(input.db, book));
  const planned = await input.interpreter.planRecommendations(prompt, seeds);
  const plan = recommendationRetrievalPlanSchema.parse(planned.plan);
  const retrieved = await retrieveCandidates({
    db: input.db,
    embeddingModel: input.embeddingModel,
    embeddingCreator: input.embeddingCreator,
  }, plan);
  const seedIds = new Set(seedBooks.map((book) => book.id));
  const evidence = retrieved.results
    .filter((result) => !seedIds.has(result.book.id))
    .slice(0, RETRIEVAL_LIMIT);

  const { recommendations } = await input.interpreter.generateCandidateRecommendations(
    evidence.map(candidateDto),
    plan,
    prompt,
    [...seedIds],
    input.scope,
  );

  const evidenceById = new Map(evidence.map((result) => [result.book.id.slice(0, 256), result]));
  const maxSeconds = plan.maxDurationHours === null
    ? null
    : plan.maxDurationHours * 3600;
  const onShelf = input.scope === 'discover'
    ? []
    : recommendations.shelf.flatMap((entry) => {
      // Dynamic evidence allowlist: an ID invented by the model never reaches
      // a DB hydration path, even if a different shelf row happens to use it.
      const result = evidenceById.get(entry.bookId);
      if (!result) return [];
      const { book, tags } = result;
      if (maxSeconds !== null
        && (book.durationSeconds === null || book.durationSeconds > maxSeconds)) return [];
      return [{ ...book, reason: entry.reason, tags }];
    });

  let available: ExternalRecommendation[] = [];
  if (input.scope !== 'shelf') {
    const verifier = input.externalVerifier
      ?? createItunesAudiobookVerifier({ ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
    // Keep verification isolated per candidate: one failed lookup must not
    // discard independently verified suggestions.
    const verified = await Promise.all(recommendations.external.map((candidate) =>
      verifier.verify(candidate, {
        maxDurationHours: plan.maxDurationHours,
      }).catch(() => null)));

    const owned = input.db.getAllBooks();
    const seen = new Set<string>();
    available = verified.filter((candidate): candidate is ExternalRecommendation => {
      if (!candidate) return false;
      if (!externalSatisfiesHardTags(candidate, plan)) return false;
      const title = normalizeForMatching(candidate.title);
      const author = normalizeForMatching(candidate.author);
      const key = `${title}|${author}`;
      const alreadyOwned = owned.some((book) => normalizeForMatching(book.title) === title
        && (!book.author || normalizeForMatching(book.author) === author));
      if (alreadyOwned || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return {
    interpretation: recommendations.interpretation,
    constraints: {
      maxDurationHours: plan.maxDurationHours,
      genres: plan.requiredTags.filter((tag) => tag.category === 'genre').map((tag) => tag.tag),
      moods: plan.preferredTags.filter((tag) => tag.category === 'mood').map((tag) => tag.tag),
    },
    scope: input.scope,
    onShelf,
    available,
  };
}
