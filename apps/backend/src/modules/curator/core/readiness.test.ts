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
import { beforeEach, describe, expect, it } from 'vitest';

import { CuratorDb, type ReadinessCounts } from './db.js';
import {
  computeLibraryReadiness,
  invalidateReadinessCache,
  READINESS_CACHE_TTL_MS,
  summarizeReadiness,
  type ReadinessDb,
  type ReadinessMetric,
} from './readiness.js';
import {
  composeEmbeddingCard,
  countEmbeddingFreshness,
  embedBooks,
  EMBEDDING_CARD_OPTIONS,
} from './retrieval/embedder.js';
import { createStubEmbeddingCreator } from './retrieval/fixtures/stubEmbedder.js';

const MODEL = 'nomic-embed-text';

// `computeLibraryReadiness` memoizes its snapshot; without this, one test's
// library can answer another's question.
beforeEach(() => {
  invalidateReadinessCache();
});

function addBook(db: CuratorDb, id: string, description: string | null = null): void {
  db.upsertBook({
    id,
    title: `Title ${id}`,
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description,
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

/**
 * Store an embedding whose `card_hash` does NOT match the book's card — the
 * shape a stale vector has: present, at the right model, describing text the
 * book no longer has.
 */
function embed(db: CuratorDb, id: string, model = MODEL): void {
  db.upsertBookEmbedding({ bookId: id, model, cardHash: `hash-${id}`, vector: new Float32Array([0.1, 0.2]) });
}

/**
 * Store an embedding the way a real run does: over the card the book actually
 * has right now, composed through the SAME helper `embedBooks` uses. Call it
 * after the book's tags and entities are in place, exactly as a pipeline
 * would.
 */
function embedFresh(db: CuratorDb, id: string, model = MODEL): void {
  const card = composeEmbeddingCard(db, db.getBook(id)!);
  db.upsertBookEmbedding({ bookId: id, model, cardHash: card.hash, vector: new Float32Array([0.1, 0.2]) });
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
 *   a1    ok            yes       v1 + tags      nomic-embed-text, CURRENT card
 *   a2    ok            —         v1             nomic-embed-text, CURRENT card
 *   a3    ok            yes       v1             nomic-embed-text, WRONG card hash
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
 *   embedded  2 USABLE of 8        = 25%   2 stale (a3's card changed, a4 is another
 *                                                   model), 4 never embedded
 *
 * The embedding rows deliberately span all three states in ONE fixture. A
 * mirror-image implementation that marked everything stale would satisfy any
 * assertion that only says "stale is detected"; a1/a2 reading fresh in the
 * same breath as a3/a4 reading stale is what rules it out. Note also that the
 * SQL counts (`embeddedAtModel: 3`, `embeddedAnyModel: 4`) are UNCHANGED from
 * the presence-based era — the whole point is that those numbers no longer
 * decide the metric.
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

  // Composed AFTER a1's tags and entities are in place, so these two really
  // are embedded over the card the book has now.
  embedFresh(db, 'a1');
  embedFresh(db, 'a2');
  // a3 has a vector at the right model over text it no longer has: stale.
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
      // 2 of 8, not 3 of 8: a3 has a row at the configured model, which the
      // presence-based version counted, but its card_hash describes text the
      // book no longer has.
      expect(embedded.pct).toBe(25);
      expect(embedded.covered).toBe(2);
      expect(embedded.stale).toBe(2); // a3 (card changed) + a4 (other model)
      expect(embedded.unknown).toBe(0); // staleness is knowable: a model is configured
      expect(embedded.status).toBe('Attention');
      // Stale and never-embedded are reported apart — they take different
      // remedies (a re-run vs. a first run).
      expect(embedded.note).toContain('4 never embedded');
      // The a4 vector exists but was made by a different model, so it is not
      // comparable and must not be counted as coverage.
      expect(embedded.note).toContain('1 embedded under a different model');
      // No other metric has a notion of staleness, and must not pretend to.
      expect(metric(r.metrics, 'enriched').stale).toBeUndefined();
      expect(metric(r.metrics, 'tagged').stale).toBeUndefined();
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
      expect(r.disclosure).toContain('only 25% of books have an up-to-date embedding for semantic search (2 of 8)');
      // Named distinctly, as its own clause: "2 have an out-of-date
      // embedding" is a different statement from "2 were never embedded",
      // and only one of them is fixed by re-running the embedder.
      expect(r.disclosure).toContain(
        'and 2 have an out-of-date embedding that no longer matches the book and should be re-embedded'
      );
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
        embedFresh(db, id);
      }
      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL });
      expect(r.metrics.map((m) => m.pct)).toEqual([100, 100, 100, 100]);
      expect(r.metrics.every((m) => m.status === 'Great')).toBe(true);
      // The other half of the freshness pairing: four books embedded over the
      // card they actually have read 100% and produce no caveat. An
      // implementation that marked everything stale would fail here while
      // still passing every "stale is detected" assertion above.
      expect(metric(r.metrics, 'embedded').stale).toBe(0);
      expect(metric(r.metrics, 'embedded').note).toBeUndefined();
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

  it('reports embedded as Unknown when the freshness census was not taken, rather than 0%', () => {
    // `summarizeReadiness` is public, and a caller that hands it counts but no
    // census must not get a confident percentage back off `embeddedAtModel` —
    // that is precisely the row-presence number this change stopped trusting.
    const r = summarizeReadiness(
      {
        totalBooks: 4,
        enrichmentAttempted: 4,
        externalResolved: 4,
        withEntities: 4,
        taggedAtVersion: 4,
        taggedVersionUnknown: 0,
        embeddedAtModel: 4,
        embeddedAnyModel: 4,
      },
      { schemaVersion: 1, embeddingModel: MODEL, embeddingFreshness: null }
    );
    const embedded = metric(r.metrics, 'embedded');
    expect(embedded.pct).toBeNull();
    expect(embedded.pct).not.toBe(100);
    expect(embedded.stale).toBeNull();
    expect(embedded.note).toBe('Embedding freshness was not measured for this snapshot');
    expect(r.unmeasured).toContain('embedded');
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
      // Stale is not Unknown, and Unknown is not "nothing is stale". With no
      // model there is nothing to judge a stored vector against, so staleness
      // is unknowable — `null`. Reporting `0` here would be the reassuring
      // claim "no book is out of date", made by a check that never ran.
      expect(embedded.stale).toBeNull();
      expect(embedded.stale).not.toBe(0);
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

  /** Every one of the 955 vectors current — the state item B exists to reach. */
  const allFresh = { fresh: 955, stale: 0, neverEmbedded: 0 };

  it('renders the entity coverage as 31%, not as a confident silence', () => {
    const r = summarizeReadiness(counts, { schemaVersion: 1, embeddingModel: MODEL, embeddingFreshness: allFresh });
    const entities = metric(r.metrics, 'entities');
    expect(entities.pct).toBe(31);
    expect(entities.covered).toBe(297);
    expect(entities.total).toBe(955);
    expect(entities.status).toBe('Attention');
    expect(metric(r.metrics, 'enriched').pct).toBe(72);
  });

  it('produces a disclosure the librarian must state, naming the 31% figure', () => {
    const r = summarizeReadiness(counts, { schemaVersion: 1, embeddingModel: MODEL, embeddingFreshness: allFresh });
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

describe('countEmbeddingFreshness — three states, judged by the embedder own predicate', () => {
  it('splits the fixture library into fresh / stale / never-embedded', () => {
    const db = fixtureDb();
    try {
      // Hand-worked from the fixture table: a1/a2 embedded over their current
      // cards, a3 over text it no longer has, a4 under another model, a5-a8
      // never embedded. t1 is tombstoned and appears in none of them.
      expect(countEmbeddingFreshness(db, MODEL)).toEqual({ fresh: 2, stale: 2, neverEmbedded: 4 });
    } finally {
      db.close();
    }
  });

  it('the three states always account for every active book, and no more', () => {
    const db = fixtureDb();
    try {
      const f = countEmbeddingFreshness(db, MODEL);
      // 8, not 9 — a census that lost the active scope would find t1 too.
      expect(f.fresh + f.stale + f.neverEmbedded).toBe(8);
      expect(db.getReadinessCounts({ schemaVersion: 1, embeddingModel: MODEL }).totalBooks).toBe(8);
    } finally {
      db.close();
    }
  });

  it('a model change makes an otherwise-current vector stale, never "never embedded"', () => {
    const db = fixtureDb();
    try {
      // Judged against a model nothing was embedded at: a1-a3's vectors are
      // now model-changed and a4's card hash still does not match, so all
      // four are STALE. The four books with no row at all stay never-embedded
      // — the two states must not bleed into each other, because one is fixed
      // by re-running the embedder and the other by running it at all.
      expect(countEmbeddingFreshness(db, 'a-third-model')).toEqual({ fresh: 0, stale: 4, neverEmbedded: 4 });
    } finally {
      db.close();
    }
  });
});

describe('a library whose every vector is stale must not read as its healthiest', () => {
  /**
   * The failure this change exists to fix, and not a hypothetical one: a
   * vocabulary consolidation rewrote 1,560 tag rows with no re-embed. Under
   * the presence-based metric that library reported "100% Embedded / Great" —
   * the most reassuring verdict the header can give, for its least usable
   * state.
   */
  it('reports 0% and four stale books, not 100% and Great', () => {
    const db = new CuratorDb(':memory:');
    try {
      for (const id of ['v1', 'v2', 'v3', 'v4']) {
        addBook(db, id);
        enrich(db, id, 'ok');
        db.replaceBookEntities(id, [{ entity: 'Someone', kind: 'person', sources: ['openlibrary'] }]);
        db.recordTagRun(id, ['genre'], 1, 1_000);
        tag(db, id);
        embedFresh(db, id);
      }
      // Every book was fully covered a moment ago.
      const before = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL });
      expect(metric(before.metrics, 'embedded').pct).toBe(100);

      // Now the consolidation: every book's tags are rewritten, so every
      // card_hash on record describes text no book still has.
      invalidateReadinessCache();
      for (const id of ['v1', 'v2', 'v3', 'v4']) {
        db.replaceBookTags(id, [{ tag: 'hardboiled', category: 'genre', confidence: 0.9, source: 'vocab' }], 2_000);
      }

      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL });
      const embedded = metric(r.metrics, 'embedded');
      expect(embedded.pct).toBe(0);
      expect(embedded.covered).toBe(0);
      expect(embedded.stale).toBe(4);
      expect(embedded.status).toBe('Attention');
      expect(embedded.status).not.toBe('Great');
      // Known-bad, not unknowable: we can tell exactly what is wrong with
      // these four, so they must not be filed under `unknown`.
      expect(embedded.unknown).toBe(0);
      // And none of them is "never embedded" — every one has a vector, it is
      // just the wrong one, so the remedy is a re-run and the note has
      // nothing else to say.
      expect(embedded.note).toBeUndefined();
      expect(r.caveat).toContain('and 4 have an out-of-date embedding');
      // The SQL row count is unchanged; only the predicate over it moved.
      expect(db.getReadinessCounts({ schemaVersion: 1, embeddingModel: MODEL }).embeddedAtModel).toBe(4);
    } finally {
      db.close();
    }
  });

  it('discloses staleness even when the confirmed percentage still looks healthy', () => {
    const db = new CuratorDb(':memory:');
    try {
      // Ten books, fully covered on every other axis; one of them goes stale.
      // 90% embedded is "Great" by percentage alone, so only the stale share
      // can surface it.
      for (let i = 0; i < 10; i++) {
        const id = `s${i}`;
        addBook(db, id);
        enrich(db, id, 'ok');
        db.replaceBookEntities(id, [{ entity: 'Someone', kind: 'person', sources: ['openlibrary'] }]);
        db.recordTagRun(id, ['genre'], 1, 1_000);
        tag(db, id);
        embedFresh(db, id);
      }
      db.replaceBookTags('s0', [{ tag: 'hardboiled', category: 'genre', confidence: 0.9, source: 'vocab' }], 2_000);

      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL });
      const embedded = metric(r.metrics, 'embedded');
      expect(embedded.pct).toBe(90);
      expect(embedded.status).toBe('Great');
      expect(embedded.stale).toBe(1);
      // 1 of 10 is exactly the 10% materiality share.
      expect(r.caveat).toContain('and 1 have an out-of-date embedding');
    } finally {
      db.close();
    }
  });

  it('stays silent about a stale share too small to be worth a permanent caveat', () => {
    const db = new CuratorDb(':memory:');
    try {
      // Twenty books, one stale: 5%, under the bar. A caveat present on every
      // answer stops being read, which would defeat the feature.
      for (let i = 0; i < 20; i++) {
        const id = `q${i}`;
        addBook(db, id);
        enrich(db, id, 'ok');
        db.replaceBookEntities(id, [{ entity: 'Someone', kind: 'person', sources: ['openlibrary'] }]);
        db.recordTagRun(id, ['genre'], 1, 1_000);
        tag(db, id);
        embedFresh(db, id);
      }
      db.replaceBookTags('q0', [{ tag: 'hardboiled', category: 'genre', confidence: 0.9, source: 'vocab' }], 2_000);

      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL });
      // Still counted and still shown on the chip — just not shouted about.
      expect(metric(r.metrics, 'embedded').stale).toBe(1);
      expect(metric(r.metrics, 'embedded').pct).toBe(95);
      expect(r.caveat).toBeNull();
      expect(r.disclosure).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('the composition-options trap — readiness composes cards exactly as the embedder does', () => {
  /**
   * If the readiness path and `embedBooks` disagree about ANY composition
   * option — `descriptionChars` above all — every hash mismatches and the
   * whole library reads stale. That is a catastrophic false alarm which looks
   * exactly like a real finding, so it needs a test that fails on divergence
   * rather than a comment asking the next author to be careful.
   *
   * The description below is deliberately far longer than
   * `EMBEDDING_CARD_OPTIONS.descriptionChars`, so truncation actually happens
   * and a different limit really would produce different text.
   */
  const longDescription = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');

  it('a book the embedder just wrote reads fresh, and the embedder agrees there is nothing to redo', async () => {
    expect(longDescription.length).toBeGreaterThan(EMBEDDING_CARD_OPTIONS.descriptionChars * 1.5);

    const db = new CuratorDb(':memory:');
    try {
      addBook(db, 'd1', longDescription);
      tag(db, 'd1');
      db.replaceBookEntities('d1', [{ entity: 'Someone', kind: 'person', sources: ['openlibrary'] }]);

      const first = await embedBooks(db, createStubEmbeddingCreator(), { model: MODEL, concurrency: 1 });
      expect(first.embedded).toBe(1);

      // Direction 1: the readiness path judges what the embedder just wrote
      // as current.
      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL });
      const embedded = metric(r.metrics, 'embedded');
      expect(embedded.pct).toBe(100);
      expect(embedded.covered).toBe(1);
      expect(embedded.stale).toBe(0);

      // Direction 2: the embedder agrees, and would make zero embed calls.
      // Both directions matter — asserting only the first would let a
      // readiness path that judged everything fresh pass.
      const second = await embedBooks(db, createStubEmbeddingCreator(), { model: MODEL, concurrency: 1 });
      expect(second.unchanged).toBe(1);
      expect(second.embedded).toBe(0);
    } finally {
      db.close();
    }
  });

  it('and flips to stale the moment the truncated card text actually changes', async () => {
    // The paired case: identical setup, one edit inside the composed card.
    // Without it, an implementation that never reports stale passes above.
    const db = new CuratorDb(':memory:');
    try {
      addBook(db, 'd2', longDescription);
      tag(db, 'd2');
      await embedBooks(db, createStubEmbeddingCreator(), { model: MODEL, concurrency: 1 });

      db.replaceBookTags('d2', [{ tag: 'cosy', category: 'genre', confidence: 0.9, source: 'vocab' }], 2_000);

      const r = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL });
      expect(metric(r.metrics, 'embedded').pct).toBe(0);
      expect(metric(r.metrics, 'embedded').stale).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('readiness snapshot cache', () => {
  /** Counts how often the snapshot actually goes to the database. */
  function counting(db: CuratorDb): { db: ReadinessDb; counts: () => number; census: () => number } {
    let countQueries = 0;
    let censusQueries = 0;
    return {
      db: {
        getReadinessCounts: (o) => {
          countQueries += 1;
          return db.getReadinessCounts(o);
        },
        getStaleEmbeddings: (o) => {
          censusQueries += 1;
          return o ? db.getStaleEmbeddings(o) : db.getStaleEmbeddings();
        },
        getTagsForBook: (id) => db.getTagsForBook(id),
        getEntitiesForBook: (id) => db.getEntitiesForBook(id),
      },
      counts: () => countQueries,
      census: () => censusQueries,
    };
  }

  it('serves a repeat call within the TTL from the snapshot, and recomputes once it expires', () => {
    const db = fixtureDb();
    try {
      const probe = counting(db);
      let clock = 1_000_000;
      const opts = { schemaVersion: 1, embeddingModel: MODEL, now: () => clock };

      const first = computeLibraryReadiness(probe.db, opts);
      expect(probe.counts()).toBe(1);
      expect(probe.census()).toBe(1);

      // The `query_library` case: the same snapshot re-requested each round of
      // the agent loop must not re-compose 955 cards every time.
      clock += READINESS_CACHE_TTL_MS - 1;
      expect(computeLibraryReadiness(probe.db, opts)).toBe(first);
      expect(probe.counts()).toBe(1);
      expect(probe.census()).toBe(1);

      clock += 1; // exactly TTL old — no longer good
      const third = computeLibraryReadiness(probe.db, opts);
      expect(third).not.toBe(first);
      expect(probe.counts()).toBe(2);
      expect(probe.census()).toBe(2);
    } finally {
      db.close();
    }
  });

  it('never serves one library snapshot for another, or across a config change', () => {
    const big = fixtureDb();
    const small = new CuratorDb(':memory:');
    try {
      addBook(small, 'only-one');
      const at = () => 5_000; // one instant: only the key can force a miss

      expect(computeLibraryReadiness(big, { schemaVersion: 1, embeddingModel: MODEL, now: at }).totalBooks).toBe(8);
      expect(computeLibraryReadiness(small, { schemaVersion: 1, embeddingModel: MODEL, now: at }).totalBooks).toBe(1);
      expect(computeLibraryReadiness(big, { schemaVersion: 1, embeddingModel: MODEL, now: at }).totalBooks).toBe(8);

      // Turning the embedding model off must not keep serving a snapshot that
      // reports a confident percentage for it.
      const off = computeLibraryReadiness(big, { schemaVersion: 1, embeddingModel: null, now: at });
      expect(metric(off.metrics, 'embedded').pct).toBeNull();
      expect(metric(off.metrics, 'embedded').stale).toBeNull();
    } finally {
      big.close();
      small.close();
    }
  });

  it('does not keep serving a snapshot after the clock jumps backwards', () => {
    // An NTP correction or a container clock skew makes the snapshot's age
    // meaningless. Without this the snapshot could outlive its TTL by however
    // far the clock moved, which is a silent, unbounded staleness — the exact
    // failure mode this whole change is about, in the cache itself.
    const db = fixtureDb();
    try {
      const probe = counting(db);
      let clock = 1_000_000;
      const opts = { schemaVersion: 1, embeddingModel: MODEL, now: () => clock };
      computeLibraryReadiness(probe.db, opts);
      expect(probe.counts()).toBe(1);
      clock -= 5_000;
      computeLibraryReadiness(probe.db, opts);
      expect(probe.counts()).toBe(2);
    } finally {
      db.close();
    }
  });

  it('does not serve a snapshot computed against a different tag schema version', () => {
    // `taggedAtVersion` is computed FOR a schema version, so a snapshot taken
    // at v1 says nothing about v2. Same db, same instant: only the key can
    // force the miss.
    const db = fixtureDb();
    try {
      const at = () => 9_000;
      const v1 = computeLibraryReadiness(db, { schemaVersion: 1, embeddingModel: MODEL, now: at });
      const v2 = computeLibraryReadiness(db, { schemaVersion: 2, embeddingModel: MODEL, now: at });
      expect(metric(v1.metrics, 'tagged').pct).toBe(75); // 6 runs at v1 of 8
      // Nothing was ever tagged at v2, and those books carry tag_runs, so it
      // is a confident 0% rather than Unknown.
      expect(metric(v2.metrics, 'tagged').pct).toBe(0);
      expect(v2.schemaVersion).toBe(2);
    } finally {
      db.close();
    }
  });

  it('invalidateReadinessCache forces the next read to go to the database', () => {
    const db = fixtureDb();
    try {
      const probe = counting(db);
      const opts = { schemaVersion: 1, embeddingModel: MODEL, now: () => 7_000 };
      computeLibraryReadiness(probe.db, opts);
      expect(probe.counts()).toBe(1);
      computeLibraryReadiness(probe.db, opts);
      expect(probe.counts()).toBe(1);
      invalidateReadinessCache();
      computeLibraryReadiness(probe.db, opts);
      expect(probe.counts()).toBe(2);
    } finally {
      db.close();
    }
  });
});
