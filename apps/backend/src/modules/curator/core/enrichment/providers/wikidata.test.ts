/**
 * Fixture-based tests for the Wikidata provider. No network (AGENTS.md):
 * every request is served by an injected `fetchImpl` that routes on URL.
 *
 * The weight of this suite sits deliberately on REJECTION. `book_entities` is
 * an allowlist that `tagging/ground.ts` uses to authorise character tags, so
 * "accepts the right book" is the easy half of the precision claim and
 * "refuses the film, the disambiguation page, and the wrong author" is the half
 * that matters.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Book } from '../../types.js';
import { isRateLimited } from './throttle.js';
import type { TitleParse } from '../titleParse.js';
import { wikidataProvider, type WikidataClaim, type WikidataEntity, type WikidataRaw } from './wikidata.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeTitleParse(overrides: Partial<TitleParse> = {}): TitleParse {
  return {
    original: overrides.candidateTitles?.[0] ?? '',
    normalizedTitle: overrides.candidateTitles?.[0] ?? '',
    candidateTitles: [],
    author: null,
    year: null,
    ordinal: null,
    series: null,
    seriesSequence: null,
    confidence: 'low',
    ...overrides,
  };
}

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    title: 'It',
    author: 'Stephen King',
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
    isbn: null,
    // Pinned so the candidate-title expansion is deterministic rather than
    // whatever `parseTitle` happens to produce today.
    titleParse: makeTitleParse({ candidateTitles: ['It'] }),
    ...overrides,
  };
}

function itemClaim(id: string, rank = 'normal'): WikidataClaim {
  return {
    rank,
    mainsnak: {
      snaktype: 'value',
      datavalue: { type: 'wikibase-entityid', value: { 'entity-type': 'item', id } },
    },
  };
}

function stringClaim(value: string): WikidataClaim {
  return { rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { type: 'string', value } } };
}

/**
 * Q7725634 = literary work; Q39829 = Stephen King.
 *
 * `claims` MERGES with the base rather than replacing it, so a test that
 * overrides one property keeps the rest. This matters more than it looks: an
 * earlier version spread `...overrides` last, which silently dropped P31 from
 * every fixture that overrode `claims` — and the wrong-author test then passed
 * because the item was rejected as a non-work, not because its author was
 * wrong. Overriding one gate must never disable another.
 */
function itNovelEntity(overrides: Partial<WikidataEntity> = {}): WikidataEntity {
  const baseClaims: Record<string, unknown[]> = {
    P31: [itemClaim('Q7725634')],
    P50: [itemClaim('Q39829')],
    P674: [itemClaim('Q3040001'), itemClaim('Q3040002'), itemClaim('Q3040003')],
    P840: [itemClaim('Q3040004')],
    P136: [itemClaim('Q3040005')],
  };
  return {
    id: 'Q602288',
    labels: { en: { language: 'en', value: 'It' } },
    sitelinks: { enwiki: { title: 'It (novel)' } },
    ...overrides,
    claims: { ...baseClaims, ...overrides.claims },
  } as WikidataEntity;
}

/** The 2017 film of the same name — Q11424 = film. What the bare "It" page and
 *  a careless title match would otherwise hand us. */
const IT_FILM_ENTITY: WikidataEntity = {
  id: 'Q22000542',
  labels: { en: { language: 'en', value: 'It' } },
  sitelinks: { enwiki: { title: 'It (2017 film)' } },
  claims: {
    P31: [itemClaim('Q11424')],
    P674: [itemClaim('Q3040001'), itemClaim('Q3040003')],
  },
};

/**
 * An audio adaptation: Q1200957 = radio drama. Same title, and — unlike the
 * film — it credits the novelist through P50, exactly as Wikidata does for
 * dramatisations and scripts.
 *
 * This is the fixture that ISOLATES the P31 gate. Title matches, author
 * matches, cast list is real; the ONLY thing standing between it and a written
 * allowlist is "is this the written work?". It is also the adaptation class
 * most dangerous to an audiobook library, being audio itself.
 */
const IT_RADIO_DRAMA_ENTITY: WikidataEntity = {
  id: 'Q9000001',
  labels: { en: { language: 'en', value: 'It' } },
  sitelinks: { enwiki: { title: 'It (radio drama)' } },
  claims: {
    P31: [itemClaim('Q1200957')],
    P50: [itemClaim('Q39829')],
    P674: [itemClaim('Q3040001'), itemClaim('Q3040003')],
  },
};

/** Q4167410 = Wikimedia disambiguation page. */
const IT_DISAMBIGUATION_ENTITY: WikidataEntity = {
  id: 'Q1063605',
  labels: { en: { language: 'en', value: 'It' } },
  sitelinks: { enwiki: { title: 'It' } },
  claims: { P31: [itemClaim('Q4167410')] },
};

const LABELS: Record<string, string> = {
  Q39829: 'Stephen King',
  Q3040001: 'Beverly Marsh',
  Q3040002: 'Ben Hanscom',
  Q3040003: 'Pennywise',
  Q3040004: 'Derry',
  Q3040005: 'horror fiction',
};

// ─────────────────────────────────────────────────────────────────────────────
// Fetch router
// ─────────────────────────────────────────────────────────────────────────────

type Responder = () => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Routes {
  /** en.wikipedia.org pageprops. */
  pageprops?: unknown | Responder;
  /** QID → entity JSON, or a Responder to simulate a transport failure. */
  entities?: Record<string, WikidataEntity | Responder>;
  /** QID → English label. Ids absent here come back with no label. */
  labels?: Record<string, string>;
  /** Overrides the whole wbgetentities response (for failure paths). */
  labelsResponder?: Responder;
}

interface Harness {
  fetchImpl: typeof fetch;
  urls: string[];
  headers: Array<Record<string, unknown>>;
}

function makeFetch(routes: Routes): Harness {
  const urls: string[] = [];
  const headers: Array<Record<string, unknown>> = [];

  const impl = vi.fn(async (input: unknown, init?: { headers?: Record<string, unknown> }) => {
    const url = String(input);
    urls.push(url);
    headers.push(init?.headers ?? {});

    if (url.includes('en.wikipedia.org')) {
      const route = routes.pageprops;
      if (typeof route === 'function') return (route as Responder)();
      return json(200, route ?? { query: { pages: [] } });
    }

    const entityMatch = /Special:EntityData\/(Q[^.]+)\.json/.exec(url);
    if (entityMatch) {
      const qid = entityMatch[1];
      const route = routes.entities?.[qid];
      if (typeof route === 'function') return (route as Responder)();
      if (!route) return new Response('not found', { status: 404 });
      return json(200, { entities: { [qid]: route } });
    }

    if (url.includes('wbgetentities')) {
      if (routes.labelsResponder) return routes.labelsResponder();
      const ids = decodeURIComponent(new URL(url).searchParams.get('ids') ?? '').split('|').filter(Boolean);
      const entities: Record<string, { labels: Record<string, { value: string }> }> = {};
      for (const id of ids) {
        const label = routes.labels?.[id];
        entities[id] = { labels: label ? { en: { value: label } } : {} };
      }
      return json(200, { entities });
    }

    throw new Error(`unexpected URL in test: ${url}`);
  });

  return { fetchImpl: impl as unknown as typeof fetch, urls, headers };
}

/** The common "Wikipedia resolves It (novel) → Q602288, It → disambiguation" shape. */
const IT_PAGEPROPS = {
  query: {
    pages: [
      { title: 'It (book)', missing: true },
      { title: 'It', pageprops: { wikibase_item: 'Q1063605' } },
      { title: 'It (novel)', pageprops: { wikibase_item: 'Q602288' } },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────

describe('wikidataProvider', () => {
  it('has the stable provider name', () => {
    expect(wikidataProvider.name).toBe('wikidata');
  });

  it('resolves the QID via pageprops and maps P674/P840/P136, caching raw with its labels', async () => {
    const harness = makeFetch({
      pageprops: IT_PAGEPROPS,
      entities: { Q602288: itNovelEntity(), Q1063605: IT_DISAMBIGUATION_ENTITY },
      labels: LABELS,
    });

    const result = await wikidataProvider.lookup(makeBook(), harness.fetchImpl);

    expect(result).not.toBeNull();
    expect(result?.entities).toEqual([
      { entity: 'Beverly Marsh', kind: 'person' },
      { entity: 'Ben Hanscom', kind: 'person' },
      { entity: 'Pennywise', kind: 'person' },
      { entity: 'Derry', kind: 'place' },
    ]);
    expect(result?.subjects).toEqual(['horror fiction']);

    const raw = result?.raw as WikidataRaw;
    expect(raw.qid).toBe('Q602288');
    expect(raw.labels).toMatchObject({ Q3040001: 'Beverly Marsh', Q3040004: 'Derry' });
    // `rederive` reads it back with no network — so the labels must be cached.
    expect(raw.entity.claims?.P674).toHaveLength(3);
  });

  it('asks Wikipedia for the disambiguated page titles as well as the bare one, in one request', async () => {
    const harness = makeFetch({
      pageprops: IT_PAGEPROPS,
      entities: { Q602288: itNovelEntity(), Q1063605: IT_DISAMBIGUATION_ENTITY },
      labels: LABELS,
    });

    await wikidataProvider.lookup(makeBook(), harness.fetchImpl);

    const pageRequests = harness.urls.filter((u) => u.includes('en.wikipedia.org'));
    expect(pageRequests).toHaveLength(1);
    const titles = decodeURIComponent(new URL(pageRequests[0]).searchParams.get('titles') ?? '');
    expect(titles.split('|')).toEqual(['It (novel)', 'It (book)', 'It (novella)', 'It']);
  });

  it('sends the descriptive User-Agent Wikimedia requires on every request', async () => {
    const harness = makeFetch({
      pageprops: IT_PAGEPROPS,
      entities: { Q602288: itNovelEntity(), Q1063605: IT_DISAMBIGUATION_ENTITY },
      labels: LABELS,
    });

    await wikidataProvider.lookup(makeBook(), harness.fetchImpl);

    expect(harness.headers.length).toBeGreaterThan(1);
    for (const sent of harness.headers) {
      expect(String(sent['User-Agent'])).toContain('AudioShelf-Librarian');
    }
  });

  // ── Rejection: the half of the precision claim that matters ────────────────

  it('REJECTS an adaptation whose title AND author both match, on P31 alone', async () => {
    // The gate-isolating test for `isWorkKind`. Everything else about this item
    // checks out — right title, right author, a genuine cast list — so P31 is
    // the only thing that can reject it. Delete that check and this is the test
    // that fails.
    const harness = makeFetch({
      pageprops: { query: { pages: [{ title: 'It (radio drama)', pageprops: { wikibase_item: 'Q9000001' } }] } },
      entities: { Q9000001: IT_RADIO_DRAMA_ENTITY },
      labels: LABELS,
    });

    const result = await wikidataProvider.lookup(makeBook(), harness.fetchImpl);

    expect(result).toBeNull();
    // P31 is checked before the author labels are fetched, so a non-work costs
    // exactly one request. This assertion fails too if the gate is removed.
    expect(harness.urls.some((u) => u.includes('wbgetentities'))).toBe(false);
  });

  it('REJECTS the film of the same name rather than adopting its cast', async () => {
    // End-to-end rejection rather than a single-gate one: the film page carries
    // a real cast list and no author, so both gates would independently refuse
    // it. Kept because it is the shape the pageprops call actually returns.
    const harness = makeFetch({
      pageprops: { query: { pages: [{ title: 'It (2017 film)', pageprops: { wikibase_item: 'Q22000542' } }] } },
      entities: { Q22000542: IT_FILM_ENTITY },
      labels: LABELS,
    });

    expect(await wikidataProvider.lookup(makeBook(), harness.fetchImpl)).toBeNull();
  });

  it('REJECTS a Wikimedia disambiguation page item', async () => {
    const harness = makeFetch({
      pageprops: { query: { pages: [{ title: 'It', pageprops: { wikibase_item: 'Q1063605' } }] } },
      entities: { Q1063605: IT_DISAMBIGUATION_ENTITY },
      labels: LABELS,
    });

    expect(await wikidataProvider.lookup(makeBook(), harness.fetchImpl)).toBeNull();
  });

  it('REJECTS a real book whose author does not match the shelf copy', async () => {
    const otherAuthor = itNovelEntity({ claims: { P50: [itemClaim('Q3040006')] } });
    const harness = makeFetch({
      pageprops: IT_PAGEPROPS,
      entities: { Q602288: otherAuthor, Q1063605: IT_DISAMBIGUATION_ENTITY },
      labels: { ...LABELS, Q3040006: 'Peter Straub' },
    });

    expect(await wikidataProvider.lookup(makeBook(), harness.fetchImpl)).toBeNull();
  });

  it('REJECTS a real book by the right author whose title is a different work', async () => {
    const wrongTitle = itNovelEntity({
      labels: { en: { language: 'en', value: 'The Tommyknockers' } },
      sitelinks: { enwiki: { title: 'The Tommyknockers' } },
    });
    const harness = makeFetch({
      pageprops: IT_PAGEPROPS,
      entities: { Q602288: wrongTitle, Q1063605: IT_DISAMBIGUATION_ENTITY },
      labels: LABELS,
    });

    expect(await wikidataProvider.lookup(makeBook(), harness.fetchImpl)).toBeNull();
  });

  it('REJECTS a work item carrying no author at all when the book has one', async () => {
    const noAuthor = itNovelEntity({ claims: { P31: [itemClaim('Q7725634')] } });
    delete noAuthor.claims?.P50;
    const harness = makeFetch({
      pageprops: IT_PAGEPROPS,
      entities: { Q602288: noAuthor, Q1063605: IT_DISAMBIGUATION_ENTITY },
      labels: LABELS,
    });

    expect(await wikidataProvider.lookup(makeBook(), harness.fetchImpl)).toBeNull();
  });

  it('REJECTS a book with no author of its own, even on an exact title hit', async () => {
    // The one place this provider is deliberately stricter than the other
    // three. `matchesBook` would pass this on title alone; the pageprops trick
    // resolves a bare title far too confidently for that to be safe, and the
    // cast list it would hand back becomes a tag-authorising allowlist.
    const harness = makeFetch({
      pageprops: IT_PAGEPROPS,
      entities: { Q602288: itNovelEntity(), Q1063605: IT_DISAMBIGUATION_ENTITY },
      labels: LABELS,
    });

    const book = makeBook({ author: null });
    expect(await wikidataProvider.lookup(book, harness.fetchImpl)).toBeNull();
  });

  it('verifies against a P2093 author-name-string when the author has no Wikidata item', async () => {
    const stringAuthor = itNovelEntity({
      claims: { P31: [itemClaim('Q7725634')], P2093: [stringClaim('Stephen King')], P674: [itemClaim('Q3040001')] },
    });
    delete stringAuthor.claims?.P50;
    const harness = makeFetch({
      pageprops: IT_PAGEPROPS,
      entities: { Q602288: stringAuthor, Q1063605: IT_DISAMBIGUATION_ENTITY },
      labels: LABELS,
    });

    const result = await wikidataProvider.lookup(makeBook(), harness.fetchImpl);

    expect(result?.entities).toEqual([
      { entity: 'Beverly Marsh', kind: 'person' },
      { entity: 'Derry', kind: 'place' },
    ]);
  });

  // ── Extraction details ────────────────────────────────────────────────────

  it('skips a character with no English label rather than falling back to another language', async () => {
    const harness = makeFetch({
      pageprops: IT_PAGEPROPS,
      entities: { Q602288: itNovelEntity(), Q1063605: IT_DISAMBIGUATION_ENTITY },
      labels: { Q39829: 'Stephen King', Q3040001: 'Beverly Marsh', Q3040004: 'Derry', Q3040005: 'horror fiction' },
    });

    const result = await wikidataProvider.lookup(makeBook(), harness.fetchImpl);

    expect(result?.entities).toEqual([
      { entity: 'Beverly Marsh', kind: 'person' },
      { entity: 'Derry', kind: 'place' },
    ]);
  });

  it('skips deprecated-rank claims', async () => {
    const deprecated = itNovelEntity({
      claims: {
        P31: [itemClaim('Q7725634')],
        P50: [itemClaim('Q39829')],
        P674: [itemClaim('Q3040001'), itemClaim('Q3040003', 'deprecated')],
      },
    });
    const harness = makeFetch({
      pageprops: IT_PAGEPROPS,
      entities: { Q602288: deprecated, Q1063605: IT_DISAMBIGUATION_ENTITY },
      labels: LABELS,
    });

    const result = await wikidataProvider.lookup(makeBook(), harness.fetchImpl);

    // Pennywise is the deprecated one; Derry survives from the base fixture.
    expect(result?.entities).toEqual([
      { entity: 'Beverly Marsh', kind: 'person' },
      { entity: 'Derry', kind: 'place' },
    ]);
  });

  // ── not-found vs error (invariant 5) ──────────────────────────────────────

  it('returns null (a genuine miss) when Wikipedia has no page under any candidate form', async () => {
    const harness = makeFetch({
      pageprops: { query: { pages: [{ title: 'It (novel)', missing: true }, { title: 'It', missing: true }] } },
    });

    expect(await wikidataProvider.lookup(makeBook(), harness.fetchImpl)).toBeNull();
    expect(harness.urls).toHaveLength(1);
  });

  it('makes no request at all for a titleless book', async () => {
    const harness = makeFetch({ pageprops: IT_PAGEPROPS });

    expect(await wikidataProvider.lookup(makeBook({ title: '', titleParse: null }), harness.fetchImpl)).toBeNull();
    expect(harness.urls).toHaveLength(0);
  });

  it('throws (cached as error, not not-found) when the pageprops request fails', async () => {
    const harness = makeFetch({ pageprops: () => json(500, { message: 'boom' }) });

    await expect(wikidataProvider.lookup(makeBook(), harness.fetchImpl)).rejects.toThrow(/HTTP 500/);
  });

  it('throws when the action API reports an error inside a 200 body', async () => {
    const harness = makeFetch({ pageprops: () => json(200, { error: { code: 'maxlag', info: 'lagged' } }) });

    await expect(wikidataProvider.lookup(makeBook(), harness.fetchImpl)).rejects.toThrow(/maxlag/);
  });

  it('throws rather than claiming not-found when the only entity fetch fails', async () => {
    const harness = makeFetch({
      pageprops: { query: { pages: [{ title: 'It (novel)', pageprops: { wikibase_item: 'Q602288' } }] } },
      entities: { Q602288: () => json(503, { message: 'down' }) },
    });

    await expect(wikidataProvider.lookup(makeBook(), harness.fetchImpl)).rejects.toThrow(/throttling/);
  });

  it('throws when one candidate was never checked, even though another was checked and rejected', async () => {
    // Q602288 (the novel, ranked first) errors; Q1063605 is examined and is a
    // disambiguation page. Returning null here would cache "Wikidata has no
    // record" for a work we never actually looked at.
    const harness = makeFetch({
      pageprops: IT_PAGEPROPS,
      entities: { Q602288: () => json(500, { message: 'boom' }), Q1063605: IT_DISAMBIGUATION_ENTITY },
      labels: LABELS,
    });

    await expect(wikidataProvider.lookup(makeBook(), harness.fetchImpl)).rejects.toThrow(/HTTP 500/);
  });

  it('throws rather than caching an empty-but-ok payload when the label lookup fails after a match', async () => {
    // The work verified and we know it has a cast list; a status-'ok' row with
    // zero entities would pin "this book has no characters" for the 90-day TTL.
    let call = 0;
    const harness = makeFetch({
      pageprops: IT_PAGEPROPS,
      entities: { Q602288: itNovelEntity(), Q1063605: IT_DISAMBIGUATION_ENTITY },
      labelsResponder: () => {
        call += 1;
        // First call resolves the author (so verification succeeds); the second
        // — the characters/locations/genres — fails.
        if (call === 1) return json(200, { entities: { Q39829: { labels: { en: { value: 'Stephen King' } } } } });
        return json(500, { message: 'boom' });
      },
    });

    await expect(wikidataProvider.lookup(makeBook(), harness.fetchImpl)).rejects.toThrow(/HTTP 500/);
  });

  it('marks a 429 as rate-limited so the caller stops asking', async () => {
    const harness = makeFetch({
      pageprops: () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
    });

    const err = await wikidataProvider.lookup(makeBook(), harness.fetchImpl).catch((e: unknown) => e);
    expect(isRateLimited(err)).toBe(true);
  });

  it('marks a 403 as rate-limited and names the User-Agent as the likely cause', async () => {
    const harness = makeFetch({ pageprops: () => new Response('forbidden', { status: 403 }) });

    const err = await wikidataProvider.lookup(makeBook(), harness.fetchImpl).catch((e: unknown) => e);
    expect(isRateLimited(err)).toBe(true);
    expect(String((err as Error).message)).toMatch(/User-Agent/);
  });

  // ── rederive ──────────────────────────────────────────────────────────────

  it('re-derives entities and subjects from the cached raw with no network', async () => {
    const harness = makeFetch({
      pageprops: IT_PAGEPROPS,
      entities: { Q602288: itNovelEntity(), Q1063605: IT_DISAMBIGUATION_ENTITY },
      labels: LABELS,
    });
    const payload = await wikidataProvider.lookup(makeBook(), harness.fetchImpl);
    const before = harness.urls.length;

    const derived = wikidataProvider.rederive?.(payload?.raw);

    expect(derived?.entities).toEqual(payload?.entities);
    expect(derived?.subjects).toEqual(payload?.subjects);
    expect(harness.urls).toHaveLength(before);
  });

  it('re-derives null for a payload shape it does not recognise', () => {
    expect(wikidataProvider.rederive?.(null)).toBeNull();
    expect(wikidataProvider.rederive?.({ volumeInfo: { title: 'It' } })).toBeNull();
    expect(wikidataProvider.rederive?.({ qid: 'Q1', entity: {}, labels: {} })).toBeNull();
  });
});
