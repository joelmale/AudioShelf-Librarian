import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const smokeScript = fileURLToPath(new URL("../../../scripts/live-readonly-smoke.mjs", import.meta.url));
const releaseScript = fileURLToPath(new URL("../../../scripts/release-check.mjs", import.meta.url));
const packageVersion = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version as string;

function runScript(script: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [script, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error && "code" in error && typeof error.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
}

describe("release metadata gate", () => {
  it("accepts the package version and rejects a mismatched Git tag", async () => {
    const valid = await runScript(releaseScript, [packageVersion]);
    expect(valid.code).toBe(0);

    const mismatch = await runScript(releaseScript, [packageVersion], {
      ...process.env,
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "v0.0.0",
    });
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.stderr).toContain(`does not match package version ${packageVersion}`);

    const malformed = await runScript(releaseScript, ["1.1.0-01"]);
    expect(malformed.code).not.toBe(0);
    expect(malformed.stderr).toContain("is not a valid semantic version");
  });
});

describe("read-only live smoke", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://test").pathname;
      const json = (body: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };

      if (["/desk", "/scout/trends", "/scout/search", "/curate/review", "/process/scan", "/activity", "/settings"].includes(pathname)) {
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><div id="root"></div>');
      } else if (pathname === "/health") json({ status: "ok", version: packageVersion });
      else if (pathname === "/api/system/settings") json({ success: true, data: {} });
      else if (pathname === "/api/librarian/jobs" || pathname === "/api/librarian/scan/history") json({ success: true, data: [] });
      else if (pathname === "/api/operations" || pathname === "/api/collections" || pathname === "/api/encode/queue" || pathname === "/api/encode/history") json([]);
      else if (pathname === "/api/books") json({ books: [], total: 0, limit: 1, offset: 0 });
      else if (pathname === "/api/tags/stats") json({ totalBooks: 0, taggedBooks: 0, untaggedBooks: 0, vocabularySize: 0 });
      else if (pathname === "/api/encode/config") json({ enabled: true, rescanAvailable: true });
      else if (pathname === "/api/librarian/status") {
        json({
          success: true,
          data: {
            audiobookbay: { activeDomain: "https://example.test", knownMirrors: 1 },
            qbittorrent: { connected: false, completedTorrents: 0 },
            audiobookshelf: { connected: false, libraries: 0 },
            proxy: { enabled: false, working: false },
          },
        });
      } else {
        res.statusCode = 404;
        json({ error: "not found" });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("validates the deployed version and response contracts", async () => {
    const result = await runScript(smokeScript, ["--base-url", baseUrl, "--expected-version", packageVersion]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("18 passed, 0 warnings, 0 failed");

    const mismatch = await runScript(smokeScript, ["--base-url", baseUrl, "--expected-version", "9.9.9"]);
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.stdout).toContain(`Health version ${packageVersion} does not match 9.9.9`);
  });

  it("warns for optional integrations and fails required integrations", async () => {
    const optional = await runScript(smokeScript, ["--base-url", baseUrl, "--expected-version", packageVersion, "--include-integrations"]);
    expect(optional.code).toBe(0);
    expect(optional.stdout).toContain("WARN");
    expect(optional.stdout).toContain("optional integration is unavailable");

    const required = await runScript(smokeScript, ["--base-url", baseUrl, "--expected-version", packageVersion, "--require-abs", "--require-qbit"]);
    expect(required.code).not.toBe(0);
    expect(required.stdout).toContain("required integration is unavailable");
  });
});
