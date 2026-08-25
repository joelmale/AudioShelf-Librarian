import { describe, expect, it } from 'vitest';

import { readinessChips, type LibraryReadinessView } from './readiness.js';

/**
 * The Desk header is the last place a `0%` that means "we never checked" can
 * creep back in (invariant 5). The backend already refuses to send one — it
 * sends `pct: null` — but `${pct}%` renders "null%" and `${pct ?? 0}%`
 * renders "0%", and both look plausible in a diff. These cases pin the
 * rendering rule itself.
 */
function view(metrics: LibraryReadinessView['metrics']): LibraryReadinessView {
  return { totalBooks: 955, metrics, unmeasured: [], disclosure: null, schemaVersion: 1, generatedAt: 0 };
}

describe('readinessChips', () => {
  it('renders a measured metric as a percentage with its count behind it', () => {
    const chips = readinessChips(
      view([
        {
          key: 'entities',
          label: 'Grounded entities',
          pct: 31,
          covered: 297,
          unknown: 0,
          total: 955,
          status: 'Attention',
        },
      ])
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].value).toBe('31%');
    expect(chips[0].detail).toBe('297 of 955');
    expect(chips[0].status).toBe('Attention');
  });

  it('renders an unmeasurable metric as Unknown, never as 0%', () => {
    const chips = readinessChips(
      view([
        {
          key: 'embedded',
          label: 'Embedded',
          pct: null,
          covered: null,
          unknown: 955,
          total: 955,
          status: 'Unknown',
          note: 'No embedding model is configured',
        },
      ])
    );
    expect(chips[0].value).toBe('Unknown');
    expect(chips[0].value).not.toBe('0%');
    expect(chips[0].value).not.toContain('null');
    // The reason travels with it, so the header can explain itself on hover
    // instead of just showing a shrug.
    expect(chips[0].detail).toBe('No embedding model is configured');
  });

  it('appends a measured metric’s note to its detail without disturbing the value', () => {
    const chips = readinessChips(
      view([
        {
          key: 'enriched',
          label: 'External metadata',
          pct: 72,
          covered: 692,
          unknown: 0,
          total: 955,
          status: 'Good',
          note: '3 embedded under a different model',
        },
      ])
    );
    expect(chips[0].value).toBe('72%');
    expect(chips[0].detail).toBe('692 of 955 · 3 embedded under a different model');
  });

  it('renders nothing at all before the first response arrives', () => {
    expect(readinessChips(undefined)).toEqual([]);
  });
});
