#!/usr/bin/env node

import { WebSocket } from "ws";

const argv = process.argv.slice(2);
const readArg = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (argv.includes("--help")) {
  console.log(`Usage: npm run smoke:live:plan-scan -- --target-dir PATH --confirm-plan-only [options]

Options:
  --target-dir PATH       Existing path inside the configured inbox or library
  --confirm-plan-only     Required acknowledgement that a local ingest record will be created
  --base-url URL          Application URL (default AUDIOSHELF_BASE_URL or http://127.0.0.1:3050)
  --timeout-ms NUMBER     Completion timeout (default 120000)

The request always sends planOnly=true. Move and rename actions are proposed
for review and executeAction is never called.`);
  process.exit(0);
}

const targetDir = readArg("--target-dir");
if (!targetDir || !argv.includes("--confirm-plan-only")) {
  throw new Error("--target-dir and --confirm-plan-only are required. Run with --help for details.");
}

const baseUrl = new URL(readArg("--base-url") ?? process.env.AUDIOSHELF_BASE_URL ?? "http://127.0.0.1:3050");
const token = process.env.AUDIOSHELF_TOKEN;
const timeoutMs = Number.parseInt(readArg("--timeout-ms") ?? "120000", 10);
const socketUrl = new URL(baseUrl);
socketUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
socketUrl.pathname = "/api";
socketUrl.search = "";
if (token) socketUrl.searchParams.set("access_token", token);

const socket = new WebSocket(socketUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("WebSocket connection timed out")), 10_000);
  socket.once("open", () => { clearTimeout(timer); resolve(); });
  socket.once("error", (error) => { clearTimeout(timer); reject(error); });
});

let expectedJobId;
const bufferedTerminalProgress = new Map();
let acceptTerminalProgress;
const completion = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Plan-only scan timed out")), timeoutMs);
  acceptTerminalProgress = (payload) => {
    if (!expectedJobId || payload?.jobId !== expectedJobId) return;
    clearTimeout(timer);
    resolve(payload);
  };
  socket.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type !== "librarian:scan_progress") return;
      if (!["completed", "cancelled", "error"].includes(message.payload?.status)) return;
      if (typeof message.payload?.jobId === "string") {
        bufferedTerminalProgress.set(message.payload.jobId, message.payload);
      }
      acceptTerminalProgress(message.payload);
    } catch {
      // Ignore unrelated or malformed diagnostic messages.
    }
  });
});

try {
  const response = await fetch(new URL("/api/librarian/scan", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ targetDir, scanOrder: "alphabetical", planOnly: true }),
    signal: AbortSignal.timeout(15_000),
  });
  const started = await response.json();
  if (!response.ok) throw new Error(started?.error ?? `${response.status} ${response.statusText}`);
  if (started.mode !== "plan-only") throw new Error("Server did not acknowledge plan-only mode.");
  if (typeof started.jobId !== "string" || !started.jobId) throw new Error("Server did not return a scan job ID.");
  expectedJobId = started.jobId;
  const bufferedProgress = bufferedTerminalProgress.get(expectedJobId);
  if (bufferedProgress) acceptTerminalProgress(bufferedProgress);

  const finalProgress = await completion;
  if (finalProgress.status !== "completed") throw new Error(`Plan-only scan ended with ${finalProgress.status}.`);

  const jobResponse = await fetch(new URL(`/api/librarian/jobs/${encodeURIComponent(started.jobId)}`, baseUrl), {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const jobBody = await jobResponse.json();
  if (!jobResponse.ok) throw new Error(jobBody?.error ?? "Unable to read the plan-only job.");
  const proposedCount = Array.isArray(finalProgress.results)
    ? finalProgress.results.length
    : jobBody.data?.items?.filter((item) => item.action?.action_type !== "skip").length ?? 0;

  console.log(`Plan-only scan completed: ${started.jobId}`);
  console.log(`Scanned ${finalProgress.scanned ?? 0}/${finalProgress.total ?? 0} targets; ${proposedCount} proposed item(s).`);
  console.log("No move or rename action was executed.");
} finally {
  socket.close();
  void completion.catch(() => undefined);
}
