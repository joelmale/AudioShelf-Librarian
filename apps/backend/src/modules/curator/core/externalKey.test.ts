import { describe, expect, it } from 'vitest';
import {
  externalBookKey,
  isExternalBookKey,
  normalizeForMatching,
  parseExternalBookKey,
} from './externalKey.js';

describe('externalBookKey', () => {
  it('is stable across case differences', () => {
    expect(externalBookKey('Leviathan Wakes', 'James S.A. Corey'))
      .toBe(externalBookKey('LEVIATHAN WAKES', 'james s.a. corey'));
  });

  it('is stable across an "(Unabridged)" edition suffix', () => {
    expect(externalBookKey('Leviathan Wakes', 'James S.A. Corey'))
      .toBe(externalBookKey('Leviathan Wakes (Unabridged)', 'James S.A. Corey'));
  });

  it('is stable across an "(Abridged)" edition suffix', () => {
    expect(externalBookKey('Leviathan Wakes', 'James S.A. Corey'))
      .toBe(externalBookKey('Leviathan Wakes (Abridged)', 'James S.A. Corey'));
  });

  it('is stable across punctuation and subtitle separators', () => {
    expect(externalBookKey('The Expanse: Leviathan Wakes', 'James S.A. Corey'))
      .toBe(externalBookKey('The Expanse - Leviathan Wakes', 'James S.A. Corey'));
  });

  it('is stable across extra/irregular whitespace', () => {
    expect(externalBookKey('Leviathan Wakes', 'James S.A. Corey'))
      .toBe(externalBookKey('  Leviathan   Wakes  ', '  James   S.A.   Corey  '));
  });

  it('combines all of the above in one case', () => {
    expect(externalBookKey('Leviathan Wakes', 'James S.A. Corey'))
      .toBe(externalBookKey('  LEVIATHAN   WAKES (Unabridged)', 'james s.a. corey'));
  });

  it('does not collide two genuinely different works', () => {
    expect(externalBookKey('Leviathan Wakes', 'James S.A. Corey'))
      .not.toBe(externalBookKey('Caliban\'s War', 'James S.A. Corey'));
    expect(externalBookKey('Leviathan Wakes', 'James S.A. Corey'))
      .not.toBe(externalBookKey('Leviathan Wakes', 'Some Other Author'));
  });

  it('produces the documented ext:<title>|<author> shape', () => {
    expect(externalBookKey('Leviathan Wakes', 'James S.A. Corey'))
      .toBe('ext:leviathan wakes|james s a corey');
  });

  it('allows an empty author, producing a stable ext:<title>| key', () => {
    expect(externalBookKey('Leviathan Wakes', '')).toBe('ext:leviathan wakes|');
    expect(externalBookKey('Leviathan Wakes', '')).toBe(externalBookKey('LEVIATHAN WAKES', ''));
  });

  it('throws rather than minting a degenerate key for a title that normalizes to empty', () => {
    expect(() => externalBookKey('', 'James S.A. Corey')).toThrow();
    expect(() => externalBookKey('   ', 'James S.A. Corey')).toThrow();
    expect(() => externalBookKey('***', 'James S.A. Corey')).toThrow();
  });
});

describe('isExternalBookKey', () => {
  it('is true for a minted external key', () => {
    expect(isExternalBookKey(externalBookKey('Leviathan Wakes', 'James S.A. Corey'))).toBe(true);
  });

  it('is false for a plain books.id (no ext: prefix)', () => {
    expect(isExternalBookKey('01HXYZ')).toBe(false);
  });
});

describe('parseExternalBookKey', () => {
  it('recovers normalized title and author from a minted key', () => {
    const key = externalBookKey('Leviathan Wakes', 'James S.A. Corey');
    expect(parseExternalBookKey(key)).toEqual({
      title: 'leviathan wakes',
      author: 'james s a corey',
    });
  });

  it('recovers an empty author when the key was minted with no author', () => {
    const key = externalBookKey('Leviathan Wakes', '');
    expect(parseExternalBookKey(key)).toEqual({ title: 'leviathan wakes', author: '' });
  });

  it('returns null for a non-external key', () => {
    expect(parseExternalBookKey('01HXYZ')).toBeNull();
  });

  it('returns null for a malformed key missing the separator', () => {
    expect(parseExternalBookKey('ext:leviathan wakes')).toBeNull();
  });
});

describe('normalizeForMatching', () => {
  it('lowercases, strips edition markers, and collapses punctuation/whitespace', () => {
    expect(normalizeForMatching('  The Expanse: Leviathan Wakes (Unabridged)  '))
      .toBe('the expanse leviathan wakes');
  });
});
