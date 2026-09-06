import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePublicationEvent, verifyDockerPublishWorkflow } from "./publish-workflow-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publishWorkflow = await readFile(path.join(root, ".github/workflows/docker-publish.yml"), "utf8");
const ciWorkflow = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
const event = (input) => evaluatePublicationEvent(publishWorkflow, ciWorkflow, input);

assert.deepEqual(event({ name: "push", branch: "main" }), { ciRuns: true, push: true, tags: ["sha-<long-source-sha>", "main", "latest"] });
assert.deepEqual(event({ name: "push", branch: "codex/ui-simplification" }), { ciRuns: true, push: true, tags: ["sha-<long-source-sha>", "codex-ui-simplification", "ui-preview"] });
assert.deepEqual(event({ name: "push", branch: "feat/librarian-engine" }), { ciRuns: false, push: true, tags: ["sha-<long-source-sha>", "feat-librarian-engine", "beta"] });
assert.deepEqual(event({ name: "pull_request", base: "main", number: 42 }), { ciRuns: true, push: false, tags: ["sha-<long-source-sha>", "pr-42"] });
assert.deepEqual(event({ name: "tag", tag: "v1.2.3" }), { ciRuns: false, push: true, tags: ["sha-<long-source-sha>", "v1.2.3", "1.2.3", "1.2"] });
assert.equal(event({ name: "push", branch: "codex/unrelated" }), null);

const gates = [
  ["Type check", "npm run typecheck"],
  ["Lint", "npm run lint"],
  ["Run tests", "npm test"],
  ["Build release assets", "npm run build"],
  ["Verify frontend bundle budget", "npm run verify:bundle"],
  ["Verify release metadata", 'if [[ "${GITHUB_REF_TYPE}" == "tag" ]]; then\nnpm run release:check -- "${GITHUB_REF_NAME#v}"\nelse\nnpm run release:check\nfi'],
];

function gateBlock(workflow, name) {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `${name} fixture step must exist`);
  const next = workflow.indexOf("\n      - name:", start + marker.length);
  return { start, end: next < 0 ? workflow.length : next, content: workflow.slice(start, next < 0 ? undefined : next) };
}

function replaceGate(workflow, name, content) {
  const gate = gateBlock(workflow, name);
  return workflow.slice(0, gate.start) + content + workflow.slice(gate.end);
}

function moveGateAfterBuild(workflow, name) {
  const gate = gateBlock(workflow, name);
  const withoutGate = workflow.slice(0, gate.start) + workflow.slice(gate.end);
  const insertion = withoutGate.indexOf("      - name: Summarize published image");
  assert.notEqual(insertion, -1, "post-build fixture step must exist");
  return withoutGate.slice(0, insertion) + gate.content + "\n" + withoutGate.slice(insertion);
}

function addGateMetadata(workflow, name, metadata) {
  const gate = gateBlock(workflow, name);
  const eol = gate.content.includes("\r\n") ? "\r\n" : "\n";
  const firstLineEnd = gate.content.indexOf(eol) + eol.length;
  const content = gate.content.slice(0, firstLineEnd) + `        ${metadata}${eol}` + gate.content.slice(firstLineEnd);
  return replaceGate(workflow, name, content);
}

function neutralizedGate(name, command, kind) {
  if (kind === "echo") return `      - name: ${name}\n        run: echo gate disabled`;
  if (kind === "comment") return `      - name: ${name}\n        run: # ${command.split("\n").find((line) => line.startsWith("npm ")) ?? command}`;
  if (name === "Verify release metadata") {
    return gateBlock(publishWorkflow, name).content.replace("          fi", "          fi || true");
  }
  return `      - name: ${name}\n        run: ${command} || true`;
}

assert.throws(() => verifyDockerPublishWorkflow(publishWorkflow.replace("codex/ui-simplification", ""), ciWorkflow), /codex\/ui-simplification/);
assert.throws(() => verifyDockerPublishWorkflow(publishWorkflow.replace("github.event_name == 'push' && github.ref", "github.ref"), ciWorkflow), /ui-preview/);
for (const [gate, command] of gates) {
  assert.throws(() => verifyDockerPublishWorkflow(publishWorkflow.replace(`- name: ${gate}`, `- name: removed ${gate}`), ciWorkflow), new RegExp(gate));
  assert.throws(() => verifyDockerPublishWorkflow(moveGateAfterBuild(publishWorkflow, gate), ciWorkflow), new RegExp(gate));
  assert.throws(() => verifyDockerPublishWorkflow(replaceGate(publishWorkflow, gate, neutralizedGate(gate, command, "echo")), ciWorkflow), new RegExp(gate));
  assert.throws(() => verifyDockerPublishWorkflow(replaceGate(publishWorkflow, gate, neutralizedGate(gate, command, "swallow")), ciWorkflow), new RegExp(gate));
  assert.throws(() => verifyDockerPublishWorkflow(replaceGate(publishWorkflow, gate, neutralizedGate(gate, command, "comment")), ciWorkflow), new RegExp(gate));
  assert.throws(() => verifyDockerPublishWorkflow(addGateMetadata(publishWorkflow, gate, "if: false"), ciWorkflow), new RegExp(gate));
  assert.throws(() => verifyDockerPublishWorkflow(addGateMetadata(publishWorkflow, gate, "continue-on-error: true"), ciWorkflow), new RegExp(gate));
}
assert.throws(() => verifyDockerPublishWorkflow(publishWorkflow.replace("push: ${{ github.event_name != 'pull_request' }}", "push: false"), ciWorkflow), /pull-request/);
assert.throws(() => verifyDockerPublishWorkflow(publishWorkflow, ciWorkflow.replace(", codex/ui-simplification", "")), /codex\/ui-simplification/);
