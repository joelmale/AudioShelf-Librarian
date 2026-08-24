import { describe, expect, it } from 'vitest';

import { titleParseReview } from './PipelineRunsPanel.js';

/**
 * Pins the reading of a title-parse dry run's review table off a finished
 * operation's summary. This is the mechanism a user relies on to confirm
 * that normalising a title never loses author/year data that exists only
 * inside the title string, so it must degrade safely (null, not a throw or
 * an empty table) whenever the summary isn't a finished dry run carrying a
 * `review` array.
 */
describe('titleParseReview', () => {
  const entry = {
    bookId: 'b1',
    originalTitle: '1951 - Foundation',
    normalizedTitle: 'Foundation',
    parsedAuthor: 'Isaac Asimov',
    parsedYear: 1951,
    ordinal: null,
    confidence: 'high' as const,
    wouldFill: ['author', 'publishedYear'],
  };

  it('reads the review table and counts off a finished dry run', () => {
    const summary = {
      dryRun: true,
      review: [entry],
      reviewTotal: 1,
      filledAuthorCount: 1,
      filledYearCount: 1,
      lowConfidenceCount: 0,
    };
    expect(titleParseReview(summary)).toEqual({
      review: [entry],
      reviewTotal: 1,
      filledAuthorCount: 1,
      filledYearCount: 1,
      lowConfidenceCount: 0,
    });
  });

  it('falls back to the review array length when reviewTotal is absent', () => {
    const result = titleParseReview({ review: [entry, entry] });
    expect(result?.reviewTotal).toBe(2);
  });

  it('defaults missing counts to zero rather than undefined', () => {
    const result = titleParseReview({ review: [] });
    expect(result).toEqual({ review: [], reviewTotal: 0, filledAuthorCount: 0, filledYearCount: 0, lowConfidenceCount: 0 });
  });

  it('returns null for a real run, which never populates a review array', () => {
    expect(titleParseReview({ dryRun: false, processed: 12, filledAuthorCount: 3 })).toBeNull();
  });

  it('returns null for absent or non-object summaries', () => {
    expect(titleParseReview(undefined)).toBeNull();
    expect(titleParseReview(null)).toBeNull();
    expect(titleParseReview('review')).toBeNull();
    expect(titleParseReview(42)).toBeNull();
  });
});
