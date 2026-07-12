#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const readArg = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (argv.includes("--help")) {
  console.log(`Usage: npm run smoke:live:readonly -- [options]

Options:
  --base-url URL          Application URL (default AUDIOSHELF_BASE_URL or http://127.0.0.1:3050)
  --expected-version VER  Required health version (default package version or AUDIOSHELF_EXPECTED_VERSION)
  --include-integrations  Probe ABS, qBittorrent, ABB, and proxy status
  --require-abs           Fail unless Audiobookshelf is connected; implies --include-integrations
  --require-qbit          Fail unless qBittorrent is connected; implies --include-integrations
  --search-query TEXT     Run one lowercase AudiobookBay search without downloading
  --timeout-ms NUMBER     Per-request timeout (default 15000)

This command sends GET requests only. It never downloads, scans, tags, pushes,
queues an encode, changes settings, or modifies files.`);
  process.exit(0);
}

const baseUrl = new URL(readArg("--base-url") ?? process.env.AUDIOSHELF_BASE_URL ?? "http://127.0.0.1:3050");
const token = process.env.AUDIOSHELF_TOKEN;
const timeoutMs = Number.parseInt(readArg("--timeout-ms") ?? "15000", 10);
const packageMetadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const expectedVersion = readArg("--expected-version") ?? process.env.AUDIOSHELF_EXPECTED_VERSION ?? packageMetadata.version;
const requireAbs = argv.includes("--require-abs");
const requireQbit = argv.includes("--require-qbit");
const includeIntegrations = argv.includes("--include-integrations") || requireAbs || requireQbit;
const results = [];

function assertJson(body, contentType, label) {
  if (!contentType.includes("application/json") || body === null || typeof body !== "object") {
    throw new Error(`${label} did not return JSON`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
}

function assertNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is not numeric`);
}

async function request(name, pathname, validate = () => undefined, { allowChallenge = false } = {}) {
  const started = Date.now();
  try {
    const response = await fetch(new URL(pathname, baseUrl), {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    const challengeAccepted = allowChallenge && response.status === 403 && body?.requiresChallenge === true;
    if (!response.ok && !challengeAccepted) throw new Error(`${response.status} ${response.statusText}`);
    validate(body, contentType);
    const result = { name, status: "PASS", durationMs: Date.now() - started, body };
    results.push(result);
    return result;
  } catch (error) {
    results.push({ name, status: "FAIL", durationMs: Date.now() - started, detail: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function recordIntegration(name, connected, required, detail) {
  results.push({
    name,
    status: connected ? "PASS" : required ? "FAIL" : "WARN",
    durationMs: 0,
    detail: connected ? detail : required ? "required integration is unavailable" : "optional integration is unavailable",
  });
}

const routes = ["/desk", "/scout/trends", "/scout/search", "/curate/review", "/process/scan", "/activity", "/settings"];
await Promise.all(routes.map((route) => request(`UI ${route}`, route, (body, contentType) => {
  if (!contentType.includes("text/html") || typeof body !== "string" || !body.includes('id="root"')) {
    throw new Error("SPA shell was not returned");
  }
})));

await Promise.all([
  request("Health", "/health", (body, contentType) => {
    assertJson(body, contentType, "Health");
    if (body.status !== "ok") throw new Error("Health status is not ok");
    if (body.version !== expectedVersion) throw new Error(`Health version ${body.version ?? "<missing>"} does not match ${expectedVersion}`);
  }),
  request("Settings redaction", "/api/system/settings", (body, contentType) => {
    assertJson(body, contentType, "Settings");
    const settings = body?.data;
    if (!body?.success || !settings) throw new Error("Public settings payload is missing");
    for (const secret of ["absToken", "qbitPass", "anthropicApiKey", "proxyUrl"]) {
      if (Object.hasOwn(settings, secret)) throw new Error(`${secret} was exposed`);
    }
  }),
  request("Ingest jobs", "/api/librarian/jobs", (body, contentType) => {
    assertJson(body, contentType, "Ingest jobs");
    if (body.success !== true) throw new Error("Ingest jobs request was not successful");
    assertArray(body.data, "Ingest jobs data");
  }),
  request("Organization history", "/api/librarian/scan/history", (body, contentType) => {
    assertJson(body, contentType, "Organization history");
    if (body.success !== true) throw new Error("Organization history request was not successful");
    assertArray(body.data, "Organization history data");
  }),
  request("Operations", "/api/operations", (body, contentType) => {
    assertJson(body, contentType, "Operations");
    assertArray(body, "Operations payload");
  }),
  request("Book browse", "/api/books?limit=1", (body, contentType) => {
    assertJson(body, contentType, "Book browse");
    assertArray(body.books, "Books");
    assertNumber(body.total, "Book total");
  }),
  request("Tag statistics", "/api/tags/stats", (body, contentType) => {
    assertJson(body, contentType, "Tag statistics");
    for (const key of ["totalBooks", "taggedBooks", "untaggedBooks", "vocabularySize"]) {
      assertNumber(body[key], `Tag statistics ${key}`);
    }
  }),
  request("Collection browse", "/api/collections", (body, contentType) => {
    assertJson(body, contentType, "Collections");
    assertArray(body, "Collections payload");
  }),
  request("Encode configuration", "/api/encode/config", (body, contentType) => {
    assertJson(body, contentType, "Encode configuration");
    if (typeof body.enabled !== "boolean" || typeof body.rescanAvailable !== "boolean") {
      throw new Error("Encode configuration payload is invalid");
    }
  }),
  request("Encode queue", "/api/encode/queue", (body, contentType) => {
    assertJson(body, contentType, "Encode queue");
    assertArray(body, "Encode queue payload");
  }),
  request("Encode history", "/api/encode/history?limit=1", (body, contentType) => {
    assertJson(body, contentType, "Encode history");
    assertArray(body, "Encode history payload");
  }),
]);

if (includeIntegrations) {
  const response = await request("External integration status payload", "/api/librarian/status", (body, contentType) => {
    assertJson(body, contentType, "External integration status");
    if (body.success !== true || !body.data) throw new Error("External integration status payload is invalid");
    for (const key of ["audiobookbay", "qbittorrent", "audiobookshelf", "proxy"]) {
      if (!body.data[key] || typeof body.data[key] !== "object") throw new Error(`External integration status is missing ${key}`);
    }
  });
  const integrations = response?.body?.data;
  if (integrations) {
    recordIntegration("Audiobookshelf connection", integrations.audiobookshelf.connected === true, requireAbs, `${integrations.audiobookshelf.libraries ?? 0} libraries`);
    recordIntegration("qBittorrent connection", integrations.qbittorrent.connected === true, requireQbit, `${integrations.qbittorrent.completedTorrents ?? 0} completed torrents`);
    recordIntegration("AudiobookBay discovery", typeof integrations.audiobookbay.activeDomain === "string" && integrations.audiobookbay.activeDomain.length > 0, false, integrations.audiobookbay.activeDomain);
    recordIntegration("Proxy connection", integrations.proxy.enabled === true && integrations.proxy.working === true, false, integrations.proxy.location ?? integrations.proxy.ip ?? "working");
  }
}

const searchQuery = readArg("--search-query");
if (searchQuery) {
  const query = searchQuery.trim().toLowerCase();
  await request(
    `Search "${query}"`,
    `/api/librarian/search?q=${encodeURIComponent(query)}&page=1`,
    (body, contentType) => {
      assertJson(body, contentType, "Search");
      if (body?.requiresChallenge === true) return;
      if (body?.success !== true || !Array.isArray(body?.results)) throw new Error("Search payload is invalid");
    },
    { allowChallenge: true },
  );
}

for (const result of results) {
  console.log(`${result.status.padEnd(4)} ${String(result.durationMs).padStart(5)} ms  ${result.name}${result.detail ? ` - ${result.detail}` : ""}`);
}

const failures = results.filter((result) => result.status === "FAIL");
const warnings = results.filter((result) => result.status === "WARN");
const passed = results.filter((result) => result.status === "PASS");
console.log(`\n${passed.length} passed, ${warnings.length} warnings, ${failures.length} failed against ${baseUrl.origin} (expected ${expectedVersion}).`);
if (failures.length > 0) process.exitCode = 1;
