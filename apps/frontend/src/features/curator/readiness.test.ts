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
  return { totalBooks: 955, metrics, unmeasured: [], disclosure: null, caveat: null, schemaVersion: 1, generatedAt: 0 };
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

  it('names the stale count separately, so the reader is told what to do rather than how to feel', () => {
    const chips = readinessChips(
      view([
        {
          key: 'embedded',
          label: 'Embedded',
          pct: 73,
          covered: 700,
          unknown: 0,
          stale: 142,
          total: 955,
          status: 'Good',
          note: '113 never embedded',
        },
      ])
    );
    expect(chips[0].value).toBe('73%');
    // "73% embedded" tells the reader to feel bad; "142 out of date - re-embed
    // to fix" tells them which lever to pull. The never-embedded books need a
    // different lever, so they stay a separate clause.
    expect(chips[0].detail).toBe('700 of 955 · 142 out of date — re-embed to fix · 113 never embedded');
  });

  it('says nothing about staleness when it is unknowable, and nothing when there is none', () => {
    const base = {
      key: 'embedded',
      label: 'Embedded',
      pct: 100,
      covered: 955,
      unknown: 0,
      total: 955,
      status: 'Great',
    };
    // `null` means the check could not run — the mirror of the `pct: null`
    // rule above. "0 out of date" would be a confident all-clear from a check
    // that never happened.
    expect(readinessChips(view([{ ...base, stale: null }]))[0].detail).toBe('955 of 955');
    // A genuine zero is also not worth a chip segment; the 100% says it.
    expect(readinessChips(view([{ ...base, stale: 0 }]))[0].detail).toBe('955 of 955');
  });

  it('renders nothing at all before the first response arrives', () => {
    expect(readinessChips(undefined)).toEqual([]);
  });
});
