import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../../core/db.js';
import { LIBRARIAN_TOOLS, type LibrarianToolDeps } from '../../core/librarian/tools.js';
import { invalidateReadinessCache } from '../../core/readiness.js';
import { composeBookCardFromDb } from '../../core/retrieval/bookCard.js';
import type { EmbeddingCreator } from '../../core/retrieval/embeddings.js';
import { FIXTURE_BOOKS, seedFixtureLibrary } from '../../core/retrieval/fixtures/library.js';
import { createStubEmbeddingCreator, stubEmbed } from '../../core/retrieval/fixtures/stubEmbedder.js';
import type { McpServices } from '../services.js';
import { registerLibrarianTools } from './librarian.js';
import { registerQueryTools } from './queryLibrary.js';

let db: CuratorDb;
let client: Client;
let server: McpServer;
let services: McpServices;
let createEmbedding: ReturnType<typeof vi.fn<EmbeddingCreator['create']>>;

function parseResult(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

function schemaKeys(schema: unknown): string[] {
  let current = schema as { shape?: Record<string, unknown>; innerType?: () => unknown };
  while (!current.shape && current.innerType) {
    current = current.innerType() as typeof current;
  }
  return Object.keys(current.shape ?? {}).sort();
}

async function direct(name: string, input: unknown): Promise<unknown> {
  const entry = LIBRARIAN_TOOLS.find((tool) => tool.name === name);
  if (!entry) throw new Error(`missing registry tool ${name}`);
  const deps: LibrarianToolDeps = {
    db,
    embeddingModel: services.config.embeddingModel,
    embeddingCreator: services.embeddingCreator,
  };
  const parsed = entry.inputSchema.parse(input);
  return (entry.handler as (d: LibrarianToolDeps, i: unknown) => unknown)(deps, parsed);
}

beforeEach(async () => {
  db = new CuratorDb(':memory:');
  seedFixtureLibrary(db);
  for (const book of FIXTURE_BOOKS) {
    const card = composeBookCardFromDb(db, book.id)!;
    db.upsertBookEmbedding({
      bookId: book.id,
      model: 'stub-model',
      cardHash: card.hash,
      vector: stubEmbed(card.text),
    });
  }

  const stub = createStubEmbeddingCreator();
  createEmbedding = vi.fn(stub.create.bind(stub));
  services = {
    db,
    config: { embeddingModel: 'stub-model', taggingConcurrency: 1 },
    embeddingCreator: { create: createEmbedding },
    llmClient: {},
  } as unknown as McpServices;

  server = new McpServer({ name: 'librarian-adapter-test', version: '1.0.0' });
  registerLibrarianTools(server, services);
  registerQueryTools(server, services);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  db.close();
  invalidateReadinessCache();
});

describe('MCP librarian registry adapter', () => {
  const parityCases = [
    ['search_library', { tag: 'melancholic', category: 'mood' }],
    ['get_book', { id: 'fx-01' }],
    ['find_similar', { bookId: 'fx-13', k: 3 }],
    ['search_semantic', { query: 'melancholic coastal autumn', limit: 3 }],
    ['tag_coverage', { tags: [{ tag: 'melancholic', category: 'mood' }], bookIds: ['fx-01', 'fx-02', 'fx-03'] }],
  ] as const;

  for (const [name, input] of parityCases) {
    it(`${name} returns the same payload as its registry handler`, async () => {
      const expected = await direct(name, input);
      const result = await client.callTool({ name, arguments: input });

      expect(result.isError).not.toBe(true);
      expect(parseResult(result)).toEqual(expected);
    });
  }

  it('derives public names, descriptions, and input schemas from the registry', async () => {
    const listed = (await client.listTools()).tools;
    for (const entry of LIBRARIAN_TOOLS) {
      const exposed = listed.find((tool) => tool.name === entry.name);
      expect(exposed?.description).toBe(entry.description);
      expect(exposed?.inputSchema.type).toBe('object');
      expect(Object.keys(exposed?.inputSchema.properties ?? {}).sort()).toEqual(
        schemaKeys(entry.inputSchema)
      );
    }
  });

  it('uses the configured injected embedder for semantic search', async () => {
    const result = await client.callTool({
      name: 'search_semantic',
      arguments: { query: 'quiet autumn coast', limit: 2 },
    });

    expect(result.isError).not.toBe(true);
    expect(createEmbedding).toHaveBeenCalledOnce();
    expect(createEmbedding).toHaveBeenCalledWith({ model: 'stub-model', input: ['quiet autumn coast'] });
  });

  it('rejects invalid input at the MCP boundary', async () => {
    const result = await client.callTool({ name: 'get_book', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it.each(['search_library', 'query_library'])('%s translates refined registry failures as VALIDATION', async (name) => {
    const result = await client.callTool({
      name,
      arguments: { minDurationHours: 10, maxDurationHours: 9 },
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({
      code: 'VALIDATION',
      error: expect.stringContaining('Invalid input for librarian tool'),
      detail: expect.any(Array),
    });
  });

  it.each([
    ['search_library', { limit: -1 }],
    ['search_library', { limit: 1.5 }],
    ['search_library', { limit: 101 }],
    ['search_library', { title: 'x'.repeat(501) }],
    ['search_library', { minDurationHours: 3, maxDurationHours: 2 }],
    ['search_library', { publishedFrom: 2025, publishedTo: 2024 }],
    ['find_similar', { bookId: 'fx-01', k: -1 }],
    ['find_similar', { bookId: 'fx-01', k: 1.5 }],
    ['find_similar', { bookId: 'fx-01', k: 101 }],
    ['search_semantic', { query: 'q', limit: 101 }],
    ['search_semantic', { query: 'q', weights: { semantic: 1e100 } }],
    ['search_semantic', { query: 'q', weights: { semantic: 1, tag: 1, reception: 0 } }],
    ['search_semantic', { query: 'q', anyTags: Array.from({ length: 51 }, () => ({ tag: 'x' })) }],
    ['search_semantic', { query: 'q', softExcludeTags: Array.from({ length: 51 }, () => ({ tag: 'x' })) }],
    ['tag_coverage', { tags: [{ tag: 'x' }], bookIds: Array.from({ length: 501 }, (_, i) => `b-${i}`) }],
  ] satisfies Array<[string, Record<string, unknown>]>)('rejects invalid %s arguments over real MCP %#', async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
  });

  it('translates registry NotFound and tool errors into MCP error results', async () => {
    const missing = await client.callTool({ name: 'get_book', arguments: { id: 'missing' } });
    expect(missing.isError).toBe(true);
    expect(parseResult(missing)).toMatchObject({ code: 'NOT_FOUND' });

    const noEmbeddingDb = new CuratorDb(':memory:');
    try {
      noEmbeddingDb.upsertBook({
        id: 'bare',
        title: 'Bare Book',
        author: null,
        series: null,
        seriesSequence: null,
        durationSeconds: null,
        publishedYear: null,
        genres: [],
        description: null,
        coverPath: null,
        absAddedAt: null,
        lastSyncedAt: 1,
      });
      const isolated = { ...services, db: noEmbeddingDb };
      const errorServer = new McpServer({ name: 'error-test', version: '1.0.0' });
      registerLibrarianTools(errorServer, isolated);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const errorClient = new Client({ name: 'error-client', version: '1.0.0' });
      await Promise.all([errorServer.connect(st), errorClient.connect(ct)]);
      try {
        const failed = await errorClient.callTool({ name: 'find_similar', arguments: { bookId: 'bare' } });
        expect(failed.isError).toBe(true);
        expect(parseResult(failed)).toMatchObject({ code: 'INTERNAL' });
      } finally {
        await errorClient.close().catch(() => undefined);
        await errorServer.close().catch(() => undefined);
      }
    } finally {
      noEmbeddingDb.close();
    }
  });

  it('keeps query_library as a deprecated payload-compatible alias', async () => {
    const args = { author: 'Elena Marsh', limit: 2 };
    const current = await client.callTool({ name: 'search_library', arguments: args });
    const legacy = await client.callTool({ name: 'query_library', arguments: args });

    expect(parseResult(legacy)).toEqual(parseResult(current));
    const alias = (await client.listTools()).tools.find((tool) => tool.name === 'query_library');
    expect(alias?.description).toMatch(/deprecated/i);
  });
});
