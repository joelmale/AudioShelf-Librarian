import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../../config/settings.js";
import { createSystemRouter } from "./index.js";

describe("system settings routes", () => {
  let dataDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-settings-routes-"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.principal = {
        subject: "route-test",
        role: req.header("x-test-role") === "viewer" ? "viewer" : "administrator",
        libraries: [],
        claims: {},
      };
      next();
    });
    app.use("/api/system", createSystemRouter(new SettingsStore(dataDir)));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/system`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("supports field-level PATCH while keeping history administrator-only", async () => {
    const patched = await fetch(`${baseUrl}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ libraryDir: "/library-v2" }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).data.libraryDir).toBe("/library-v2");

    const denied = await fetch(`${baseUrl}/settings/history`, {
      headers: { "x-test-role": "viewer" },
    });
    expect(denied.status).toBe(403);

    const allowed = await fetch(`${baseUrl}/settings/history`);
    expect(allowed.status).toBe(200);
    const payload = await allowed.json();
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0].actor).toBe("route-test");
  });

  it("never returns secret values through settings or history APIs", async () => {
    const secret = "route-secret-that-must-not-leak";
    const patched = await fetch(`${baseUrl}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ absToken: secret, inboxDir: "/new-inbox" }),
    });
    const patchedText = await patched.text();
    expect(patchedText).not.toContain(secret);
    expect(JSON.parse(patchedText).data.secretStatus.absTokenConfigured).toBe(true);

    const history = await fetch(`${baseUrl}/settings/history`);
    expect(await history.text()).not.toContain(secret);
  });

  it("returns 404 for an unknown restore target without changing settings", async () => {
    const response = await fetch(`${baseUrl}/settings/history/00000000-0000-4000-8000-000000000000/restore`, {
      method: "POST",
    });
    expect(response.status).toBe(404);

    const settings = await fetch(`${baseUrl}/settings`);
    expect((await settings.json()).data.libraryDir).toBe("/audiobooks");
  });

  it("restores a selected API snapshot and creates a reversible checkpoint", async () => {
    const secret = "restore-route-secret";
    await fetch(`${baseUrl}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ libraryDir: "/changed-library", absToken: secret }),
    });
    await fetch(`${baseUrl}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inboxDir: "/changed-inbox" }),
    });
    const historyBefore = await fetch(`${baseUrl}/settings/history`).then((response) => response.json());
    const originalStateId = historyBefore.data[1].id as string;

    const restored = await fetch(`${baseUrl}/settings/history/${originalStateId}/restore`, {
      method: "POST",
    });
    expect(restored.status).toBe(200);
    const restoredText = await restored.text();
    expect(restoredText).not.toContain(secret);
    const restoredPayload = JSON.parse(restoredText);
    expect(restoredPayload.data.changedKeys).toEqual(["inboxDir", "libraryDir"]);
    expect(restoredPayload.data.settings).toMatchObject({
      libraryDir: "/audiobooks",
      inboxDir: "/inbox",
      secretStatus: { absTokenConfigured: true },
    });

    const historyAfter = await fetch(`${baseUrl}/settings/history`).then((response) => response.json());
    expect(historyAfter.data).toHaveLength(3);
    expect(historyAfter.data[0]).toMatchObject({
      source: "rollback",
      restoredFrom: originalStateId,
      snapshot: { libraryDir: "/changed-library", inboxDir: "/changed-inbox" },
    });
  });
});
