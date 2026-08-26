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
 *
 * COVERAGE MEANS USABLE, NOT PRESENT. The `embedded` metric originally
 * counted a `book_embeddings` row at the configured model and ignored
 * `card_hash` entirely, so a library whose every vector was stale reported
 * "100% Embedded / Great" — the most reassuring verdict this header can give,
 * for its least usable state. Not hypothetical: a vocabulary consolidation
 * rewrote 1,560 tag rows with no re-embed, which is why readiness item B
 * exists at all. `covered` is now judged by `isEmbeddingStale` — the same
 * predicate the embedder re-embeds on — and the books that fail it are
 * reported as their own `stale` count rather than silently dragging a
 * percentage down. See {@link ReadinessMetric.stale}.
 */
import type { ReadinessCounts } from './db.js';
import {
  countEmbeddingFreshness,
  type EmbeddingFreshness,
  type EmbeddingFreshnessDb,
} from './retrieval/embedder.js';

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
  /**
   * Books whose coverage EXISTS but is out of date — present, and known to be
   * wrong. Absent on metrics that have no notion of staleness; `null` when
   * staleness is not knowable in this configuration.
   *
   * Deliberately NOT folded into `unknown`. Unknown means "we cannot tell";
   * stale means "we can tell, and it is out of date". They also take
   * different remedies — a never-covered book needs a first run, a stale one
   * needs a re-run — which is the whole reason this is a separate count
   * rather than a lower percentage. "73% embedded" tells the reader to feel
   * bad; "142 out of date, re-embed to fix" tells them what to do.
   *
   * `null` rather than `0` where it is unknowable, because `stale: 0` reads
   * as the confident claim "nothing is stale" — invariant 5, on this axis.
   */
  stale?: number | null;
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

/**
 * A metric with this share of its books STALE is disclosed even when the
 * confirmed percentage is healthy. Same share and same reasoning as
 * {@link MATERIAL_UNKNOWN_SHARE} — a handful of books drifting out of date
 * between a tag edit and the next embedding run must not pin a permanent
 * caveat to every answer — but a separate constant because the two are
 * separate judgements and should be tunable apart.
 */
export const MATERIAL_STALE_SHARE = 0.1;

/**
 * Above this share of unknown books, the metric renders `Unknown` instead of
 * a percentage — the percentage stops being a fact about the library and
 * becomes a fact about how little was checked.
 *
 * A majority, not a token threshold, and learned from real data. The live
 * library reported `Tagged at current schema: 0%` while 958 of its 965 books
 * were in fact tagged: 954 of them carried tags recorded before `tag_runs`
 * existed, so they were `unknown`, and the 7 genuinely untagged books left
 * `covered: 0`. Every number underneath was correct and the headline still
 * said the opposite of the truth — and the librarian was instructed to state
 * it aloud ("only 0% of books are tagged at the current tag schema").
 *
 * `unknown > total / 2` is the same judgement `unknown >= total` already
 * made, moved to where it protects a real case: once the unchecked books
 * outnumber the checked ones, "I cannot tell you" is the honest answer.
 */
export const UNKNOWN_DOMINATES_SHARE = 0.5;

interface MetricSpec {
  key: ReadinessMetricKey;
  label: string;
  covered: number;
  unknown: number;
  /**
   * Books covered-but-out-of-date. Set only on metrics that HAVE a notion of
   * staleness; presence of {@link MetricSpec.stalePhrase} is what marks the
   * metric as one of those.
   */
  stale?: number;
  /** Clause for the disclosure, e.g. "have grounded entities". */
  phrase: string;
  /** Clause describing the unknown books, e.g. "were never enriched". */
  unknownPhrase: string;
  /** Clause describing the stale books; its presence declares staleness knowable here. */
  stalePhrase?: string;
  /** Note used when NO book could be checked — the `Unknown` rendering. */
  neverCheckedNote: string;
  /** Reason the metric is unmeasurable in this configuration, when it is. */
  unmeasurableNote?: string;
  /** Extra colour for the measurable case (e.g. vectors under another model). */
  note?: string;
}

function buildMetric(spec: MetricSpec, total: number): ReadinessMetric {
  // A metric only carries a `stale` count if staleness is a meaningful state
  // for it at all — declared by giving it a `stalePhrase`.
  const hasStaleness = spec.stalePhrase !== undefined;

  // Three ways a percentage would be a lie rather than a number: an empty
  // mirror, a check that answered for no book at all, and a check that cannot
  // run in this configuration. All three report Unknown.
  const unmeasurable =
    total === 0 ||
    spec.unknown > total * UNKNOWN_DOMINATES_SHARE ||
    spec.unmeasurableNote !== undefined;
  if (unmeasurable) {
    return {
      key: spec.key,
      label: spec.label,
      pct: null,
      covered: null,
      // The REAL unknown count, not `total`. When the metric is unmeasurable
      // because a check cannot run at all, `spec.unknown` is already `total`
      // and this is the same number. When it is unmeasurable because unknown
      // books merely outnumber checked ones, flattening to `total` would
      // throw away the one fact still worth stating: how many books are
      // genuinely in the dark, versus how many were checked and came back
      // negative. The live library's tagged metric is 954 unknown of 961,
      // not 961 of 961 — 7 books really are untagged.
      unknown: spec.unknown,
      // Unknown coverage means unknown STALENESS too: with no model
      // configured there is nothing to judge a stored vector against. `null`,
      // never `0` — "0 stale" is the reassuring claim "nothing is out of
      // date", made by a check that could not run.
      ...(hasStaleness ? { stale: null } : {}),
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
    ...(hasStaleness ? { stale: spec.stale ?? 0 } : {}),
    total,
    status: pct >= 90 ? 'Great' : pct >= MATERIAL_COVERAGE_PCT ? 'Good' : 'Attention',
  };
  if (notes.length > 0) metric.note = notes.join('; ');
  return metric;
}

/** Share of the library a metric reports stale, or 0 where staleness is not a state. */
function staleShare(m: ReadinessMetric): number {
  if (m.total <= 0 || typeof m.stale !== 'number') return 0;
  return m.stale / m.total;
}

/** A metric worth interrupting an answer for. */
function isMaterial(m: ReadinessMetric): boolean {
  if (m.pct === null) return true;
  if (m.pct < MATERIAL_COVERAGE_PCT) return true;
  if (m.total > 0 && m.unknown / m.total >= MATERIAL_UNKNOWN_SHARE) return true;
  // A library that is 95% embedded but a fifth of it out of date is not
  // healthy: those vectors answer for the wrong queries. The percentage alone
  // would not disclose it.
  return staleShare(m) >= MATERIAL_STALE_SHARE;
}

function clauseFor(m: ReadinessMetric, spec: MetricSpec): string {
  if (m.pct === null) {
    return `${m.label} coverage is Unknown (${m.note ?? 'the check could not run'})`;
  }
  // Stale and unknown are named as SEPARATE clauses on purpose. "N have an
  // out-of-date embedding" and "N were never embedded" are different
  // statements about different books, taking different remedies; collapsing
  // them into one number tells the reader nothing they can act on.
  const clauses = [`only ${m.pct}% of books ${spec.phrase} (${m.covered} of ${m.total})`];
  if (m.total > 0 && m.unknown / m.total >= MATERIAL_UNKNOWN_SHARE) {
    clauses.push(`and ${m.unknown} more ${spec.unknownPhrase}`);
  }
  if (staleShare(m) >= MATERIAL_STALE_SHARE && spec.stalePhrase) {
    clauses.push(`and ${m.stale} ${spec.stalePhrase}`);
  }
  return clauses.join(', ');
}

/**
 * Turn raw counts into the readiness summary. Pure — no database access, no
 * clock beyond the injected `now`, so a test can hand it a fixture whose
 * expected numbers were worked out by hand rather than recomputed the same
 * way the implementation does.
 */
export function summarizeReadiness(
  counts: ReadinessCounts,
  opts: {
    schemaVersion: number;
    embeddingModel: string | null;
    /**
     * The usable-coverage census for the `embedded` metric — see
     * {@link EmbeddingFreshness}. REQUIRED, and `null` only when it genuinely
     * could not be taken (no embedding model configured). There is
     * deliberately no fall back to `counts.embeddedAtModel`: that counts row
     * presence, which is the bug this parameter exists to fix. A library
     * whose every vector is stale reported "100% Embedded / Great" — the most
     * reassuring verdict the header can give, for its least usable state.
     */
    embeddingFreshness: EmbeddingFreshness | null;
    now?: () => number;
  }
): LibraryReadiness {
  const total = counts.totalBooks;
  const noModel = opts.embeddingModel === null || opts.embeddingModel === '';
  const embeddedElsewhere = counts.embeddedAnyModel - counts.embeddedAtModel;

  const freshness = opts.embeddingFreshness;
  // Staleness is knowable only against a configured model. Without one, the
  // metric is Unknown and `stale` is null — reporting `stale: 0` there would
  // claim nothing is out of date on the strength of a check that never ran.
  const embeddedUnmeasurable = noModel
    ? 'No embedding model is configured'
    : freshness === null
      ? 'Embedding freshness was not measured for this snapshot'
      : undefined;

  // `stale` and `neverEmbedded` are reported apart because they take
  // different remedies: a re-run versus a first run.
  const embeddedNotes: string[] = [];
  if (freshness && freshness.neverEmbedded > 0) {
    embeddedNotes.push(`${freshness.neverEmbedded} never embedded`);
  }
  if (embeddedElsewhere > 0) {
    embeddedNotes.push(`${embeddedElsewhere} embedded under a different model, which does not count as coverage`);
  }

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
      // USABLE coverage, not row presence: a vector at the configured model
      // over the card text the book has now. A stale vector is worse than a
      // missing one — it returns the book for queries it no longer matches
      // and fails to return it for ones it now does — so it must never be
      // counted here.
      covered: freshness?.fresh ?? 0,
      stale: freshness?.stale ?? 0,
      unknown: embeddedUnmeasurable !== undefined ? total : 0,
      phrase: 'have an up-to-date embedding for semantic search',
      unknownPhrase: 'have no embedding recorded for the configured model',
      stalePhrase: 'have an out-of-date embedding that no longer matches the book and should be re-embedded',
      neverCheckedNote: 'No embedding model is configured',
      ...(embeddedUnmeasurable !== undefined ? { unmeasurableNote: embeddedUnmeasurable } : {}),
      ...(embeddedNotes.length > 0 ? { note: embeddedNotes.join('; ') } : {}),
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

/** The db surface {@link computeLibraryReadiness} reads. */
export interface ReadinessDb extends EmbeddingFreshnessDb {
  getReadinessCounts(opts: { schemaVersion: number; embeddingModel: string | null }): ReadinessCounts;
}

/**
 * How long a readiness snapshot stays good for.
 *
 * The counts are pure SQL and cheap, but the freshness census is not: it
 * composes every book's card to compare hashes. Measured on the real library
 * (955 books): 6.9 ms for `getStaleEmbeddings`, 44.1 ms to compose the cards,
 * ~51 ms total. That is fine for `GET /api/readiness`, which a human triggers
 * by loading the Desk. It is NOT fine attached to every `query_library`
 * result and repeated on each round of the agent loop — a reviewer flagged
 * the per-call cost even before freshness made it 7x more expensive.
 *
 * 60s is honest at this cadence because readiness only moves when a pipeline
 * run completes: syncing, enriching, tagging or embedding a library takes
 * minutes to hours, so a snapshot a minute old cannot be describing a
 * meaningfully different library.
 */
export const READINESS_CACHE_TTL_MS = 60_000;

interface CachedSnapshot {
  /** Identity, not contents: a different db is a different library. */
  db: unknown;
  schemaVersion: number;
  embeddingModel: string | null;
  takenAt: number;
  value: LibraryReadiness;
}

let cachedSnapshot: CachedSnapshot | null = null;

/**
 * Drop the cached snapshot. Call after work that changes coverage if a caller
 * needs the next read to be exact rather than up-to-60s-old; tests use it to
 * keep one test's snapshot from answering another's question.
 */
export function invalidateReadinessCache(): void {
  cachedSnapshot = null;
}

/**
 * Database-reading convenience wrapper over {@link summarizeReadiness},
 * memoized for {@link READINESS_CACHE_TTL_MS}.
 *
 * The cache key includes the db instance and the settings the snapshot was
 * computed under, so a config change or a different library is a miss rather
 * than a stale hit.
 */
export function computeLibraryReadiness(db: ReadinessDb, opts: {
  schemaVersion: number;
  embeddingModel: string | null;
  now?: () => number;
}): LibraryReadiness {
  const now = opts.now ?? Date.now;
  const at = now();
  const model = opts.embeddingModel;

  const age = cachedSnapshot === null ? Infinity : at - cachedSnapshot.takenAt;
  if (
    cachedSnapshot !== null &&
    cachedSnapshot.db === db &&
    cachedSnapshot.schemaVersion === opts.schemaVersion &&
    cachedSnapshot.embeddingModel === model &&
    // A clock that moved backwards makes the age meaningless, so recompute
    // rather than serve a snapshot of unknown vintage.
    age >= 0 &&
    age < READINESS_CACHE_TTL_MS
  ) {
    return cachedSnapshot.value;
  }

  const value = summarizeReadiness(
    db.getReadinessCounts({ schemaVersion: opts.schemaVersion, embeddingModel: model }),
    {
      schemaVersion: opts.schemaVersion,
      embeddingModel: model,
      // No model means no way to judge a stored vector, so no census — the
      // metric reports Unknown rather than inventing a count.
      embeddingFreshness: model === null || model === '' ? null : countEmbeddingFreshness(db, model),
      ...(opts.now ? { now: opts.now } : {}),
    }
  );

  cachedSnapshot = { db, schemaVersion: opts.schemaVersion, embeddingModel: model, takenAt: at, value };
  return value;
}
