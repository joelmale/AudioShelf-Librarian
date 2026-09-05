const UI_BRANCH = "codex/ui-simplification";
const ENGINE_BRANCH = "feat/librarian-engine";
const DEFAULT_BRANCH = "main";
const RELEASE_GATES = [
  ["Type check", "npm run typecheck"],
  ["Lint", "npm run lint"],
  ["Run tests", "npm test"],
  ["Build release assets", "npm run build"],
  ["Verify frontend bundle budget", "npm run verify:bundle"],
  ["Verify release metadata", 'if [[ "${GITHUB_REF_TYPE}" == "tag" ]]; then\nnpm run release:check -- "${GITHUB_REF_NAME#v}"\nelse\nnpm run release:check\nfi'],
];

function requireContract(condition, message) {
  if (!condition) throw new Error(`Docker publication workflow contract: ${message}`);
}

function branchList(workflow, event) {
  const eventBlock = workflow.match(new RegExp(`${event}:([\\s\\S]*?)(?=\\r?\\n  [a-z_]+:|\\r?\\n\\r?\\nenv:|$)`))?.[1];
  const branches = eventBlock?.match(/branches:\s*\[([^\]]+)\]/)?.[1];
  return branches?.split(",").map((value) => value.trim().replaceAll('"', "")) ?? [];
}

function rawTagPredicate(workflow, tag) {
  return workflow.match(new RegExp(`type=raw,value=${tag},enable=\\$?\\{\\{\\s*(.*?)\\s*\\}\\}`))?.[1];
}

function stepBlock(workflow, name) {
  const start = workflow.indexOf(`- name: ${name}`);
  if (start < 0) return null;
  const end = workflow.indexOf("\n      - name:", start + 1);
  return { start, content: workflow.slice(start, end < 0 ? undefined : end) };
}

function normalizedRunBody(step) {
  const lines = step.replaceAll("\r\n", "\n").split("\n");
  const runIndex = lines.findIndex((line) => /^\s*run:/.test(line));
  if (runIndex < 0) return undefined;

  const runLine = lines[runIndex];
  const runMatch = runLine.match(/^(\s*)run:\s*(.*?)\s*$/);
  if (!runMatch) return undefined;
  if (runMatch[2] !== "|") return runMatch[2].trim();

  const runIndent = runMatch[1].length;
  const body = [];
  for (const line of lines.slice(runIndex + 1)) {
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    if (line.trim() !== "" && indentation <= runIndent) break;
    body.push(line.trim());
  }
  while (body.at(-1) === "") body.pop();
  return body.join("\n");
}

function workflowModel(publishWorkflow, ciWorkflow) {
  const pushBranches = branchList(publishWorkflow, "push");
  const ciPushBranches = branchList(ciWorkflow, "push");
  const uiPreviewPredicate = rawTagPredicate(publishWorkflow, "ui-preview");

  requireContract(pushBranches.join(",") === [DEFAULT_BRANCH, ENGINE_BRANCH, UI_BRANCH].join(","), "pushes must run for main, feat/librarian-engine, and codex/ui-simplification.");
  requireContract(ciPushBranches.join(",") === [DEFAULT_BRANCH, UI_BRANCH].join(","), "CI must run on pushes to main and codex/ui-simplification.");
  requireContract(branchList(publishWorkflow, "pull_request").join(",") === DEFAULT_BRANCH, "pull requests to main must build.");
  requireContract(branchList(ciWorkflow, "pull_request").join(",") === DEFAULT_BRANCH, "CI must run for pull requests to main.");
  requireContract(/tags:\s*\[\s*'v\*\.\*\.\*'\s*\]/.test(publishWorkflow), "release tags must remain v*.*.*.");
  requireContract(publishWorkflow.includes("type=sha,format=long"), "long SHA image tags must remain enabled.");
  requireContract(publishWorkflow.includes("type=semver,pattern=v{{version}}"), "v-prefixed semver image tags must remain enabled.");
  requireContract(publishWorkflow.includes("type=semver,pattern={{version}}"), "semver image tags must remain enabled.");
  requireContract(publishWorkflow.includes("type=semver,pattern={{major}}.{{minor}}"), "minor semver image tags must remain enabled.");
  requireContract(rawTagPredicate(publishWorkflow, "latest") === "is_default_branch", "latest must remain limited to main.");
  requireContract(rawTagPredicate(publishWorkflow, "beta") === `github.ref == 'refs/heads/${ENGINE_BRANCH}'`, "beta must remain limited to the engine branch.");
  requireContract(uiPreviewPredicate === `github.event_name == 'push' && github.ref == 'refs/heads/${UI_BRANCH}'`, "ui-preview must be limited to pushes of the UI branch.");
  requireContract(publishWorkflow.includes("push: ${{ github.event_name != 'pull_request' }}"), "pull-request builds must never push an image.");
  requireContract(publishWorkflow.includes("org.opencontainers.image.revision=${{ github.event.pull_request.head.sha || github.sha }}"), "OCI revision must identify the source SHA.");
  requireContract(publishWorkflow.includes("$GITHUB_STEP_SUMMARY"), "published images must write their digest to the job summary.");
  const buildStep = publishWorkflow.indexOf("- name: Build and push Docker image");
  for (const [name, command] of RELEASE_GATES) {
    const step = stepBlock(publishWorkflow, name);
    requireContract(step !== null && step.start < buildStep && normalizedRunBody(step.content) === command, `${name} must run its approved command before the Docker build.`);
    requireContract(!/^\s+continue-on-error:\s*true\s*$/m.test(step?.content ?? ""), `${name} must not continue after an error.`);
    requireContract(!/^\s+if:/m.test(step?.content ?? ""), `${name} must not be conditionally skipped.`);
  }

  return { pushBranches, ciPushBranches };
}

export function evaluatePublicationEvent(publishWorkflow, ciWorkflow, event) {
  const model = workflowModel(publishWorkflow, ciWorkflow);
  if (event.name === "push" && !model.pushBranches.includes(event.branch)) return null;
  if (event.name === "pull_request" && event.base !== DEFAULT_BRANCH) return null;
  if (event.name === "tag" && !/^v\d+\.\d+\.\d+$/.test(event.tag)) return null;

  const tags = ["sha-<long-source-sha>"];
  if (event.name === "push") {
    tags.push(event.branch.replaceAll("/", "-"));
    if (event.branch === DEFAULT_BRANCH) tags.push("latest");
    if (event.branch === ENGINE_BRANCH) tags.push("beta");
    if (event.branch === UI_BRANCH) tags.push("ui-preview");
  } else if (event.name === "pull_request") {
    tags.push(`pr-${event.number}`);
  } else {
    const version = event.tag.slice(1);
    const [major, minor] = version.split(".");
    tags.push(event.tag, version, `${major}.${minor}`);
  }

  return { ciRuns: event.name !== "tag" && (event.name !== "push" || model.ciPushBranches.includes(event.branch)), push: event.name !== "pull_request", tags };
}

export function verifyDockerPublishWorkflow(publishWorkflow, ciWorkflow) {
  workflowModel(publishWorkflow, ciWorkflow);
}
