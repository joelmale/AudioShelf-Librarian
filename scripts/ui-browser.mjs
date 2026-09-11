#!/usr/bin/env node
/**
 * Offline synthetic-browser UI harness — single entry point for every phase.
 *
 * Usage:
 *   node scripts/ui-browser.mjs --phase p6
 *   npm run ui:browser -- --phase p2 --output-dir temp/custom
 *
 * Options:
 *   --phase <p0|p1|p2|p6>   Which phase's assertions to run (default: p6).
 *   --dist <path>           Prebuilt frontend to serve (default: apps/frontend/dist).
 *   --output-dir <path>     Evidence directory (default: temp/<phase default>).
 *   --playwright-prefix <p> Playwright install outside the repo.
 *   --scenarios <a,b>       P0 only: subset of fixture scenarios.
 *
 * The harness never starts a backend and never reaches a real service: it serves
 * a prebuilt dist over loopback and fail-closes every request its phase did not
 * declare as a fixture. See scripts/ui-browser/core.mjs.
 */

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  defaultDist,
  defaultPlaywrightPrefix,
  loadPlaywright,
  option,
  repositoryRoot,
  staticServer,
} from "./ui-browser/core.mjs";

const PHASES = ["p0", "p1", "p2", "p6"];

const requested = (option("--phase") ?? "p6").toLowerCase();
if (!PHASES.includes(requested)) {
  console.error(`Unknown phase "${requested}". Expected one of: ${PHASES.join(", ")}`);
  process.exit(2);
}

const { phase } = await import(`./ui-browser/phases/${requested}.mjs`);

const dist = resolve(option("--dist") ?? defaultDist);
const outputDir = resolve(option("--output-dir") ?? join(repositoryRoot, "temp", phase.defaultOutput));
const playwrightPrefix = resolve(
  option("--playwright-prefix") ?? process.env.PLAYWRIGHT_PACKAGE_DIR ?? defaultPlaywrightPrefix,
);

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(playwrightPrefix, "browsers");
}

console.log(`[${phase.id}] ${phase.title}`);
console.log(`[${phase.id}] dist: ${dist}`);
console.log(`[${phase.id}] output: ${outputDir}`);

await mkdir(outputDir, { recursive: true });

const { chromium } = loadPlaywright(playwrightPrefix);
const server = await staticServer(dist);
const browser = await chromium.launch({ headless: true });

try {
  await phase.run({ browser, origin: server.origin, outputDir, viewports: phase.viewports });
} finally {
  await browser.close();
  await server.close();
}
