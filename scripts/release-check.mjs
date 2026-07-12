#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (...parts) => JSON.parse(await readFile(path.join(root, ...parts), "utf8"));
const packagePaths = [
  ["package.json"],
  ["apps", "backend", "package.json"],
  ["apps", "frontend", "package.json"],
  ["packages", "shared", "package.json"],
];
const packages = await Promise.all(packagePaths.map((parts) => readJson(...parts)));
const expected = process.argv[2] ?? packages[0].version;
const semverIdentifier = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const semverPattern = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${semverIdentifier}(?:\\.${semverIdentifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

if (!semverPattern.test(expected)) throw new Error(`${expected} is not a valid semantic version.`);

if (process.env.GITHUB_REF_TYPE === "tag") {
  const expectedTag = `v${expected}`;
  if (process.env.GITHUB_REF_NAME !== expectedTag) {
    throw new Error(`Git tag ${process.env.GITHUB_REF_NAME ?? "<missing>"} does not match package version ${expected}.`);
  }
}

for (const pkg of packages) {
  if (pkg.version !== expected) throw new Error(`${pkg.name} is ${pkg.version}; expected ${expected}.`);
}

const lock = await readJson("package-lock.json");
for (const key of ["", "apps/backend", "apps/frontend", "packages/shared"]) {
  if (lock.packages?.[key]?.version !== expected) {
    throw new Error(`package-lock entry ${key || "root"} is ${lock.packages?.[key]?.version}; expected ${expected}.`);
  }
}

const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## [${expected}] -`)) throw new Error(`CHANGELOG.md has no ${expected} release entry.`);

const publishWorkflow = await readFile(path.join(root, ".github", "workflows", "docker-publish.yml"), "utf8");
if (!publishWorkflow.includes("type=semver,pattern=v{{version}}")) throw new Error("Docker workflow does not publish v-prefixed semver tags.");
if (!publishWorkflow.includes("flavor: latest=false")) throw new Error("Docker workflow does not restrict latest to the default branch.");
if (!publishWorkflow.includes("gh release create")) throw new Error("Docker workflow does not create a GitHub Release for version tags.");

console.log(`Release ${expected} metadata is consistent across all workspaces.`);
