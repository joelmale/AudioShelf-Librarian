import { Router } from "express";
import type { WsRouter } from "../../websocket/index.js";
import type { Config, ScanProgress } from "@audioshelf/shared";
import { MetadataScanner } from "./services/scanner.js";
import { ScanStrategy, type ScanOrder } from "./services/scanStrategies.js";
import { AudiobookBayService } from "./services/audiobookbay.js";
import { QBittorrentService } from "./services/qbittorrent.js";
import { TorrentMonitorService } from "./services/torrentMonitor.js";
import fs from "fs";
import path from "path";
import { SettingsStore } from "../../config/settings.js";

export function createLibrarianRouter(config: Config, ws: WsRouter): Router {
  const router = Router();
  const scanner = new MetadataScanner(config);
  const strategy = new ScanStrategy();
  const settingsStore = SettingsStore.getInstance();

  // Global state for active scan session
  let activeScan: { 
    isCancelled: boolean; 
    results: any[]; 
    isRunning: boolean;
  } = { isCancelled: false, results: [], isRunning: false };

  const organizer = scanner['organizer'] as any; // Access the organizer inside scanner

  router.post("/scan", async (req, res) => {
    if (activeScan.isRunning) {
      return res.status(400).json({ error: "A scan is already running" });
    }

    const sysSettings = settingsStore.getSettings();
    const targetDir = req.body.targetDir || sysSettings.inboxDir || "/library";
    const order: ScanOrder = req.body.scanOrder || "alphabetical";

    try {
      if (!fs.existsSync(targetDir)) {
        return res.status(400).json({ error: `Directory does not exist: ${targetDir}` });
      }

      const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
      
      const audioExts = new Set(['.mp3', '.m4a', '.m4b', '.flac', '.ogg', '.opus', '.wav', '.aac']);
      const hasAudioFiles = entries.some(e => e.isFile() && audioExts.has(path.extname(e.name).toLowerCase()));
      
      let dirs: string[];
      if (hasAudioFiles) {
        // Target is a single book folder, scan it directly
        dirs = [targetDir];
      } else {
        // Target is an inbox folder, scan its subdirectories
        dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => path.join(targetDir, e.name));
      }
      
      activeScan = { isCancelled: false, results: [], isRunning: true };
      res.json({ status: "started", total: dirs.length });

      // Run asynchronously so we don't block the HTTP response
      setImmediate(async () => {
        try {
          const orderedDirs = await strategy.orderDirectories(dirs, order);
          let scanned = 0;

          for (const dir of orderedDirs) {
            if (activeScan.isCancelled) {
              console.log("Scan cancelled by user");
              break;
            }

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
            const book = await scanner.scanDirectory(dir);
            scanned++;

            // Use the organizer to get the proposed action
            const action = organizer.organizeBook(book);
            if (action.action_type !== "skip") {
              activeScan.results.push(action);
              // Broadcast the proposed action
              ws.broadcast({
                type: "librarian:scan_action",
                payload: action
              });
            }
          }

          ws.broadcast({
            type: "librarian:scan_progress",
            payload: {
              scanned,
              total: orderedDirs.length,
              currentFile: "",
              status: activeScan.isCancelled ? "cancelled" : "completed"
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
        } finally {
          activeScan.isRunning = false;
        }
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/scan/cancel", (req, res) => {
    if (!activeScan.isRunning) {
      return res.status(400).json({ error: "No scan is currently running" });
    }
    activeScan.isCancelled = true;
    res.json({ success: true, message: "Scan cancellation requested" });
  });

  router.post("/scan/commit", async (req, res) => {
    if (activeScan.isRunning) {
      return res.status(400).json({ error: "Cannot commit while a scan is running" });
    }
    if (activeScan.results.length === 0) {
      return res.status(400).json({ error: "No actions to commit" });
    }

    const actionsToExecute = [...activeScan.results];
    activeScan.results = []; // Clear them out
    
    // Send immediate response
    res.json({ success: true, message: "Started committing changes", total: actionsToExecute.length });

    // Execute asynchronously
    setImmediate(async () => {
      let executed = 0;
      for (const action of actionsToExecute) {
        try {
          await organizer.executeAction(action);
          executed++;
        } catch (e) {
          console.error(`Failed to execute action for ${action.source_path}`, e);
        }
      }
      console.log(`Finished committing ${executed}/${actionsToExecute.length} actions.`);
    });
  });

  const abbService = new AudiobookBayService();
  const qbtService = new QBittorrentService();
  const torrentMonitor = new TorrentMonitorService();

  router.get("/status", async (req, res) => {
    try {
      const abbStats = abbService.getStats();
      let qbtOk = false;
      let qbtTorrents: any[] = [];
      let monitorStats = { importedCount: 0, activeDownloads: 0, completedDownloads: 0 };
      
      try {
        qbtOk = await qbtService.testConnection();
        if (qbtOk) {
          qbtTorrents = await qbtService.getTorrents("completed", "audiobooks");
          monitorStats = await torrentMonitor.getStats();
        }
      } catch (e) {
        console.error("QBT Status fetch failed", e);
      }

      let absOk = false;
      let absLibraries = 0;
      let absBooks = 0;
      
      const sysSettings = settingsStore.getSettings();
      if (sysSettings.absUrl && sysSettings.absToken) {
        try {
          let baseUrl = sysSettings.absUrl.trim().replace(/\/+$/, '');
          if (!/^https?:\/\//i.test(baseUrl)) {
            baseUrl = 'https://' + baseUrl;
          }
          const absRes = await fetch(`${baseUrl}/api/libraries`, {
            headers: { "Authorization": `Bearer ${sysSettings.absToken}` }
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
