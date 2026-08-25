/**
 * Library-readiness signal — plan §10.D, readiness item D.
 *
 * Early in a library's life coverage is partial by construction: Open Library
 * misses roughly half the shelf, tagging is new, embeddings lag behind tag
 * edits. A librarian that answers confidently from 31% entity coverage reads
 * as BROKEN rather than as under-informed. This module turns the counts in
 * `db.getReadinessCounts()` into (a) a summary the Desk header renders and
 * (b) a `disclosure` sentence the librarian is required to state when
 * coverage is materially low — the §8.6 honesty posture at library level
 * rather than per query.
 *
 * INVARIANT 5 IS THE WHOLE POINT OF THIS FILE. A check that cannot succeed
 * reports `Unknown`, never a confident number. This project has paid for that
 * three times: the M4B metric read 0% because ABS list responses are
 * minified; structure read "811 misaligned" because it compared against one
 * hardcoded folder scheme; and item A's own classifier read `unaudited` for
 * books it had genuinely audited. A `0%` that means "we never checked" would
 * be especially galling here, in the feature whose entire purpose is honesty
 * about coverage — so every metric carries an explicit `unknown` count, and a
 * metric with nothing determinable renders `pct: null` / status `Unknown`.
 *
 * The precedent followed is `librarian/index.ts`'s `/health/library`, which
 * already reports `Unknown` for `files` and `structure` and names them in an
 * `unmeasured` array so a reader can tell "measured and fine" from "not
 * measured".
 */
import type { ReadinessCounts } from './db.js';

export type ReadinessMetricKey = 'enriched' | 'entities' | 'tagged' | 'embedded';

/** Same four-tier vocabulary the Desk health panel already renders. */
export type ReadinessStatus = 'Great' | 'Good' | 'Attention' | 'Unknown';

export interface ReadinessMetric {
  key: ReadinessMetricKey;
  /** Human label for the Desk chip. */
  label: string;
  /**
   * Percentage of the ACTIVE library confirmed covered, or `null` when the
   * check could not succeed for a single book. `null` must render as
   * "Unknown" — never as `0%`.
   */
  pct: number | null;
  /** Books confirmed covered. `null` whenever `pct` is `null`. */
  covered: number | null;
  /**
   * Books this check could not answer for — never enriched, tagged at an
   * unrecorded schema version, and so on. NOT the same as "not covered":
   * these are books we have no evidence about in either direction.
   */
  unknown: number;
  /** Active books — the denominator of `pct`. */
  total: number;
  status: ReadinessStatus;
  /** Why the metric is Unknown, or what its `unknown` books mean. */
  note?: string;
}

export interface LibraryReadiness {
  totalBooks: number;
  metrics: ReadinessMetric[];
  /** Keys of metrics that could not be measured at all — `pct === null`. */
  unmeasured: ReadinessMetricKey[];
  /**
   * MODEL-FACING. The sentence the librarian must state in its answer, or
   * `null` when coverage is good enough that a caveat would be noise. See
   * {@link isMaterial}.
   *
   * This is prompt text: it addresses the model in the second person ("state
   * this in your answer"). Never render it in the UI — see {@link
   * LibraryReadiness.caveat} for the human-facing counterpart.
   */
  disclosure: string | null;
  /**
   * HUMAN-FACING. The same facts as {@link disclosure}, minus the instruction
   * to the model, for the Desk header to render.
   *
   * Split from `disclosure` because one string was serving both audiences and
   * the Desk page rendered the prompt verbatim — a reader was told to "state
   * this in your answer before recommending", which is addressed to the
   * librarian, not to them. Both are built from the SAME clause list, so the
   * numbers cannot drift apart; only the framing differs.
   */
  caveat: string | null;
  /** Tag schema version the `tagged` metric was computed against. */
  schemaVersion: number;
  generatedAt: number;
}

/**
 * Below this, a metric is "materially low" and the librarian must say so.
 * 50% is chosen because it is the point at which a null result stops being
 * evidence: with under half the library checked, "no book matches" is at
 * least as likely to mean "we haven't looked at the matching book" as it is
 * to mean the shelf lacks one.
 */
export const MATERIAL_COVERAGE_PCT = 50;

/**
 * A metric with this share of its books unknown is disclosed even when the
 * confirmed percentage is healthy. It is a share rather than `unknown > 0` on
 * purpose: two freshly-synced books would otherwise pin a permanent caveat to
 * every answer, and a caveat that is always present stops being read — which
 * would defeat the feature.
 */
export const MATERIAL_UNKNOWN_SHARE = 0.1;

interface MetricSpec {
  key: ReadinessMetricKey;
  label: string;
  covered: number;
  unknown: number;
  /** Clause for the disclosure, e.g. "have grounded entities". */
  phrase: string;
  /** Clause describing the unknown books, e.g. "were never enriched". */
  unknownPhrase: string;
  /** Note used when NO book could be checked — the `Unknown` rendering. */
  neverCheckedNote: string;
  /** Reason the metric is unmeasurable in this configuration, when it is. */
  unmeasurableNote?: string;
  /** Extra colour for the measurable case (e.g. vectors under another model). */
  note?: string;
}

function buildMetric(spec: MetricSpec, total: number): ReadinessMetric {
  // Three ways a percentage would be a lie rather than a number: an empty
  // mirror, a check that answered for no book at all, and a check that cannot
  // run in this configuration. All three report Unknown.
  const unmeasurable = total === 0 || spec.unknown >= total || spec.unmeasurableNote !== undefined;
  if (unmeasurable) {
    return {
      key: spec.key,
      label: spec.label,
      pct: null,
      covered: null,
      unknown: total,
      total,
      status: 'Unknown',
      note:
        spec.unmeasurableNote ??
        (total === 0 ? 'No books have been synced into the mirror yet' : spec.neverCheckedNote),
    };
  }

  const pct = Math.round((spec.covered / total) * 100);
  const notes: string[] = [];
  if (spec.unknown > 0) notes.push(`${spec.unknown} ${spec.unknownPhrase}`);
  if (spec.note) notes.push(spec.note);
  const metric: ReadinessMetric = {
    key: spec.key,
    label: spec.label,
    pct,
    covered: spec.covered,
    unknown: spec.unknown,
    total,
    status: pct >= 90 ? 'Great' : pct >= MATERIAL_COVERAGE_PCT ? 'Good' : 'Attention',
  };
  if (notes.length > 0) metric.note = notes.join('; ');
  return metric;
}

/** A metric worth interrupting an answer for. */
function isMaterial(m: ReadinessMetric): boolean {
  if (m.pct === null) return true;
  if (m.pct < MATERIAL_COVERAGE_PCT) return true;
  return m.total > 0 && m.unknown / m.total >= MATERIAL_UNKNOWN_SHARE;
}

function clauseFor(m: ReadinessMetric, spec: MetricSpec): string {
  if (m.pct === null) {
    return `${m.label} coverage is Unknown (${m.note ?? 'the check could not run'})`;
  }
  const base = `only ${m.pct}% of books ${spec.phrase} (${m.covered} of ${m.total})`;
  if (m.total > 0 && m.unknown / m.total >= MATERIAL_UNKNOWN_SHARE) {
    return `${base}, and ${m.unknown} more ${spec.unknownPhrase}`;
  }
  return base;
}

/**
 * Turn raw counts into the readiness summary. Pure — no database access, no
 * clock beyond the injected `now`, so a test can hand it a fixture whose
 * expected numbers were worked out by hand rather than recomputed the same
 * way the implementation does.
 */
export function summarizeReadiness(
  counts: ReadinessCounts,
  opts: { schemaVersion: number; embeddingModel: string | null; now?: () => number }
): LibraryReadiness {
  const total = counts.totalBooks;
  const noModel = opts.embeddingModel === null || opts.embeddingModel === '';
  const embeddedElsewhere = counts.embeddedAnyModel - counts.embeddedAtModel;

  const specs: MetricSpec[] = [
    {
      key: 'enriched',
      label: 'External metadata',
      covered: counts.externalResolved,
      // Enrichment that ran and missed is a real "no". Enrichment that never
      // ran for a book is not a "no" at all.
      unknown: total - counts.enrichmentAttempted,
      phrase: 'have external metadata',
      unknownPhrase: 'were never enriched',
      neverCheckedNote: 'Enrichment has never run for any book',
    },
    {
      key: 'entities',
      label: 'Grounded entities',
      covered: counts.withEntities,
      // Entities are a product of enrichment, so a book enrichment never
      // touched has not been checked for entities either.
      unknown: total - counts.enrichmentAttempted,
      phrase: 'have grounded characters or places',
      unknownPhrase: 'were never enriched',
      neverCheckedNote: 'Enrichment has never run, so no book has been checked for entities',
    },
    {
      key: 'tagged',
      label: 'Tagged at current schema',
      covered: counts.taggedAtVersion,
      unknown: counts.taggedVersionUnknown,
      phrase: 'are tagged at the current tag schema',
      unknownPhrase: 'carry tags recorded before the tag-run log existed, at an unknown schema version',
      neverCheckedNote: 'Every tagged book predates the tag-run log, so no schema version is recorded',
    },
    {
      key: 'embedded',
      label: 'Embedded',
      covered: counts.embeddedAtModel,
      unknown: noModel ? total : 0,
      phrase: 'are embedded for semantic search',
      unknownPhrase: 'have no embedding recorded for the configured model',
      neverCheckedNote: 'No embedding model is configured',
      ...(noModel ? { unmeasurableNote: 'No embedding model is configured' } : {}),
      ...(!noModel && embeddedElsewhere > 0
        ? { note: `${embeddedElsewhere} embedded under a different model, which does not count as coverage` }
        : {}),
    },
  ];

  const metrics = specs.map((spec) => buildMetric(spec, total));
  const unmeasured = metrics.filter((m) => m.pct === null).map((m) => m.key);

  // Built as a pair: same clauses, two framings. `disclosure` instructs the
  // librarian; `caveat` informs a person reading the Desk header.
  let disclosure: string | null = null;
  let caveat: string | null = null;
  if (total === 0) {
    disclosure =
      'The library mirror is empty — nothing has been synced from Audiobookshelf yet, so nothing here can ground an answer. Say so rather than answering.';
    caveat =
      'Nothing has been synced from Audiobookshelf yet, so there is nothing here to ground an answer.';
  } else {
    const material = metrics.filter(isMaterial);
    if (material.length > 0) {
      const clauses = material.map((m) => clauseFor(m, specs.find((s) => s.key === m.key)!));
      const body = `${clauses.join('; ')}. A book missing from a result may simply be uncovered rather than a poor match.`;
      disclosure =
        `This library's coverage is materially incomplete — state this in your answer before recommending: ${body}`;
      caveat = `Coverage is still partial, so answers may be incomplete: ${body}`;
    }
  }

  return {
    totalBooks: total,
    metrics,
    unmeasured,
    disclosure,
    caveat,
    schemaVersion: opts.schemaVersion,
    generatedAt: (opts.now ?? Date.now)(),
  };
}

/** Database-reading convenience wrapper over {@link summarizeReadiness}. */
export function computeLibraryReadiness(
  db: { getReadinessCounts(opts: { schemaVersion: number; embeddingModel: string | null }): ReadinessCounts },
  opts: { schemaVersion: number; embeddingModel: string | null; now?: () => number }
): LibraryReadiness {
  return summarizeReadiness(
    db.getReadinessCounts({ schemaVersion: opts.schemaVersion, embeddingModel: opts.embeddingModel }),
    opts
  );
}
