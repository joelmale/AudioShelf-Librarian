import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsRouter } from "../../websocket/index.js";
import { createLibrarianRouter, RealignExecuteRequestSchema } from "./index.js";
import type { RealignService } from "./services/realign.js";
import { SettingsStore } from "../../config/settings.js";

vi.mock("node-cron", () => ({ default: { schedule: vi.fn() } }));

describe("realignment route request contract", () => {
  let sandbox: string;
  let server: Server;
  let baseUrl: string;
  let executeRealign: ReturnType<typeof vi.fn>;
  let previousSettingsStore: SettingsStore | undefined;
  let currentRole: "viewer" | "librarian" | "administrator";

  beforeEach(async () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-realign-route-"));
    previousSettingsStore = (SettingsStore as unknown as { instance?: SettingsStore }).instance;
    process.env.DATA_DIR = sandbox; process.env.DB_PATH = ":memory:";
    executeRealign = vi.fn().mockResolvedValue({ success: 1, failed: 0, errors: [], scanErrors: [], historyBatchId: "history" });
    currentRole = "administrator";
    const realignService = {
      scanLibrary: vi.fn().mockResolvedValue({ planId: "plan", createdAt: "2026-08-28T00:00:00.000Z", expiresAt: "2026-08-28T00:10:00.000Z", libraries: [], candidates: [{ bookId: "book" }] }),
      executeRealign,
    } as unknown as RealignService;
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.principal = { subject: "test", role: currentRole, libraries: [], claims: {} }; next() });
    app.use("/api/librarian", createLibrarianRouter({ PORT: 0 }, { broadcast: vi.fn() } as unknown as WsRouter, { realignService }));
    server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/librarian`;
  });
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousSettingsStore) (SettingsStore as unknown as { instance: SettingsStore }).instance = previousSettingsStore;
    else delete (SettingsStore as unknown as { instance?: SettingsStore }).instance;
    delete process.env.DATA_DIR; delete process.env.DB_PATH; vi.restoreAllMocks(); fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("uses one injected service across scan then ID-only execution", async () => {
    const scanned = await fetch(`${baseUrl}/realign/scan`); expect(scanned.status).toBe(200); expect((await scanned.json() as { planId: string }).planId).toBe("plan");
    const executed = await fetch(`${baseUrl}/realign/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: "plan", bookIds: ["book"] }) });
    expect(executed.status).toBe(200); expect(executeRealign).toHaveBeenCalledWith("plan", ["book"]);
  });

  it("rejects legacy client-authored paths before calling the service", async () => {
    const response = await fetch(`${baseUrl}/realign/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidates: [{ bookId: "book", currentPath: "C:/forged", proposedPath: "C:/forged-target" }] }) });
    expect(response.status).toBe(400); expect(executeRealign).not.toHaveBeenCalled();
  });

  it("enforces bounded unique IDs", () => {
    expect(RealignExecuteRequestSchema.safeParse({ planId: "plan", bookIds: ["a", "a"] }).success).toBe(false);
    expect(RealignExecuteRequestSchema.safeParse({ planId: "plan", bookIds: [] }).success).toBe(false);
  });

  it("forbids viewers and admits librarian/admin roles to rollback", async () => {
    currentRole = "viewer";
    expect((await fetch(`${baseUrl}/scan/rollback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    for (const role of ["librarian", "administrator"] as const) {
      currentRole = role;
      // No history is expected; 400 proves authorization passed to the handler.
      expect((await fetch(`${baseUrl}/scan/rollback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(400);
    }
  });
});
