/**
 * Propose `series -> Fandom wiki` candidates for R4, for a human to confirm.
 *
 * R4 (docs/enrichment-sources-review.md §3) wants curated cast and location
 * lists for the indie series Wikidata has never heard of, read from their fan
 * wikis through the standard MediaWiki action API. What makes that bounded is
 * that it keys on SERIES, not on book: ~961 books collapse to a few dozen
 * distinct `books.series` values, so the whole source costs dozens of requests
 * in perpetuity rather than one per book.
 *
 * It also makes it dangerous. `book_entities` is an allowlist: a wrong wiki
 * mapping does not produce a few bad rows, it authorizes an entire other
 * fandom's character names for every book in the series. The review doc is
 * explicit that the mapping "must not be fully automatic" and has to be
 * "confirmed once by a human" before use.
 *
 * So this module deliberately stops short of deciding. It proposes ranked
 * candidates with the evidence for each, and every row it emits is
 * `unconfirmed`. Nothing here writes a mapping, touches `book_entities`, or
 * fetches a single character name — that is R4 proper, and it must not start
 * until a person has signed off on the table this produces.
 *
 * Ranking is intentionally conservative. `exact` means the wiki's own name,
 * with a trailing "Wiki"/"Wikia" removed, tokenizes identically to the series
 * name; anything less is `weak` no matter how plausible it looks, because the
 * cost of a false positive here is a poisoned allowlist and the cost of a
 * false negative is one line of human typing.
 */
import { normalizeTokens } from './entityMatcher.js';
import { DEFAULT_HEADERS, createRateLimiter, isRateLimited } from './providers/throttle.js';

/**
 * Fandom's cross-wiki search. This is the one surface here whose response
 * shape has NOT been confirmed against the live service — see
 * `parseWikiSearchResponse`, which is written to tolerate a miss rather than
 * throw. Treat it the way `hardcover.ts` treats its GraphQL document.
 */
const FANDOM_SEARCH_API = 'https://community.fandom.com/api/v1/Wikis/ByString';

/** Fandom is a courtesy target, not a quota'd API. One request per second,
 *  matching the Open Library interval, is well inside polite use for the few
 *  dozen requests a full run makes. */
const FANDOM_MIN_INTERVAL_MS = 1_000;

const limiter = createRateLimiter(FANDOM_MIN_INTERVAL_MS);

/** How far a candidate is from being usable without a human squinting at it. */
export type MappingConfidence = 'exact' | 'strong' | 'weak';

export interface FandomWikiCandidate {
  /** The wiki's display name as Fandom reports it, e.g. "Discworld Wiki". */
  name: string;
  /** Full URL as reported, e.g. "https://discworld.fandom.com". */
  url: string;
  /** Subdomain extracted from `url` — the value R4 would actually key on. */
  subdomain: string | null;
  /** Fandom's own one-line description, kept verbatim as review evidence. */
  description: string | null;
  confidence: MappingConfidence;
  /** Why it scored what it scored, in words, for the human reading the table. */
  reason: string;
}

export interface SeriesMappingProposal {
  series: string;
  /** How many books ride on this mapping — i.e. the blast radius of getting
   *  it wrong. Sorting the review queue by this puts the costly rows first. */
  books: number;
  candidates: FandomWikiCandidate[];
  /** Set when the lookup itself failed, as distinct from finding nothing.
   *  A search that errored is NOT evidence that no wiki exists. */
  error?: string;
  /** Always 'unconfirmed' from this module. Nothing here may promote a row. */
  status: 'unconfirmed';
}

/**
 * Trailing words that are platform furniture rather than part of the name.
 *
 * Deliberately limited to the three words Fandom itself appends. "Encyclopedia"
 * and "Database" were here initially and had to be removed: they let
 * "Dune Encyclopedia Wiki" — a real wiki for a DIFFERENT, expanded-universe
 * work — tokenize identically to the series "Dune" and score `exact`, which is
 * the exact poisoned-allowlist failure this whole module exists to prevent.
 * A word that can be part of a real title is not furniture.
 */
const WIKI_SUFFIXES = new Set(['wiki', 'wikia', 'fandom']);

/**
 * Tokens for comparison, with wiki-furniture and a leading article removed.
 * "The Discworld Wiki" and "Discworld" must compare equal; that is the whole
 * point of the exact tier.
 */
export function comparableTokens(value: string): string[] {
  const tokens = normalizeTokens(value);
  const trimmed = [...tokens];
  while (trimmed.length > 1 && WIKI_SUFFIXES.has(trimmed[trimmed.length - 1])) trimmed.pop();
  if (trimmed.length > 1 && trimmed[0] === 'the') trimmed.shift();
  return trimmed;
}

/** The `discworld` in `https://discworld.fandom.com/...`, or null if the URL
 *  is not a Fandom wiki host we recognise. Never guesses. */
export function fandomSubdomain(url: string): string | null {
  const match = /^https?:\/\/([a-z0-9-]+)\.fandom\.com(?:\/|$)/i.exec(url.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Score one candidate against the series name.
 *
 * `exact`  - names tokenize identically once wiki-furniture is stripped.
 * `strong` - every series token appears in the wiki name, and the subdomain
 *            also matches the series' joined tokens. Two independent signals.
 * `weak`   - anything else, including "looks obviously right". A human decides.
 */
export function scoreCandidate(series: string, name: string, url: string): { confidence: MappingConfidence; reason: string } {
  const seriesTokens = comparableTokens(series);
  const nameTokens = comparableTokens(name);
  const subdomain = fandomSubdomain(url);

  if (seriesTokens.length === 0) return { confidence: 'weak', reason: 'series name has no comparable tokens' };

  if (seriesTokens.join(' ') === nameTokens.join(' ')) {
    return { confidence: 'exact', reason: `wiki name matches the series exactly ("${nameTokens.join(' ')}")` };
  }

  const nameSet = new Set(nameTokens);
  const allPresent = seriesTokens.every((t) => nameSet.has(t));
  const subdomainMatches = subdomain !== null && subdomain.replace(/-/g, '') === seriesTokens.join('');
  if (allPresent && subdomainMatches) {
    return { confidence: 'strong', reason: 'every series word appears in the wiki name, and the subdomain agrees' };
  }
  if (allPresent) {
    return { confidence: 'weak', reason: 'series words all appear, but the subdomain does not corroborate' };
  }
  const overlap = seriesTokens.filter((t) => nameSet.has(t)).length;
  return {
    confidence: 'weak',
    reason: overlap > 0 ? `only ${overlap} of ${seriesTokens.length} series words match` : 'no shared words with the series name',
  };
}

/** One raw item as Fandom's Wikis API is documented to return it. Every field
 *  is optional because this shape is unconfirmed against the live service. */
interface RawWikiItem {
  id?: unknown;
  name?: unknown;
  title?: unknown;
  url?: unknown;
  desc?: unknown;
  description?: unknown;
}

/**
 * Pull candidates out of whatever came back, without trusting the shape.
 *
 * Accepts `{items: [...]}` (the documented form) and a bare array, tolerates
 * `name`/`title` and `desc`/`description` spellings, and silently drops any
 * entry without a usable name and URL. An unrecognised body yields an empty
 * list, never a throw: a parse miss must read as "found nothing", which the
 * caller reports honestly, rather than as an error that stops the whole run.
 */
export function parseWikiSearchResponse(raw: unknown): Array<{ name: string; url: string; description: string | null }> {
  const container = raw as { items?: unknown } | null;
  const items = Array.isArray(raw) ? raw : Array.isArray(container?.items) ? container.items : [];
  const out: Array<{ name: string; url: string; description: string | null }> = [];
  for (const entry of items as RawWikiItem[]) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name : typeof entry.title === 'string' ? entry.title : '';
    const url = typeof entry.url === 'string' ? entry.url : '';
    if (!name.trim() || !url.trim()) continue;
    const description =
      typeof entry.desc === 'string' ? entry.desc : typeof entry.description === 'string' ? entry.description : null;
    out.push({ name: name.trim(), url: url.trim(), description });
  }
  return out;
}

export interface ProposeOptions {
  /** Candidates kept per series. More than a handful is noise in a review table. */
  limit?: number;
  /** Injected for tests — there is no default fetch anywhere in this module. */
  fetchImpl: typeof fetch;
}

export function wikiSearchUrl(series: string, limit: number): string {
  const params = new URLSearchParams({ string: series, limit: String(limit), batch: '1' });
  return `${FANDOM_SEARCH_API}?${params.toString()}`;
}

/**
 * Propose candidates for one series. One request, through the shared limiter.
 *
 * A rate-limited failure is rethrown so the caller can stop the whole run
 * rather than record dozens of empty results that look like "no wiki exists" —
 * the same throttled-vs-not-found distinction `enricher.ts` draws. Any other
 * failure is recorded on the proposal as `error` and the run continues.
 */
export async function proposeForSeries(
  series: string,
  books: number,
  options: ProposeOptions
): Promise<SeriesMappingProposal> {
  const limit = options.limit ?? 5;
  const base: SeriesMappingProposal = { series, books, candidates: [], status: 'unconfirmed' };

  await limiter.acquire();
  let body: unknown;
  try {
    const res = await options.fetchImpl(wikiSearchUrl(series, limit), { headers: { ...DEFAULT_HEADERS } });
    if (res.status === 429 || res.status === 503) {
      const err = new Error(`Fandom search rate-limited (${res.status})`);
      limiter.penalize(60_000);
      throw Object.assign(err, { rateLimited: true });
    }
    if (!res.ok) return { ...base, error: `HTTP ${res.status}` };
    body = await res.json();
  } catch (err) {
    if (isRateLimited(err) || (err as { rateLimited?: boolean })?.rateLimited) throw err;
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  const candidates = parseWikiSearchResponse(body).map((item) => {
    const { confidence, reason } = scoreCandidate(series, item.name, item.url);
    return {
      name: item.name,
      url: item.url,
      subdomain: fandomSubdomain(item.url),
      description: item.description,
      confidence,
      reason,
    };
  });

  // Best first, so a reviewer reads the likely answer before the noise. Ties
  // keep Fandom's own ordering, which is roughly relevance.
  const rank: Record<MappingConfidence, number> = { exact: 0, strong: 1, weak: 2 };
  candidates.sort((a, b) => rank[a.confidence] - rank[b.confidence]);

  return { ...base, candidates };
}

/** A series worth proposing a mapping for. */
export interface SeriesCount {
  series: string;
  books: number;
}

/**
 * Collapse books to distinct series, largest first.
 *
 * A single-book "series" is dropped by default: R4's whole economic argument
 * is that one request covers many books, and a one-book series is a per-book
 * cost wearing a series' clothes. It is also the case most likely to be a
 * mis-parsed title rather than a real series.
 */
export function seriesCounts(books: Array<{ series?: string | null }>, minBooks = 2): SeriesCount[] {
  const counts = new Map<string, number>();
  for (const book of books) {
    const series = typeof book.series === 'string' ? book.series.trim() : '';
    if (!series) continue;
    counts.set(series, (counts.get(series) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, books]) => books >= minBooks)
    .map(([series, books]) => ({ series, books }))
    .sort((a, b) => b.books - a.books || (a.series < b.series ? -1 : a.series > b.series ? 1 : 0));
}

export interface MappingReport {
  generatedFor: number;
  proposals: SeriesMappingProposal[];
  /** Counts by best-candidate confidence, plus how many found nothing. */
  summary: { exact: number; strong: number; weak: number; none: number; errored: number };
}

/** Roll proposals into the shape the review artifact is rendered from. */
export function buildMappingReport(proposals: SeriesMappingProposal[]): MappingReport {
  const summary = { exact: 0, strong: 0, weak: 0, none: 0, errored: 0 };
  for (const proposal of proposals) {
    if (proposal.error) summary.errored += 1;
    else if (proposal.candidates.length === 0) summary.none += 1;
    else summary[proposal.candidates[0].confidence] += 1;
  }
  return { generatedFor: proposals.length, proposals, summary };
}
