/**
 * Desk-header rendering for the library-readiness signal (plan §10.D).
 *
 * Pure, and separate from `DeskPage.tsx`, so the one rule that matters here
 * can be tested without a DOM: a metric the backend could not measure sends
 * `pct: null`, and `null` must render as **Unknown** — never as `0%`. A `0%`
 * that means "we never checked" is the exact failure this feature exists to
 * prevent (invariant 5), and rendering is the last place it can creep back
 * in: `${pct}%` on a null reads "null%", and `${pct ?? 0}%` reads "0%".
 *
 * The chip detail also names `stale` separately from the covered count, for
 * the same reason the backend counts it separately: a percentage tells the
 * reader to feel bad, "142 out of date — re-embed to fix" tells them what to
 * do about it.
 */
export interface ReadinessMetricView {
  key: string;
  label: string;
  pct: number | null;
  covered: number | null;
  /** Completed enrichment checks; present only on the external-metadata
   * metric so the UI can distinguish attempted from successfully resolved. */
  attempted?: number;
  unknown: number;
  /**
   * Books whose coverage exists but is out of date. Absent on metrics with no
   * notion of staleness; `null` when staleness is not knowable — which must
   * render as nothing, never as "0 out of date".
   */
  stale?: number | null;
  total: number;
  status: string;
  note?: string;
}

export interface LibraryReadinessView {
  totalBooks: number;
  metrics: ReadinessMetricView[];
  unmeasured: string[];
  /** MODEL-FACING prompt text — must never be rendered. See `caveat`. */
  disclosure: string | null;
  /** HUMAN-FACING version of the same facts; this is what the header shows. */
  caveat: string | null;
  schemaVersion: number;
  generatedAt: number;
}

export interface GroundingProviderCoverageView {
  provider: string;
  attempted: number;
  resolved: number;
  notFound: number;
  errors: number;
}

export interface GroundingResidualSeriesView {
  series: string;
  books: number;
  withAsin: number;
  withDescription: number;
  resolvedByProvider: Record<string, number>;
}

export interface GroundingResidualView {
  generatedAt: number;
  totalBooks: number;
  groundedBooks: number;
  ungroundedBooks: number;
  withSeries: number;
  withoutSeries: number;
  withAsin: number;
  withDescription: number;
  withResolvedMetadata: number;
  providers: GroundingProviderCoverageView[];
  series: GroundingResidualSeriesView[];
}

export interface ReadinessChip {
  key: string;
  label: string;
  /** What the header shows: a percentage, or the word Unknown. */
  value: string;
  status: string;
  /** Hover text — the count behind the number, or why it is Unknown. */
  detail: string;
}

function detailFor(m: ReadinessMetricView): string {
  if (m.pct === null) return m.note ?? 'Not measured';
  const parts = [`${m.covered} of ${m.total}`];
  // `typeof` rather than a truthiness check: `null` means staleness is
  // unknowable and must stay silent, and `0` means genuinely nothing is out
  // of date, which is not worth a chip segment either.
  if (typeof m.stale === 'number' && m.stale > 0) parts.push(`${m.stale} out of date — re-embed to fix`);
  if (m.note) parts.push(m.note);
  return parts.join(' · ');
}

export function readinessChips(data: LibraryReadinessView | undefined): ReadinessChip[] {
  if (!data) return [];
  return data.metrics.flatMap((m) => {
    const coverage = {
      key: m.key,
      label: m.label,
      value: m.pct === null ? 'Unknown' : `${m.pct}%`,
      status: m.status,
      detail: detailFor(m),
    };
    if (m.key !== 'enriched' || m.attempted === undefined) return [coverage];

    const attemptedPct = m.total === 0 ? null : Math.round((m.attempted / m.total) * 100);
    const attemptedStatus = attemptedPct === null
      ? 'Unknown'
      : attemptedPct >= 90
        ? 'Great'
        : attemptedPct >= 50
          ? 'Good'
          : 'Attention';
    return [{
      key: 'enrichment-attempted',
      label: 'Enrichment attempted',
      value: attemptedPct === null ? 'Unknown' : `${attemptedPct}%`,
      status: attemptedStatus,
      detail: attemptedPct === null ? 'No books are in the active library' : `${m.attempted} of ${m.total} completed`,
    }, coverage];
  });
}
