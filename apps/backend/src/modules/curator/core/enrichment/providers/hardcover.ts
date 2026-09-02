/**
 * Hardcover enrichment provider (librarian engine plan §2, Phase 5).
 *
 * Pure fetch+parse against Hardcover's GraphQL API, `fetchImpl` injected so
 * tests never touch the network — same contract as `googleBooks.ts` and
 * `openLibrary.ts`.
 *
 * WHAT THIS PROVIDER IS FOR, AND WHAT IT IS NOT FOR. Unlike the other
 * providers, Hardcover is not here for entities. It is here for the
 * **reception prior** — the `w_rec` term §4.3 has carried since Phase 3 with
 * nothing to populate it, which is why `ranker.ts` has been scoring every book
 * at the neutral 0.5. Hardcover publishes an aggregate rating and a rating
 * count per book, which is exactly that signal. Entities are left empty:
 * Hardcover's taxonomy is genre/mood "tags", not MARC person/place headings,
 * so anything extracted as an entity would be an ungrounded guess and would
 * pollute the `book_entities` allowlist that `tagging/ground.ts` treats as
 * authoritative. Its tags go to `subjects` instead, where they are candidate
 * facet terms subject to the normal promotion queue.
 *
 * TOKEN REQUIRED. Hardcover's API is authenticated for every request; there is
 * no anonymous tier. {@link createHardcoverProvider} therefore returns `null`
 * when no token is configured and the caller omits the provider entirely,
 * exactly as `createGoogleBooksProvider` does — a provider that exists but
 * always returns null would be recorded as a genuine `not-found` against every
 * book, which is a cached lie that suppresses re-lookup once a token IS added.
 *
 * ── NOT VERIFIED AGAINST THE LIVE API ──────────────────────────────────────
 * This was written and tested against fixtures only; no request has been made
 * to Hardcover. The GraphQL document, field names, and rating scale below are
 * from the published schema and MUST be confirmed against a real response
 * before the reception prior is trusted in ranking. Until then, prefer running
 * it in a sample enrichment run and reading the quality report.
 */
import { AppError } from '../../errors.js';
import type { Book } from '../../types.js';
import type { EnrichmentPayload, EnrichmentProvider } from '../types.js';
import { matchesBook } from './matching.js';

const HARDCOVER_ENDPOINT = 'https://api.hardcover.app/v1/graphql';
const REQUEST_TIMEOUT_MS = 15_000;
/** Hardcover publishes ratings on a 1–5 scale. */
const MAX_RATING = 5;
/**
 * Below this many ratings the average is noise — one enthusiastic friend of
 * the author should not outrank a book with two thousand ratings. Such a book
 * reports `null`, which the ranker reads as "no signal" and scores neutral.
 */
const MIN_RATINGS_FOR_PRIOR = 5;

const SEARCH_DOCUMENT = `query CuratorLookup($query: String!) {
  search(query: $query, query_type: "Book", per_page: 5) {
    results
  }
}`;

interface HardcoverBookLike {
  id?: unknown;
  title?: unknown;
  author_names?: unknown;
  rating?: unknown;
  ratings_count?: unknown;
  genres?: unknown;
  moods?: unknown;
  tags?: unknown;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Hardcover nests hits under `search.results.hits[].document`; tolerate both shapes. */
function extractHits(raw: unknown): HardcoverBookLike[] {
  if (raw === null || typeof raw !== 'object') return [];
  const data = (raw as { data?: unknown }).data;
  const search = data && typeof data === 'object' ? (data as { search?: unknown }).search : undefined;
  const results = search && typeof search === 'object' ? (search as { results?: unknown }).results : undefined;
  if (!results || typeof results !== 'object') return [];
  const hits = (results as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) return [];
  return hits
    .map((hit) => (hit && typeof hit === 'object' ? (hit as { document?: unknown }).document ?? hit : null))
    .filter((doc): doc is HardcoverBookLike => doc !== null && typeof doc === 'object');
}

function subjectsFrom(doc: HardcoverBookLike): string[] {
  return [...new Set([...asStringArray(doc.genres), ...asStringArray(doc.moods), ...asStringArray(doc.tags)])];
}

/**
 * Normalized reception prior in [0,1] for a cached Hardcover payload, or
 * `null` when the book has too few ratings to say anything. `null` is the
 * value `ranker.ts` scores at its neutral midpoint — see its docblock on why
 * unknown reception must not be scored as zero.
 */
export function hardcoverReceptionPrior(raw: unknown): number | null {
  const [doc] = extractHits(raw);
  if (!doc) return null;
  const rating = asNumber(doc.rating);
  const count = asNumber(doc.ratings_count);
  if (rating === null || count === null || count < MIN_RATINGS_FOR_PRIOR) return null;
  return Math.min(1, Math.max(0, rating / MAX_RATING));
}

const EMPTY_FACETS = { genres: [] as string[], moods: [] as string[], tags: [] as string[] };

/** Set-equality on two string arrays, case-sensitive — `subjectsFrom` already
 *  case-preserves, so an exact string match is the right comparison. */
function sameSubjectSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((v) => bSet.has(v));
}

/**
 * Recover Hardcover's genre/mood/tag distinction from the cached `raw`
 * response (R1, docs/enrichment-sources-review.md §3 — "Wire subjects into
 * the canonicalizer"). `subjectsFrom` above destroys that distinction before
 * storage — `[...new Set([...genres, ...moods, ...tags])]` — so the stored
 * `payload.subjects` for a Hardcover row can never tell a mood from a genre.
 * `raw` is cached verbatim precisely so a rule like this can change for free:
 * no re-fetch, no rederive pass, just a new reader over data already on disk.
 *
 * `raw.data.search.results.hits` is UNVERIFIED search output — `lookup()`
 * (above) only trusts the hit `matchesBook` picked, which is routinely not
 * `hits[0]`. This does not re-run `matchesBook` (no `Book` is available this
 * far downstream, only the cached row), so instead it re-derives the same
 * verified answer a cheaper way: `verifiedSubjects` is the row's own stored
 * `payload.subjects`, which `payloadFor` built from `subjectsFrom(matched)` at
 * write time — the genuinely-matched hit is therefore the one and only hit
 * whose `subjectsFrom` set equals `verifiedSubjects`. When zero or more than
 * one hit satisfies that (a legitimate tie, or a `raw` shape that predates
 * this check), this returns everything empty rather than guess — silence is
 * the safe failure, a wrong book's mood/genre attributed to this book is not.
 *
 * That premise holds ONLY while nothing rewrites a row's stored `subjects`
 * from an unverified hit. This provider therefore deliberately exposes no
 * `rederive` hook — see the comment where it used to be.
 */
export function hardcoverFacets(
  raw: unknown,
  verifiedSubjects: readonly string[]
): { genres: string[]; moods: string[]; tags: string[] } {
  const hits = extractHits(raw);
  if (hits.length === 0) return EMPTY_FACETS;
  // Only one candidate — no ambiguity to resolve, since a cached 'ok' row
  // only exists because SOME hit matched, and here there is only one.
  let doc: HardcoverBookLike | undefined;
  if (hits.length === 1) {
    doc = hits[0];
  } else {
    const matches = hits.filter((hit) => sameSubjectSet(subjectsFrom(hit), verifiedSubjects));
    doc = matches.length === 1 ? matches[0] : undefined;
  }
  if (!doc) return EMPTY_FACETS;
  return {
    genres: asStringArray(doc.genres),
    moods: asStringArray(doc.moods),
    tags: asStringArray(doc.tags),
  };
}

function payloadFor(raw: unknown, doc: HardcoverBookLike): EnrichmentPayload {
  return {
    raw,
    // Deliberately empty — see the module docblock on why Hardcover must not
    // feed the entity allowlist.
    entities: [],
    subjects: subjectsFrom(doc),
  };
}

export interface HardcoverProviderOptions {
  /** Optional so a config assembled without this key disables the provider
   *  rather than throwing while the whole API router is being built. */
  token?: string | undefined;
  endpoint?: string;
  timeoutMs?: number;
}

/**
 * Build the provider, or `null` when no token is configured so the caller can
 * omit it. See the module docblock for why omitting beats a provider that
 * always returns null.
 */
export function createHardcoverProvider(options: HardcoverProviderOptions): EnrichmentProvider | null {
  const token = (options.token ?? '').trim();
  if (!token) return null;
  const endpoint = options.endpoint ?? HARDCOVER_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  return {
    name: 'hardcover',

    async lookup(book: Book, fetchImpl: typeof fetch): Promise<EnrichmentPayload | null> {
      const query = [book.title, book.author].filter(Boolean).join(' ').trim();
      if (!query) return null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ query: SEARCH_DOCUMENT, variables: { query } }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new AppError('INTERNAL', 'Hardcover request failed', { cause: err });
      } finally {
        clearTimeout(timer);
      }

      // 404 is "no such route", not "no such book" — only an empty hit list
      // is a genuine not-found, and conflating them would cache a transport
      // problem as a permanent answer.
      if (!response.ok) {
        throw new AppError('INTERNAL', `Hardcover responded ${response.status}`, {
          detail: { status: response.status },
        });
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch (err) {
        throw new AppError('INTERNAL', 'Hardcover returned invalid JSON', { cause: err });
      }

      const hits = extractHits(raw);
      if (hits.length === 0) return null;

      // Same verification posture as the other search-based providers: a
      // search hit is a candidate, not a match. An unverified hit would
      // attach another book's rating to this one.
      const matched = hits.find((doc) =>
        matchesBook(
          { title: typeof doc.title === 'string' ? doc.title : '', authors: asStringArray(doc.author_names) },
          book.title,
          book
        ));
      if (!matched) return null;

      return payloadFor(raw, matched);
    },

    // Deliberately NO `rederive`. Every other provider can recompute its
    // derived fields from `raw` alone, but Hardcover cannot: `raw` holds the
    // whole unverified search page, and which hit `matchesBook` accepted is
    // not recoverable from it (`rederive` receives no `Book`, and no stored
    // `subjects`). The previous implementation re-derived from `hits[0]`,
    // which silently replaced a verified row's subjects with an unrelated
    // book's — and, worse, then satisfied `hardcoverFacets`' uniqueness check
    // as the one "matching" hit, so a wrong book's moods were promoted with
    // full confidence. Omitting the hook makes `rederiveFromCache` count these
    // rows as `rowsUnsupported` and leave their verified `subjects` intact.
    // Re-deriving Hardcover safely needs the hook widened to take the whole
    // payload (raw + stored subjects), not just `raw`; that is a change to the
    // shared `EnrichmentProvider` contract and is deliberately not made here.
  };
}
