import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../../../../config/settings.js";
import { ActionLog } from "../../core/actionLog.js";
import { OperationRegistry } from "../../core/operations.js";
import type { ApiServices } from "../services.js";
import { createOperationsRouter } from "./operations.js";

describe("persisted action-log verbosity", () => {
  let server: Server;
  let dataDir: string;
  let baseUrl: string;
  let settingsStore: SettingsStore;
  let actionLog: ActionLog;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-log-settings-"));
    settingsStore = new SettingsStore(dataDir);
    actionLog = new ActionLog();
    const services = {
      operations: new OperationRegistry(),
      actionLog,
    } as ApiServices;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.principal = {
        subject: "log-settings-test",
        role: req.header("x-test-role") === "curator" ? "curator" : "administrator",
        libraries: [],
        claims: {},
      };
      next();
    });
    app.use("/api", createOperationsRouter(services, settingsStore));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects curators and lets administrators persist and apply the setting", async () => {
    const denied = await fetch(`${baseUrl}/settings/log-level`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-test-role": "curator" },
      body: JSON.stringify({ level: "warn" }),
    });
    expect(denied.status).toBe(403);
    expect(settingsStore.getPublicSettings().actionLogLevel).toBe("debug");
    expect(settingsStore.getHistory()).toHaveLength(0);

    const allowed = await fetch(`${baseUrl}/settings/log-level`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "warn" }),
    });
    expect(allowed.status).toBe(200);
    expect(settingsStore.getPublicSettings().actionLogLevel).toBe("warn");
    expect(settingsStore.getHistory()[0]).toMatchObject({
      actor: "log-settings-test",
      changedKeys: ["actionLogLevel"],
    });

    actionLog.record("info", "hidden", "not retained");
    actionLog.record("warn", "visible", "retained");
    expect(actionLog.query().map((entry) => entry.event)).toEqual(["visible"]);
  });
});
