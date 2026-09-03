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
 * Discovery is by PROBE, not by search, and that was forced by the live API.
 *
 * The review doc assumed Fandom's cross-wiki search would seed this. It is
 * gone: `GET community.fandom.com/api/v1/Wikis/ByString` answers
 * `404 MethodNotFoundException: WikisApiController::getByString` (confirmed
 * 2026-09-03). What does work is the standard MediaWiki action API on each
 * wiki - the same interface `wikidata.ts` speaks - so this derives candidate
 * subdomains from the series name and asks each one who it is.
 *
 * The substitution is an improvement for R4's purpose. `siteinfo` returns the
 * wiki's OWN name, which is the authoritative thing to score a series against,
 * and a wrong guess returns a plain 404 rather than a plausible-looking search
 * hit. Verified live: discworld.fandom.com -> "Discworld Wiki",
 * expanse.fandom.com -> "The Expanse Wiki", theexpanse.fandom.com -> 404.
 *
 * The cost changes honestly: the doc budgeted one request per series, and this
 * spends up to `limit` (default 4). Still dozens-to-low-hundreds of requests
 * once, for a mapping cached in perpetuity.
 */
function siteinfoUrlFor(subdomain: string): string {
  const params = new URLSearchParams({
    action: 'query',
    meta: 'siteinfo',
    siprop: 'general',
    format: 'json',
    formatversion: '2',
  });
  return `https://${subdomain}.fandom.com/api.php?${params.toString()}`;
}

export { siteinfoUrlFor as siteinfoUrl };

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

/**
 * Candidate subdomains for a series, most likely first.
 *
 * Fandom subdomains are lowercase alphanumerics and hyphens, and the naming is
 * inconsistent about leading articles: "The Expanse" lives at `expanse`, while
 * plenty of others keep the article. So try the article-stripped form first,
 * then the literal one, then a hyphenated variant. Deduped, capped by `limit`
 * at the call site.
 */
export function candidateSubdomains(series: string): string[] {
  const raw = normalizeTokens(series);
  const comparable = comparableTokens(series);
  const forms = [comparable.join(''), raw.join(''), comparable.join('-'), raw.join('-')];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const form of forms) {
    const cleaned = form.replace(/[^a-z0-9-]/g, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/**
 * The wiki's own name from a `meta=siteinfo` body, or null.
 *
 * Defensive on purpose: a Fandom subdomain that does not exist answers 404,
 * but a parked or misconfigured one can answer 200 with something else
 * entirely. No sitename means no candidate, never a throw.
 */
export function parseSiteinfo(raw: unknown): { sitename: string } | null {
  const body = raw as { query?: { general?: { sitename?: unknown } } } | null;
  const sitename = body?.query?.general?.sitename;
  if (typeof sitename !== 'string' || !sitename.trim()) return null;
  return { sitename: sitename.trim() };
}

export interface ProposeOptions {
  /** Subdomain guesses attempted per series. Each is one request. */
  limit?: number;
  /** Injected for tests — there is no default fetch anywhere in this module. */
  fetchImpl: typeof fetch;
}

/**
 * Propose candidates for one series by asking each guessed wiki who it is.
 *
 * A 404 is the expected answer for a wrong guess and is NOT an error — it is
 * exactly the disproof this approach exists to get. A rate-limited response is
 * rethrown so the caller stops the whole run rather than recording the
 * remaining series as "no wiki found", which would be a lie that survives into
 * the review table. Any other transport failure is recorded on the proposal
 * and the run continues.
 */
export async function proposeForSeries(
  series: string,
  books: number,
  options: ProposeOptions
): Promise<SeriesMappingProposal> {
  const limit = options.limit ?? 4;
  const base: SeriesMappingProposal = { series, books, candidates: [], status: 'unconfirmed' };
  const candidates: FandomWikiCandidate[] = [];
  let lastError: string | undefined;

  for (const subdomain of candidateSubdomains(series).slice(0, limit)) {
    await limiter.acquire();
    let body: unknown;
    try {
      const res = await options.fetchImpl(siteinfoUrlFor(subdomain), { headers: { ...DEFAULT_HEADERS } });
      if (res.status === 429 || res.status === 503) {
        limiter.penalize(60_000);
        throw Object.assign(new Error(`Fandom rate-limited (${res.status})`), { rateLimited: true });
      }
      // The wiki simply does not exist. That is a clean negative, not a fault.
      if (res.status === 404) continue;
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      body = await res.json();
    } catch (err) {
      if (isRateLimited(err) || (err as { rateLimited?: boolean })?.rateLimited) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }

    const info = parseSiteinfo(body);
    if (!info) continue;
    const url = `https://${subdomain}.fandom.com`;
    const { confidence, reason } = scoreCandidate(series, info.sitename, url);
    candidates.push({ name: info.sitename, url, subdomain, description: null, confidence, reason });
  }

  const rank: Record<MappingConfidence, number> = { exact: 0, strong: 1, weak: 2 };
  candidates.sort((a, b) => rank[a.confidence] - rank[b.confidence]);

  // Only surface an error when nothing was found: a transport blip on one
  // guess is noise if another guess answered.
  return candidates.length === 0 && lastError ? { ...base, error: lastError } : { ...base, candidates };
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
