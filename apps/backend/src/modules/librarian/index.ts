import { Router } from "express";
import type { WsRouter } from "../../websocket/index.js";
import type { Config, ScanProgress } from "@audioshelf/shared";
import { MetadataScanner } from "./services/scanner.js";
import { ScanStrategy, type ScanOrder } from "./services/scanStrategies.js";
import { AudiobookBayService } from "./services/audiobookbay.js";
import { QBittorrentService } from "./services/qbittorrent.js";
import { TorrentMonitorService } from "./services/torrentMonitor.js";
import type { OrganizationAction } from "@audioshelf/shared";
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
    results: OrganizationAction[]; 
    isRunning: boolean;
  } = { isCancelled: false, results: [], isRunning: false };

  const organizer = scanner.getOrganizer(); // Access the organizer inside scanner

  router.post("/scan", async (req, res) => {
    if (activeScan.isRunning) {
      return res.status(400).json({ error: "A scan is already running" });
    }

    const sysSettings = settingsStore.getSettings();
    const baseDir = path.resolve(sysSettings.inboxDir || "/library");
    const allowedLibraryDir = path.resolve(sysSettings.libraryDir || "/books");
    const targetDir = req.body.targetDir ? path.resolve(req.body.targetDir) : baseDir;

    if (!targetDir.startsWith(baseDir) && !targetDir.startsWith(allowedLibraryDir)) {
      return res.status(403).json({ error: "Access denied. Path outside allowed directories." });
    }
    const order: ScanOrder = req.body.scanOrder || "alphabetical";

    try {
      if (!fs.existsSync(targetDir)) {
        return res.status(400).json({ error: `Directory does not exist: ${targetDir}` });
      }

      const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
      
      const audioExts = new Set(['.mp3', '.m4a', '.m4b', '.flac', '.ogg', '.opus', '.wav', '.aac']);
      const partFolderRegex = /^(?:cd|disc|disk|part|pt)\s*[-_]?\s*\d+/i;

      async function findBookDirectories(dir: string): Promise<string[]> {
        const bookDirs: string[] = [];
        
        async function walk(currentDir: string) {
          console.log(`[DeepScan] Walking: ${currentDir}`);
          const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
          const dirsList = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('@'));
          const filesList = entries.filter(e => e.isFile() && !e.name.startsWith('.'));
          
          console.log(`[DeepScan]  -> Found ${dirsList.length} dirs, ${filesList.length} files`);
          
          const hasAudioFiles = filesList.some(e => {
            const ext = path.extname(e.name).toLowerCase();
            const isAudio = audioExts.has(ext);
            if (isAudio) console.log(`[DeepScan]  -> Found audio file: ${e.name}`);
            return isAudio;
          });
          
          if (hasAudioFiles) {
            console.log(`[DeepScan]  -> Marked ${currentDir} as book directory!`);
            bookDirs.push(currentDir);
            return;
          }
          
          if (dirsList.length > 0) {
            const allDirsAreParts = dirsList.every(d => partFolderRegex.test(d.name));
            if (allDirsAreParts) {
              console.log(`[DeepScan]  -> All subdirs are parts! Marked ${currentDir} as book directory!`);
              bookDirs.push(currentDir);
              return;
            }
            
            await Promise.all(dirsList.map(d => walk(path.join(currentDir, d.name))));
          }
        }
        
        await walk(dir);
        console.log(`[DeepScan] Finished. Found ${bookDirs.length} books.`);
        return bookDirs;
      }
      
      let dirs = await findBookDirectories(targetDir);
      
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

            try {
              // Scan the directory
              const book = await scanner.scanDirectory(dir);
              
              if (book.audio_files.length > 0) {
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
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.warn(`Skipped ${dir} during scan:`, errMsg);
            }
            scanned++;
          }

          ws.broadcast({
            type: "librarian:scan_progress",
            payload: {
              scanned,
              total: orderedDirs.length,
              currentFile: "",
              status: activeScan.isCancelled ? "cancelled" : "completed",
              results: activeScan.results
            }
          });
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error("Scan error", errMsg);
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
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMsg });
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
      const successfulActions: typeof actionsToExecute = [];

      for (const action of actionsToExecute) {
        try {
          await organizer.executeAction(action);
          if (action.success) {
            successfulActions.push(action);
          }
          executed++;
        } catch (e) {
          console.error(`Failed to execute action for ${action.source_path}`, e);
        }
      }
      
      if (successfulActions.length > 0) {
        const HistoryStore = (await import("../../config/history.js")).HistoryStore;
        HistoryStore.getInstance().addBatch(successfulActions);
      }
      
      console.log(`Finished committing ${executed}/${actionsToExecute.length} actions.`);
    });
  });

  router.post("/scan/rollback", async (req, res) => {
    try {
      const { batchId } = req.body || {};
      const HistoryStore = (await import("../../config/history.js")).HistoryStore;
      const history = HistoryStore.getInstance();
      
      let batchToRollback = null;
      if (batchId) {
        batchToRollback = history.getHistory().find(b => b.id === batchId);
      } else {
        batchToRollback = history.getLatestBatch();
      }
      
      if (!batchToRollback) {
        return res.status(400).json({ error: "No history found to rollback" });
      }

      let rolledBack = 0;
      for (const action of batchToRollback.actions) {
        // Only rollback moves and renames
        if (action.action_type === "move" || action.action_type === "rename") {
          const tPath = path.resolve(action.target_path);
          const sysSettings = settingsStore.getSettings();
          const baseDir = path.resolve(sysSettings.inboxDir || "/library");
          const allowedLibraryDir = path.resolve(sysSettings.libraryDir || "/books");
          if (!tPath.startsWith(baseDir) && !tPath.startsWith(allowedLibraryDir)) {
            console.warn(`Rollback target path ${tPath} is outside allowed directories`);
            continue;
          }
          try {
            // Target path is where the file currently is. Source path is where it should go back to.
            if (fs.existsSync(action.target_path)) {
              await fs.promises.rename(action.target_path, action.source_path);
              rolledBack++;
            }
          } catch (e: unknown) {
            const errObj = e as { code?: string };
            if (errObj.code === 'EXDEV') {
               await fs.promises.cp(action.target_path, action.source_path, { recursive: true });
               await fs.promises.rm(action.target_path, { recursive: true, force: true });
               rolledBack++;
            } else {
              console.error(`Failed to rollback ${action.target_path}:`, e);
            }
          }
        }
      }

      // Remove from history
      history.removeBatch(batchToRollback.id);

      res.json({ success: true, message: `Rolled back ${rolledBack} actions successfully` });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("Rollback failed:", errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  router.post("/scan/enhance-metadata", async (req, res) => {
    try {
      const { action } = req.body;
      if (!action || !action.book) {
        return res.status(400).json({ error: "Missing action or book object" });
      }

      const sysSettings = settingsStore.getSettings();
      const ollamaUrl = sysSettings.ollamaUrl || "http://ollama:11434";
      const ollamaModel = sysSettings.ollamaModel || "mistral-nemo:latest";
      const book = action.book;

      const prompt = `You are a meticulous metadata extraction assistant for audiobooks.

Analyze the following input folder path and raw data to extract clean metadata.
---
INPUT PATH: ${book.source_path}
RAW TITLE: ${book.title}
RAW AUTHOR: ${book.authors?.join(", ") || "Unknown"}
---

RULES:
1. The overarching Series Name should be separated from the individual Book Title.
2. If the book is a novella or part of a series, extract decimal points for series numbers accurately (e.g., 0.2).
3. Do not include narrator names in the title or author.

Respond strictly using this JSON schema:
{
  "title": "Cleaned Book Title",
  "author": "Cleaned Author Name",
  "series": "Series Name",
  "series_number": 0.0
}`;

      if (sysSettings.debugLogs) {
        console.log(`[Ollama] Sending request to ${ollamaUrl} using model ${ollamaModel}`);
        console.log(`[Ollama] Prompt: \n${prompt}`);
      }

      const response = await fetch(`${ollamaUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ollamaModel,
          prompt,
          stream: false,
          format: "json"
        })
      });

      if (!response.ok) {
         throw new Error(`Ollama failed: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (sysSettings.debugLogs) {
        console.log(`[Ollama] Response received: \n${data.response}`);
      }
      let extracted;
      try {
        extracted = JSON.parse(data.response);
      } catch(e) {
        throw new Error("Failed to parse JSON from Ollama");
      }

      book.title = extracted.title || book.title;
      if (extracted.author && extracted.author !== "Unknown Author") {
        book.authors = [extracted.author];
      }
      if (extracted.series) {
        book.series = extracted.series;
        book.series_number = extracted.series_number ? parseFloat(extracted.series_number) : null;
        book.is_series = true;
      } else {
        book.series = null;
        book.series_number = null;
        book.is_series = false;
      }
      book.metadata_source = "manual";
      book.confidence_score = 1.0;

      // Re-organize to get updated paths and action type
      const newAction = organizer.organizeBook(book);

      // Update in active scan so the backend has the correct state on commit
      const idx = activeScan.results.findIndex(a => a.source_path === newAction.source_path);
      if (idx !== -1) {
        activeScan.results[idx] = newAction;
      }

      res.json({ success: true, data: newAction });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("Enhance failed:", errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  router.get("/scan/history", async (req, res) => {
    try {
      const HistoryStore = (await import("../../config/history.js")).HistoryStore;
      const history = HistoryStore.getInstance().getHistory();
      res.json({ success: true, data: history });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMsg });
    }
  });

  const abbService = new AudiobookBayService();
  const qbtService = new QBittorrentService();
  const torrentMonitor = new TorrentMonitorService();

  router.get("/status", async (req, res) => {
    try {
      const abbStats = abbService.getStats();
      let qbtOk = false;
      let qbtTorrents: unknown[] = [];
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
              absBooks = data.libraries.reduce((sum: number, lib: { mediaCount?: number }) => sum + (lib.mediaCount || 0), 0);
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
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMsg });
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
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("Search failed:", errMsg);
      res.status(500).json({ error: errMsg });
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
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("Download failed:", errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  return router;
}
