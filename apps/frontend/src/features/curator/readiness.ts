/**
 * Desk-header rendering for the library-readiness signal (plan §10.D).
 *
 * Pure, and separate from `DeskPage.tsx`, so the one rule that matters here
 * can be tested without a DOM: a metric the backend could not measure sends
 * `pct: null`, and `null` must render as **Unknown** — never as `0%`. A `0%`
 * that means "we never checked" is the exact failure this feature exists to
 * prevent (invariant 5), and rendering is the last place it can creep back
 * in: `${pct}%` on a null reads "null%", and `${pct ?? 0}%` reads "0%".
 */
export interface ReadinessMetricView {
  key: string;
  label: string;
  pct: number | null;
  covered: number | null;
  unknown: number;
  total: number;
  status: string;
  note?: string;
}

export interface LibraryReadinessView {
  totalBooks: number;
  metrics: ReadinessMetricView[];
  unmeasured: string[];
  disclosure: string | null;
  schemaVersion: number;
  generatedAt: number;
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

export function readinessChips(data: LibraryReadinessView | undefined): ReadinessChip[] {
  if (!data) return [];
  return data.metrics.map((m) => ({
    key: m.key,
    label: m.label,
    value: m.pct === null ? 'Unknown' : `${m.pct}%`,
    status: m.status,
    detail:
      m.pct === null
        ? (m.note ?? 'Not measured')
        : `${m.covered} of ${m.total}${m.note ? ` · ${m.note}` : ''}`,
  }));
}
