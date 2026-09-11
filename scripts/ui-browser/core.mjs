/**
 * Shared infrastructure for the offline synthetic-browser UI harness.
 *
 * Every phase serves the same prebuilt frontend from a local ephemeral port and
 * fail-closes the network: same-origin requests are answered from in-memory
 * fixtures, anything a phase did not declare is aborted and recorded as BLOCKED,
 * and no backend, provider, LLM, filesystem mutation or WebSocket peer is
 * reachable. Phase modules under ./phases supply only their fixtures and their
 * assertions; they must not re-implement anything here.
 */

import { createServer } from "node:http";
import { access, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const defaultDist = join(repositoryRoot, "apps", "frontend", "dist");
export const defaultPlaywrightPrefix = join(tmpdir(), "audioshelf-ui-playwright");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function option(name, argv = process.argv) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

export function loadPlaywright(prefix) {
  try {
    return createRequire(join(prefix, "package.json"))("playwright");
  } catch (error) {
    throw new Error(
      `Playwright is unavailable at ${prefix}. Install it outside the repository with:\n` +
        `  npm install --prefix "${prefix}" playwright\n` +
        `  npx --prefix "${prefix}" playwright install chromium\n\n` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith("..") && !path.includes(`..${sep}`);
}

/** Serve a prebuilt dist on an ephemeral loopback port, falling back to index.html. */
export async function staticServer(dist) {
  const root = resolve(dist);
  await access(join(root, "index.html"));
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://fixture.local").pathname);
      const requested = resolve(root, `.${pathname}`);
      const candidate = inside(root, requested) ? requested : join(root, "index.html");
      const selected = (await stat(candidate).catch(() => null))?.isFile() ? candidate : join(root, "index.html");
      response.writeHead(200, { "content-type": MIME_TYPES[extname(selected)] ?? "application/octet-stream" });
      response.end(await readFile(selected));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveServer();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate local fixture port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveServer, reject) => server.close(error => (error ? reject(error) : resolveServer()))),
  };
}

export const json = (body, status = 200) => ({
  status,
  contentType: "application/json; charset=utf-8",
  headers: { "x-ui-fixture": "synthetic" },
  body: JSON.stringify(body),
});

/**
 * Fail-closed request interception. `fixture(pathname, search, method)` returns a
 * body to fulfil, or undefined to let the static server answer. Anything under
 * /api/ with no fixture is aborted rather than reaching a real service.
 *
 * p6 uses this. p0, p1 and p2 deliberately keep their own variants and must NOT
 * be folded into this one: p0 intercepts per bestseller scenario rather than per
 * path, and p1/p2 are strictly GET-only — they abort every local non-GET request,
 * which this version permits. Replacing theirs with this would quietly weaken a
 * fail-closed property their reviews signed off on.
 */
export async function installFixtures(context, origin, report, fixture) {
  const { requests } = report;
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      if (url.protocol === "data:") {
        await route.continue();
        return;
      }
      requests.push(`BLOCKED external ${request.method()} ${url.href}`);
      await route.abort();
      return;
    }
    const body = fixture(url.pathname, url.search, request.method());
    if (body !== undefined) {
      requests.push(`FIXTURE ${request.method()} ${url.pathname}`);
      await route.fulfill(json(body));
      return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      requests.push(`BLOCKED API ${request.method()} ${url.pathname}`);
      await route.abort();
      return;
    }
    await route.continue();
  });

  await context.routeWebSocket("**/*", route => {
    const target = new URL(route.url());
    const expected = new URL(origin);
    if (target.hostname === expected.hostname && target.port === expected.port && target.pathname === "/api") {
      requests.push(`EXPECTED websocket ${target.pathname}`);
    } else {
      requests.push(`BLOCKED websocket ${target.href}`);
    }
    route.close();
  });
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyRequestSafety(report) {
  const blocked = report.requests.filter(line => line.startsWith("BLOCKED"));
  assert(blocked.length === 0, `Synthetic harness blocked unexpected requests: ${blocked.join(", ")}`);
}

export async function waitRoute(page, pathname, timeout = 8_000) {
  await page.waitForURL(url => new URL(url).pathname === pathname, { timeout });
}

export function newReport(phase) {
  return {
    phase,
    timestamp: new Date().toISOString(),
    requests: [],
    assertions: [],
    failures: [],
    viewports: [],
  };
}
