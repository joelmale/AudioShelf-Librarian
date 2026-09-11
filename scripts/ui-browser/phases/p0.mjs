/* global document */
/**
 * P0 — baseline bestseller capture across four provider scenarios.
 *
 * Publication-evidence phase: proves the pre-simplification Discover surface
 * renders success, empty, HTTP 503 and HTTP 200/success:false identically to the
 * accepted baseline. Its interception is scenario-driven rather than
 * path-driven, so it keeps its own route handler instead of the core one.
 */

import { BESTSELLER_FIXTURE_SCENARIOS, SYNTHETIC_BESTSELLER_LABEL } from "../../fixtures/ui-simplification/bestsellers.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  option as readOption,
} from "../core.mjs";

const viewports = [
  { label: "390x844", width: 390, height: 844 },
  { label: "768x1024", width: 768, height: 1024 },
  { label: "1440x1000", width: 1440, height: 1000 },
];


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
    const fixturePath = url.pathname === "/health" || url.pathname === "/api/operations" || url.pathname === "/api/librarian/bestsellers" || url.pathname === "/api/candidates/intents";
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
    // P3 added this endpoint after P0 shipped; the shell requests it on every
    // Discover render, so the baseline must answer it to stay fail-closed.
    if (url.pathname === "/api/candidates/intents") {
      requests.push(`FIXTURE ${request.method()} /api/candidates/intents`);
      await route.fulfill({ status: 200, headers: jsonHeaders(), body: "{}" });
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
  process.exit(0);
}



export const phase = {
  id: "p0",
  title: "Baseline bestseller capture",
  defaultOutput: "ui-baseline-browser",
  viewports,
  async run({ browser, origin, outputDir }) {
    const scenarios = parseScenarios();
    for (const scenario of scenarios) {
      await captureScenario(browser, origin, outputDir, scenario);
    }
    console.log(`Captured synthetic P0 evidence in ${outputDir}`);
  },
};
