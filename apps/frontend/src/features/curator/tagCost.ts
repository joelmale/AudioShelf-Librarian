/**
 * Cost estimation for a tagging run. Lives outside the page component
 * because the pipeline panel — not the page — is what renders the estimate,
 * and a component importing from a page module would invert the dependency.
 */

// Claude Haiku 4.5 first-party API pricing, verified against
// https://docs.anthropic.com/en/docs/about-claude/pricing on 2026-08-22:
// $1/MTok input, $5/MTok output. These rates are correct and don't need
// updating — only the per-book token counts below are a rough fallback.
const IN_COST_PER_MTOK = 1.0;
const OUT_COST_PER_MTOK = 5.0;

// Fallback per-book token counts, used only when there's no run history yet
// to measure from. These predate the Phase 0 prompt change to "aim for
// 15-30 tags" and understate real output — prefer `avgTagTokens` from
// /tags/stats whenever it's available.
const FALLBACK_IN_PER_BOOK = 1800;
const FALLBACK_OUT_PER_BOOK = 300;

export interface MeasuredTagTokens {
  inputTokensPerBook: number;
  outputTokensPerBook: number;
  sampleSize: number;
}

export interface TagCostEstimate {
  /** Formatted as `$X.XX`. */
  cost: string;
  source: 'measured' | 'rough';
  /** Human-readable note on where the per-book token counts came from. */
  detail: string;
}

/**
 * Estimate the dollar cost of tagging `bookCount` books. Uses the caller's
 * measured per-book token averages (from recent real runs) when available,
 * falling back to the hardcoded rough constants otherwise. `bookCount`
 * should already reflect which run is being estimated — every active book
 * for a retag-all, only the untagged ones for a normal run.
 */
export function estimateTaggingCost(bookCount: number, measured: MeasuredTagTokens | null): TagCostEstimate {
  const inPerBook = measured?.inputTokensPerBook ?? FALLBACK_IN_PER_BOOK;
  const outPerBook = measured?.outputTokensPerBook ?? FALLBACK_OUT_PER_BOOK;
  const cost = (bookCount * inPerBook * IN_COST_PER_MTOK + bookCount * outPerBook * OUT_COST_PER_MTOK) / 1_000_000;
  return {
    cost: `$${cost.toFixed(2)}`,
    source: measured ? 'measured' : 'rough',
    detail: measured
      ? `estimate based on your last ${measured.sampleSize} tagged book${measured.sampleSize === 1 ? '' : 's'}`
      : 'rough estimate (no tagging history yet)',
  };
}
