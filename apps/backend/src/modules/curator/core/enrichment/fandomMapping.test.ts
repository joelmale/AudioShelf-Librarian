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
  verifySuppliedSubdomain,
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
    // The joined form is the one that matters and it comes out right.
    expect(candidateSubdomains("Grandma's Capers!")).toContain('grandmascapers');
    expect(candidateSubdomains("Grandma's Capers!").every((g) => /^[a-z0-9-]+$/.test(g))).toBe(true);
  });

  it('tries the distinctive noun inside a longer title, which whole-name forms miss', () => {
    // All three verified live: pern/silo/prydain.fandom.com exist, and none of
    // them is derivable from the full series name.
    expect(candidateSubdomains('The Dragonriders of Pern')).toContain('pern');
    expect(candidateSubdomains('The Silo Saga')).toContain('silo');
    expect(candidateSubdomains('Chronicles of Prydain')).toContain('prydain');
  });

  it('does not waste a request on a stopword or a very short token', () => {
    const guesses = candidateSubdomains('The Chronicles of a Saga');
    expect(guesses).not.toContain('chronicles');
    expect(guesses).not.toContain('saga');
    expect(guesses).not.toContain('the');
  });

  it('reaches the distinctive token before the low-yield hyphen variants', () => {
    // Regression: hyphen variants used to occupy the whole request budget, so
    // "The Silo Saga" never probed `silo` - the wiki that actually exists.
    const guesses = candidateSubdomains('The Silo Saga');
    expect(guesses.indexOf('silo')).toBeLessThan(guesses.indexOf('silo-saga'));
    expect(guesses.slice(0, 4)).toContain('silo');
  });

  it('does not re-try the whole name as a single token', () => {
    // "Discworld" is one token; there is no second strategy to run.
    expect(candidateSubdomains('Discworld')).toEqual(['discworld']);
  });
});

describe('parseSiteinfo', () => {
  it('reads the sitename from a real siteinfo body', () => {
    // Shape confirmed live against discworld.fandom.com.
    expect(parseSiteinfo({ query: { general: { sitename: 'Discworld Wiki' } } })).toEqual({
      sitename: 'Discworld Wiki',
      server: null,
    });
    // `server` is the wiki's canonical host, which is what collapses aliases.
    expect(
      parseSiteinfo({ query: { general: { sitename: 'Red Rising Wiki', server: 'https://red-rising.fandom.com' } } })
    ).toEqual({ sitename: 'Red Rising Wiki', server: 'https://red-rising.fandom.com' });
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

  it('collapses alias subdomains onto one row, keyed on the canonical server', async () => {
    // Live behaviour: redrising.fandom.com and red-rising.fandom.com are one
    // wiki. Listing both makes a reviewer read the same row twice.
    const fetchImpl = vi.fn(async (url: string) => {
      const sub = /^https:\/\/([a-z0-9-]+)\.fandom\.com/.exec(String(url))?.[1] ?? '';
      if (sub !== 'redrising' && sub !== 'red-rising') return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          query: { general: { sitename: 'Red Rising Wiki', server: 'https://red-rising.fandom.com' } },
        }),
      };
    }) as unknown as typeof fetch;

    const proposal = await proposeForSeries('Red Rising', 4, { fetchImpl });
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0].subdomain).toBe('red-rising');
  });

  it('keeps two DIFFERENT wikis that happen to share a name', async () => {
    // empyrean and the-empyrean are both real and both called "Empyrean Wiki".
    // Deduping on the name would silently drop one the reviewer must choose.
    const fetchImpl = vi.fn(async (url: string) => {
      const sub = /^https:\/\/([a-z0-9-]+)\.fandom\.com/.exec(String(url))?.[1] ?? '';
      if (sub !== 'empyrean' && sub !== 'the-empyrean') return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          query: { general: { sitename: 'Empyrean Wiki', server: `https://${sub}.fandom.com` } },
        }),
      };
    }) as unknown as typeof fetch;

    const proposal = await proposeForSeries('The Empyrean', 2, { fetchImpl });
    expect(proposal.candidates.map((c) => c.subdomain).sort()).toEqual(['empyrean', 'the-empyrean']);
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

describe('verifySuppliedSubdomain', () => {
  it('accepts a wiki the generator could never derive, and reports its real name', async () => {
    // Real case: "Sookie Stackhouse Southern Vampire Mysteries" lives at
    // sookiestackhouse.fandom.com, whose own name is "Southern Vampire
    // Mysteries". No name-derivation can reach it; only a human can.
    const fetchImpl = wikiHost({ sookiestackhouse: 'Southern Vampire Mysteries' });
    const { candidate, error } = await verifySuppliedSubdomain(
      'Sookie Stackhouse Southern Vampire Mysteries',
      'sookiestackhouse',
      { fetchImpl }
    );
    expect(error).toBeUndefined();
    expect(candidate).toMatchObject({
      subdomain: 'sookiestackhouse',
      name: 'Southern Vampire Mysteries',
      reason: 'supplied by hand and verified live',
    });
    // Scored honestly: the names genuinely disagree, override or not.
    expect(candidate?.confidence).toBe('weak');
  });

  it('catches a typo instead of trusting the cell', async () => {
    const { candidate, error } = await verifySuppliedSubdomain('Discworld', 'typo-not-real', {
      fetchImpl: wikiHost({}),
    });
    expect(candidate).toBeNull();
    expect(error).toMatch(/does not exist/);
  });

  it('follows a redirect to the canonical host and says so', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        query: { general: { sitename: 'Red Rising Wiki', server: 'https://red-rising.fandom.com' } },
      }),
    })) as unknown as typeof fetch;
    const { candidate } = await verifySuppliedSubdomain('Red Rising', 'redrising', { fetchImpl });
    expect(candidate?.subdomain).toBe('red-rising');
    expect(candidate?.description).toMatch(/you entered redrising/);
  });
});
