import { describe, expect, it } from 'vitest';

import { parseTitle } from './titleParse.js';

/**
 * Every title in the first block is a REAL title from the user's 958-book
 * library that Open Library failed to resolve. A live probe confirmed six of
 * the seven resolve once cleaned, so these are the regression cases that
 * justify the module existing.
 */
describe('parseTitle — real library failures', () => {
  it('splits ordinal / title / author / year when the author is known', () => {
    const p = parseTitle('24 - Snow Crash - Neal Stephenson - 1992', 'Neal Stephenson');
    expect(p.normalizedTitle).toBe('Snow Crash');
    expect(p.author).toBe('Neal Stephenson');
    expect(p.year).toBe(1992);
    expect(p.ordinal).toBe(24);
    expect(p.confidence).toBe('high');
    expect(p.original).toBe('24 - Snow Crash - Neal Stephenson - 1992');
  });

  it('never returns the author as the title when the author is unknown', () => {
    // The regression guard. A "longest segment" heuristic picks
    // "Neal Stephenson" here, and a live probe then returned *Reamde* — a
    // real, wrong book. A false match is worse than no match.
    const p = parseTitle('24 - Snow Crash - Neal Stephenson - 1992', null);
    expect(p.normalizedTitle).not.toBe('Neal Stephenson');
    expect(p.normalizedTitle).toBe('Snow Crash');
    expect(p.confidence).toBe('low');
    // The author is now identified positionally, so it is no longer offered
    // as something to look the book up by — searching Open Library for
    // "Neal Stephenson" returned *Reamde*, a real but wrong book.
    expect(p.candidateTitles).not.toContain('Neal Stephenson');
    expect(p.author).toBe('Neal Stephenson');
  });

  it('accepts a pre-1900 year', () => {
    const p = parseTitle('52 - Frankenstein - Mary Shelley - 1818', 'Mary Shelley');
    expect(p.normalizedTitle).toBe('Frankenstein');
    expect(p.year).toBe(1818);
    expect(p.ordinal).toBe(52);
    expect(p.author).toBe('Mary Shelley');
  });

  it('handles a leading-article title', () => {
    const p = parseTitle('55 - The Diamond Age - Neal Stephenson - 1995', 'Neal Stephenson');
    expect(p.normalizedTitle).toBe('The Diamond Age');
    expect(p.year).toBe(1995);
  });

  it('strips an underscore ordinal prefix', () => {
    const p = parseTitle('2_ Apt Pupil', 'Stephen King');
    expect(p.normalizedTitle).toBe('Apt Pupil');
    expect(p.ordinal).toBe(2);
    expect(p.confidence).toBe('high');
  });

  it('strips an underscore ordinal prefix before an article', () => {
    const p = parseTitle('4_ The Breathing Method', 'Stephen King');
    expect(p.normalizedTitle).toBe('The Breathing Method');
    expect(p.ordinal).toBe(4);
  });

  it('ranks the work above the collection it came from', () => {
    // "3 Past Midnight" is the collection, "The Library Policeman" the story.
    // Ranking the collection first made a live lookup match *Four Past
    // Midnight* and its 357 indexed names — the cross-work contamination that
    // put Andy Dufresne under "Apt Pupil" in the user's real data.
    const p = parseTitle('3 Past Midnight - The Library Policeman', 'Stephen King');
    expect(p.candidateTitles[0]).toBe('The Library Policeman');
    expect(p.candidateTitles).toContain('Past Midnight');
    expect(p.normalizedTitle).toBe('The Library Policeman');
    expect(p.ordinal).toBe(3);
    expect(p.confidence).toBe('low');
  });

  it('ranks the work above the collection for the sibling novella too', () => {
    const p = parseTitle('4 Past Midnight - The Sun Dog', 'Stephen King');
    expect(p.candidateTitles[0]).toBe('The Sun Dog');
    expect(p.ordinal).toBe(4);
  });
});

describe('parseTitle — recovering an author the catalogue is missing', () => {
  // A full-library dry run over 958 books recovered ZERO authors, because the
  // author was only ever populated by matching an author the catalogue already
  // had. Books with no author — the ones this feature exists for — kept none.
  it('infers the author positionally when the catalogue has none', () => {
    const p = parseTitle('55 - The Diamond Age - Neal Stephenson - 1995', null);
    expect(p.normalizedTitle).toBe('The Diamond Age');
    expect(p.author).toBe('Neal Stephenson');
    expect(p.year).toBe(1995);
    // Inferred, not confirmed — the review table is the human gate.
    expect(p.confidence).toBe('low');
  });

  it('infers across the other real library titles of this shape', () => {
    expect(parseTitle('70 - Sphere - Michael Crichton - 1987', null).author).toBe('Michael Crichton');
    expect(parseTitle('93 - VALIS - Philip K Dick - 1981', null).author).toBe('Philip K Dick');
    expect(parseTitle('77 - The Invisible Man - H G Wells - 1897', null).author).toBe('H G Wells');
    expect(parseTitle('70 - Sphere - Michael Crichton - 1987', null).normalizedTitle).toBe('Sphere');
  });

  it('does not infer an author from a collection prefix', () => {
    // No year and an inline ordinal — "Past Midnight" is a collection, not a
    // person. Inferring here would write a garbage author.
    const p = parseTitle('3 Past Midnight - The Library Policeman', null);
    expect(p.author).toBeNull();
  });

  it('does not infer an author from a series suffix', () => {
    const p = parseTitle('Alvin Journeyman - Alvin Maker, Book 4', null);
    expect(p.author).toBeNull();
  });

  it('keeps confidence high only when the author was confirmed', () => {
    const confirmed = parseTitle('24 - Snow Crash - Neal Stephenson - 1992', 'Neal Stephenson');
    expect(confirmed.confidence).toBe('high');
    const inferred = parseTitle('24 - Snow Crash - Neal Stephenson - 1992', null);
    expect(inferred.confidence).toBe('low');
    expect(inferred.author).toBe('Neal Stephenson');
  });
});

describe('parseTitle — titles that must survive untouched', () => {
  it('treats a lone four-digit title as a title, not a year', () => {
    // The book "1984" was parsed as publishedYear 1984. It was published 1949.
    const p = parseTitle('1984', 'George Orwell');
    expect(p.normalizedTitle).toBe('1984');
    expect(p.year).toBeNull();
  });

  it('does not split inside brackets', () => {
    // Real title, previously cut to "A Dangerous Fortune (24 MP3s".
    const p = parseTitle('A Dangerous Fortune (24 MP3s - U)', 'Ken Follett');
    expect(p.normalizedTitle).toBe('A Dangerous Fortune (24 MP3s - U)');
  });

  it('leaves a number that is part of the sentence alone', () => {
    const raw = '#1 in Customer Service: The Complete Adventures of Tom Stranger';
    const p = parseTitle(raw, 'Robert Kroese');
    expect(p.normalizedTitle).toBe(raw);
    expect(p.ordinal).toBeNull();
  });

  it('does not mistake a leading year-like number for an ordinal', () => {
    const p = parseTitle('2001: A Space Odyssey', 'Arthur C. Clarke');
    expect(p.normalizedTitle).toBe('2001: A Space Odyssey');
    expect(p.ordinal).toBeNull();
    expect(p.year).toBeNull();
  });

  it('leaves a clean title alone and reports high confidence', () => {
    const p = parseTitle('Dune', 'Frank Herbert');
    expect(p.normalizedTitle).toBe('Dune');
    expect(p.confidence).toBe('high');
    expect(p.ordinal).toBeNull();
    expect(p.year).toBeNull();
  });

  it('strips edition markers', () => {
    expect(parseTitle('Leviathan Wakes (Unabridged)', 'James S. A. Corey').normalizedTitle).toBe(
      'Leviathan Wakes'
    );
    expect(parseTitle('Leviathan Wakes (Abridged)', null).normalizedTitle).toBe('Leviathan Wakes');
  });
});

describe('parseTitle — author matching', () => {
  it('matches an author despite case and punctuation differences', () => {
    const p = parseTitle('24 - Snow Crash - NEAL  STEPHENSON - 1992', 'Neal Stephenson');
    expect(p.normalizedTitle).toBe('Snow Crash');
    expect(p.author).toBe('NEAL STEPHENSON');
    expect(p.confidence).toBe('high');
  });

  it('matches an author written with different punctuation', () => {
    const p = parseTitle('A Title - Arthur C Clarke', 'Arthur C. Clarke');
    expect(p.normalizedTitle).toBe('A Title');
    expect(p.author).toBe('Arthur C Clarke');
  });

  it('matches a surname-first catalogue author against a title written forename-first', () => {
    // AudiobookShelf commonly stores "Stephenson, Neal". A sequence-based
    // comparison called this a mismatch, leaving 144 of 958 books flagged
    // low-confidence over a pure formatting difference.
    const p = parseTitle('55 - The Diamond Age - Neal Stephenson - 1995', 'Stephenson, Neal');
    expect(p.normalizedTitle).toBe('The Diamond Age');
    expect(p.author).toBe('Neal Stephenson');
    expect(p.confidence).toBe('high');
  });

  it('matches surname-first with initials', () => {
    const p = parseTitle('77 - The Invisible Man - H G Wells - 1897', 'Wells, H. G.');
    expect(p.normalizedTitle).toBe('The Invisible Man');
    expect(p.author).toBe('H G Wells');
    expect(p.confidence).toBe('high');
  });

  it('still refuses an author whose tokens do not match', () => {
    const p = parseTitle('70 - Sphere - Michael Crichton - 1987', 'Crichton, Robert');
    // Different person: shared surname is not enough.
    expect(p.author).toBe('Michael Crichton'); // inferred positionally
    expect(p.confidence).toBe('low'); // but never confirmed
  });

  it('keeps title candidate dedup order-sensitive', () => {
    // nameKey is order-insensitive for people; titles must not be, or
    // genuinely different candidates would collapse into one.
    const p = parseTitle('Crash Snow - Snow Crash', null);
    expect(p.candidateTitles).toHaveLength(2);
  });

  it('does not invent an author when none matches', () => {
    const p = parseTitle('Some Title - Some Subtitle', 'Frank Herbert');
    expect(p.author).toBeNull();
  });
});

describe('parseTitle — degenerate input', () => {
  it('returns an empty-but-valid parse for empty input', () => {
    const p = parseTitle('', 'Someone');
    expect(p.normalizedTitle).toBe('');
    expect(p.candidateTitles).toEqual([]);
    expect(p.original).toBe('');
  });

  it('returns an empty-but-valid parse for whitespace', () => {
    expect(parseTitle('   ', null).normalizedTitle).toBe('');
  });

  it('never returns an empty title when the input is only an ordinal', () => {
    const p = parseTitle('24', null);
    expect(p.normalizedTitle).toBe('24');
    expect(p.candidateTitles).toEqual(['24']);
  });

  it('never returns an empty title when parsing would consume everything', () => {
    const p = parseTitle('12 - 1999', null);
    expect(p.normalizedTitle).not.toBe('');
  });

  it('dedupes repeated segments', () => {
    const p = parseTitle('Dune - Dune', null);
    expect(p.candidateTitles).toEqual(['Dune']);
    expect(p.confidence).toBe('high');
  });

  it('always echoes the original verbatim', () => {
    const raw = '  7_ Weird   Title (Unabridged)  ';
    expect(parseTitle(raw, null).original).toBe(raw);
  });
});
