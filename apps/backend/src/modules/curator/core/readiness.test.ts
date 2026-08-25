/**
 * Library-readiness signal (plan §10.D, readiness item D).
 *
 * TEST DESIGN NOTE — read before adding cases. This is a *reporting* feature,
 * which makes it the easiest place in the repo to write a test that proves
 * nothing: recompute `covered / total` the same way the implementation does
 * and every assertion passes no matter what the implementation says. So every
 * expectation below is a LITERAL worked out by hand from the fixture, never
 * derived from the counts object or from another readiness field. If a change
 * makes one of these numbers wrong, the literal fails; if the numbers were
 * recomputed, nothing would.
 *
 * The hazard this whole feature exists to prevent is invariant 5 — a check
 * that cannot succeed reporting a confident number instead of `Unknown`. The
 * `invariant 5` block below asserts both directions, because only one of them
 * is interesting on its own: `Unknown` where nothing was checked, AND a real
 * `0%` where the check ran and genuinely found nothing. A implementation that
 * mapped every zero to Unknown would pass the first half and fail the second.
 */
import { describe, expect, it } from 'vitest';

import { CuratorDb, type ReadinessCounts } from './db.js';
import { computeLibraryReadiness, summarizeReadiness, type ReadinessMetric } from './readiness.js';

const MODEL = 'nomic-embed-text';

function addBook(db: CuratorDb, id: string): void {
  db.upsertBook({
    id,
    title: `Title ${id}`,
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: 1_000,
  });
}

function enrich(db: CuratorDb, id: string, status: 'ok' | 'not-found' | 'error'): void {
  db.upsertExternalMetadata({
    bookId: id,
    provider: 'openlibrary',
    payload: status === 'ok' ? { hit: true } : null,
    fetchedAt: 1_000,
    status,
  });
}

function embed(db: CuratorDb, id: string, model = MODEL): void {
  db.upsertBookEmbedding({ bookId: id, model, cardHash: `hash-${id}`, vector: new Float32Array([0.1, 0.2]) });
}

function tag(db: CuratorDb, id: string): void {
  db.replaceBookTags(id, [{ tag: 'noir', category: 'genre', confidence: 0.9, source: 'llm-open' }], 1_000);
}

function metric(metrics: ReadinessMetric[], key: string): ReadinessMetric {
  const found = metrics.find((m) => m.key === key);
  if (!found) throw new Error(`no metric ${key}`);
  return found;
}

/**
 * The hand-built fixture. Worked out on paper first; the literals asserted
 * against it are transcribed from that working, not read back off the code.
 *
 *   book  enrichment    entities  tag_run        embedding
 *   a1    ok            yes       v1 + tags      nomic-embed-text
 *   a2    ok            —         v1             nomic-embed-text
 *   a3    ok            yes       v1             nomic-embed-text
 *   a4    not-found     —         v1             other-model
 *   a5    error         —         v1             —
 *   a6    ok            —         v1             —
 *   a7    (never run)   —         —              —
 *   a8    (never run)   —         —              —
 *   t1    ok            yes       tags, NO run   nomic-embed-text   TOMBSTONED
 *
 * Expected, by hand, over the 8 ACTIVE books (t1 excluded entirely):
 *   enriched  4 'ok' of 8          = 50%   3 unknown (a7, a8 never run; a5 errored)
 *   entities  2 of 8               = 25%   3 unknown (same three)
 *   tagged    6 runs at v1 of 8    = 75%   0 unknown (a7/a8 have no tags either,
 *                                                     so they are a confident "untagged")
 *   embedded  3 at MODEL of 8      = 37.5% -> 38%   a4's vector is another model
 */
function fixtureDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 't1']) addBook(db, id);

  enrich(db, 'a1', 'ok');
  enrich(db, 'a2', 'ok');
  enrich(db, 'a3', 'ok');
  enrich(db, 'a4', 'not-found');
  enrich(db, 'a5', 'error');
  enrich(db, 'a6', 'ok');
  enrich(db, 't1', 'ok');
  // a7, a8: enrichment never ran -> "unknown", not "no".

  db.replaceBookEntities('a1', [{ entity: 'Ahab', kind: 'person', sources: ['openlibrary'] }]);
  db.replaceBookEntities('a3', [{ entity: 'Maine', kind: 'place', sources: ['openlibrary'] }]);
  db.replaceBookEntities('t1', [{ entity: 'Ghost', kind: 'person', sources: ['openlibrary'] }]);

  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 't1']) db.recordTagRun(id, ['genre'], 1, 1_000);

  // a1 carries book_tags AND a tag_run. Without a book of this shape the
  // `NOT EXISTS (SELECT 1 FROM tag_runs ...)` clause in taggedVersionUnknown
  // is exercised by nothing: deleting it left the entire suite green, while
  // on the real library (955 tagged of 955) it would push unknown to 955,
  // trip `unknown >= total`, and report a fully audited library as
  // "Every tagged book predates the tag-run log".
  tag(db, 'a1');
  // t1 is tagged with NO run and is tombstoned — the only book that catches
  // the loss of the active-scope on this specific query.
  tag(db, 't1');

  embed(db, 'a1');
  embed(db, 'a2');
  embed(db, 'a3');
  embed(db, 'a4', 'other-model');
  embed(db, 't1');

  db.tombstoneBook('t1');
  return db;
}

describe('getReadinessCounts — raw counts, active books only', () => {
  it('counts each dimension over the hand-built fixture', () => {
    const db = fixtureDb();
    try {
      const counts = db.getReadinessCounts({ schemaVersion: 1, embeddingModel: MODEL });
      expect(counts.totalBooks).toBe(8);
      // 5, not 6: a5's row is status 'error'. An errored lookup is a check
      // that could not complete, so it must land in `unknown` where a retry
      // can still change the answer — not be reported as a confident "no".
      expect(counts.enrichmentAttempted).toBe(5);
      expect(counts.externalResolved).toBe(4);
      expect(counts.withEntities).toBe(2);
      expect(counts.taggedAtVersion).toBe(6);
      expect(counts.taggedVersionUnknown).toBe(0);
      expect(counts.embeddedAtModel).toBe(3);
      expect(counts.embeddedAnyModel).toBe(4);
    } finally {
      db.close();
    }
  });

  it('excludes tombstoned books from both numerator and denominator', () => {
    // t1 is enriched, entity-grounded, tag-run at v1 and embedded — every
    // count above would be one higher if the tombstone were ignored, and the
    // denominator would be 9. Asserted as literals in the case above; this
    // case proves the tombstone is what makes the difference.
    const db = fixtureDb();
    try {
      const withTombstone = db.getReadinessCounts({ schemaVersion: 1, embeddingModel: MODEL });
      // Bring t1 back to life exactly as a sync would.
      addBook(db, 't1');
      const revived = db.getReadinessCounts({ schemaVersion: 1, embeddingModel: MODEL });
      expect(withTombstone.totalBooks).toBe(8);
      expect(revived.totalBooks).toBe(9);
      expect(withTombstone.externalResolved).toBe(4);
      expect(revived.externalResolved).toBe(5);
      expect(withTombstone.withEntities).toBe(2);
      expect(revived.withEntities).toBe(3);
      expect(withTombstone.embeddedAtModel).toBe(3);
      expect(revived.embeddedAtModel).toBe(4);
    } finally {
      db.close();
    }
  });

  it('a tag run at an older schema version does not count as covered at the current one', () => {
    const db = new CuratorDb(':memory:');
    try {
      addBook(db, 'old');
      db.recordTagRun('old', ['genre'], 0, 1_000);
      const counts = db.getReadinessCounts({ schemaVersion: 1, embeddingModel: MODEL });
      expect(counts.taggedAtVersion).toBe(0);
      // It HAS a run, so its version is known — it is a confident "not at the
      // current version", not an unknown.
      expect(counts.taggedVersionUnknown).toBe(0);
    } finally {
      db.close();
    }
  });

  it('a book with tags but no tag run counts as version-unknown, not as untagged', () => {
    const db = new CuratorDb(':memory:');
    try {
      addBook(db, 'pre-a');
      addBook(db, 'never');
      tag(db, 'pre-a'); // tagged before tag_runs existed
      const counts = db.getReadinessCounts({ schemaVersion: 1, embeddingModel: MODEL });
      expect(counts.totalBooks).toBe(2);
      expect(counts.taggedAtVersion).toBe(0);
      expect(counts.taggedVersionUnknown).toBe(1); // 'never' is not in here
    } finally {
      db.close();
    }
  });
});

describe('summarizeReadiness — percentages over the hand-built fixture', () => {
  it('reports the four hand-derived percentages, statuses and unknown counts', () => {
    const db = fixtureDb();
    try {
      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL, now: () => 42 });
      expect(r.totalBooks).toBe(8);
      expect(r.generatedAt).toBe(42);
      expect(r.unmeasured).toEqual([]);

      const enriched = metric(r.metrics, 'enriched');
      expect(enriched.pct).toBe(50); // 4 of 8
      expect(enriched.covered).toBe(4);
      expect(enriched.unknown).toBe(3); // a7, a8 never run + a5 errored
      expect(enriched.status).toBe('Good');

      const entities = metric(r.metrics, 'entities');
      expect(entities.pct).toBe(25); // 2 of 8
      expect(entities.covered).toBe(2);
      expect(entities.unknown).toBe(3); // same three: entity status is unknowable where enrichment never answered
      expect(entities.status).toBe('Attention');

      const tagged = metric(r.metrics, 'tagged');
      expect(tagged.pct).toBe(75); // 6 of 8
      expect(tagged.covered).toBe(6);
      expect(tagged.unknown).toBe(0);
      expect(tagged.status).toBe('Good');

      const embedded = metric(r.metrics, 'embedded');
      expect(embedded.pct).toBe(38); // 3 of 8 = 37.5, rounded
      expect(embedded.covered).toBe(3);
      expect(embedded.status).toBe('Attention');
      // The a4 vector exists but was made by a different model, so it is not
      // comparable and must not be counted as coverage.
      expect(embedded.note).toContain('1 embedded under a different model');
    } finally {
      db.close();
    }
  });

  it('discloses only the materially low metrics, and stays silent about the healthy one', () => {
    const db = fixtureDb();
    try {
      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL });
      expect(r.disclosure).not.toBeNull();
      // entities (25%) and embedded (38%) are below the bar.
      expect(r.disclosure).toContain('only 25% of books have grounded characters or places (2 of 8)');
      expect(r.disclosure).toContain('only 38% of books are embedded for semantic search (3 of 8)');
      // enriched is exactly at the 50% bar, so it is disclosed for its unknown
      // share (2 of 8 = 25% >= 10%), not for its percentage.
      expect(r.disclosure).toContain('and 3 more were never enriched');
      // tagged is 75% with nothing unknown — a caveat about it would be noise.
      expect(r.disclosure).not.toContain('tag schema');
    } finally {
      db.close();
    }
  });

  it('says nothing at all when every metric is healthy', () => {
    const db = new CuratorDb(':memory:');
    try {
      for (const id of ['h1', 'h2', 'h3', 'h4']) {
        addBook(db, id);
        enrich(db, id, 'ok');
        db.replaceBookEntities(id, [{ entity: 'Someone', kind: 'person', sources: ['openlibrary'] }]);
        db.recordTagRun(id, ['genre'], 1, 1_000);
        embed(db, id);
      }
      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL });
      expect(r.metrics.map((m) => m.pct)).toEqual([100, 100, 100, 100]);
      expect(r.metrics.every((m) => m.status === 'Great')).toBe(true);
      expect(r.disclosure).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('invariant 5 — a check that cannot succeed reports Unknown, never a confident number', () => {
  it('reports Unknown, not 0%, for enrichment and entities when enrichment has never run', () => {
    const db = new CuratorDb(':memory:');
    try {
      for (const id of ['n1', 'n2', 'n3']) addBook(db, id);
      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL });

      const enriched = metric(r.metrics, 'enriched');
      expect(enriched.pct).toBeNull();
      expect(enriched.pct).not.toBe(0); // the exact lie this feature exists to prevent
      expect(enriched.covered).toBeNull();
      expect(enriched.status).toBe('Unknown');
      expect(enriched.note).toBe('Enrichment has never run for any book');

      const entities = metric(r.metrics, 'entities');
      expect(entities.pct).toBeNull();
      expect(entities.status).toBe('Unknown');

      expect(r.unmeasured).toContain('enriched');
      expect(r.unmeasured).toContain('entities');
      expect(r.disclosure).toContain('External metadata coverage is Unknown');
    } finally {
      db.close();
    }
  });

  it('reports a REAL 0% when enrichment ran and every provider missed', () => {
    // The other half of the invariant. An implementation that mapped every
    // zero to Unknown would pass the case above and fail this one.
    const db = new CuratorDb(':memory:');
    try {
      for (const id of ['m1', 'm2', 'm3', 'm4']) {
        addBook(db, id);
        enrich(db, id, 'not-found');
      }
      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL });
      const enriched = metric(r.metrics, 'enriched');
      expect(enriched.pct).toBe(0);
      expect(enriched.covered).toBe(0);
      expect(enriched.unknown).toBe(0);
      expect(enriched.status).toBe('Attention');
      expect(r.unmeasured).not.toContain('enriched');
    } finally {
      db.close();
    }
  });

  it('reports embedded as Unknown, not 0%, when no embedding model is configured', () => {
    const db = new CuratorDb(':memory:');
    try {
      for (const id of ['e1', 'e2']) addBook(db, id);
      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: null });
      const embedded = metric(r.metrics, 'embedded');
      expect(embedded.pct).toBeNull();
      expect(embedded.status).toBe('Unknown');
      expect(embedded.note).toBe('No embedding model is configured');
      expect(r.unmeasured).toContain('embedded');
    } finally {
      db.close();
    }
  });

  it('reports tagged as Unknown when every tagged book predates the tag-run log', () => {
    const db = new CuratorDb(':memory:');
    try {
      for (const id of ['p1', 'p2']) {
        addBook(db, id);
        tag(db, id);
      }
      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL });
      const tagged = metric(r.metrics, 'tagged');
      expect(tagged.pct).toBeNull();
      expect(tagged.status).toBe('Unknown');
      expect(tagged.note).toBe('Every tagged book predates the tag-run log, so no schema version is recorded');
    } finally {
      db.close();
    }
  });

  it('reports every metric as Unknown, and refuses to answer, on an empty mirror', () => {
    const db = new CuratorDb(':memory:');
    try {
      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL });
      expect(r.totalBooks).toBe(0);
      expect(r.metrics.map((m) => m.pct)).toEqual([null, null, null, null]);
      expect(r.metrics.map((m) => m.status)).toEqual(['Unknown', 'Unknown', 'Unknown', 'Unknown']);
      expect(r.unmeasured).toEqual(['enriched', 'entities', 'tagged', 'embedded']);
      expect(r.disclosure).toContain('The library mirror is empty');
      // The empty-mirror disclosure also carries a directive ("Say so rather
      // than answering") that must not reach the header.
      expect(r.disclosure).toContain('Say so rather than answering');
      expect(r.caveat).not.toContain('Say so rather than answering');
      expect(r.caveat).toContain('Nothing has been synced');
    } finally {
      db.close();
    }
  });
});

describe('exit criterion — a library at 31% entity coverage says so', () => {
  /**
   * The real library's own numbers, taken from the readiness plan's "current
   * state" table (955 books, 692 Open Library resolved, 297 with grounded
   * entities) rather than from anything this code computes. 297/955 = 31.1%
   * and 692/955 = 72.4%; the expected 31 and 72 below were derived from those
   * source figures by hand.
   */
  const counts: ReadinessCounts = {
    totalBooks: 955,
    enrichmentAttempted: 955,
    externalResolved: 692,
    withEntities: 297,
    taggedAtVersion: 955,
    taggedVersionUnknown: 0,
    embeddedAtModel: 955,
    embeddedAnyModel: 955,
  };

  it('renders the entity coverage as 31%, not as a confident silence', () => {
    const r = summarizeReadiness(counts, { schemaVersion: 1, embeddingModel: MODEL });
    const entities = metric(r.metrics, 'entities');
    expect(entities.pct).toBe(31);
    expect(entities.covered).toBe(297);
    expect(entities.total).toBe(955);
    expect(entities.status).toBe('Attention');
    expect(metric(r.metrics, 'enriched').pct).toBe(72);
  });

  it('produces a disclosure the librarian must state, naming the 31% figure', () => {
    const r = summarizeReadiness(counts, { schemaVersion: 1, embeddingModel: MODEL });
    expect(r.disclosure).not.toBeNull();
    expect(r.disclosure).toContain('only 31% of books have grounded characters or places (297 of 955)');
    expect(r.disclosure).toContain('state this in your answer');
    expect(r.disclosure).toContain('may simply be uncovered rather than a poor match');

    // The Desk header renders `caveat`, never `disclosure`. `disclosure` is
    // prompt text addressed to the librarian in the second person; it was
    // once rendered verbatim to a human, who was told to "state this in your
    // answer before recommending".
    expect(r.disclosure).toContain('state this in your answer');
    expect(r.caveat).not.toContain('state this in your answer');
    expect(r.caveat).not.toContain('your answer');
    expect(r.caveat).toContain('Coverage is still partial');
    // Same facts, same numbers — only the framing differs.
    expect(r.caveat).toContain('may simply be uncovered rather than a poor match');
    // 72% enriched, 100% tagged and 100% embedded are fine — the caveat must
    // be about the one dimension that is actually thin, or it teaches the
    // reader to ignore it.
    expect(r.disclosure).not.toContain('have external metadata');
    expect(r.disclosure).not.toContain('tag schema');
  });
});
