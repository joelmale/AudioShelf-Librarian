import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { loadConfig } from "./config/index.js";
import { attachWebSocket } from "./websocket/index.js";
import { createLibrarianRouter } from "./modules/librarian/index.js";
import { createSystemRouter } from "./modules/system/index.js";
import { createCuratorRouter } from "./modules/curator/index.js";
import { authenticate, authEnabled } from "./security/auth.js";

async function main() {
  const config = loadConfig();
  
  const app = express();
  app.use(express.json());

  // Mount unified API
  const api = express.Router();
  api.use(authenticate);
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
        const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ");
        const logEntry = {
          level,
          message,
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
  
  api.use("/librarian", createLibrarianRouter(config, ws));
  api.use("/system", createSystemRouter());
  api.use("/", createCuratorRouter());
  
  app.use("/api", api);

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
          headers: { "Authorization": `Bearer ${sysSettings.absToken}` }
        });
        if (absRes.ok) absConnected = true;
      } catch (e) {
        absConnected = false;
      }
    }
    
    res.json({
      status: "ok",
      version: "1.0.0",
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
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
