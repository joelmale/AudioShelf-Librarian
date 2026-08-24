import { describe, expect, it } from 'vitest';

import { estimateTaggingCost } from './tagCost.js';

/**
 * Pins the cost-estimate math. Rates are Claude Haiku 4.5 first-party
 * pricing: $1/MTok input, $5/MTok output (see the comment in tagCost.ts).
 * The bug this guards against was real: the hardcoded per-book token counts
 * predated the Phase 0 prompt change to "aim for 15-30 tags" and badly
 * understated output, and the estimate was always multiplied by the
 * untagged count even for a retag-all run that processes every book.
 */
describe('estimateTaggingCost', () => {
  it('falls back to the rough constants when there is no measured history', () => {
    const estimate = estimateTaggingCost(1000, null);
    // (1000 * 1800 * 1.0 + 1000 * 300 * 5.0) / 1_000_000 = 1.8 + 1.5 = 3.30
    expect(estimate.cost).toBe('$3.30');
    expect(estimate.source).toBe('rough');
    expect(estimate.detail).toMatch(/no tagging history/i);
  });

  it('uses the measured per-book averages when available', () => {
    const measured = { inputTokensPerBook: 2000, outputTokensPerBook: 600, sampleSize: 128 };
    const estimate = estimateTaggingCost(100, measured);
    // (100 * 2000 * 1.0 + 100 * 600 * 5.0) / 1_000_000 = 0.2 + 0.3 = 0.50
    expect(estimate.cost).toBe('$0.50');
    expect(estimate.source).toBe('measured');
    expect(estimate.detail).toMatch(/last 128 tagged books/);
  });

  it('singularizes the sample-size note for exactly one measured book', () => {
    const measured = { inputTokensPerBook: 1000, outputTokensPerBook: 100, sampleSize: 1 };
    const estimate = estimateTaggingCost(1, measured);
    expect(estimate.detail).toMatch(/last 1 tagged book\b/);
    expect(estimate.detail).not.toMatch(/books\b/);
  });

  it('returns $0.00 for zero books, whether measured or rough', () => {
    expect(estimateTaggingCost(0, null).cost).toBe('$0.00');
    expect(estimateTaggingCost(0, { inputTokensPerBook: 5000, outputTokensPerBook: 1000, sampleSize: 10 }).cost).toBe(
      '$0.00'
    );
  });

  it('scales linearly with book count for a retag-all vs a normal run', () => {
    const measured = { inputTokensPerBook: 1800, outputTokensPerBook: 300, sampleSize: 50 };
    const untaggedEstimate = estimateTaggingCost(12, measured);
    const retagAllEstimate = estimateTaggingCost(958, measured);
    expect(Number(retagAllEstimate.cost.slice(1))).toBeGreaterThan(Number(untaggedEstimate.cost.slice(1)));
  });
});
