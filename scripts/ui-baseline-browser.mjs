#!/usr/bin/env node

import { createServer } from "node:http";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { BESTSELLER_FIXTURE_SCENARIOS, SYNTHETIC_BESTSELLER_LABEL } from "./fixtures/ui-simplification/bestsellers.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDist = join(repositoryRoot, "apps", "frontend", "dist");
const defaultPlaywrightPrefix = join(tmpdir(), "audioshelf-ui-playwright");
const defaultOutput = join(repositoryRoot, "temp", "ui-baseline-browser");
const viewports = [
  { label: "390x844", width: 390, height: 844 },
  { label: "768x1024", width: 768, height: 1024 },
  { label: "1440x1000", width: 1440, height: 1000 },
];

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printHelp() {
  console.log(`Usage: node scripts/ui-baseline-browser.mjs [options]

Captures labelled synthetic browser baselines from an already-built frontend.
No backend is started and every API, WebSocket, and external request is blocked.

Options:
  --dist PATH          Prebuilt frontend directory (default: apps/frontend/dist)
  --output-dir PATH    Ignored capture directory (default: temp/ui-baseline-browser)
  --scenario NAME      success, empty, error, success-false-200, or all (default: all)
  --playwright-prefix  Temporary npm prefix containing playwright
`);
}

function parseScenarios() {
  const requested = readOption("--scenario") ?? "all";
  const scenarios = requested === "all" ? Object.keys(BESTSELLER_FIXTURE_SCENARIOS) : requested.split(",");
  for (const scenario of scenarios) {
    if (!(scenario in BESTSELLER_FIXTURE_SCENARIOS)) {
      throw new Error(`Unknown scenario "${scenario}". Use --help for supported names.`);
    }
  }
  return scenarios;
}

function loadPlaywright(prefix) {
  try {
    const require = createRequire(join(prefix, "package.json"));
    return require("playwright");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Playwright is unavailable at ${prefix}. Install it outside the repository with:\n` +
        `  npm install --prefix "${prefix}" playwright\n` +
        `  npx --prefix "${prefix}" playwright install chromium\n\n${detail}`,
    );
  }
}

function withinDist(dist, candidate) {
  const pathFromRoot = relative(dist, candidate);
  return pathFromRoot !== "" && !pathFromRoot.startsWith("..") && !pathFromRoot.includes(`..${sep}`);
}

async function startStaticServer(dist) {
  const root = resolve(dist);
  await access(join(root, "index.html"));

  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://fixture.local").pathname);
      const requested = resolve(root, `.${pathname}`);
      const candidate = withinDist(root, requested) ? requested : join(root, "index.html");
      const selected = (await stat(candidate).catch(() => null))?.isFile() ? candidate : join(root, "index.html");
      const body = await readFile(selected);
      response.writeHead(200, { "content-type": MIME_TYPES[extname(selected)] ?? "application/octet-stream" });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectServer);
      resolveServer();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate a local fixture port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveServer, rejectServer) => server.close((error) => error ? rejectServer(error) : resolveServer())),
  };
}

function jsonHeaders() {
  return { "content-type": "application/json; charset=utf-8", "x-ui-fixture": "synthetic" };
}

async function installNetworkInterception(context, origin, scenario) {
  const requests = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      requests.push(`BLOCKED external ${request.method()} ${url.href}`);
      await route.abort();
      return;
    }
    const fixturePath = url.pathname === "/health" || url.pathname === "/api/operations" || url.pathname === "/api/librarian/bestsellers";
    if (fixturePath && request.method() !== "GET") {
      requests.push(`BLOCKED non-GET fixture ${request.method()} ${url.pathname}`);
      await route.abort();
      return;
    }
    if (url.pathname === "/health") {
      requests.push(`FIXTURE ${request.method()} /health`);
      await route.fulfill({ status: 200, headers: jsonHeaders(), body: JSON.stringify({ absConnected: false, version: "synthetic", dbWritable: false }) });
      return;
    }
    if (url.pathname === "/api/operations") {
      requests.push(`FIXTURE ${request.method()} /api/operations`);
      await route.fulfill({ status: 200, headers: jsonHeaders(), body: "[]" });
      return;
    }
    if (url.pathname === "/api/librarian/bestsellers") {
      requests.push(`FIXTURE ${request.method()} /api/librarian/bestsellers (${scenario})`);
      const fixture = BESTSELLER_FIXTURE_SCENARIOS[scenario];
      await route.fulfill({ status: fixture.status, headers: jsonHeaders(), body: JSON.stringify(fixture.body) });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      requests.push(`BLOCKED API ${request.method()} ${url.pathname}`);
      await route.abort();
      return;
    }
    if (request.method() !== "GET") {
      requests.push(`BLOCKED non-GET local ${request.method()} ${url.pathname}`);
      await route.abort();
      return;
    }
    await route.continue();
  });

  await context.routeWebSocket("**/*", (route) => {
    requests.push(`BLOCKED websocket ${route.url()}`);
    route.close();
  });
  return requests;
}

async function verifyScenario(page, scenario) {
  const expected = BESTSELLER_FIXTURE_SCENARIOS[scenario];
  if (scenario === "error") {
    await page.getByRole("alert").waitFor();
    const text = await page.getByRole("alert").textContent();
    if (!text?.includes("Error loading bestsellers: Failed to fetch bestsellers")) {
      throw new Error(`Error scenario did not show the current endpoint failure state: ${text ?? "<empty>"}`);
    }
    return;
  }

  await page.getByRole("heading", { name: "Top Bestsellers" }).waitFor();
  const cardCount = await page.locator(".bestseller-card").count();
  if (cardCount !== expected.expectedCards) {
    throw new Error(`${scenario} expected ${expected.expectedCards} cards, rendered ${cardCount}.`);
  }
  if (scenario !== "success") {
    const empty = await page.locator(".bestseller-list__empty").textContent();
    if (!empty?.includes("No titles are currently available")) {
      throw new Error(`${scenario} did not render the expected empty-chart copy.`);
    }
  }
}

async function addFixtureLabel(page, scenario) {
  await page.addStyleTag({ content: `
    [data-ui-fixture-label] {
      position: fixed; z-index: 2147483647; right: 8px; bottom: 8px;
      max-width: calc(100vw - 16px); padding: 5px 7px; border-radius: 4px;
      background: #1a2a3a; color: #fff; font: 600 11px/1.2 system-ui, sans-serif;
      letter-spacing: .02em; box-shadow: 0 1px 4px rgba(0,0,0,.35);
    }
  ` });
  await page.evaluate(({ label, currentScenario }) => {
    // eslint-disable-next-line no-undef -- Playwright executes this serialized callback in the browser page.
    const pageDocument = document;
    const banner = pageDocument.createElement("aside");
    banner.dataset.uiFixtureLabel = "true";
    banner.textContent = `${label} · ${currentScenario}`;
    pageDocument.body.append(banner);
  }, { label: SYNTHETIC_BESTSELLER_LABEL, currentScenario: scenario });
}

function reportInterception(scenario, viewport, requests) {
  const fixture = requests.filter((request) => request.startsWith("FIXTURE "));
  const sockets = requests.filter((request) => request.startsWith("BLOCKED websocket"));
  const api = requests.filter((request) => request.startsWith("BLOCKED API"));
  const external = requests.filter((request) => request.startsWith("BLOCKED external"));
  const nonGet = requests.filter((request) => request.startsWith("BLOCKED non-GET"));
  if (api.length > 0 || nonGet.length > 0) {
    throw new Error(`${scenario} ${viewport.label} requested blocked routes: ${[...api, ...nonGet].join(", ")}`);
  }
  console.log(`${scenario} ${viewport.label}: verified; ${SYNTHETIC_BESTSELLER_LABEL}`);
  console.log(`  ${fixture.length} fixture API responses, ${sockets.length} blocked WebSocket(s), ${external.length} blocked external request(s)`);
}

async function captureScenario(browser, origin, outputDir, scenario) {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: viewport.width, height: viewport.height },
    });
    const requests = await installNetworkInterception(context, origin, scenario);
    const page = await context.newPage();
    await page.goto(`${origin}/scout/trends`, { waitUntil: "networkidle" });
    await verifyScenario(page, scenario);
    await addFixtureLabel(page, scenario);
    const captureBase = `${scenario}-${viewport.label}`;
    await page.screenshot({ path: join(outputDir, `${captureBase}.png`) });
    await page.screenshot({ path: join(outputDir, `${captureBase}-full-page.png`), fullPage: true });
    await writeFile(join(outputDir, `${captureBase}.evidence.json`), `${JSON.stringify({
      label: SYNTHETIC_BESTSELLER_LABEL,
      scenario,
      viewport: { width: viewport.width, height: viewport.height },
      servedFrom: origin,
      network: "Service workers blocked; API, WebSocket, and external routes intercepted.",
      requests,
    }, null, 2)}\n`);
    await context.close();
    reportInterception(scenario, viewport, requests);
  }
}

if (process.argv.includes("--help")) {
  printHelp();
  process.exit(0);
}

const dist = resolve(readOption("--dist") ?? defaultDist);
const outputDir = resolve(readOption("--output-dir") ?? defaultOutput);
const playwrightPrefix = resolve(readOption("--playwright-prefix") ?? process.env.PLAYWRIGHT_PACKAGE_DIR ?? defaultPlaywrightPrefix);
const scenarios = parseScenarios();
await mkdir(outputDir, { recursive: true });

const { chromium } = loadPlaywright(playwrightPrefix);
const staticServer = await startStaticServer(dist);
const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of scenarios) {
    await captureScenario(browser, staticServer.origin, outputDir, scenario);
  }
  console.log(`Captured ${scenarios.length * viewports.length} labelled synthetic baseline sets in ${outputDir}`);
} finally {
  await browser.close();
  await staticServer.close();
}
