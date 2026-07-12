#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps", "frontend", "dist");
const manifestPath = path.join(dist, ".vite", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const entries = Object.entries(manifest);
const entry = entries.find(([, value]) => value.isEntry);

if (!entry) throw new Error("Frontend manifest has no application entry.");

const staticKeys = new Set();
function visit(key) {
  if (staticKeys.has(key)) return;
  const item = manifest[key];
  if (!item) throw new Error(`Manifest import ${key} is missing.`);
  staticKeys.add(key);
  for (const imported of item.imports ?? []) visit(imported);
}
visit(entry[0]);
const primaryKey = entries.find(([key]) => key.replaceAll("\\", "/").endsWith("src/preview/PreviewApp.tsx"))?.[0];
if (!primaryKey) throw new Error("Primary application chunk is missing from the manifest.");
visit(primaryKey);

const initialFiles = [...staticKeys]
  .map((key) => manifest[key].file)
  .filter((file) => file.endsWith(".js"));
const initialBytes = (await Promise.all(initialFiles.map(async (file) => (await stat(path.join(dist, file))).size)))
  .reduce((total, size) => total + size, 0);
const budgetBytes = 300_000;

if (initialBytes > budgetBytes) {
  throw new Error(`Initial JavaScript is ${initialBytes} bytes, above the ${budgetBytes}-byte budget.`);
}

const deferredSources = [
  "src/preview/pages/ScoutPage.tsx",
  "src/preview/pages/ProcessPage.tsx",
  "src/preview/pages/CuratePage.tsx",
  "src/features/logs/UnifiedLogsPage.tsx",
  "src/preview/components/PreviewSettingsDialog.tsx",
  "src/features/curator/pages/Tagging.tsx",
];

for (const source of deferredSources) {
  const key = entries.find(([candidate]) => candidate.replaceAll("\\", "/").endsWith(source))?.[0];
  if (!key) throw new Error(`Expected deferred entry ${source} is missing from the manifest.`);
  if (staticKeys.has(key)) throw new Error(`${source} leaked into the initial dependency graph.`);
}

if (entries.some(([key, value]) => key.includes("/classic/") || value.file.includes("ClassicApp"))) {
  throw new Error("A classic UI chunk is still present in the production manifest.");
}

console.log(`Initial JavaScript: ${initialBytes} bytes across ${initialFiles.length} files (budget ${budgetBytes}).`);
console.log("Deferred Scout, Process, Curate, Activity, Settings, and Tags entries verified.");
