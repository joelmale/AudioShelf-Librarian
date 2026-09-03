/**
 * Route-level tests for the vocabulary promotion queue. DB-level behavior
 * (refreshProposedVocabCounts, retagLlmOpenTags, isVocabTerm, ...) is already
 * exercised in core/db.vocab.test.ts — these tests cover only what lives in
 * the route itself: request validation, 404/400 mapping, and response shape.
 */
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../../core/db.js';
import { composeBookCardFromDb } from '../../core/retrieval/bookCard.js';
import { isEmbeddingStale } from '../../core/retrieval/embedder.js';
import { createStubEmbeddingCreator, stubEmbed } from '../../core/retrieval/fixtures/stubEmbedder.js';
import type { EmbeddingCreator, EmbeddingRequest } from '../../core/retrieval/embeddings.js';
import type { Book } from '../../core/types.js';
import { errorHandler } from '../http.js';
import type { ApiServices } from '../services.js';
import { createVocabRouter } from './vocab.js';

const EMBEDDING_MODEL = 'stub-model';

function addBook(db: CuratorDb, input: Pick<Book, 'id' | 'title'>): void {
  db.upsertBook({
    ...input,
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
  });
}

/** `embeddingCreator` defaults to the deterministic offline stub — pass one
 *  explicitly to exercise the re-embed failure path (readiness plan item B). */
function buildApp(db: CuratorDb, embeddingCreator: EmbeddingCreator = createStubEmbeddingCreator()) {
  const app = express();
  app.use(express.json());
  const services = {
    db,
    config: { embeddingModel: EMBEDDING_MODEL, taggingConcurrency: 2 },
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    actionLog: { record: () => {} },
    embeddingCreator,
  } as unknown as ApiServices;
  app.use('/api', createVocabRouter(services));
  app.use(errorHandler({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as never));
  return app;
}

const databases: CuratorDb[] = [];
const servers: import('node:http').Server[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function makeDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

describe('GET /vocab/proposed', () => {
  it('refreshes counts then returns proposed terms with sample titles', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    db.replaceBookTags('b1', [{ tag: 'noblebright', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1000);
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/proposed`);
    const body = (await res.json()) as Array<{ term: string; sampleBooks: string[] }>;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ term: 'noblebright', category: 'mood', status: 'proposed', bookCount: 1 });
    expect(body[0]?.sampleBooks).toEqual(['Alpha']);
  });

  it('adds alias suggestions and marks cross-category collisions', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    addBook(db, { id: 'b2', title: 'Beta' });
    addBook(db, { id: 'b3', title: 'Gamma' });
    db.setVocabTermStatus('space-opera', 'genre', 'promoted', 1);
    db.replaceBookTags('b1', [{ tag: 'spaceopera', category: 'genre', confidence: 0.8, source: 'llm-open' }], 1);
    db.replaceBookTags('b2', [{ tag: 'adventure', category: 'theme', confidence: 0.8, source: 'llm-open' }], 1);
    db.replaceBookTags('b3', [{ tag: 'adventure', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1);

    const res = await fetch(`${await listen(buildApp(db))}/api/vocab/proposed`);
    const body = (await res.json()) as Array<{ term: string; categoryCollision: boolean; aliasSuggestions: string[] }>;
    expect(body.find((row) => row.term === 'spaceopera')?.aliasSuggestions).toContain('space-opera');
    expect(body.find((row) => row.term === 'adventure')?.categoryCollision).toBe(true);
  });
});

describe('GET /vocab/proposed/books', () => {
  it('returns every matching active book with its effective description', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    addBook(db, { id: 'b2', title: 'Beta' });
    db.setEnrichedDescription('b1', { text: 'A remembered plot description.', source: 'googlebooks' });
    db.replaceBookTags('b1', [{ tag: 'coastal-town', category: 'setting', confidence: 0.8, source: 'llm-open' }], 1);
    db.replaceBookTags('b2', [{ tag: 'coastal-town', category: 'setting', confidence: 0.8, source: 'llm-open' }], 1);
    db.refreshProposedVocabCounts(1);

    const query = new URLSearchParams({ term: 'coastal-town', category: 'setting' });
    const res = await fetch(`${await listen(buildApp(db))}/api/vocab/proposed/books?${query}`);
    const body = (await res.json()) as { total: number; books: Array<{ title: string; description: string | null }> };
    expect(res.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.books).toEqual([
      expect.objectContaining({ title: 'Alpha', description: 'A remembered plot description.' }),
      expect.objectContaining({ title: 'Beta', description: null }),
    ]);
  });

  it('reconstructs every provider-cache book without creating book tags', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    addBook(db, { id: 'b2', title: 'Beta' });
    addBook(db, { id: 'b3', title: 'Gamma' });
    for (const bookId of ['b1', 'b2']) {
      db.upsertExternalMetadata({
        bookId,
        provider: 'googlebooks',
        payload: { subjects: ['Space Adventure'] },
        fetchedAt: 1,
        status: 'ok',
      });
    }
    db.refreshEnrichmentVocabProposals([{ term: 'space-adventure', category: 'genre', bookCount: 2 }], 1);
    db.replaceBookTags('b3', [{ tag: 'space-adventure', category: 'genre', confidence: 0.8, source: 'llm-open' }], 1);
    db.refreshProposedVocabCounts(1);

    const query = new URLSearchParams({ term: 'space-adventure', category: 'genre' });
    const res = await fetch(`${await listen(buildApp(db))}/api/vocab/proposed/books?${query}`);
    const body = (await res.json()) as { total: number; books: Array<{ title: string }> };
    expect(res.status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.books.map((book) => book.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(db.getAllBookTags()).toHaveLength(1);
  });
});

describe('POST /vocab/batch', () => {
  it('promotes atomically and de-duplicates books before one re-embed pass', async () => {
    const db = makeDb();
    for (const [id, title] of [['b1', 'Alpha'], ['b2', 'Beta'], ['b3', 'Gamma']] as const) addBook(db, { id, title });
    db.replaceBookTags('b1', [{ tag: 'bright', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1);
    db.replaceBookTags('b2', [
      { tag: 'bright', category: 'mood', confidence: 0.8, source: 'llm-open' },
      { tag: 'community', category: 'theme', confidence: 0.8, source: 'llm-open' },
    ], 1);
    db.replaceBookTags('b3', [{ tag: 'community', category: 'theme', confidence: 0.8, source: 'llm-open' }], 1);
    db.refreshProposedVocabCounts(1);

    const res = await fetch(`${await listen(buildApp(db))}/api/vocab/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'promote', terms: [
        { term: 'bright', category: 'mood' }, { term: 'community', category: 'theme' },
      ] }),
    });
    const body = (await res.json()) as { reviewed: number; retagged: number; affectedBooks: number; reembed: { attempted: boolean } };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ reviewed: 2, retagged: 4, affectedBooks: 3 });
    expect(body.reembed.attempted).toBe(true);
    expect(db.getTagsForBook('b2').every((tag) => tag.source === 'vocab')).toBe(true);
  });

  it('applies nothing when any item is missing', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    db.replaceBookTags('b1', [{ tag: 'bright', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1);
    db.refreshProposedVocabCounts(1);
    const res = await fetch(`${await listen(buildApp(db))}/api/vocab/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'promote', terms: [
        { term: 'bright', category: 'mood' }, { term: 'missing', category: 'theme' },
      ] }),
    });
    expect(res.status).toBe(400);
    expect(db.getVocabTerms(['proposed']).some((row) => row.term === 'bright')).toBe(true);
    expect(db.getTagsForBook('b1')[0]?.source).toBe('llm-open');
  });

  it('blocks cross-category bulk promotion but permits transactional bulk rejection', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    addBook(db, { id: 'b2', title: 'Beta' });
    db.replaceBookTags('b1', [{ tag: 'adventure', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1);
    db.replaceBookTags('b2', [{ tag: 'adventure', category: 'theme', confidence: 0.8, source: 'llm-open' }], 1);
    db.refreshProposedVocabCounts(1);
    const base = await listen(buildApp(db));

    const blocked = await fetch(`${base}/api/vocab/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'promote', terms: [{ term: 'adventure', category: 'mood' }] }),
    });
    expect(blocked.status).toBe(400);
    expect(db.isVocabTerm('adventure', 'mood')).toBe(false);

    const rejected = await fetch(`${base}/api/vocab/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject', terms: [
        { term: 'adventure', category: 'mood' }, { term: 'adventure', category: 'theme' },
      ] }),
    });
    expect(rejected.status).toBe(200);
    expect(db.getVocabTerms(['rejected']).filter((row) => row.term === 'adventure')).toHaveLength(2);
  });
});

describe('POST /vocab/promote', () => {
  it('404s when the term is not a proposed vocab term', async () => {
    const db = makeDb();
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'ghost', category: 'mood' }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('400s on an invalid body', async () => {
    const db = makeDb();
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'x', category: 'not-a-category' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION');
  });

  it('promotes a proposed term and retags matching llm-open rows to vocab', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    addBook(db, { id: 'b2', title: 'Beta' });
    db.replaceBookTags('b1', [{ tag: 'noblebright', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1000);
    db.replaceBookTags('b2', [{ tag: 'noblebright', category: 'mood', confidence: 0.6, source: 'llm-open' }], 1000);
    db.refreshProposedVocabCounts(1000);
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'noblebright', category: 'mood' }),
    });
    const body = (await res.json()) as {
      term: string;
      category: string;
      status: string;
      retagged: number;
      reembed: { attempted: boolean };
    };

    expect(res.status).toBe(200);
    // Exact shape (not toMatchObject) so an accidental extra field on this
    // response still fails the test.
    expect(body).toEqual({
      term: 'noblebright',
      category: 'mood',
      status: 'promoted',
      retagged: 2,
      reembed: expect.anything(),
    });
    expect(body.reembed.attempted).toBe(true);
    expect(db.isVocabTerm('noblebright', 'mood')).toBe(true);
    expect(db.getTagsForBook('b1')[0]).toMatchObject({ tag: 'noblebright', source: 'vocab' });
  });

  // Readiness plan item B, exit criterion (part a — the promote path).
  // Promote-to-self only flips `source: llm-open -> vocab`; composeBookCard
  // never renders `source` (bookCard.ts only emits `t.tag`), so this path
  // cannot demonstrate a card genuinely changing — every promoted book's
  // card is byte-identical before and after in production. What this test
  // DOES prove is the wiring: never-embedded books become embedded as a
  // direct effect of the promote request, checked through the real
  // predicate (isEmbeddingStale against a freshly composed card), not by
  // comparing a stored column to itself. The load-bearing "card really
  // changed" case is the alias test below.
  it('never-embedded books fail the real staleness check before promote, and pass it after', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    addBook(db, { id: 'b2', title: 'Beta' });
    db.replaceBookTags('b1', [{ tag: 'noblebright', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1000);
    db.replaceBookTags('b2', [{ tag: 'noblebright', category: 'mood', confidence: 0.6, source: 'llm-open' }], 1000);
    db.refreshProposedVocabCounts(1000);
    const app = buildApp(db);

    // Before: never embedded, so isEmbeddingStale — the real predicate the
    // embedder itself uses to decide whether to write a vector — says stale
    // for every book, against a card freshly composed from the db, not read
    // back from a stored row.
    for (const id of ['b1', 'b2']) {
      const candidate = db.getStaleEmbeddings({ bookIds: [id] })[0]!;
      const card = composeBookCardFromDb(db, id)!;
      expect(isEmbeddingStale(candidate, EMBEDDING_MODEL, card.hash)).toBe(true);
    }
    expect(db.getBookEmbedding('b1')).toBeNull();
    expect(db.getBookEmbedding('b2')).toBeNull();

    const res = await fetch(`${await listen(app)}/api/vocab/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'noblebright', category: 'mood' }),
    });
    expect(res.status).toBe(200);

    // After: the promote's own request wired a re-embed scoped to the
    // affected books, so the same real predicate — recomposing the card
    // fresh, not reading the stored card_hash column back at itself — now
    // says not-stale for both.
    for (const id of ['b1', 'b2']) {
      const candidate = db.getStaleEmbeddings({ bookIds: [id] })[0]!;
      const card = composeBookCardFromDb(db, id)!;
      expect(isEmbeddingStale(candidate, EMBEDDING_MODEL, card.hash)).toBe(false);
      expect(candidate.storedModel).toBe(EMBEDDING_MODEL);
    }
  });

  // Invariant: a failed re-embed must never fail or roll back the tag
  // mutation that preceded it. Simulates the embedder being unreachable.
  it('promote still succeeds and the tag mutation persists even when the re-embed fails for every book', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    db.replaceBookTags('b1', [{ tag: 'noblebright', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1000);
    db.refreshProposedVocabCounts(1000);

    const alwaysFails: EmbeddingCreator = {
      create: async () => {
        throw new Error('Ollama unreachable');
      },
    };
    const app = buildApp(db, alwaysFails);

    const res = await fetch(`${await listen(app)}/api/vocab/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'noblebright', category: 'mood' }),
    });
    const body = (await res.json()) as {
      status: string;
      retagged: number;
      reembed: { attempted: boolean; result?: { processed: number; failed: number } };
    };

    // The promote itself is unaffected: still 200, tag still retagged.
    expect(res.status).toBe(200);
    expect(body.status).toBe('promoted');
    expect(body.retagged).toBe(1);
    expect(db.isVocabTerm('noblebright', 'mood')).toBe(true);
    expect(db.getTagsForBook('b1')[0]).toMatchObject({ tag: 'noblebright', source: 'vocab' });

    // The response reports the re-embed failure honestly rather than
    // implying the book is now fresh (invariant 5).
    expect(body.reembed.attempted).toBe(true);
    expect(body.reembed.result?.processed).toBe(0);
    expect(body.reembed.result?.failed).toBe(1);
    // The book is still stale — nothing was ever written for it.
    expect(db.getBookEmbedding('b1')).toBeNull();
  });
});

describe('POST /vocab/reject', () => {
  it('rejects a proposed term and returns the updated row', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    db.replaceBookTags('b1', [{ tag: 'zany', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);
    db.refreshProposedVocabCounts(1000);
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'zany', category: 'mood' }),
    });
    const body = (await res.json()) as { term: string; category: string; status: string; bookCount: number };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ term: 'zany', category: 'mood', status: 'rejected', bookCount: 1 });
    expect(db.getVocabTerms(['rejected']).some((t) => t.term === 'zany')).toBe(true);
  });
});

describe('POST /vocab/alias', () => {
  it('400s when the canonical term is not a seed/promoted vocab term', async () => {
    const db = makeDb();
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/alias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: 'spooky', canonical: 'not-a-real-term', category: 'mood' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION');
  });

  it('aliases into a seed term, retags matching rows, and resolves the alias out of the proposed queue', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    db.replaceBookTags('b1', [{ tag: 'spooky', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);
    db.refreshProposedVocabCounts(1000);
    const canonical = db.getVocabTerms(['seed']).find((t) => t.category === 'mood')!.term;
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/alias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: 'spooky', canonical, category: 'mood' }),
    });
    const body = (await res.json()) as {
      alias: string;
      canonical: string;
      category: string;
      retagged: number;
      reembed: { attempted: boolean };
    };

    expect(res.status).toBe(200);
    // Exact shape (not toMatchObject) so an accidental extra field on this
    // response still fails the test.
    expect(body).toEqual({
      alias: 'spooky',
      canonical,
      category: 'mood',
      retagged: 1,
      reembed: expect.anything(),
    });
    expect(body.reembed.attempted).toBe(true);
    expect(db.getTagAlias('spooky', 'mood')).toEqual({ alias: 'spooky', canonical, category: 'mood' });
    expect(db.getTagsForBook('b1')[0]).toMatchObject({ tag: canonical, source: 'vocab' });
    expect(db.getVocabTerms(['proposed']).some((t) => t.term === 'spooky')).toBe(false);
    expect(
      db.getVocabTerms(['rejected']).some((t) => t.term === 'spooky' && t.category === 'mood')
    ).toBe(true);
    // Alias renames the tag string itself, which changes the composed card
    // text — the book goes from never-embedded to embedded, matching its
    // current (renamed) card.
    const stored = db.getBookEmbedding('b1');
    expect(stored).not.toBeNull();
    expect(stored?.model).toBe(EMBEDDING_MODEL);
  });

  // Readiness plan item B, exit criterion — THE LOAD-BEARING CASE. Aliasing
  // genuinely rewrites the tag string on the book (bookCard.ts renders
  // `t.tag`), unlike promote-to-self (see the comment on the promote-path
  // test above, which only flips `source` — never rendered in the card).
  // This is the only path where the card text actually changes and a real
  // "stale, then not stale" swing is observable. Do not simplify this back
  // down to a promote-only test — promote-to-self cannot exercise the
  // card-changed branch of isEmbeddingStale at all.
  it('a book that is already embedded and fresh goes stale the instant the alias mutation lands, and fresh again once the wired re-embed runs', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    db.replaceBookTags('b1', [{ tag: 'spooky', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);
    db.refreshProposedVocabCounts(1000);
    const canonical = db.getVocabTerms(['seed']).find((t) => t.category === 'mood')!.term;

    // Seed the library as already-curated: b1 is embedded and fresh under
    // its PRE-alias card (tag: 'spooky'), matching the real state a
    // vocabulary consolidation runs against.
    const preCard = composeBookCardFromDb(db, 'b1')!;
    db.upsertBookEmbedding({ bookId: 'b1', model: EMBEDDING_MODEL, cardHash: preCard.hash, vector: stubEmbed(preCard.text) });
    const preCandidate = db.getStaleEmbeddings({ bookIds: ['b1'] })[0]!;
    expect(isEmbeddingStale(preCandidate, EMBEDDING_MODEL, preCard.hash)).toBe(false);

    // A creator that captures the db's own staleness verdict for b1 the
    // instant it's called — which is AFTER retagLlmOpenTags has committed
    // (it's synchronous, called before the awaited reembed) but BEFORE
    // embedBooks writes the new vector (it calls creator.create() before
    // db.upsertBookEmbedding). This observes the true mid-flight state
    // rather than inferring it.
    let midFlightStale: boolean | undefined;
    const capturingCreator: EmbeddingCreator = {
      create: async (req: EmbeddingRequest) => {
        const midCandidate = db.getStaleEmbeddings({ bookIds: ['b1'] })[0]!;
        const midCard = composeBookCardFromDb(db, 'b1')!;
        midFlightStale = isEmbeddingStale(midCandidate, EMBEDDING_MODEL, midCard.hash);
        return req.input.map((text) => stubEmbed(text));
      },
    };
    const app = buildApp(db, capturingCreator);

    const res = await fetch(`${await listen(app)}/api/vocab/alias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: 'spooky', canonical, category: 'mood' }),
    });
    expect(res.status).toBe(200);

    // The mutation alone (before the re-embed's write) made the book stale —
    // the card genuinely changed, this isn't a comparison of a column to
    // itself.
    expect(midFlightStale).toBe(true);

    // And the wired re-embed brought it current again: the real predicate,
    // recomposed fresh, now says not-stale under the NEW (post-alias) card.
    const postCard = composeBookCardFromDb(db, 'b1')!;
    expect(postCard.hash).not.toBe(preCard.hash); // sanity: the card really did change
    const postCandidate = db.getStaleEmbeddings({ bookIds: ['b1'] })[0]!;
    expect(isEmbeddingStale(postCandidate, EMBEDDING_MODEL, postCard.hash)).toBe(false);
  });
});

/** Start an ephemeral server for one test (closed in afterEach) and return its base origin. */
async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}
