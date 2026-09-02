import { describe, expect, it } from 'vitest';

import { extractSubjects } from './providers/googleBooks.js';
import {
  deriveSubjectCandidates,
  facetsForProvider,
  isMachineTag,
  normalizeSubjectCandidate,
  splitHeading,
  surfaceFacetTerms,
} from './subjectFacets.js';

describe('splitHeading / isMachineTag (moved verbatim from googleBooks.ts)', () => {
  it('splits slash-delimited BISAC paths', () => {
    expect(splitHeading('Fiction / Mystery & Detective / Cozy')).toEqual([
      'Fiction ',
      ' Mystery & Detective ',
      ' Cozy',
    ]);
  });

  it('splits comma-delimited headings only when there is no "&"', () => {
    expect(splitHeading('Fiction, science fiction, general')).toEqual(['Fiction', ' science fiction', ' general']);
    expect(splitHeading('Boats, Ships & Underwater Craft')).toEqual(['Boats, Ships & Underwater Craft']);
  });

  it('flags a machine tag by carrying both ":" and "="', () => {
    expect(isMachineTag('nyt:trade_fiction_paperback=2011-12-31')).toBe(true);
    expect(isMachineTag('Fiction: Horror')).toBe(false);
  });

  it('extractSubjects (googleBooks.ts) is unaffected by the move: applying splitHeading to its own output is a no-op (idempotence)', () => {
    const categories = [
      'Fiction / Mystery & Detective / Amateur Sleuth',
      'Fiction / Mystery & Detective / Cozy / General',
      'Fiction / Mystery & Detective / Women Sleuths',
    ];
    const out = extractSubjects(categories);
    expect(out).toEqual(['Fiction', 'Mystery & Detective', 'Amateur Sleuth', 'Cozy', 'Women Sleuths']);
    // Re-splitting Google Books' already-split output changes nothing.
    expect(out.flatMap((segment) => splitHeading(segment).map((s) => s.trim()))).toEqual(out);
  });
});

describe('surfaceFacetTerms (RULE 6: split, trim, drop machine tags and "general", dedupe — UNCAPPED)', () => {
  it('drops "general" as its own segment, case-insensitively, before the stoplist ever runs', () => {
    expect(surfaceFacetTerms(['Fiction / Mystery & Detective / Cozy / General'])).toEqual([
      'Fiction',
      'Mystery & Detective',
      'Cozy',
    ]);
  });

  it('dedupes case-insensitively, first-seen order', () => {
    expect(surfaceFacetTerms(['Cozy', 'cozy', 'COZY'])).toEqual(['Cozy']);
  });

  it('does NOT cap at 12 — that belongs downstream of the stoplist, not here (see deriveSubjectCandidates)', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Term${i}`);
    expect(surfaceFacetTerms(many)).toHaveLength(40);
  });

  it('drops machine tags', () => {
    expect(surfaceFacetTerms(['nyt:trade_fiction_paperback=2011-12-31', 'Fiction: Horror'])).toEqual([
      'Fiction: Horror',
    ]);
  });

  it('ignores non-string entries defensively', () => {
    expect(surfaceFacetTerms([42, null, undefined, 'Cozy'] as unknown as string[])).toEqual(['Cozy']);
  });
});

describe('normalizeSubjectCandidate (RULE 7: normalize + stoplist)', () => {
  it('drops the exact stoplisted forms at any frequency', () => {
    expect(normalizeSubjectCandidate('Fiction')).toBeNull();
    expect(normalizeSubjectCandidate('General')).toBeNull();
    expect(normalizeSubjectCandidate('Audiobook')).toBeNull();
  });

  it('drops a form carrying a stoplisted TOKEN even when the exact form is not stoplisted', () => {
    // The comma-blob `&`-guard leaves this whole; normalizeTagForm hyphenates
    // it to `fiction-mystery-detective-general`, and the `general` token catches it.
    expect(normalizeSubjectCandidate('Fiction, mystery & detective, general')).toBeNull();
  });

  it('keeps a legitimate compound term untouched by the stoplist', () => {
    expect(normalizeSubjectCandidate('Mystery & Detective')).toBe('mystery-detective');
    expect(normalizeSubjectCandidate('Boats, Ships & Underwater Craft')).toBe('boats-ships-underwater-craft');
  });

  it('returns null for a segment that normalizes to empty', () => {
    expect(normalizeSubjectCandidate('   ---   ')).toBeNull();
  });
});

describe('deriveSubjectCandidates (the full per-row pipeline)', () => {
  it('the openlibrary BISAC-style heading fixture: Fiction and General both drop, the rest survives', () => {
    expect(deriveSubjectCandidates(['Fiction / Mystery & Detective / Cozy / General'])).toEqual([
      'mystery-detective',
      'cozy',
    ]);
  });

  it('a comma-blob with no "&" splits and drops Fiction/general, keeping the real subject', () => {
    expect(deriveSubjectCandidates(['Fiction, science fiction, general'])).toEqual(['science-fiction']);
  });

  it('a comma-blob WITH "&" stays whole and is stoplisted wholesale on the "general" token', () => {
    expect(deriveSubjectCandidates(['Fiction, mystery & detective, general'])).toEqual([]);
  });

  it('caps at 12 surviving terms, AFTER the stoplist — a term about to be dropped never burns a slot', () => {
    // 12 genuine, surviving terms interleaved with 5 stoplisted ones
    // ('Fiction' / 'general') ahead of a 13th genuine term. Capping before
    // the stoplist ran would leave exactly 12 survivors anyway by coincidence
    // of order here, so the fixture also puts a stoplisted entry BEFORE the
    // 12th genuine one, at index 6 — if the cap ran first (on the raw
    // 18-entry list), 'Term11' would be pushed out by the stoplisted entries
    // still occupying slots; it must survive.
    const raw = [
      'Term0', 'Term1', 'Term2', 'Term3', 'Term4', 'Term5',
      'Fiction',
      'Term6', 'Term7', 'Term8', 'Term9', 'Term10', 'Term11',
      'general', 'general', 'general', 'general',
      'Term12',
    ];
    const result = deriveSubjectCandidates(raw);
    expect(result).toHaveLength(12);
    expect(result).toEqual([
      'term0', 'term1', 'term2', 'term3', 'term4', 'term5',
      'term6', 'term7', 'term8', 'term9', 'term10', 'term11',
    ]);
    expect(result).not.toContain('term12');
  });
});

describe('SUBJECT_FACETS / facetsForProvider (the routing table)', () => {
  it('routes each known provider to its documented category', () => {
    const byProvider = Object.fromEntries(
      ['googlebooks', 'audnexus', 'wikidata', 'openlibrary'].map((p) => [p, facetsForProvider(p).map((f) => f.category)])
    );
    expect(byProvider).toEqual({
      googlebooks: ['genre'],
      audnexus: ['genre'],
      wikidata: ['genre'],
      openlibrary: ['theme'],
    });
  });

  it('routes hardcover to two facets — genre AND mood — reading `raw`, not `subjects`', () => {
    const entries = facetsForProvider('hardcover');
    expect(entries.map((f) => f.category).sort()).toEqual(['genre', 'mood']);

    const payload = {
      subjects: ['Totally Bogus'],
      raw: { data: { search: { results: { hits: [{ document: { genres: ['Science Fiction'], moods: ['adventurous'], tags: ['Cozy Vibes'] } }] } } } },
    };
    const byCategory = Object.fromEntries(entries.map((f) => [f.category, f.extract(payload)]));
    expect(byCategory.genre).toEqual(['Science Fiction']);
    expect(byCategory.mood).toEqual(['adventurous']);
    // Never falls back to the flattened `subjects` array.
    expect(byCategory.genre).not.toContain('Totally Bogus');
    expect(byCategory.mood).not.toContain('Totally Bogus');
  });

  it('hardcover: recovers genre/mood from the VERIFIED hit, not `hits[0]`', () => {
    // hits[0] is an unrelated book search results routinely carry alongside
    // the real match; `lookup()` only trusts whichever hit `matchesBook`
    // picked, recorded here at hits[1] and reflected in `subjects` (exactly
    // what `payloadFor`/`subjectsFrom` would have stored for that hit).
    const payload = {
      subjects: ['Horror', 'dark'],
      raw: {
        data: {
          search: {
            results: {
              hits: [
                { document: { title: 'A Totally Different Book', genres: ['Comedy'], moods: ['funny'] } },
                { document: { title: 'Book 0', genres: ['Horror'], moods: ['dark'] } },
              ],
            },
          },
        },
      },
    };
    const entries = facetsForProvider('hardcover');
    const byCategory = Object.fromEntries(entries.map((f) => [f.category, f.extract(payload)]));
    expect(byCategory.genre).toEqual(['Horror']);
    expect(byCategory.mood).toEqual(['dark']);
    expect(byCategory.genre).not.toContain('Comedy');
    expect(byCategory.mood).not.toContain('funny');
  });

  it('hardcover: contributes nothing when no hit\'s facets match the verified `subjects`', () => {
    // A `raw` shape that predates this check, or any other case where the
    // verified hit cannot be recovered — silence, never a guess.
    const payload = {
      subjects: ['Horror', 'dark'],
      raw: {
        data: {
          search: {
            results: {
              hits: [
                { document: { title: 'A', genres: ['Comedy'], moods: ['funny'] } },
                { document: { title: 'B', genres: ['Romance'], moods: ['sweet'] } },
              ],
            },
          },
        },
      },
    };
    const entries = facetsForProvider('hardcover');
    const contributed = entries.flatMap((f) => f.extract(payload));
    expect(contributed).toEqual([]);
  });

  it('hardcover: contributes nothing when more than one hit ties on the verified `subjects`', () => {
    const payload = {
      subjects: ['Horror', 'dark'],
      raw: {
        data: {
          search: {
            results: {
              hits: [
                { document: { title: 'A', genres: ['Horror'], moods: ['dark'] } },
                { document: { title: 'B', genres: ['Horror'], moods: ['dark'] } },
              ],
            },
          },
        },
      },
    };
    const entries = facetsForProvider('hardcover');
    const contributed = entries.flatMap((f) => f.extract(payload));
    expect(contributed).toEqual([]);
  });

  it('returns [] for an unknown provider — fail closed, never guess a category', () => {
    expect(facetsForProvider('fandom')).toEqual([]);
  });

  it('has no entry for hardcover "tags" — the uncontrolled community bucket contributes nothing', () => {
    const payload = {
      raw: { data: { search: { results: { hits: [{ document: { genres: [], moods: [], tags: ['Cozy Vibes'] } }] } } } },
    };
    const contributed = facetsForProvider('hardcover').flatMap((f) => f.extract(payload));
    expect(contributed).toEqual([]);
  });
});
