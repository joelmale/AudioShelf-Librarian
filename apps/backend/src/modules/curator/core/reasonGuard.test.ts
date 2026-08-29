import { describe, expect, it } from 'vitest';

import { matchedTagReason, reasonIsAboutAnotherBook, type ReasonSubject } from './reasonGuard.js';

/** The real slate from the 2026-08-28 Key West answer. */
const FLORIDA_STRAITS: ReasonSubject = { title: 'Florida Straits', author: 'Laurence Shames' };
const SUNBURN: ReasonSubject = { title: 'Sunburn: Key West, Book 03', author: 'Laurence Shames' };
const TROPICAL_DEPRESSION: ReasonSubject = { title: 'Tropical Depression', author: 'Laurence Shames' };
const BULLET: ReasonSubject = { title: 'The Bullet That Missed', author: 'Richard Osman' };
const FRICK: ReasonSubject = { title: 'The Invisible Husband of Frick Island', author: 'Colleen Oakley' };

describe('reasonIsAboutAnotherBook', () => {
  it('catches the observed Florida Straits / Sunburn mix-up', () => {
    const reason = '‘Sunburn’ is another novel from Laurence Shames set in Key West, '
      + 'providing a continuation of the Key West Capers series.';
    expect(reasonIsAboutAnotherBook(reason, FLORIDA_STRAITS, [SUNBURN, TROPICAL_DEPRESSION])).toBe(true);
  });

  it('catches a quoted title whose subtitle differs from the stored one', () => {
    // Stored as "Sunburn: Key West, Book 03"; prose quotes bare "Sunburn".
    // Matching only the full stored title would miss every real case.
    const reason = '‘Tropical Depression’ is a compelling mystery set on the coast.';
    expect(reasonIsAboutAnotherBook(reason, SUNBURN, [TROPICAL_DEPRESSION, FLORIDA_STRAITS])).toBe(true);
  });

  it('catches a wrong author even when the title is right', () => {
    // The observed "'The Bullet That Missed' from Stephen King" case, with a
    // slate that contains the real author of another book.
    const reason = '‘The Bullet That Missed’ is a unique mystery by Colleen Oakley.';
    expect(reasonIsAboutAnotherBook(reason, BULLET, [FRICK])).toBe(true);
  });

  it('accepts a reason that names this book and its own author', () => {
    const reason = '‘Florida Straits’ by Laurence Shames is a Key West caper with a wry tone.';
    expect(reasonIsAboutAnotherBook(reason, FLORIDA_STRAITS, [SUNBURN, BULLET])).toBe(false);
  });

  it('accepts prose that names no book at all', () => {
    // The common, good case: a sentence about the vibe, quoting nothing.
    const reason = 'A sunny coastal mystery with a light, humorous tone and a strong sense of place.';
    expect(reasonIsAboutAnotherBook(reason, FLORIDA_STRAITS, [SUNBURN, BULLET])).toBe(false);
  });

  it('leaves a comparison to a book outside this slate alone', () => {
    // "if you liked X" is legitimate. Only mix-ups WITHIN the slate are
    // demonstrably wrong, so an unknown title must not trip the guard.
    const reason = 'If you enjoyed ‘Where the Crawdads Sing’, this coastal mystery lands similarly.';
    expect(reasonIsAboutAnotherBook(reason, FLORIDA_STRAITS, [SUNBURN, BULLET])).toBe(false);
  });

  it('allows naming another author alongside this book’s own', () => {
    // Two authors in one sentence is normal; crediting only the wrong one is not.
    const reason = 'Laurence Shames writes these with the wry warmth Richard Osman fans enjoy.';
    expect(reasonIsAboutAnotherBook(reason, FLORIDA_STRAITS, [BULLET])).toBe(false);
  });

  it('does not fire on an empty or whitespace reason', () => {
    expect(reasonIsAboutAnotherBook('   ', FLORIDA_STRAITS, [SUNBURN])).toBe(false);
  });

  it('tolerates a book with no author on either side', () => {
    const anon: ReasonSubject = { title: 'Anonymous Work', author: null };
    const other: ReasonSubject = { title: 'Another Work', author: null };
    expect(reasonIsAboutAnotherBook('A fine book.', anon, [other])).toBe(false);
    expect(reasonIsAboutAnotherBook('‘Another Work’ is fine.', anon, [other])).toBe(true);
  });

  it('ignores a very short pre-colon fragment that is not distinctive', () => {
    // A title like "It: The Novel" must not let the two-letter head "It"
    // match every reason containing the word.
    const shortHead: ReasonSubject = { title: 'It: The Novel', author: 'Someone' };
    const subject: ReasonSubject = { title: 'Real Book', author: 'Other Person' };
    expect(reasonIsAboutAnotherBook('‘It’ is a good read.', subject, [shortHead])).toBe(false);
  });
});

describe('matchedTagReason', () => {
  it('names the tags the ranker actually scored on', () => {
    expect(matchedTagReason(['beach-town', 'cozy-mystery', 'humorous']))
      .toBe('Ranked highly for this request on beach-town, cozy-mystery, humorous.');
  });

  it('falls back to overall similarity when nothing matched by tag', () => {
    expect(matchedTagReason([])).toBe('Ranked highly for this request by overall similarity.');
  });

  it('caps the listed tags so a card stays readable', () => {
    expect(matchedTagReason(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('Ranked highly for this request on a, b, c, d.');
  });
});
