import { describe, expect, it, vi } from 'vitest';

import {
  buildMappingReport,
  comparableTokens,
  fandomSubdomain,
  parseWikiSearchResponse,
  proposeForSeries,
  scoreCandidate,
  seriesCounts,
  wikiSearchUrl,
} from './fandomMapping.js';

function respondWith(body: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('comparableTokens', () => {
  it('strips wiki furniture and a leading article so a wiki name can equal a series name', () => {
    expect(comparableTokens('Discworld Wiki')).toEqual(['discworld']);
    expect(comparableTokens('The Expanse Wiki')).toEqual(['expanse']);
    expect(comparableTokens('Deathlands Wikia')).toEqual(['deathlands']);
  });

  it('never strips the only token, so a wiki literally called "Wiki" keeps a name', () => {
    expect(comparableTokens('Wiki')).toEqual(['wiki']);
    expect(comparableTokens('The')).toEqual(['the']);
  });
});

describe('fandomSubdomain', () => {
  it('extracts the subdomain R4 would key on', () => {
    expect(fandomSubdomain('https://discworld.fandom.com')).toBe('discworld');
    expect(fandomSubdomain('https://the-expanse.fandom.com/wiki/Main_Page')).toBe('the-expanse');
  });

  it('returns null rather than guessing at a non-Fandom host', () => {
    expect(fandomSubdomain('https://discworld.example.com')).toBeNull();
    expect(fandomSubdomain('not a url')).toBeNull();
    expect(fandomSubdomain('https://fandom.com/wiki/X')).toBeNull();
  });
});

describe('scoreCandidate', () => {
  it('calls an identical name exact', () => {
    expect(scoreCandidate('Discworld', 'Discworld Wiki', 'https://discworld.fandom.com').confidence).toBe('exact');
    expect(scoreCandidate('The Expanse', 'The Expanse Wiki', 'https://expanse.fandom.com').confidence).toBe('exact');
  });

  it('calls it strong only when the subdomain independently corroborates', () => {
    expect(scoreCandidate('Deathlands', 'Deathlands Series Wiki', 'https://deathlands.fandom.com').confidence).toBe(
      'strong'
    );
    // Same name evidence, but the subdomain is someone else's wiki.
    expect(scoreCandidate('Deathlands', 'Deathlands Series Wiki', 'https://gunslinger.fandom.com').confidence).toBe(
      'weak'
    );
  });

  it('refuses to promote a plausible-looking near miss', () => {
    // This is the poisoned-allowlist case: a real wiki, obviously related,
    // and NOT the same series. A human has to make this call, not a heuristic.
    const scored = scoreCandidate('Dune', 'Dune Encyclopedia Wiki', 'https://dune-expanded.fandom.com');
    expect(scored.confidence).toBe('weak');
  });

  it('scores an unrelated wiki weak and says why', () => {
    const scored = scoreCandidate('Key West Capers', 'Star Wars Wiki', 'https://starwars.fandom.com');
    expect(scored.confidence).toBe('weak');
    expect(scored.reason).toMatch(/no shared words/);
  });
});

describe('parseWikiSearchResponse', () => {
  it('reads the documented {items:[...]} shape', () => {
    const parsed = parseWikiSearchResponse({
      items: [{ id: 1, name: 'Discworld Wiki', url: 'https://discworld.fandom.com', desc: 'A wiki about Discworld' }],
    });
    expect(parsed).toEqual([
      { name: 'Discworld Wiki', url: 'https://discworld.fandom.com', description: 'A wiki about Discworld' },
    ]);
  });

  it('tolerates a bare array and the title/description spellings', () => {
    const parsed = parseWikiSearchResponse([
      { title: 'Expanse Wiki', url: 'https://expanse.fandom.com', description: 'd' },
    ]);
    expect(parsed).toEqual([{ name: 'Expanse Wiki', url: 'https://expanse.fandom.com', description: 'd' }]);
  });

  it('returns nothing — never throws — on a shape it does not recognise', () => {
    // The response shape is unconfirmed against the live service, so a miss
    // has to read as "found nothing", not as a crash that stops the run.
    expect(parseWikiSearchResponse(null)).toEqual([]);
    expect(parseWikiSearchResponse('nonsense')).toEqual([]);
    expect(parseWikiSearchResponse({ items: 'nope' })).toEqual([]);
    expect(parseWikiSearchResponse({ items: [null, 42, {}, { name: 'no url' }] })).toEqual([]);
  });
});

describe('seriesCounts', () => {
  it('collapses books to distinct series, largest blast radius first', () => {
    expect(
      seriesCounts([
        { series: 'Discworld' },
        { series: 'Discworld' },
        { series: 'Discworld' },
        { series: 'The Expanse' },
        { series: 'The Expanse' },
      ])
    ).toEqual([
      { series: 'Discworld', books: 3 },
      { series: 'The Expanse', books: 2 },
    ]);
  });

  it('drops one-book series, which have none of R4 economics', () => {
    expect(seriesCounts([{ series: 'Standalone' }, { series: 'Pair' }, { series: 'Pair' }])).toEqual([
      { series: 'Pair', books: 2 },
    ]);
  });

  it('ignores books with no series', () => {
    expect(seriesCounts([{ series: null }, { series: '   ' }, {}])).toEqual([]);
  });
});

describe('proposeForSeries', () => {
  it('ranks best-first and never marks anything confirmed', async () => {
    const fetchImpl = respondWith({
      items: [
        { name: 'Unrelated Wiki', url: 'https://unrelated.fandom.com' },
        { name: 'Discworld Wiki', url: 'https://discworld.fandom.com', desc: 'about Discworld' },
      ],
    });
    const proposal = await proposeForSeries('Discworld', 12, { fetchImpl });

    expect(proposal.status).toBe('unconfirmed');
    expect(proposal.books).toBe(12);
    expect(proposal.candidates[0]).toMatchObject({
      name: 'Discworld Wiki',
      subdomain: 'discworld',
      confidence: 'exact',
    });
    expect(proposal.candidates[1].confidence).toBe('weak');
  });

  it('records a transport failure as an error, distinct from finding nothing', async () => {
    const proposal = await proposeForSeries('Anything', 3, { fetchImpl: respondWith({}, { ok: false, status: 500 }) });
    expect(proposal.error).toBe('HTTP 500');
    expect(proposal.candidates).toEqual([]);
  });

  it('rethrows a throttle so the caller can stop, rather than logging dozens of false "no wiki"', async () => {
    const proposal = proposeForSeries('Anything', 3, { fetchImpl: respondWith({}, { ok: false, status: 429 }) });
    await expect(proposal).rejects.toThrow(/rate-limited/);
  });

  it('has no default fetch — it cannot reach the network unless one is injected', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fandomMapping must never use the global fetch');
    });
    try {
      const proposal = await proposeForSeries('Discworld', 2, { fetchImpl: respondWith({ items: [] }) });
      expect(proposal.candidates).toEqual([]);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });

  it('sends the descriptive User-Agent and asks for the series verbatim', async () => {
    const fetchImpl = respondWith({ items: [] });
    await proposeForSeries('Key West Capers', 5, { fetchImpl });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe(wikiSearchUrl('Key West Capers', 5));
    expect(url).toContain('string=Key+West+Capers');
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/AudioShelf-Librarian/);
  });
});

describe('buildMappingReport', () => {
  it('counts each series by its BEST candidate, and separates errored from empty', () => {
    const report = buildMappingReport([
      { series: 'A', books: 3, status: 'unconfirmed', candidates: [{ name: 'A Wiki', url: 'https://a.fandom.com', subdomain: 'a', description: null, confidence: 'exact', reason: '' }] },
      { series: 'B', books: 2, status: 'unconfirmed', candidates: [{ name: 'B?', url: 'https://x.fandom.com', subdomain: 'x', description: null, confidence: 'weak', reason: '' }] },
      { series: 'C', books: 2, status: 'unconfirmed', candidates: [] },
      { series: 'D', books: 2, status: 'unconfirmed', candidates: [], error: 'HTTP 500' },
    ]);
    expect(report.generatedFor).toBe(4);
    expect(report.summary).toEqual({ exact: 1, strong: 0, weak: 1, none: 1, errored: 1 });
  });
});
