import { describe, expect, it } from 'vitest';

import type { Book } from '../../types.js';
import { candidateTitlesFor, deinvertAuthor, matchesBook } from './matching.js';

const book = (author: string | null): Book => ({ id: 'b', title: 'Deathstalker Legacy', author } as Book);

describe('deinvertAuthor', () => {
  it('flips a single-comma "Last, First"', () => {
    expect(deinvertAuthor('Green, Simon R.')).toBe('Simon R. Green');
    expect(deinvertAuthor('Weaver, Brynne')).toBe('Brynne Weaver');
  });

  it('leaves an already-natural name alone', () => {
    expect(deinvertAuthor('Simon R. Green')).toBe('Simon R. Green');
  });

  it('refuses anything not safely invertible', () => {
    // Two commas: a list or a name with a suffix — not a simple inversion.
    expect(deinvertAuthor('Smith, John, and Jane Doe')).toBe('Smith, John, and Jane Doe');
    expect(deinvertAuthor('Green, Simon R., Jr.')).toBe('Green, Simon R., Jr.');
    // A generational suffix is not a given name.
    expect(deinvertAuthor('King, Jr.')).toBe('King, Jr.');
    expect(deinvertAuthor('Adams, III')).toBe('Adams, III');
    // Empty halves.
    expect(deinvertAuthor('Green,')).toBe('Green,');
    expect(deinvertAuthor(', Simon')).toBe(', Simon');
  });
});

describe('matchesBook author verification', () => {
  const found = { title: 'Deathstalker Legacy', authors: ['Simon R. Green'] };

  it('accepts an inverted stored author — the bug that cached not-found', () => {
    expect(matchesBook(found, 'Deathstalker Legacy', book('Green, Simon R.'))).toBe(true);
  });

  it('accepts a missing middle initial in either direction', () => {
    expect(matchesBook(found, 'Deathstalker Legacy', book('Simon Green'))).toBe(true);
    expect(
      matchesBook({ title: 'Deathstalker Legacy', authors: ['Simon Green'] }, 'Deathstalker Legacy', book('Simon R. Green'))
    ).toBe(true);
  });

  it('still rejects a genuinely different author', () => {
    expect(matchesBook(found, 'Deathstalker Legacy', book('Brynne Weaver'))).toBe(false);
    expect(matchesBook(found, 'Deathstalker Legacy', book('Simon Smith'))).toBe(false);
  });

  it('passes on title alone when the book has no usable author', () => {
    expect(matchesBook(found, 'Deathstalker Legacy', book(null))).toBe(true);
    expect(matchesBook(found, 'Deathstalker Legacy', book('   '))).toBe(true);
  });

  it('rejects when the found record has no authors at all', () => {
    expect(matchesBook({ title: 'Deathstalker Legacy', authors: [] }, 'Deathstalker Legacy', book('Simon R. Green'))).toBe(false);
  });

  it('rejects on title mismatch regardless of author', () => {
    expect(matchesBook(found, 'An Entirely Different Book', book('Simon R. Green'))).toBe(false);
  });
});

describe('candidateTitlesFor shelf annotations', () => {
  const titled = (title: string, author: string | null = null): Book =>
    ({ id: 'b', title, author } as Book);

  it('offers the title without a trailing parenthetical', () => {
    // `(Holmes)` is the narrator. No catalogue indexes it, so the raw title
    // matches nothing while the book itself is perfectly well catalogued.
    const candidates = candidateTitlesFor(titled('Taran Wanderer (Holmes)'));
    expect(candidates).toContain('Taran Wanderer');
  });

  it('strips a production house and a full-cast marker', () => {
    const candidates = candidateTitlesFor(titled('Siren Song Full Cast (GraphicAudio)'));
    expect(candidates).toContain('Siren Song Full Cast');
    expect(candidates).toContain('Siren Song');
  });

  it('reads the text after a bracketed index as the likely title', () => {
    // `<series> [<index>] <title>` is the shape; the real title is the tail.
    const candidates = candidateTitlesFor(titled("Second Foundation [01] Foundation's Fear"));
    expect(candidates).toContain("Foundation's Fear");
    // The bracket-removed reading is offered too, since either could be right.
    expect(candidates).toContain("Second Foundation Foundation's Fear");
  });

  it('always keeps the original first, because stripping is a guess', () => {
    // Providers verify every hit, so an extra candidate costs one lookup;
    // reordering ahead of the parser's own best guess would not be free.
    const candidates = candidateTitlesFor(titled('The Dark Tower (DT7)'));
    expect(candidates[0]).toBe('The Dark Tower (DT7)');
    expect(candidates).toContain('The Dark Tower');
  });

  it('adds no variant when stripping would consume the whole title', () => {
    // What is left when the strip eats everything is not a title. The parser's
    // own output is untouched here — this guards only the variants added on
    // top of it.
    const candidates = candidateTitlesFor(titled('(GraphicAudio)'));
    expect(candidates.every((candidate) => candidate.length > 1)).toBe(true);
  });

  it('leaves a title with no annotation untouched', () => {
    expect(candidateTitlesFor(titled('Revelation Space'))).toEqual(['Revelation Space']);
  });
});
