import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpRouter, type McpRouterHandle } from "./server.js";
import type { McpServices } from "./services.js";

/**
 * Drives the MCP router with a real MCP client over real HTTP.
 *
 * This layer had never executed in its life — it was dead code using a
 * deprecated transport — so a mocked test would prove nothing about whether the
 * Streamable HTTP handshake, session handling, or pre-parsed body handoff
 * actually work.
 */

const books = [
  { id: "bk-1", title: "Elantris", author: "Brandon Sanderson", series: null, durationSeconds: 3600, publishedYear: 2005 },
  { id: "bk-2", title: "Mistborn", author: "Brandon Sanderson", series: "Mistborn", durationSeconds: 7200, publishedYear: 2006 },
];

const services = {
  config: { taggingConcurrency: 1, absLibraryId: "lib-1", embeddingModel: "stub-model" },
  db: {
    queryBooks: () => ({ books }),
    getTagsForBook: (id: string) =>
      id === "bk-1" ? [{ tag: "epic-fantasy", category: "genre", confidence: 0.9 }] : [],
    // query_library attaches a coverage disclosure when the library is thinly
    // covered (readiness item D). These are this transport test's two books,
    // fully covered, so no `libraryCoverage` key appears and the payload
    // assertions below stay about the transport. The disclosure itself is
    // tested in tools/queryLibrary.test.ts.
    getReadinessCounts: () => ({
      totalBooks: 2,
      enrichmentAttempted: 2,
      externalResolved: 2,
      withEntities: 2,
      taggedAtVersion: 2,
      taggedVersionUnknown: 0,
      embeddedAtModel: 2,
      embeddedAnyModel: 2,
    }),
  },
  absClient: {},
  llmClient: {},
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  actionLog: {},
  operations: {},
} as unknown as McpServices;

/** Mount the router behind a stub of the host app's `authenticate` middleware. */
function startHost(role: string | null, options: { globalJson: boolean }) {
  const app = express();
  if (options.globalJson) app.use(express.json()); // mirrors apps/backend/src/index.ts
  app.use((req, _res, next) => {
    if (role) req.principal = { subject: "mcp-test", role: role as never, libraries: [], claims: {} };
    next();
  });
  const handle = createMcpRouter(services);
  app.use("/mcp", handle.router);
  return { app, handle };
}

let server: Server;
let handle: McpRouterHandle;
let client: Client;

async function connect(role: string | null = "administrator", globalJson = true): Promise<Client> {
  const started = startHost(role, { globalJson });
  handle = started.handle;
  server = started.app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;

  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await handle?.close().catch(() => undefined);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("MCP router over Streamable HTTP", () => {
  it("completes the initialize handshake and establishes a session", async () => {
    await connect();
    expect(handle.sessionCount()).toBe(1);
  });

  it("lists all 14 tools to a real client", async () => {
    await connect();
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(14);
    expect(tools.map((t) => t.name).sort()).toContain("query_library");
  });

  it("returns real data from query_library end to end", async () => {
    await connect();
    const result = (await client.callTool({ name: "query_library", arguments: { author: "Sanderson" } })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.total).toBe(2);
    expect(payload.books.map((b: { title: string }) => b.title)).toEqual(["Elantris", "Mistborn"]);
    expect(payload.books[0].tags[0].tag).toBe("epic-fantasy");
  });

  it("works when the host app already consumed the body with express.json()", async () => {
    // The trap: index.ts calls app.use(express.json()) globally, draining the
    // stream before the transport sees it. handleRequest must get req.body.
    await connect("administrator", true);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it("works when mounted on an app with no global body parser", async () => {
    await connect("administrator", false);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it("enforces per-tool roles over the wire, not just in unit tests", async () => {
    await connect("curator");
    const result = (await client.callTool({ name: "sync_abs_library", arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.code).toBe("FORBIDDEN");
    expect(payload.detail.requiredRole).toBe("librarian");
  });

  it("still allows a curator the read-only tools it is entitled to", async () => {
    await connect("curator");
    const result = (await client.callTool({ name: "query_library", arguments: {} })) as { isError?: boolean };
    expect(result.isError).toBeFalsy();
  });

  it("rejects a request bearing an unknown session id", async () => {
    await connect();
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": "00000000-0000-0000-0000-000000000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(404);
  });

  it("rejects a first request that is not an initialize request", async () => {
    const started = startHost("administrator", { globalJson: true });
    handle = started.handle;
    server = started.app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(400);
  });

  it("drops sessions when the handle is closed", async () => {
    await connect();
    expect(handle.sessionCount()).toBe(1);

    await handle.close();

    expect(handle.sessionCount()).toBe(0);
  });
});
