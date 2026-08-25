/**
 * `retag_book` (librarian engine plan §10.A, review finding 5) — the MCP tool
 * runs the identical compose -> ground -> derive pipeline as `tagger.ts`'s
 * bulk retag, and must record a `tag_runs` row exactly like that path does.
 * Without it, a librarian-driven single-book retag never counts as an audit
 * for `getTagCoverage`.
 *
 * Drives the real registered tool over an in-memory MCP client/server pair
 * (not a direct function call) so this proves the wiring the librarian
 * actually exercises, not just the underlying helper.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../../core/db.js';
import type { LlmClient } from '../../core/llmClient.js';
import { invalidateReadinessCache } from '../../core/readiness.js';
import { composeEmbeddingCard } from '../../core/retrieval/embedder.js';
import { createStubEmbeddingCreator } from '../../core/retrieval/fixtures/stubEmbedder.js';
import type { Book, BookTagResult } from '../../core/types.js';
import type { McpServices } from '../services.js';
import { registerQueryTools } from './queryLibrary.js';

const databases: CuratorDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  // The readiness snapshot is memoized for a minute; without this one test's
  // library answers the next one's question.
  invalidateReadinessCache();
});

/**
 * Embed a book the way a real run does — over the card it actually has, via
 * the same helper the embedder uses. A placeholder `cardHash` would make the
 * book read as STALE, which is not coverage.
 */
function embedFresh(db: CuratorDb, id: string, model = 'stub-model'): void {
  const card = composeEmbeddingCard(db, db.getBook(id)!);
  db.upsertBookEmbedding({ bookId: id, model, cardHash: card.hash, vector: new Float32Array([1]) });
}

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

function fakeLlmClient(): LlmClient {
  const tagBook = vi.fn(
    async (book: Book): Promise<BookTagResult> => ({
      bookId: book.id,
      tags: [{ tag: 'noir', category: 'genre', confidence: 0.8 }],
      usage: { inputTokens: 100, outputTokens: 20 },
    })
  );
  return { tagBook } as unknown as LlmClient;
}

/** Connects a real McpServer (with query tools registered) to a real Client
 *  over an in-memory transport pair — no HTTP involved. */
async function connectedClient(services: McpServices): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerQueryTools(server, services);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

describe('retag_book — records a tag_runs row (finding 5)', () => {
  it('a single-book retag via the MCP tool records a tag_runs row, same as the bulk tagger', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    expect(db.getTagRunsForBook('b1')).toEqual([]);

    const services = {
      db,
      llmClient: fakeLlmClient(),
      config: { embeddingModel: 'stub-model', taggingConcurrency: 2 },
      embeddingCreator: createStubEmbeddingCreator(),
    } as unknown as McpServices;

    const { client, close } = await connectedClient(services);
    try {
      const result = await client.callTool({ name: 'retag_book', arguments: { id: 'b1' } });
      expect(result.isError).not.toBe(true);
    } finally {
      await close();
    }

    const runs = db.getTagRunsForBook('b1');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.bookId).toBe('b1');
    // A book with no metadata at all: era/length/character are not
    // evaluable (finding 4), but everything else the LLM was asked about is.
    expect(runs[0]?.categories).toContain('genre');
    expect(runs[0]?.categories).not.toContain('era');

    // Readiness plan item B: the retag also re-embeds the book it just
    // touched, scoped to that one book — not left for a separate run to
    // discover it's stale.
    expect(db.getBookEmbedding('b1')).not.toBeNull();
  });
});

/**
 * Readiness item D, part 3 — the librarian states materially low coverage in
 * its answer. The `query_library` result is the only thing an answer about
 * this library is built from, so the disclosure rides on it: a separate tool
 * the model might not call would not be a rule.
 */
describe('query_library — library coverage disclosure (item D)', () => {
  function services(db: CuratorDb): McpServices {
    return {
      db,
      llmClient: fakeLlmClient(),
      config: { embeddingModel: 'stub-model', taggingConcurrency: 2 },
      embeddingCreator: createStubEmbeddingCreator(),
    } as unknown as McpServices;
  }

  async function callQuery(db: CuratorDb): Promise<Record<string, unknown>> {
    const { client, close } = await connectedClient(services(db));
    try {
      const result = await client.callTool({ name: 'query_library', arguments: {} });
      expect(result.isError).not.toBe(true);
      const content = (result.content as Array<{ type: string; text: string }>)[0];
      return JSON.parse(content.text) as Record<string, unknown>;
    } finally {
      await close();
    }
  }

  it('attaches the disclosure to a thinly-covered library', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    // Four books, one of which has grounded entities: 25% entity coverage,
    // worked out by hand, well under the materiality bar.
    for (const id of ['q1', 'q2', 'q3', 'q4']) {
      addBook(db, { id, title: `Book ${id}` });
      db.upsertExternalMetadata({ bookId: id, provider: 'openlibrary', payload: {}, fetchedAt: 1, status: 'ok' });
      db.recordTagRun(id, ['genre'], 1, 1);
    }
    db.replaceBookEntities('q1', [{ entity: 'Ahab', kind: 'person', sources: ['openlibrary'] }]);
    for (const id of ['q1', 'q2', 'q3', 'q4']) embedFresh(db, id);

    const payload = await callQuery(db);
    const coverage = payload.libraryCoverage as { disclosure: string } | undefined;
    expect(coverage).toBeDefined();
    expect(coverage?.disclosure).toContain('only 25% of books have grounded characters or places (1 of 4)');
    expect(coverage?.disclosure).toContain('state this in your answer');
  });

  it('omits libraryCoverage entirely when coverage is healthy, so the caveat stays meaningful', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    for (const id of ['w1', 'w2']) {
      addBook(db, { id, title: `Book ${id}` });
      db.upsertExternalMetadata({ bookId: id, provider: 'openlibrary', payload: {}, fetchedAt: 1, status: 'ok' });
      db.replaceBookEntities(id, [{ entity: 'Ahab', kind: 'person', sources: ['openlibrary'] }]);
      db.recordTagRun(id, ['genre'], 1, 1);
      embedFresh(db, id);
    }

    const payload = await callQuery(db);
    expect(payload.libraryCoverage).toBeUndefined();
    expect(payload.total).toBe(2);
  });

  it('carries Unknown as null, never as a confident 0%, to the librarian', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    // Enrichment has never run for these books: entity coverage is not 0%,
    // it is unmeasured. Invariant 5, at the surface the librarian reads.
    for (const id of ['u1', 'u2']) addBook(db, { id, title: `Book ${id}` });

    const payload = await callQuery(db);
    const coverage = payload.libraryCoverage as
      | { unmeasured: string[]; metrics: Array<{ key: string; pct: number | null }> }
      | undefined;
    expect(coverage).toBeDefined();
    expect(coverage?.unmeasured).toContain('entities');
    const entities = coverage?.metrics.find((m) => m.key === 'entities');
    expect(entities?.pct).toBeNull();
    expect(entities?.pct).not.toBe(0);
  });

  it('carries the stale count to the librarian as its own number, not folded into pct', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    // Four books, fully covered and freshly embedded, then re-tagged without
    // a re-embed — the vocabulary-consolidation shape. Every vector on record
    // now describes text no book still has.
    for (const id of ['t1', 't2', 't3', 't4']) {
      addBook(db, { id, title: `Book ${id}` });
      db.upsertExternalMetadata({ bookId: id, provider: 'openlibrary', payload: {}, fetchedAt: 1, status: 'ok' });
      db.replaceBookEntities(id, [{ entity: 'Ahab', kind: 'person', sources: ['openlibrary'] }]);
      db.recordTagRun(id, ['genre'], 1, 1);
      db.replaceBookTags(id, [{ tag: 'noir', category: 'genre', confidence: 0.9, source: 'llm-open' }], 1);
      embedFresh(db, id);
    }
    for (const id of ['t1', 't2', 't3', 't4']) {
      db.replaceBookTags(id, [{ tag: 'hardboiled', category: 'genre', confidence: 0.9, source: 'vocab' }], 2);
    }

    const payload = await callQuery(db);
    const coverage = payload.libraryCoverage as
      | { disclosure: string; metrics: Array<{ key: string; pct: number | null; stale?: number | null }> }
      | undefined;
    const embedded = coverage?.metrics.find((m) => m.key === 'embedded');
    // Worked out by hand: 0 of 4 usable, all 4 present-but-out-of-date.
    expect(embedded?.pct).toBe(0);
    expect(embedded?.stale).toBe(4);
    // And the sentence the model is required to state names them as stale,
    // not as books that were never embedded.
    expect(coverage?.disclosure).toContain('and 4 have an out-of-date embedding');
  });

  it('tells the model what to do with the disclosure in the tool description', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    const { client, close } = await connectedClient(services(db));
    try {
      const { tools } = await client.listTools();
      const description = tools.find((t) => t.name === 'query_library')?.description ?? '';
      expect(description).toContain('libraryCoverage');
      expect(description).toContain('MUST state its `disclosure` sentence in your answer');
      expect(description).toContain('null means Unknown');
    } finally {
      await close();
    }
  });
});
