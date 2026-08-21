import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { loadConfig } from "./config/index.js";
import { attachWebSocket } from "./websocket/index.js";
import { createLibrarianRouter } from "./modules/librarian/index.js";
import { createSystemRouter } from "./modules/system/index.js";
import { createCuratorRouter, createCuratorServices } from "./modules/curator/index.js";
import { createMcpRouter, type McpRouterHandle } from "./modules/curator/mcp/server.js";
import { authenticate, authEnabled, authorizeApi } from "./security/auth.js";

const mcpEnabled = process.env.MCP_ENABLED?.toLowerCase() === "true";

const APP_VERSION = process.env.npm_package_version ?? "1.1.0";

async function main() {
  const config = loadConfig();
  
  const app = express();
  app.use(express.json());

  // Mount unified API
  const api = express.Router();
  api.use(authenticate);
  api.use(authorizeApi);
  if (!authEnabled()) console.warn("AUTH_ENABLED=false: API access is unrestricted; use only on a trusted internal network");

  // Unified HTTP Server
  const server = app.listen(config.PORT, () => {
    console.log(`Unified Backend running on port ${config.PORT}`);
  });

  // Attach WebSocket
  const ws = attachWebSocket(server);

  // Setup console interceptor for debug logging
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const logHistory: { level: string, message: string, timestamp: string }[] = [];

  const broadcastLog = async (level: "info"|"warn"|"error", args: any[]) => {
    try {
      const { SettingsStore } = await import("./config/settings.js");
      const sysSettings = SettingsStore.getInstance().getSettings();
      if (sysSettings.debugLogs) {
        const { redactSecrets } = await import("./security/redact.js");
        const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ");
        const logEntry = {
          level,
          // This buffer is served by GET /api/system/logs and broadcast to every
          // connected socket, so nothing secret may survive into it.
          message: redactSecrets(message),
          timestamp: new Date().toISOString()
        };
        
        logHistory.push(logEntry);
        if (logHistory.length > 1500) {
          logHistory.shift();
        }
        
        ws.broadcast({
          type: "system:log",
          payload: logEntry
        });
      }
    } catch (e) {
      // Ignore errors in logging interceptor
    }
  };

  console.log = (...args) => {
    originalLog(...args);
    broadcastLog("info", args);
  };
  console.warn = (...args) => {
    originalWarn(...args);
    broadcastLog("warn", args);
  };
  console.error = (...args) => {
    originalError(...args);
    broadcastLog("error", args);
  };

  // Mount modules
  api.get("/system/logs", (req, res) => {
    res.json(logHistory);
  });
  
  // Built once: the bundle owns a SQLite connection and a running encode worker,
  // so the MCP mount below shares it rather than constructing a second one.
  const curatorServices = createCuratorServices();

  api.use("/librarian", createLibrarianRouter(config, ws));
  api.use("/system", createSystemRouter());
  api.use("/", createCuratorRouter(curatorServices));

  app.use("/api", api);

  // MCP is mounted outside the /api router on purpose. It gets `authenticate`
  // (so an unauthenticated caller is rejected when AUTH_ENABLED=true) but not
  // `authorizeApi`, whose role is derived from HTTP path and method: every MCP
  // call is one POST to one path, so that rule would both demand `curator` for
  // read-only tools and permit `curator` to reach the librarian- and
  // administrator-gated ones. Authorization is per-tool instead — see
  // modules/curator/mcp/authorization.ts.
  let mcp: McpRouterHandle | null = null;
  if (mcpEnabled) {
    mcp = createMcpRouter(curatorServices, curatorServices.logger);
    app.use("/mcp", authenticate, mcp.router);
    console.log("MCP server enabled at /mcp (14 tools, per-tool role checks)");
  }

  app.get("/health", async (req, res) => {
    const { SettingsStore } = await import("./config/settings.js");
    const sysSettings = SettingsStore.getInstance().getSettings();
    let absConnected = false;
    
    if (sysSettings.absUrl && sysSettings.absToken) {
      try {
        let baseUrl = sysSettings.absUrl.trim().replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(baseUrl)) {
          baseUrl = 'https://' + baseUrl;
        }
        const absRes = await fetch(`${baseUrl}/api/users`, {
          headers: { "Authorization": `Bearer ${sysSettings.absToken}` },
          // The container HEALTHCHECK has a 5s timeout and runs every 30s; an
          // unbounded probe against a hung ABS would stall it every time.
          signal: AbortSignal.timeout(3_000)
        });
        if (absRes.ok) absConnected = true;
      } catch (e) {
        absConnected = false;
      }
    }
    
    res.json({
      status: "ok",
      version: APP_VERSION,
      absConnected,
      dbWritable: true
    });
  });

  // Serve Frontend statically in production
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const frontendDist = path.join(__dirname, "../../../apps/frontend/dist");
  
  if (fs.existsSync(frontendDist)) {
    console.log("Serving frontend from", frontendDist);
    app.use(express.static(frontendDist));
    app.get(/.*/, (req, res) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  } else {
    console.log("Frontend build not found at", frontendDist, "(skip if in dev mode)");
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("Shutting down...");
    // Close MCP transports first: an open Streamable HTTP session holds a
    // response stream, which would keep server.close() waiting.
    void Promise.resolve(mcp?.close())
      .catch(() => undefined)
      .then(() => server.close(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
