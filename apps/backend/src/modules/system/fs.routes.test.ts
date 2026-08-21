import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../../config/settings.js";
import { createSystemRouter } from "./index.js";

/**
 * GET /api/system/fs used to resolve and list any caller-supplied path, which
 * handed anyone reaching the API a directory-listing primitive over the whole
 * container — and authentication is off by default. Browsing is scoped to the
 * media mounts; these tests pin both halves: the feature still works inside the
 * roots, and nothing outside them is enumerable.
 */
describe("system filesystem browser", () => {
  let dataDir: string;
  let sandbox: string;
  let libraryDir: string;
  let inboxDir: string;
  let server: Server;
  let baseUrl: string;
  const originalRoots = process.env.FS_BROWSE_ROOTS;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-fs-data-"));
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-fs-"));

    libraryDir = path.join(sandbox, "audiobooks");
    inboxDir = path.join(sandbox, "inbox");
    fs.mkdirSync(path.join(libraryDir, "Brandon Sanderson", "Mistborn"), { recursive: true });
    fs.mkdirSync(path.join(libraryDir, ".hidden"), { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(path.join(sandbox, "private"), { recursive: true });

    process.env.FS_BROWSE_ROOTS = [libraryDir, inboxDir].join(path.delimiter);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.principal = { subject: "fs-test", role: "administrator", libraries: [], claims: {} };
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
    fs.rmSync(sandbox, { recursive: true, force: true });
    if (originalRoots === undefined) delete process.env.FS_BROWSE_ROOTS;
    else process.env.FS_BROWSE_ROOTS = originalRoots;
  });

  const browse = (target: string) =>
    fetch(`${baseUrl}/fs?path=${encodeURIComponent(target)}`);

  it("answers the picker's default '/' with the browsable roots", async () => {
    const response = await fetch(`${baseUrl}/fs`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.currentPath).toBe("/");
    expect(body.parentPath).toBeNull();
    expect(body.directories).toEqual(expect.arrayContaining([libraryDir, inboxDir]));
  });

  it("lists subdirectories inside a root", async () => {
    const response = await browse(libraryDir);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.directories).toContain("Brandon Sanderson");
  });

  it("still hides dotfiles", async () => {
    const body = await (await browse(libraryDir)).json();
    expect(body.directories).not.toContain(".hidden");
  });

  it("refuses a sibling directory outside every root", async () => {
    const response = await browse(path.join(sandbox, "private"));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/outside/i);
  });

  it("refuses a traversal escape from inside a root", async () => {
    const response = await browse(path.join(libraryDir, "..", "private"));

    expect(response.status).toBe(403);
  });

  it("refuses the filesystem root", async () => {
    const response = await browse(path.parse(process.cwd()).root);

    expect(response.status).toBe(403);
  });

  it("refuses the data directory holding secrets.json", async () => {
    const response = await browse(dataDir);

    expect(response.status).toBe(403);
  });

  it("does not offer a parent that climbs above a root", async () => {
    const body = await (await browse(libraryDir)).json();

    expect(body.parentPath).toBe("/");
  });

  it("offers a real parent below a root", async () => {
    const body = await (await browse(path.join(libraryDir, "Brandon Sanderson"))).json();

    expect(body.parentPath).toBe(libraryDir);
  });

  it("reports missing paths inside a root without leaking existence elsewhere", async () => {
    const inside = await browse(path.join(libraryDir, "Nonexistent Author"));
    const outside = await browse(path.join(sandbox, "private", "nested"));

    expect(inside.status).toBe(403);
    expect(outside.status).toBe(403);
  });
});
