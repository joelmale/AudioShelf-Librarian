import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { loadConfig } from "./config/index.js";
import { attachWebSocket } from "./websocket/index.js";
import { createLibrarianRouter } from "./modules/librarian/index.js";
// We will integrate Curator properly later, just a stub import for now
// import { createApp as createCuratorApp } from "./modules/curator/api/server.js";

async function main() {
  const config = loadConfig();
  
  const app = express();
  app.use(express.json());

  // Mount unified API
  const api = express.Router();

  // Unified HTTP Server
  const server = app.listen(config.PORT, () => {
    console.log(`Unified Backend running on port ${config.PORT}`);
  });

  // Attach WebSocket
  const ws = attachWebSocket(server);

  // Mount modules
  api.use("/librarian", createLibrarianRouter(config, ws));
  // api.use("/curator", createCuratorRouter(config, ws));
  
  app.use("/api", api);

  // Serve Frontend statically in production
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const frontendDist = path.join(__dirname, "../../../apps/frontend/dist");
  
  if (fs.existsSync(frontendDist)) {
    console.log("Serving frontend from", frontendDist);
    app.use(express.static(frontendDist));
    app.get("*", (req, res) => {
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
