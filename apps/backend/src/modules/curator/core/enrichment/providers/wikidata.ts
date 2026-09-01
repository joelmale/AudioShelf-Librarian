/**
 * Wikidata enrichment provider (librarian engine plan §2, provider 4).
 *
 * Pure fetch+parse against the Wikimedia action APIs — no DB access, no env
 * vars, `fetchImpl` injected so tests never touch the network (same pattern as
 * `openLibrary.ts` / `audnexus.ts` / `googleBooks.ts`).
 *
 * WHY THIS EXISTS. Grounded-entity coverage on the live library is 31%, and
 * `tagging/ground.ts#groundCharacter` DROPS any character candidate that isn't
 * on a book's `person` allowlist — so 69% of the library can never carry a
 * grounded character tag. Open Library's `person` is a mention index that
 * canonical SF/fantasy simply lacks (*Dune* has none); Google Books returns
 * descriptions and BISAC categories and no entities at all (it moved external
 * metadata 72% → 81% and grounded entities 297 → 298). Wikidata's **P674
 * (characters)** is a literally curated cast list — the only structured
 * character source among the four.
 *
 * LOW RECALL, HIGH PRECISION — A CONFIRMER, NOT A PRIMARY. This provider will
 * miss most of the library and should. `book_entities` is an **allowlist**: a
 * false `person` row does not merely add noise, it AUTHORISES a hallucinated
 * character tag that grounding would otherwise have dropped. Every knob here is
 * therefore set toward precision, and none of them should be loosened to chase
 * a hit-rate number.
 *
 * Lookup strategy (the plan's "Wikipedia pageprops trick", verified live:
 * "It (novel)" → Q602288):
 *   1. ONE `action=query&prop=pageprops&ppprop=wikibase_item` call against
 *      en.wikipedia.org carrying every candidate page title at once — the bare
 *      candidate titles from `candidateTitlesFor` plus their `(novel)` /
 *      `(book)` / `(novella)` disambiguated forms. Wikipedia resolves
 *      redirects and hands back a QID per page that has one.
 *   2. For up to `MAX_ENTITY_FETCHES` of those QIDs, disambiguated forms first,
 *      fetch `Special:EntityData/<QID>.json` and VERIFY before accepting:
 *        - P31 (instance of) must name a written-work type (`WORK_TYPES`).
 *          This is what rejects the disambiguation-page item, the film, the TV
 *          series, the video game and the album that share the book's title —
 *          all of which the pageprops call happily returns.
 *        - the item's English label / enwiki title must match a candidate
 *          title AND an author name must match (a book with no author of its
 *          own is refused outright — see `verifyEntity`).
 *   3. Only then read P674 (characters → `person`), P840 (narrative location →
 *      `place`) and P136 (genre → subjects).
 *
 * P674/P840/P136 values are QIDs, not names, so a second `wbgetentities` call
 * resolves labels. P50 (author) is a QID too, which is why author labels are
 * fetched BEFORE the accept decision rather than after it.
 *
 * Rate limiting reuses `throttle.ts` (`createRateLimiter` + `DEFAULT_HEADERS`).
 * The descriptive User-Agent is not optional: Wikimedia blocks requests with a
 * generic or absent one.
 */
import { AppError } from '../../errors.js';
import { normalizeForMatching } from '../../externalKey.js';
import type { Book } from '../../types.js';
import type { EnrichedEntity, EnrichmentPayload, EnrichmentProvider, EntityKind } from '../types.js';
import { candidateTitlesFor, matchesBook } from './matching.js';
import {
  DEFAULT_HEADERS,
  createRateLimiter,
  isRateLimited,
  markRateLimited,
  parseRetryAfter,
} from './throttle.js';

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const ENTITY_DATA = 'https://www.wikidata.org/wiki/Special:EntityData';

const TIMEOUT_MS = 15_000;

/**
 * Minimum spacing between Wikimedia requests, in ms.
 *
 * Deliberately declared HERE rather than added to `throttle.ts` alongside the
 * other providers' constants: that file is shared and under concurrent edit,
 * and this provider needs nothing from it but `createRateLimiter`. Wikimedia
 * publishes no numeric rate limit for anonymous reads; its API etiquette asks
 * for serial (non-parallel), self-identified traffic. The module-scoped limiter
 * below delivers exactly that across the whole `p-limit` book pool.
 *
 * Raised from 500ms after a live run: at ~2 req/s Wikimedia throttled 20 of 39
 * lookups. Anonymous reads get no published numeric allowance, so the only
 * evidence available is the failure rate, and slightly under 1 req/s is the
 * conservative reading of "serial traffic" their etiquette asks for. This is a
 * cancellable background operation — wall-clock is the cheapest thing to
 * spend, and a throttled request costs more of it than a slow one does.
 */
export const WIKIDATA_MIN_INTERVAL_MS = 1_100;

/** Module-scoped so it throttles across the concurrent book pool, not per book. */
const limiter = createRateLimiter(WIKIDATA_MIN_INTERVAL_MS);

/** Candidate titles from `candidateTitlesFor` to expand into page titles. */
const MAX_TITLE_ATTEMPTS = 3;
/** Hard cap on page titles in the single pageprops request. */
const MAX_PAGE_TITLES = 12;
/**
 * Entity fetches per book. Each QID is one request, and a book that resolves to
 * four unrelated pages is a book we are about to reject anyway.
 */
const MAX_ENTITY_FETCHES = 3;
/** Ceiling on label lookups for one accepted work; chunked by the API's limit. */
const MAX_LABEL_IDS = 100;
const LABEL_CHUNK = 50;

/**
 * P31 values that mean "this item is the written work". Deliberately NARROW
 * and deliberately an ALLOWLIST rather than a blocklist of films/games/albums:
 * a blocklist fails open on the type nobody thought of, and failing open here
 * writes a wrong cast list into a book's allowlist.
 *
 * An item that is genuinely a book but typed with something not listed here is
 * simply missed. That is the intended trade — see the module docblock.
 */
const WORK_TYPES: ReadonlySet<string> = new Set([
  'Q571', // book
  'Q7725634', // literary work
  'Q47461344', // written work
  'Q8261', // novel
  'Q149537', // novella
  'Q49084', // short story
  'Q1279564', // short story collection
  'Q1667921', // novel series
  'Q277759', // book series
  'Q3331189', // version, edition or translation
]);

/** Parenthetical qualifiers that mark a page as the BOOK rather than the film,
 *  album, or disambiguation page of the same name. Ranked first. */
const DISAMBIGUATORS = ['(novel)', '(book)', '(novella)'] as const;
const DISAMBIGUATED_TITLE = /\((?:novel|book|novella|novel series|short story collection)\)\s*$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Wire shapes
// ─────────────────────────────────────────────────────────────────────────────

interface PagePropsPage {
  title?: string;
  missing?: boolean;
  pageprops?: { wikibase_item?: string };
}

interface PagePropsResponse {
  query?: { pages?: PagePropsPage[] };
}

interface WikidataSnak {
  snaktype?: string;
  property?: string;
  datavalue?: { type?: string; value?: unknown };
}

export interface WikidataClaim {
  mainsnak?: WikidataSnak;
  rank?: string;
}

export interface WikidataEntity {
  id?: string;
  labels?: Record<string, { language?: string; value?: string }>;
  sitelinks?: Record<string, { title?: string }>;
  claims?: Record<string, WikidataClaim[]>;
}

interface EntityDataResponse {
  entities?: Record<string, WikidataEntity>;
}

interface WbGetEntitiesResponse {
  entities?: Record<string, { labels?: Record<string, { value?: string }> }>;
}

/**
 * What this provider caches as `EnrichmentPayload.raw`.
 *
 * `labels` is part of the cached record on purpose. P674/P840/P136 hold QIDs,
 * so without the resolved names a cached entity is un-re-derivable and
 * `rederive` would have to hit the network — which `rederive.ts` forbids by
 * construction (it takes no `fetchImpl`).
 */
export interface WikidataRaw {
  qid: string;
  entity: WikidataEntity;
  labels: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One request + parse. Returns `null` on 404 (the item genuinely does not
 * exist); throws a typed AppError for transport, non-2xx, parse, and
 * API-level errors so the enricher caches 'error' (retried sooner) rather than
 * 'not-found'.
 */
async function getJson<T>(fetchImpl: typeof fetch, url: string, label: string): Promise<T | null> {
  await limiter.acquire();

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { ...DEFAULT_HEADERS } });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    const message = isTimeout
      ? `Wikimedia ${label} request timed out after ${TIMEOUT_MS}ms: ${url}`
      : `Could not reach Wikimedia (${url})`;
    throw new AppError('INTERNAL', message, { cause: err });
  }

  if (res.status === 404) return null;

  if (res.status === 429 || res.status === 503) {
    limiter.penalize(parseRetryAfter(res.headers?.get?.('retry-after')) ?? 60_000);
    throw markRateLimited(
      new AppError('INTERNAL', `Wikimedia is throttling us (HTTP ${res.status}) — backing off`, {
        detail: { status: res.status, url },
      })
    );
  }

  // Wikimedia answers a blocked or unacceptable User-Agent with 403. Retrying
  // cannot help and hammering a block is how a self-hosted tool gets its IP
  // banned, so this stops the caller's plan the same way a 429 does.
  if (res.status === 403) {
    limiter.penalize(60_000);
    throw markRateLimited(
      new AppError('INTERNAL', 'Wikimedia rejected the request (HTTP 403) — check the User-Agent header, which Wikimedia requires to be descriptive', {
        detail: { status: 403, url },
      })
    );
  }

  if (!res.ok) {
    throw new AppError('INTERNAL', `Wikimedia ${label} request failed (HTTP ${res.status}) for ${url}`, {
      detail: { status: res.status, url },
    });
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new AppError('INTERNAL', `Wikimedia returned an unparseable response for ${url}`, { cause: err });
  }

  // The action API reports failures (maxlag, badvalue, …) in a 200 body. Left
  // unchecked those parse as "no results" and would cache a confident
  // 'not-found' for a question that was never actually answered.
  const apiError = (body as { error?: { code?: string; info?: string } } | null)?.error;
  if (apiError) {
    throw new AppError('INTERNAL', `Wikimedia API error (${apiError.code ?? 'unknown'}) for ${url}`, {
      detail: { url, code: apiError.code, info: apiError.info },
    });
  }

  return body as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — candidate page titles → QIDs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expand candidate book titles into Wikipedia page titles, disambiguated forms
 * first. Wikipedia parks the novel at "It (novel)" and a disambiguation page at
 * "It", so asking for both in one request costs nothing extra and lets the
 * ranking below prefer the one that is actually a book.
 */
export function pageTitleForms(baseTitles: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (title: string): void => {
    const trimmed = title.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key) || out.length >= MAX_PAGE_TITLES) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const base of baseTitles) for (const suffix of DISAMBIGUATORS) push(`${base} ${suffix}`);
  for (const base of baseTitles) push(base);
  return out;
}

function pagePropsUrl(titles: readonly string[]): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    prop: 'pageprops',
    ppprop: 'wikibase_item',
    redirects: '1',
    titles: titles.join('|'),
  });
  return `${WIKIPEDIA_API}?${params.toString()}`;
}

/**
 * QIDs from a pageprops response, best-first: pages whose title carries a
 * book-ish parenthetical rank ahead of bare ones, then by the order we asked.
 * Ordering is a cost optimisation only — `verifyEntity` is what decides
 * correctness, so a badly ranked list wastes a request rather than accepting a
 * wrong work.
 */
export function rankedQids(body: PagePropsResponse | null, requested: readonly string[]): string[] {
  const askedAt = new Map(requested.map((title, index) => [title.toLowerCase(), index]));
  const rows: Array<{ qid: string; rank: number; order: number }> = [];
  const seen = new Set<string>();
  for (const page of body?.query?.pages ?? []) {
    const qid = page?.pageprops?.wikibase_item;
    if (typeof qid !== 'string' || !/^Q\d+$/.test(qid) || seen.has(qid)) continue;
    seen.add(qid);
    const title = page.title ?? '';
    rows.push({
      qid,
      rank: DISAMBIGUATED_TITLE.test(title) ? 0 : 1,
      order: askedAt.get(title.toLowerCase()) ?? Number.MAX_SAFE_INTEGER,
    });
  }
  rows.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return rows.map((row) => row.qid);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — entity reading, verification
// ─────────────────────────────────────────────────────────────────────────────

/** Item-valued claim targets for `property`, skipping deprecated ranks and the
 *  `somevalue`/`novalue` snaks that carry no id. */
function itemIds(entity: WikidataEntity, property: string): string[] {
  const out: string[] = [];
  for (const claim of entity.claims?.[property] ?? []) {
    if (claim?.rank === 'deprecated') continue;
    const snak = claim?.mainsnak;
    if (!snak || snak.snaktype !== 'value' || snak.datavalue?.type !== 'wikibase-entityid') continue;
    const id = (snak.datavalue.value as { id?: string } | undefined)?.id;
    if (typeof id === 'string' && /^Q\d+$/.test(id)) out.push(id);
  }
  return out;
}

/** String-valued claims for `property` (P2093, the author-name-string used when
 *  an author has no Wikidata item of their own). */
function stringValues(entity: WikidataEntity, property: string): string[] {
  const out: string[] = [];
  for (const claim of entity.claims?.[property] ?? []) {
    if (claim?.rank === 'deprecated') continue;
    const snak = claim?.mainsnak;
    if (!snak || snak.snaktype !== 'value' || snak.datavalue?.type !== 'string') continue;
    const value = snak.datavalue.value;
    if (typeof value === 'string' && value.trim()) out.push(value.trim());
  }
  return out;
}

/**
 * Is this item the written work, as opposed to the film/series/game/album/
 * disambiguation page that shares its name? The single most important check in
 * this file: the pageprops call returns those just as readily.
 */
export function isWorkKind(entity: WikidataEntity): boolean {
  return itemIds(entity, 'P31').some((id) => WORK_TYPES.has(id));
}

/** Titles this item can legitimately be matched under: its English label, its
 *  enwiki page title, and that title minus a trailing parenthetical. */
function entityTitles(entity: WikidataEntity): string[] {
  const out: string[] = [];
  const label = entity.labels?.en?.value?.trim();
  if (label) out.push(label);
  const sitelink = entity.sitelinks?.enwiki?.title?.trim();
  if (sitelink) {
    out.push(sitelink);
    const stripped = sitelink.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (stripped && stripped !== sitelink) out.push(stripped);
  }
  return out;
}

/** Author names for matching: P50 targets resolved through `labels`, plus any
 *  P2093 author-name-strings. */
function authorNames(entity: WikidataEntity, labels: Record<string, string>): string[] {
  const fromItems = itemIds(entity, 'P50')
    .map((id) => labels[id])
    .filter((name): name is string => Boolean(name));
  return [...fromItems, ...stringValues(entity, 'P2093')];
}

/**
 * Accept or reject a resolved item for this book. Rejection is the common case
 * and must stay cheap to reason about, so the two gates are kept separate:
 *
 *  1. `isWorkKind` — is this a written work at all?
 *  2. `matchesBook` — does its title match a candidate we asked for, and its
 *     author match the book's?
 *
 * DELIBERATE DIVERGENCE from the other three providers: a book with no usable
 * author is refused outright, rather than being allowed to match on title
 * alone as `matchesBook` would permit. The shared helper's rule is right for
 * a catalogue SEARCH, which returns nothing for a title it does not hold. It
 * is wrong here, because the pageprops trick resolves a bare common-word title
 * with total confidence: a shelf entry called "Underground" with no author
 * metadata lands on whichever novel Wikipedia parks at that name, and its cast
 * list then becomes an allowlist authorising character tags for a book it has
 * nothing to do with. Losing those books costs recall we barely had — an
 * authorless, filename-derived title was unlikely to verify anyway.
 */
export function verifyEntity(
  entity: WikidataEntity,
  book: Book,
  candidateTitles: readonly string[],
  authorLabels: Record<string, string>
): boolean {
  if (!isWorkKind(entity)) return false;
  if (!book.author || !normalizeForMatching(book.author)) return false;
  const authors = authorNames(entity, authorLabels);
  for (const found of entityTitles(entity)) {
    for (const wanted of candidateTitles) {
      if (matchesBook({ title: found, authors }, wanted, book)) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P674 → `person`, P840 → `place`, P136 → subjects, all resolved through the
 * cached label map. Pure, and shared by `lookup` and `rederive` so the two can
 * never disagree.
 *
 * An id with no English label is SKIPPED rather than falling back to another
 * language: a label fallback would drop a non-Latin-script string into a
 * `person` allowlist, where it can only fail to match a tag candidate or match
 * the wrong one. No `time` entities are produced — Wikidata has no property
 * that reliably means "when this story is set".
 */
export function extractFromEntity(
  entity: WikidataEntity,
  labels: Record<string, string>
): Pick<EnrichmentPayload, 'entities' | 'subjects'> {
  const entities: EnrichedEntity[] = [];
  const seen = new Set<string>();
  const pushEntity = (id: string, kind: EntityKind): void => {
    const name = labels[id]?.trim();
    if (!name) return;
    const key = `${kind}:${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entities.push({ entity: name, kind });
  };
  for (const id of itemIds(entity, 'P674')) pushEntity(id, 'person');
  for (const id of itemIds(entity, 'P840')) pushEntity(id, 'place');

  const subjects: string[] = [];
  const subjectSeen = new Set<string>();
  for (const id of itemIds(entity, 'P136')) {
    const name = labels[id]?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (subjectSeen.has(key)) continue;
    subjectSeen.add(key);
    subjects.push(name);
  }

  return { entities, subjects };
}

async function fetchEntity(fetchImpl: typeof fetch, qid: string): Promise<WikidataEntity | null> {
  const body = await getJson<EntityDataResponse>(fetchImpl, `${ENTITY_DATA}/${qid}.json`, 'entity');
  return body?.entities?.[qid] ?? null;
}

/** Resolve QIDs to English labels via `wbgetentities`, chunked at the API's
 *  50-id limit. Ids with no English label are simply absent from the result. */
async function fetchLabels(fetchImpl: typeof fetch, ids: readonly string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids)].slice(0, MAX_LABEL_IDS);
  const labels: Record<string, string> = {};
  for (let i = 0; i < unique.length; i += LABEL_CHUNK) {
    const params = new URLSearchParams({
      action: 'wbgetentities',
      format: 'json',
      formatversion: '2',
      props: 'labels',
      languages: 'en',
      ids: unique.slice(i, i + LABEL_CHUNK).join('|'),
    });
    const body = await getJson<WbGetEntitiesResponse>(fetchImpl, `${WIKIDATA_API}?${params.toString()}`, 'labels');
    for (const [id, item] of Object.entries(body?.entities ?? {})) {
      const value = item?.labels?.en?.value?.trim();
      if (value) labels[id] = value;
    }
  }
  return labels;
}

// ─────────────────────────────────────────────────────────────────────────────

export const wikidataProvider: EnrichmentProvider = {
  name: 'wikidata',

  /** Re-extract from the cached item + label map — no network. See
   *  `EnrichmentProvider.rederive` and `WikidataRaw`. */
  rederive(raw: unknown) {
    const cached = raw as WikidataRaw | null;
    if (!cached || typeof cached !== 'object') return null;
    const entity = cached.entity;
    if (!entity || typeof entity !== 'object' || !entity.claims) return null;
    return extractFromEntity(entity, cached.labels ?? {});
  },

  async lookup(book: Book, fetchImpl: typeof fetch): Promise<EnrichmentPayload | null> {
    if (!book.title) return null;
    const candidateTitles = candidateTitlesFor(book).slice(0, MAX_TITLE_ATTEMPTS);
    if (candidateTitles.length === 0) return null;

    const forms = pageTitleForms(candidateTitles);
    // A transport failure here throws, which caches 'error'. That is the honest
    // status: we never got as far as asking Wikidata anything.
    const pages = await getJson<PagePropsResponse>(fetchImpl, pagePropsUrl(forms), 'page lookup');

    const qids = rankedQids(pages, forms);
    // Wikipedia answered and has no page (or no linked item) under any form we
    // know how to construct. That IS a genuine miss — cached 'not-found'.
    if (qids.length === 0) return null;

    let lastError: unknown = null;
    for (const qid of qids.slice(0, MAX_ENTITY_FETCHES)) {
      let entity: WikidataEntity | null;
      try {
        entity = await fetchEntity(fetchImpl, qid);
      } catch (err) {
        if (isRateLimited(err)) throw err;
        lastError = err;
        continue;
      }
      // 404 / empty payload: the item is genuinely gone. A real answer, so it
      // does not count as an unchecked candidate.
      if (!entity) continue;
      // Not a book. Cheap gate, taken before spending a label request.
      if (!isWorkKind(entity)) continue;

      // P50 values are QIDs, so the author check cannot run until they are
      // resolved — hence a label request BEFORE the accept decision.
      let authorLabels: Record<string, string> = {};
      const authorIds = itemIds(entity, 'P50');
      if (authorIds.length > 0) {
        try {
          authorLabels = await fetchLabels(fetchImpl, authorIds);
        } catch (err) {
          if (isRateLimited(err)) throw err;
          // Without author names the verification is not merely harder, it is
          // unperformable — and an unverified accept is exactly the failure
          // this provider exists to avoid. Treat the candidate as unchecked.
          lastError = err;
          continue;
        }
      }

      if (!verifyEntity(entity, book, candidateTitles, authorLabels)) continue;

      const referenced = [
        ...itemIds(entity, 'P674'),
        ...itemIds(entity, 'P840'),
        ...itemIds(entity, 'P136'),
      ];
      let labels = { ...authorLabels };
      if (referenced.length > 0) {
        // NOT best-effort. A failure here would otherwise cache status 'ok'
        // with an empty entity list for a book whose cast list we know exists —
        // a false "this book has no characters" pinned for the 90-day OK TTL.
        // Throwing caches 'error', which is retried sooner and is the truth.
        labels = { ...labels, ...(await fetchLabels(fetchImpl, referenced)) };
      }

      const raw: WikidataRaw = { qid: entity.id ?? qid, entity, labels };
      return { raw, ...extractFromEntity(entity, labels) };
    }

    // At least one candidate was never actually checked (its entity or author
    // fetch failed at the transport level). Stricter than the other providers,
    // which only rethrow when EVERY attempt failed — and deliberately so
    // (invariant 5): claiming 'not-found' requires having examined every
    // candidate, and the one that errored may well have been the right work.
    if (lastError) throw lastError;
    return null;
  },
};
