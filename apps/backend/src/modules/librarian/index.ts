import { Router } from "express";
import type { WsRouter } from "../../websocket/index.js";
import type { Config, ScanProgress } from "@audioshelf/shared/src/models";
import { MetadataScanner } from "./services/scanner.js";
import { ScanStrategy, type ScanOrder } from "./services/scanStrategies.js";
import { AudiobookBayService } from "./services/audiobookbay.js";
import { QBittorrentService } from "./services/qbittorrent.js";
import { TorrentMonitorService } from "./services/torrentMonitor.js";
import fs from "fs";
import path from "path";

export function createLibrarianRouter(config: Config, ws: WsRouter): Router {
  const router = Router();
  const scanner = new MetadataScanner(config);
  const strategy = new ScanStrategy();

  router.post("/scan", async (req, res) => {
    const targetDir = req.body.targetDir || config.INBOX_DIR || "/library";
    const order: ScanOrder = req.body.scanOrder || "alphabetical";

    try {
      const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => path.join(targetDir, e.name));
      
      res.json({ status: "started", total: dirs.length });

      // Run asynchronously so we don't block the HTTP response
      setImmediate(async () => {
        try {
          const orderedDirs = await strategy.orderDirectories(dirs, order);
          let scanned = 0;

          for (const dir of orderedDirs) {
            ws.broadcast({
              type: "librarian:scan_progress",
              payload: {
                scanned,
                total: orderedDirs.length,
                currentFile: path.basename(dir),
                status: "scanning"
              }
            });

            // Scan the directory
            await scanner.scanDirectory(dir);
            scanned++;
          }

          ws.broadcast({
            type: "librarian:scan_progress",
            payload: {
              scanned,
              total: orderedDirs.length,
              currentFile: "",
              status: "completed"
            }
          });
        } catch (e: any) {
          console.error("Scan error", e);
          ws.broadcast({
            type: "librarian:scan_progress",
            payload: {
              scanned: 0,
              total: 0,
              currentFile: "",
              status: "error"
            }
          });
        }
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  const abbService = new AudiobookBayService();
  const qbtService = new QBittorrentService();
  const torrentMonitor = new TorrentMonitorService();

  router.get("/status", async (req, res) => {
    try {
      const abbStats = abbService.getStats();
      const qbtOk = await qbtService.testConnection();
      const qbtTorrents = await qbtService.getTorrents("completed", "audiobooks");
      const monitorStats = torrentMonitor.getStats();

      let absOk = false;
      let absLibraries = 0;
      let absBooks = 0;
      
      if (config.ABS_URL && config.ABS_TOKEN) {
        try {
          const absRes = await fetch(`${config.ABS_URL.replace(/\/+$/, '')}/api/libraries`, {
            headers: { "Authorization": `Bearer ${config.ABS_TOKEN}` }
          });
          if (absRes.ok) {
            absOk = true;
            const data = await absRes.json();
            if (data && data.libraries) {
              absLibraries = data.libraries.length;
              absBooks = data.libraries.reduce((sum: number, lib: any) => sum + (lib.mediaCount || 0), 0);
            }
          }
        } catch (e) {
          console.error("ABS Status fetch failed", e);
        }
      }

      res.json({
        success: true,
        data: {
          audiobookbay: {
            activeDomain: abbStats.activeDomain,
            lastScrapeTime: abbStats.lastScrapeTime,
            knownMirrors: abbStats.knownMirrorsCount
          },
          qbittorrent: {
            connected: qbtOk,
            completedTorrents: qbtTorrents.length,
            importedTorrents: monitorStats.importedCount
          },
          audiobookshelf: {
            connected: absOk,
            libraries: absLibraries,
            books: absBooks
          }
        }
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/search", async (req, res) => {
    try {
      const query = req.query.q as string;
      const cat = req.query.cat as string;
      if (!query) {
        return res.status(400).json({ error: "Missing search query" });
      }
      
      const results = await abbService.search(query, cat);
      res.json({ success: true, results });
    } catch (e: any) {
      console.error("Search failed:", e);
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/download", async (req, res) => {
    try {
      const { bookUrl } = req.body;
      if (!bookUrl) {
        return res.status(400).json({ error: "Missing bookUrl" });
      }

      // Resolve the magnet link
      const magnetLink = await abbService.getMagnetLink(bookUrl);
      
      // Send to qBittorrent
      await qbtService.addMagnetLink(magnetLink);
      
      res.json({ success: true, message: "Sent to qBittorrent" });
    } catch (e: any) {
      console.error("Download failed:", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
