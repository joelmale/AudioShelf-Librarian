import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpRouter } from "./server.js";
import type { McpServices } from "./services.js";

/**
 * Covers the composition in apps/backend/src/index.ts: the flag gate, the
 * interaction with the globally-installed express.json(), and the fact that a
 * single service bundle is shared rather than rebuilt.
 */

const services = {
  config: { taggingConcurrency: 1, absLibraryId: "lib-1" },
  db: { queryBooks: () => ({ books: [] }), getTagsForBook: () => [] },
  absClient: {},
  llmClient: {},
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  actionLog: {},
  operations: {},
} as unknown as McpServices;

let server: Server;

/** Mirrors index.ts: global json(), /api router, optional /mcp mount. */
function buildApp(mcpEnabled: boolean) {
  const app = express();
  app.use(express.json());
  const api = express.Router();
  api.use((req, _res, next) => {
    req.principal = { subject: "test", role: "administrator", libraries: [], claims: {} };
    next();
  });
  api.get("/ping", (_req, res) => res.json({ ok: true }));
  app.use("/api", api);

  const mcp = mcpEnabled ? createMcpRouter(services) : null;
  if (mcp) {
    app.use(
      "/mcp",
      (req, _res, next) => {
        req.principal = { subject: "test", role: "administrator", libraries: [], claims: {} };
        next();
      },
      mcp.router,
    );
  }
  // The SPA catch-all that must not swallow /mcp.
  app.get(/.*/, (_req, res) => res.status(200).send("<!doctype html>spa"));
  return { app, mcp };
}

async function listen(mcpEnabled: boolean) {
  const built = buildApp(mcpEnabled);
  server = built.app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return { ...built, port: (server.address() as AddressInfo).port };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mount-test", version: "1.0.0" },
  },
};

function post(port: number, body: unknown) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("MCP mount", () => {
  it("serves an initialize request and issues a session id when enabled", async () => {
    const { port } = await listen(true);
    const response = await post(port, initialize);

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("survives the globally installed express.json() draining the body", async () => {
    // The trap: index.ts installs express.json() before any route, so the
    // transport never sees an unread stream. It must use the parsed body.
    const { port } = await listen(true);
    const response = await post(port, initialize);

    expect(response.status).toBe(200);
  });

  it("does not mount anything when the flag is off", async () => {
    const { port, mcp } = await listen(false);

    expect(mcp).toBeNull();

    // The request falls through to the SPA catch-all, not an MCP handler.
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "GET" });
    expect(await response.text()).toContain("spa");
  });

  it("leaves the REST API untouched when MCP is enabled", async () => {
    const { port } = await listen(true);
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`);

    expect(await response.json()).toEqual({ ok: true });
  });

  it("closes open sessions on shutdown", async () => {
    const { port, mcp } = await listen(true);
    await post(port, initialize);
    expect(mcp!.sessionCount()).toBe(1);

    await mcp!.close();

    expect(mcp!.sessionCount()).toBe(0);
  });
});
