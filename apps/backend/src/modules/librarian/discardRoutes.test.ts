import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsRouter } from "../../websocket/index.js";
import { createLibrarianRouter } from "./index.js";
import { IngestStore } from "./ingestStore.js";
import type { OrganizationAction } from "@audioshelf/shared";

vi.mock("node-cron", () => ({ default: { schedule: vi.fn() } }));

function mockAction(sourcePath: string): OrganizationAction {
  return {
    action_type: "move",
    source_path: sourcePath,
    target_path: `${sourcePath}-target`,
    reason: "Interrupted by restart",
    executed: false,
    success: false,
    book: { title: path.basename(sourcePath) },
  } as OrganizationAction;
}

describe("download item discard/dismiss route contract", () => {
  let sandbox: string;
  let server: Server;
  let baseUrl: string;
  let store: IngestStore;

  beforeEach(async () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-discard-route-"));
    process.env.DATA_DIR = sandbox;
    process.env.DB_PATH = path.join(sandbox, "curator.db");
    store = new IngestStore(process.env.DB_PATH);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.principal = { subject: "test", role: "administrator", libraries: [], claims: {} };
      next();
    });
    app.use("/api/librarian", createLibrarianRouter(
      { PORT: 0 } as unknown as import("@audioshelf/shared").Config,
      { broadcast: vi.fn() } as unknown as WsRouter,
      { ingestStore: store },
    ));

    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/librarian`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    delete process.env.DATA_DIR;
    delete process.env.DB_PATH;
    vi.restoreAllMocks();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("dismisses a failed acquisition item by ID", async () => {
    const jobId = store.create("/inbox/Above the Bay of Angels");
    const itemId = store.addItem(jobId, mockAction("/inbox/Above the Bay of Angels"));
    store.transitionItem(itemId, "failed", "Interrupted by restart");

    const res = await fetch(`${baseUrl}/downloads/items/${itemId}/dismiss`, { method: "POST" });
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(true);

    const job = store.get(jobId);
    expect(job?.items[0].state).toBe("discarded");
    expect(job?.state).toBe("complete");
  });

  it("discards an acquisition item via the /discard alias", async () => {
    const jobId = store.create("/inbox/Another Book");
    const itemId = store.addItem(jobId, mockAction("/inbox/Another Book"));
    store.transitionItem(itemId, "failed", "ABS resolution failed");

    const res = await fetch(`${baseUrl}/downloads/items/${itemId}/discard`, { method: "POST" });
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(true);

    const job = store.get(jobId);
    expect(job?.items[0].state).toBe("discarded");
  });

  it("returns 404 when item does not exist or was already discarded", async () => {
    const res = await fetch(`${baseUrl}/downloads/items/non-existent-id/dismiss`, { method: "POST" });
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toContain("Item not found");
  });
});
