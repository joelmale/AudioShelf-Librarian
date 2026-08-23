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
    expect(p.candidateTitles).toContain('Neal Stephenson');
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

describe('parseTitle — titles that must survive untouched', () => {
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
