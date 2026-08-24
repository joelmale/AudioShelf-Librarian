import { describe, expect, it } from 'vitest';

import {
  DESCRIPTION_MATCH_SCORE,
  FREQUENCY_MIN_BOOKS,
  FREQUENCY_RATIO,
  MAX_NOTABLE,
  SMALL_LIST,
  scoreNotability,
  type NotabilityInput,
} from './entityNotability.js';

function entity(name: string, sources: string[] = ['openlibrary']) {
  return { entity: name, kind: 'person' as const, sources };
}

const LIBRARY_SIZE = 958; // the user's real library, per the plan doc

describe('scoreNotability', () => {
  it('a small list (<= SMALL_LIST) keeps every entity notable, regardless of score', () => {
    const input: NotabilityInput = {
      entities: [entity('Elena Ward'), entity('Marguerite'), entity('A Stranger')],
      description: null,
      libraryFrequency: new Map(),
      librarySize: LIBRARY_SIZE,
    };

    const out = scoreNotability(input);
    expect(out).toHaveLength(3);
    expect(out.every((e) => e.notable)).toBe(true);
  });

  it('exactly SMALL_LIST entities are all kept; SMALL_LIST + 1 triggers scoring', () => {
    const makeEntities = (n: number) => Array.from({ length: n }, (_, i) => entity(`Person ${i}`));

    const atBoundary = scoreNotability({
      entities: makeEntities(SMALL_LIST),
      description: null,
      libraryFrequency: new Map(),
      librarySize: LIBRARY_SIZE,
    });
    expect(atBoundary.every((e) => e.notable)).toBe(true);

    const overBoundary = scoreNotability({
      entities: makeEntities(SMALL_LIST + 1),
      description: null,
      libraryFrequency: new Map(),
      librarySize: LIBRARY_SIZE,
    });
    // None of these score >= 2 (no description hit, single-token, one source,
    // not over-frequent), so once scoring kicks in, none qualify.
    expect(overBoundary.every((e) => !e.notable)).toBe(true);
  });

  it('a 697-entity book (the "It" case) keeps at most MAX_NOTABLE notable entities', () => {
    const entities = Array.from({ length: 697 }, (_, i) => entity(`Person ${i}`, ['openlibrary', 'wikidata']));
    // Corroboration alone (+1) isn't enough to clear the threshold (2), so
    // give every entity a description hit too, putting all 697 in contention
    // for the cap.
    const description = entities.map((e) => e.entity).join(', ');

    const out = scoreNotability({
      entities,
      description,
      libraryFrequency: new Map(),
      librarySize: LIBRARY_SIZE,
    });

    expect(out).toHaveLength(697);
    expect(out.filter((e) => e.notable)).toHaveLength(MAX_NOTABLE);
  });

  it('"God" appearing on 40 books scores below "Benjamin Hanscom" appearing on 1', () => {
    // Both are described and multi-token isn't in play for "God"; give
    // Hanscom the multi-token + corroboration bumps he'd realistically have,
    // and let the frequency penalty be the deciding factor for "God".
    const libraryFrequency = new Map([
      ['god', 40],
      ['benjamin hanscom', 1],
    ]);

    const entities = [
      { entity: 'God', kind: 'person' as const, sources: ['openlibrary'] },
      { entity: 'Benjamin Hanscom', kind: 'person' as const, sources: ['openlibrary', 'wikidata'] },
    ];
    // Force scoring (not the small-list wholesale path) by padding the list.
    const padding = Array.from({ length: SMALL_LIST }, (_, i) => entity(`Filler ${i}`));

    const out = scoreNotability({
      entities: [...entities, ...padding],
      description: 'Benjamin Hanscom and God are both mentioned here.',
      libraryFrequency,
      librarySize: LIBRARY_SIZE,
    });

    const god = out.find((e) => e.entity === 'God')!;
    const hanscom = out.find((e) => e.entity === 'Benjamin Hanscom')!;
    expect(hanscom.score).toBeGreaterThan(god.score);
    expect(god.notable).toBe(false);
    expect(hanscom.notable).toBe(true);
  });

  it('the frequency threshold scales with library size: max(librarySize * FREQUENCY_RATIO, FREQUENCY_MIN_BOOKS)', () => {
    // With a tiny library, FREQUENCY_MIN_BOOKS (5) is the binding floor —
    // 6 books is already "over the threshold, penalize".
    const librarySize = 100; // 100 * 0.01 = 1, so the floor of 5 wins
    expect(Math.max(librarySize * FREQUENCY_RATIO, FREQUENCY_MIN_BOOKS)).toBe(FREQUENCY_MIN_BOOKS);

    const padding = Array.from({ length: SMALL_LIST }, (_, i) => entity(`Filler ${i}`));
    const out = scoreNotability({
      // Single-token on purpose: isolates the frequency penalty from the
      // multi-token bonus, which "Common Name" would also pick up.
      entities: [{ entity: 'Common', kind: 'person', sources: ['openlibrary', 'wikidata'] }, ...padding],
      description: 'Common shows up right here.',
      libraryFrequency: new Map([['common', 6]]), // over the floor of 5
      librarySize,
    });

    const commonName = out.find((e) => e.entity === 'Common')!;
    // Description (+2) + corroboration (+1) - frequency penalty (-2) = 1, below threshold.
    expect(commonName.score).toBe(1);
    expect(commonName.notable).toBe(false);
  });

  it('a mononym present in the description still qualifies (no multi-token bonus needed)', () => {
    const padding = Array.from({ length: SMALL_LIST }, (_, i) => entity(`Filler ${i}`));
    const out = scoreNotability({
      entities: [entity('Pennywise'), ...padding],
      description: 'Pennywise haunts the sewers of Derry.',
      libraryFrequency: new Map(),
      librarySize: LIBRARY_SIZE,
    });

    const pennywise = out.find((e) => e.entity === 'Pennywise')!;
    expect(pennywise.score).toBe(DESCRIPTION_MATCH_SCORE);
    expect(pennywise.notable).toBe(true);
  });

  it('a mononym absent from the description and uncorroborated never gets the multi-token bonus, and stays unscored (not penalized) for being one word', () => {
    const padding = Array.from({ length: SMALL_LIST }, (_, i) => entity(`Filler ${i}`));
    const out = scoreNotability({
      entities: [entity('Murderbot'), ...padding],
      description: null,
      libraryFrequency: new Map(),
      librarySize: LIBRARY_SIZE,
    });

    const murderbot = out.find((e) => e.entity === 'Murderbot')!;
    expect(murderbot.score).toBe(0);
    expect(murderbot.notable).toBe(false);
  });

  it('deterministic ordering under shuffled input: the same set of entities always yields the same notable subset', () => {
    const entities = Array.from({ length: 30 }, (_, i) => entity(`Person ${String(i).padStart(2, '0')}`));
    const description = entities.map((e) => e.entity).join(', '); // every entity qualifies (+2 each)

    const forward = scoreNotability({ entities, description, libraryFrequency: new Map(), librarySize: LIBRARY_SIZE });

    const shuffled = [...entities].reverse();
    const backward = scoreNotability({
      entities: shuffled,
      description,
      libraryFrequency: new Map(),
      librarySize: LIBRARY_SIZE,
    });

    const notableNamesForward = forward.filter((e) => e.notable).map((e) => e.entity).sort();
    const notableNamesBackward = backward.filter((e) => e.notable).map((e) => e.entity).sort();
    expect(notableNamesBackward).toEqual(notableNamesForward);
    expect(notableNamesForward).toHaveLength(MAX_NOTABLE);
  });

  it('ties break on plain codepoint order of the entity string, not input order', () => {
    // All entities score identically (+2 from description, no other signals),
    // so the cap must fall back to codepoint order to pick exactly MAX_NOTABLE.
    const entities = ['Zeta', 'Alpha', 'Mu', 'Beta', ...Array.from({ length: SMALL_LIST }, (_, i) => `Extra ${i}`)].map(
      (name) => entity(name)
    );
    const description = entities.map((e) => e.entity).join(', ');

    const out = scoreNotability({ entities, description, libraryFrequency: new Map(), librarySize: LIBRARY_SIZE });
    const notable = out.filter((e) => e.notable).map((e) => e.entity);
    // Codepoint-sorted, so 'Alpha' < 'Beta' < 'Extra 0' < ... < 'Mu' < 'Zeta';
    // with MAX_NOTABLE=20 and 20 total candidates here, all qualify — assert
    // the sort key directly instead by shrinking the candidate pool below.
    expect(notable).toHaveLength(Math.min(entities.length, MAX_NOTABLE));
  });

  it('a smaller tie set demonstrates the codepoint tiebreak picks the lexicographically-first names under the cap', () => {
    // 25 equally-scored entities (over SMALL_LIST, all +2 from description),
    // more than MAX_NOTABLE=20, so the cap must pick 20 by codepoint order.
    const names = Array.from({ length: 25 }, (_, i) => `Name${String(i).padStart(2, '0')}`);
    const entities = names.map((name) => entity(name));
    const description = names.join(', ');

    const out = scoreNotability({ entities, description, libraryFrequency: new Map(), librarySize: LIBRARY_SIZE });
    const notable = out.filter((e) => e.notable).map((e) => e.entity).sort();
    const expected = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_NOTABLE);
    expect(notable).toEqual(expected);
  });

  it('empty input returns an empty array', () => {
    const out = scoreNotability({ entities: [], description: null, libraryFrequency: new Map(), librarySize: LIBRARY_SIZE });
    expect(out).toEqual([]);
  });

  it('a multi-token name gets the bonus; a single-token name does not', () => {
    const padding = Array.from({ length: SMALL_LIST }, (_, i) => entity(`Filler ${i}`));
    const out = scoreNotability({
      entities: [entity('Multi Word Name', ['a', 'b']), entity('Single', ['a', 'b']), ...padding],
      description: null,
      libraryFrequency: new Map(),
      librarySize: LIBRARY_SIZE,
    });

    const multi = out.find((e) => e.entity === 'Multi Word Name')!;
    const single = out.find((e) => e.entity === 'Single')!;
    // multi-token (+1) + corroboration (+1) = 2, notable.
    expect(multi.score).toBe(2);
    expect(multi.notable).toBe(true);
    // corroboration only (+1) = 1, not notable.
    expect(single.score).toBe(1);
    expect(single.notable).toBe(false);
  });
});
