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
import { createStubEmbeddingCreator } from '../../core/retrieval/fixtures/stubEmbedder.js';
import type { Book, BookTagResult } from '../../core/types.js';
import type { McpServices } from '../services.js';
import { registerQueryTools } from './queryLibrary.js';

const databases: CuratorDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

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
