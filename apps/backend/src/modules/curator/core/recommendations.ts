import { randomUUID } from 'node:crypto';

import type { CuratorDb } from './db.js';
import {
  createItunesAudiobookVerifier,
  type ExternalAudiobookVerifier,
  type VerifiedExternalAudiobook,
} from './externalAudiobookLookup.js';
import { normalizeForMatching } from './externalKey.js';
import { matchedTagReason, reasonIsAboutAnotherBook } from './reasonGuard.js';
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
import { resolveTagFilters, type TagResolutionNote } from './retrieval/tagResolution.js';
import type { Book, RecommendationResponse } from './types.js';

export type RecommendationScope = 'both' | 'shelf' | 'discover';

export interface ShelfRecommendation extends Book {
  reason: string;
  tags: ReturnType<CuratorDb['getTagsForBook']>;
  /**
   * The tags the ranker actually scored this book on — "why this one".
   * `ranker.ts` has produced these since Phase 3 and its docblock says they
   * drive the UI's "Why this?", but nothing threaded them out of retrieval,
   * so the panel fell back to showing the book's first four arbitrary tags
   * (`adult`, `modern`) — noise where an explanation belonged.
   */
  matchedTags: string[];
  /** True when the model's own sentence was replaced by {@link matchedTagReason}. */
  reasonReplaced?: boolean;
}

export type ExternalRecommendation = VerifiedExternalAudiobook;

/**
 * What retrieval actually did, so the caller can disclose it rather than
 * present a silently-rewritten query as the one the user asked. `tagResolution`
 * carries the canonicalizations and subtype widenings applied by
 * `retrieval/tagResolution.ts`.
 */
export interface RetrievalAudit {
  /** Books that survived the hard filters, before the evidence slice. */
  candidateCount: number;
  /** Candidates actually shown to the answering model. */
  evidenceCount: number;
  tagResolution: TagResolutionNote[];
  relaxation: SearchSemanticResult['relaxation'];
  /** Whether a taste profile actually blended into this ranking (§10.J). */
  personalized: boolean;
}

export interface RecommendationResult {
  interpretation: string;
  /** Groups this slate's `rec_impressions` rows. Send it back with any
   *  feedback so a verdict can be tied to what was actually shown. */
  slateId: string;
  constraints: RecommendationResponse['constraints'];
  scope: RecommendationScope;
  onShelf: ShelfRecommendation[];
  available: ExternalRecommendation[];
  retrieval: RetrievalAudit;
}

const RETRIEVAL_LIMIT = 20;
const MAX_DESCRIPTION_CHARS = 1_200;
const MAX_EVIDENCE_TAGS = 20;
const MAX_MATCHED_TAGS = 20;
const MAX_TAG_SOURCE_CHARS = 80;

/** Shown when hard filters left nothing to rank. Deliberately states the
 *  remedy: everything positive is already soft, so what emptied the set was a
 *  hard exclusion or the duration bound. */
const NO_SHELF_MATCH_INTERPRETATION =
  'Nothing on the shelf got past the exclusions and length limit in this request. '
  + 'Try dropping an exclusion or widening the length.';

/** How many candidates the deterministic fallback offers. */
const FALLBACK_SHELF_LIMIT = 3;

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

/**
 * The ranker's own top candidates, used when the answering model named books
 * but none of them survived the evidence allowlist or the duration bound.
 *
 * Reasons are built from `matchedTags` — the tags the ranker actually scored
 * on — so this path states why a book is here without inventing prose. It
 * never reaches outside `evidence`, so it inherits the same allowlist
 * guarantee as the model-selected path.
 */
function fallbackShelf(
  evidence: readonly SearchSemanticResult['results'][number][],
  maxSeconds: number | null,
): ShelfRecommendation[] {
  return evidence
    .filter((result) => maxSeconds === null
      || (result.book.durationSeconds !== null && result.book.durationSeconds <= maxSeconds))
    .slice(0, FALLBACK_SHELF_LIMIT)
    .map((result) => ({
      ...result.book,
      reason: matchedTagReason(result.matchedTags),
      tags: result.tags,
      matchedTags: result.matchedTags,
    }));
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
    components: { semantic: 0, tag: 0, reception: 0, taste: 0 },
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
  // loop cannot grow independent ranking/filtering implementations. The tool
  // canonicalizes every tag below against the stored vocabulary.
  const toolInput = semanticSearchTool.inputSchema.parse({
    query: plan.semanticQuery,
    ...(plan.maxDurationHours !== null ? { maxDurationHours: plan.maxDurationHours } : {}),
    ...(plan.requiredTags.length > 0 ? { relaxableTags: plan.requiredTags } : {}),
    ...(plan.excludeTags.length > 0 ? { excludeTags: plan.excludeTags } : {}),
    ...(plan.preferredTags.length > 0 ? { preferredTags: plan.preferredTags } : {}),
    ...(plan.softExcludeTags.length > 0 ? { softExcludeTags: plan.softExcludeTags } : {}),
    // Scout is the personalized surface (plan §6). Taste is a ranker prior
    // over books that already passed every hard filter, so an explicit query
    // constraint still wins; the tool reports `personalized: false` when the
    // §10.J cold-start gate holds.
    personalize: true,
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
  // External verification never inherits the shelf retry. Normalize the
  // planner's original hard terms deterministically, but retain them as hard
  // requirements even if shelf retrieval later demotes relaxable positives.
  const normalizedRequiredResult = resolveTagFilters(input.db, { allTags: plan.requiredTags });
  const normalizedExcludedResult = resolveTagFilters(input.db, { excludeTags: plan.excludeTags });
  const normalizedRequired = normalizedRequiredResult.allTags ?? [];
  const normalizedExcluded = normalizedExcludedResult.excludeTags ?? [];
  const externalHardPlanValid = normalizedRequiredResult.invalidHardFields.length === 0
    && normalizedExcludedResult.invalidHardFields.length === 0;
  const normalizedHardPlan: RecommendationRetrievalPlan = {
    ...plan,
    requiredTags: normalizedRequired,
    excludeTags: normalizedExcluded,
  };
  const retrieved = await retrieveCandidates({
    db: input.db,
    embeddingModel: input.embeddingModel,
    embeddingCreator: input.embeddingCreator,
  }, plan);
  const seedIds = new Set(seedBooks.map((book) => book.id));
  const evidence = retrieved.results
    .filter((result) => !seedIds.has(result.book.id))
    .slice(0, RETRIEVAL_LIMIT);

  const retrieval: RetrievalAudit = {
    candidateCount: retrieved.total,
    evidenceCount: evidence.length,
    tagResolution: retrieved.tagResolution ?? [],
    personalized: retrieved.personalized,
    relaxation: retrieved.relaxation,
  };
  const constraints = {
    maxDurationHours: plan.maxDurationHours,
    genres: plan.requiredTags.filter((tag) => tag.category === 'genre').map((tag) => tag.tag),
    moods: plan.preferredTags.filter((tag) => tag.category === 'mood').map((tag) => tag.tag),
  };

  // Retrieval found nothing and this scope has no external half to carry the
  // answer. Asking the model to recommend from an empty evidence set is how an
  // invented book gets produced — `driver.ts` catches that one round later, but
  // the fault is here. Report the empty shelf as a normal result instead.
  if (evidence.length === 0 && input.scope === 'shelf') {
    return {
      interpretation: NO_SHELF_MATCH_INTERPRETATION,
      constraints,
      scope: input.scope,
      onShelf: [],
      available: [],
      retrieval,
      slateId: randomUUID(),
    };
  }

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
  const selected = input.scope === 'discover'
    ? []
    : recommendations.shelf.flatMap((entry) => {
      // Dynamic evidence allowlist: an ID invented by the model never reaches
      // a DB hydration path, even if a different shelf row happens to use it.
      const result = evidenceById.get(entry.bookId);
      if (!result) return [];
      const { book, tags } = result;
      if (maxSeconds !== null
        && (book.durationSeconds === null || book.durationSeconds > maxSeconds)) return [];

      // The identity is already guaranteed real by the allowlist above; the
      // PROSE is not. A sentence describing a different book in this same
      // slate is replaced rather than shown — see `reasonGuard.ts` for the
      // real answers that motivated this.
      const others = evidence
        .filter((candidate) => candidate.book.id !== book.id)
        .map((candidate) => ({ title: candidate.book.title, author: candidate.book.author }));
      const misattributed = reasonIsAboutAnotherBook(entry.reason, { title: book.title, author: book.author }, others);

      return [{
        ...book,
        reason: misattributed ? matchedTagReason(result.matchedTags) : entry.reason,
        tags,
        matchedTags: result.matchedTags,
        ...(misattributed ? { reasonReplaced: true } : {}),
      }];
    });

  // The model named books but every one of them was invented or violated the
  // duration bound. That is a failed selection over real evidence, not an
  // honest "nothing fits" — fall back to the ranker's own order rather than
  // discarding candidates retrieval already found. A model that deliberately
  // returned an EMPTY shelf list is respected as-is; `recommendations.shelf`
  // being non-empty is what distinguishes the two.
  const onShelf = input.scope !== 'discover'
    && selected.length === 0
    && recommendations.shelf.length > 0
    ? fallbackShelf(evidence, maxSeconds)
    : selected;

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
      if (!externalHardPlanValid) return false;
      if (!externalSatisfiesHardTags(candidate, normalizedHardPlan)) return false;
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

  // Record the whole slate, not just what gets accepted later (plan §6 as
  // amended, `docs/recommendation-data-model.md` §7). Verdicts alone say what
  // was chosen; they never say what it was chosen OVER, and without the rank
  // positions there is no way to ask "did the ranker put the winner first?"
  // offline — which is the only thing that turns future weight changes into a
  // measurement instead of another human judgment call (§10.C).
  const slateId = randomUUID();
  const impressions = [
    ...onShelf.map((book, index) => ({ bookId: book.id, rank: index })),
    ...available.map((book, index) => ({
      bookId: null,
      externalKey: `${normalizeForMatching(book.title)}|${normalizeForMatching(book.author)}`,
      rank: onShelf.length + index,
    })),
  ];
  // Logging must never take down a recommendation the user is waiting on.
  try {
    input.db.insertRecImpressions(slateId, prompt, impressions, Date.now());
  } catch {
    // Intentionally swallowed: an impression row is analytics, not the answer.
  }

  return {
    interpretation: recommendations.interpretation,
    constraints,
    scope: input.scope,
    onShelf,
    available,
    retrieval,
    slateId,
  };
}
