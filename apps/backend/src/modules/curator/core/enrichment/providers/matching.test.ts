import { describe, expect, it } from 'vitest';

import type { Book } from '../../types.js';
import { deinvertAuthor, matchesBook } from './matching.js';

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
