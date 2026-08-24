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

describe('normalizeForMatching — accent and edition folding', () => {
  // Each of these was a real divergence that minted two rows for one work.
  it.each([
    ['Les Misérables', 'Les Miserables'],
    ['Stanisław Lem', 'Stanislaw Lem'],
    ['Jules Verne', 'Jules Verne'],
    ['Karel Čapek', 'Karel Capek'],
  ])('folds %s onto its unaccented spelling', (accented, plain) => {
    expect(normalizeForMatching(accented)).toBe(normalizeForMatching(plain));
  });

  it.each([
    'Leviathan Wakes (Unabridged)',
    'Leviathan Wakes [Unabridged]',
    'Leviathan Wakes, Unabridged',
    'Leviathan Wakes: Unabridged Edition',
    'Leviathan Wakes (Abridged)',
  ])('strips the edition marker from %s', (titled) => {
    expect(normalizeForMatching(titled)).toBe('leviathan wakes');
  });

  it('does NOT strip "unabridged" when it is part of the actual title', () => {
    // The trap in widening the edition-marker regex: a bare \bunabridged\b
    // would gut this real title down to "journals of sylvia plath".
    expect(normalizeForMatching('The Unabridged Journals of Sylvia Plath'))
      .toBe('the unabridged journals of sylvia plath');
  });

  it('does not unify a series-prefixed title with the bare title', () => {
    // Documented non-goal. Locked in so nobody "fixes" the docblock back to
    // claiming these collapse — they do not, and the edge PK makes a wrong
    // assumption here permanent.
    expect(normalizeForMatching('The Expanse: Leviathan Wakes'))
      .not.toBe(normalizeForMatching('Leviathan Wakes'));
  });
});

describe('externalBookKey — the throw contract', () => {
  it.each(['三体', 'Война и мир', 'こころ'])(
    'throws for %s, because the strip keeps only ASCII alphanumerics',
    (title) => {
      // Not an "empty title" case in any intuitive sense — this is the real,
      // much broader trigger, and callers must guard per-anchor rather than
      // let one non-Latin readalike abort a whole edge-write batch.
      expect(() => externalBookKey(title, 'Author')).toThrow(/normalizes to empty/);
    }
  );

  it('still mints a key for a Latin-script title that needed folding', () => {
    expect(externalBookKey('Solaris', 'Stanisław Lem')).toBe('ext:solaris|stanislaw lem');
  });
});
