import { describe, expect, it } from 'vitest';

import { matchEntity, normalizeTokens } from './entityMatcher.js';
import type { EnrichedEntity } from './types.js';

// Real Open Library-derived allowlist for Stephen King's IT.
const IT_ALLOWLIST: EnrichedEntity[] = [
  { entity: 'Benjamin Hanscom', kind: 'person' },
  { entity: 'Beverly Marsh', kind: 'person' },
  { entity: 'William Denbrough', kind: 'person' },
  { entity: 'Richard Tozier', kind: 'person' },
  { entity: 'Eddie Kaspbrak', kind: 'person' },
  { entity: 'Stanley Uris', kind: 'person' },
  { entity: 'Michael Hanlon', kind: 'person' },
  { entity: 'Adrian Mellon', kind: 'person' },
  { entity: 'Dorsey Corcoran', kind: 'person' },
  { entity: 'Henry Bowers', kind: 'person' },
  { entity: 'Pennywise', kind: 'person' },
  { entity: 'Benny Beaulieu', kind: 'person' },
  { entity: 'Derry', kind: 'place' },
  { entity: 'Maine', kind: 'place' },
  { entity: '1958', kind: 'time' },
];

describe('normalizeTokens', () => {
  it('splits camel/pascal case on lower->upper boundaries before lowercasing', () => {
    expect(normalizeTokens('BenHannigan')).toEqual(['ben', 'hannigan']);
  });

  it('lowercases and collapses punctuation runs to a single separator', () => {
    expect(normalizeTokens('beverly-marsh')).toEqual(['beverly', 'marsh']);
  });

  it('trims and drops empty tokens from leading/trailing separators', () => {
    expect(normalizeTokens('  Pennywise!! ')).toEqual(['pennywise']);
  });

  it('returns an empty array for a string with no alphanumeric content', () => {
    expect(normalizeTokens('---')).toEqual([]);
  });
});

describe('matchEntity', () => {
  it('repairs "Ben Hannigan" to the unique canonical "Benjamin Hanscom"', () => {
    const result = matchEntity('Ben Hannigan', IT_ALLOWLIST);
    expect(result).toEqual({ entity: 'Benjamin Hanscom', kind: 'person', exact: false });
  });

  it('repairs the camel-cased llama output "BenHannigan" the same way', () => {
    const result = matchEntity('BenHannigan', IT_ALLOWLIST);
    expect(result).toEqual({ entity: 'Benjamin Hanscom', kind: 'person', exact: false });
  });

  it('does not also match "Benny Beaulieu" for "Ben Hannigan" (no surname prefix overlap)', () => {
    // Sanity check the uniqueness claim directly: only one entry in the
    // allowlist should pass the repair rules for this candidate.
    const first = normalizeTokens('Ben Hannigan')[0];
    const last = normalizeTokens('Ben Hannigan')[normalizeTokens('Ben Hannigan').length - 1];
    expect(first).toBe('ben');
    expect(last).toBe('hannigan');
    // 'beaulieu' shares no 3-char prefix with 'hannigan', so Benny Beaulieu
    // is excluded even though 'ben' prefix-matches 'benny'.
    const result = matchEntity('Ben Hannigan', IT_ALLOWLIST);
    expect(result?.entity).toBe('Benjamin Hanscom');
  });

  it('returns null for "Adrian Dover" (surname and first-token both fail)', () => {
    expect(matchEntity('Adrian Dover', IT_ALLOWLIST)).toBeNull();
  });

  it('matches "Pennywise" exactly', () => {
    expect(matchEntity('Pennywise', IT_ALLOWLIST)).toEqual({
      entity: 'Pennywise',
      kind: 'person',
      exact: true,
    });
  });

  it('matches "Beverly Marsh" exactly', () => {
    expect(matchEntity('Beverly Marsh', IT_ALLOWLIST)).toEqual({
      entity: 'Beverly Marsh',
      kind: 'person',
      exact: true,
    });
  });

  it('matches kebab-cased "beverly-marsh" exactly', () => {
    expect(matchEntity('beverly-marsh', IT_ALLOWLIST)).toEqual({
      entity: 'Beverly Marsh',
      kind: 'person',
      exact: true,
    });
  });

  it('returns null for a single-token candidate with no exact hit (no repair for single tokens)', () => {
    expect(matchEntity('Marsh', IT_ALLOWLIST)).toBeNull();
  });

  it('returns null when the repair rules match more than one allowlist entry (ambiguity)', () => {
    const ambiguousAllowlist: EnrichedEntity[] = [
      { entity: 'Benjamin Hanscom', kind: 'person' },
      { entity: 'Benjamin Hanlon', kind: 'person' },
    ];
    // 'ben' prefix-matches 'benjamin' for both entries, and 'hanl' either
    // prefix-matches (hanlon) or shares a 3-char prefix (hanscom) with both
    // surnames, so two entries pass the repair rules -> ambiguous -> null.
    expect(matchEntity('Ben Hanl', ambiguousAllowlist)).toBeNull();
  });

  it('respects a kinds restriction: excludes a place when restricted to person', () => {
    expect(matchEntity('Derry', IT_ALLOWLIST, ['person'])).toBeNull();
  });

  it('respects a kinds restriction: matches a place when restricted to place', () => {
    expect(matchEntity('Derry', IT_ALLOWLIST, ['place'])).toEqual({
      entity: 'Derry',
      kind: 'place',
      exact: true,
    });
  });

  it('matches a time entity exactly when restricted to kind time', () => {
    expect(matchEntity('1958', IT_ALLOWLIST, ['time'])).toEqual({
      entity: '1958',
      kind: 'time',
      exact: true,
    });
  });

  it('returns null for an empty candidate string', () => {
    expect(matchEntity('', IT_ALLOWLIST)).toBeNull();
  });
});
