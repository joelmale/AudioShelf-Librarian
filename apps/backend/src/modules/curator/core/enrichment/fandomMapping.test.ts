import { describe, expect, it, vi } from 'vitest';

import {
  buildMappingReport,
  comparableTokens,
  fandomSubdomain,
  candidateSubdomains,
  parseSiteinfo,
  proposeForSeries,
  scoreCandidate,
  seriesCounts,
  siteinfoUrl,
} from './fandomMapping.js';

/** Answer per subdomain, the way the live API does: a wiki that exists returns
 *  its own sitename, everything else 404s. */
function wikiHost(hosts: Record<string, string>, fallbackStatus = 404): typeof fetch {
  return vi.fn(async (url: string) => {
    const subdomain = /^https:\/\/([a-z0-9-]+)\.fandom\.com/.exec(String(url))?.[1] ?? '';
    const sitename = hosts[subdomain];
    if (!sitename) return { ok: false, status: fallbackStatus, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ query: { general: { sitename } } }) };
  }) as unknown as typeof fetch;
}

function alwaysStatus(status: number): typeof fetch {
  return vi.fn(async () => ({ ok: false, status, json: async () => ({}) })) as unknown as typeof fetch;
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

describe('candidateSubdomains', () => {
  it('tries the article-stripped form first, because that is how Fandom names them', () => {
    // Verified live: expanse.fandom.com exists, theexpanse.fandom.com 404s.
    expect(candidateSubdomains('The Expanse')).toEqual(['expanse', 'theexpanse', 'the-expanse']);
  });

  it('produces one form for a single-word series', () => {
    expect(candidateSubdomains('Discworld')).toEqual(['discworld']);
  });

  it('strips characters a subdomain cannot contain', () => {
    // An apostrophe tokenizes as a break, so "Grandma's" yields grandma + s.
    // The joined form is the one that matters and it comes out right; the
    // hyphenated variant is a cheap second guess, not a claim about Fandom.
    expect(candidateSubdomains("Grandma's Capers!")).toEqual(['grandmascapers', 'grandma-s-capers']);
  });
});

describe('parseSiteinfo', () => {
  it('reads the sitename from a real siteinfo body', () => {
    // Shape confirmed live against discworld.fandom.com.
    expect(parseSiteinfo({ query: { general: { sitename: 'Discworld Wiki' } } })).toEqual({
      sitename: 'Discworld Wiki',
    });
  });

  it('returns null - never throws - for anything else', () => {
    // A parked subdomain can answer 200 with something unrelated.
    expect(parseSiteinfo(null)).toBeNull();
    expect(parseSiteinfo('nonsense')).toBeNull();
    expect(parseSiteinfo({ query: {} })).toBeNull();
    expect(parseSiteinfo({ query: { general: { sitename: '   ' } } })).toBeNull();
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
  it('finds the real wiki by probing, and never marks anything confirmed', async () => {
    const fetchImpl = wikiHost({ discworld: 'Discworld Wiki' });
    const proposal = await proposeForSeries('Discworld', 12, { fetchImpl });

    expect(proposal.status).toBe('unconfirmed');
    expect(proposal.books).toBe(12);
    expect(proposal.candidates).toEqual([
      {
        name: 'Discworld Wiki',
        url: 'https://discworld.fandom.com',
        subdomain: 'discworld',
        description: null,
        confidence: 'exact',
        reason: 'wiki name matches the series exactly ("discworld")',
      },
    ]);
  });

  it('skips the 404 guess and keeps the one that answers', async () => {
    // The live case: "The Expanse" is at expanse.fandom.com, not theexpanse.
    const fetchImpl = wikiHost({ expanse: 'The Expanse Wiki' });
    const proposal = await proposeForSeries('The Expanse', 9, { fetchImpl });
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]).toMatchObject({ subdomain: 'expanse', confidence: 'exact' });
    expect(proposal.error).toBeUndefined();
  });

  it('treats every guess 404ing as "no candidates", not as an error', async () => {
    const proposal = await proposeForSeries('Nonexistent Series', 4, { fetchImpl: wikiHost({}) });
    expect(proposal.candidates).toEqual([]);
    expect(proposal.error).toBeUndefined();
  });

  it('reports a transport failure only when nothing was found', async () => {
    const proposal = await proposeForSeries('Anything', 3, { fetchImpl: alwaysStatus(500) });
    expect(proposal.error).toBe('HTTP 500');
    expect(proposal.candidates).toEqual([]);
  });

  it('rethrows a throttle so the caller can stop, rather than logging false "no wiki"', async () => {
    await expect(proposeForSeries('Anything', 3, { fetchImpl: alwaysStatus(429) })).rejects.toThrow(/rate-limited/);
  });

  it('has no default fetch - it cannot reach the network unless one is injected', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fandomMapping must never use the global fetch');
    });
    try {
      const proposal = await proposeForSeries('Discworld', 2, { fetchImpl: wikiHost({}) });
      expect(proposal.candidates).toEqual([]);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });

  it('sends the descriptive User-Agent to the documented siteinfo endpoint', async () => {
    const fetchImpl = wikiHost({ discworld: 'Discworld Wiki' });
    await proposeForSeries('Discworld', 2, { fetchImpl });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe(siteinfoUrl('discworld'));
    expect(url).toContain('meta=siteinfo');
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/AudioShelf-Librarian/);
  });

  it('caps the number of guesses, so a many-word series cannot fan out', async () => {
    const fetchImpl = wikiHost({});
    await proposeForSeries('The Long Dark Tea Time Of The Soul', 2, { fetchImpl, limit: 2 });
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
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
