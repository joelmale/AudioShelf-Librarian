import { Router, type Response } from "express";
import type { WsRouter } from "../../websocket/index.js";
import type { Config, ScanProgress } from "@audioshelf/shared";
import { MetadataScanner } from "./services/scanner.js";
import { ScanStrategy, type ScanOrder } from "./services/scanStrategies.js";
import { AudiobookBayService, AntiBotChallengeError } from "./services/audiobookbay.js";
import { BestsellersService } from "./services/bestsellers.js";
import { QBittorrentService } from "./services/qbittorrent.js";
import { TorrentMonitorService } from "./services/torrentMonitor.js";
import { InboxPollerService } from "./services/inboxPoller.js";
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { OrganizationAction } from "@audioshelf/shared";
import fs from "fs";
import path from "path";
import { SettingsStore } from "../../config/settings.js";
import { ABSClient } from "../curator/core/absClient.js";
import { assertContained, assertContainedInAny } from "../../security/paths.js";
import { IngestStore } from "./ingestStore.js";
import { requireRole } from "../../security/auth.js";
import { RealignService } from "./services/realign.js";
import { buildAcquisitionPipeline } from "./services/acquisitionPipeline.js";
import { rollbackBatch } from "./services/rollback.js";

export function shouldAutoExecuteScanAction(
  actionType: OrganizationAction["action_type"],
  planOnly: boolean,
): boolean {
  return !planOnly && (actionType === "move" || actionType === "rename");
}

export function createLibrarianRouter(config: Config, ws: WsRouter): Router {
  const router = Router();
  /** One proxy middleware per resolved ABB domain, not one per request. */
  const abbProxyCache = new Map<string, ReturnType<typeof createProxyMiddleware>>();
  const scanner = new MetadataScanner(config);
  const strategy = new ScanStrategy();
  const settingsStore = SettingsStore.getInstance();
  const ingestStore = new IngestStore();

  // Global state for active scan session
  let activeScan: { 
    isCancelled: boolean; 
    results: OrganizationAction[]; 
    isRunning: boolean;
    jobId: string | null;
    itemIds: Map<string,string>;
    planOnly: boolean;
  } = { isCancelled: false, results: [], isRunning: false, jobId: null, itemIds: new Map(), planOnly: false };

  const rejectPlanOnlyMutation = (res: Response, jobId = activeScan.jobId): boolean => {
    const isPlanOnly = jobId ? ingestStore.get(jobId)?.planOnly === true : activeScan.planOnly;
    if (!isPlanOnly) return false;
    res.status(409).json({
      error: "Plan-only scan sessions cannot modify files or scan results. Start a live scan to perform this action.",
      code: "PLAN_ONLY_SESSION",
    });
    return true;
  };

  const organizer = scanner.getOrganizer(); // Access the organizer inside scanner
  const finalizeInAbs=async(itemId:string,jobId:string,action:OrganizationAction)=>{
    ingestStore.transitionItem(itemId,'finalized');
    const job=ingestStore.get(jobId); const settings=settingsStore.getSettings();
    if(!job?.libraryId||!settings.absUrl||!settings.absToken){ingestStore.transitionItem(itemId,'complete');return;}
    const client=new ABSClient(settings.absUrl,settings.absToken); await client.triggerLibraryScan(job.libraryId); ingestStore.transitionItem(itemId,'scan_requested');
    for(let attempt=0;attempt<6;attempt++){const items=await client.getLibraryItems(job.libraryId);const target=path.resolve(action.target_path);const found=items.find(i=>i.path&&path.resolve(i.path)===target);if(found){ingestStore.transitionItem(itemId,'abs_item_resolved',null,found.id);ingestStore.transitionItem(itemId,'complete',null,found.id);return;}await new Promise(r=>setTimeout(r,1000));}
    throw new Error('ABS scan completed but the imported item could not be resolved');
  };

  router.get('/jobs', requireRole('viewer'), (_req,res) => res.json({ success:true, data:ingestStore.list() }));
  router.get('/jobs/:id', requireRole('viewer'), (req,res) => { const id=String(req.params.id); const job=ingestStore.get(id); if(!job)return res.status(404).json({error:'Job not found'}); res.json({success:true,data:job}); });
  router.post('/jobs/:id/cancel', requireRole('librarian'), (req,res) => { const id=String(req.params.id); ingestStore.cancelJob(id); if(activeScan.jobId===id)activeScan.isCancelled=true; res.json({success:true}); });
  router.post('/jobs/:id/retry',requireRole('librarian'),async(req,res)=>{const id=String(req.params.id);if(rejectPlanOnlyMutation(res,id))return;const job=ingestStore.get(id);if(!job)return res.status(404).json({error:'Job not found'});const failed=job.items.filter(i=>i.state==='failed');for(const item of failed){try{ingestStore.transitionItem(item.id,'staging');await organizer.executeAction(item.action);await finalizeInAbs(item.id,id,item.action);}catch(e:any){ingestStore.transitionItem(item.id,'failed',e.message);}}res.json({success:true,data:ingestStore.get(id)});});

  router.post("/scan", requireRole('librarian'), async (req, res) => {
    if (activeScan.isRunning) {
      return res.status(400).json({ error: "A scan is already running" });
    }

    const sysSettings = settingsStore.getSettings();
    const baseDir = path.resolve(sysSettings.inboxDir || "/library");
    const allowedLibraryDir = path.resolve(sysSettings.libraryDir || "/books");
    const targetDir = req.body.targetDir ? path.resolve(req.body.targetDir) : baseDir;
    const planOnly = req.body.planOnly === true;

    const order: ScanOrder = req.body.scanOrder || "alphabetical";

    try {
      await assertContainedInAny(targetDir, [baseDir, allowedLibraryDir], { allowRoot: true, mustExist: true });
      if (!fs.existsSync(targetDir)) {
        return res.status(400).json({ error: `Directory does not exist: ${targetDir}` });
      }

      const jobId = ingestStore.create(targetDir, typeof req.body.libraryId === 'string' ? req.body.libraryId : undefined, planOnly);
      activeScan = { isCancelled: false, results: [], isRunning: true, jobId, itemIds:new Map(), planOnly };
      res.json({
        status: "started",
        jobId,
        mode: planOnly ? "plan-only" : "live",
        message: planOnly ? "Plan-only discovery initiated" : "Discovery phase initiated",
      });

      // Run asynchronously so we don't block the HTTP response
      setImmediate(async () => {
        try {
          // Attempt to populate the ABS duplicate detection cache
          if (sysSettings.absUrl && sysSettings.absToken) {
            try {
              const absClient = new ABSClient(sysSettings.absUrl, sysSettings.absToken);
              const libraries = await absClient.getLibraries();
              const allItems: any[] = [];
              for (const lib of libraries) {
                const items = await absClient.getLibraryItems(lib.id);
                allItems.push(...items);
              }
              organizer.setAbsCache(allItems);
            } catch (err) {
              console.warn("Failed to populate ABS cache for duplicate detection, gracefully degrading to local filesystem checks.", err);
              organizer.setAbsCache([]);
            }
          } else {
            organizer.setAbsCache([]);
          }

          const dirs = await scanner.discoverTargets(
            targetDir, 
            (message, files) => {
              ws.broadcast({
                type: "librarian:scan_warning",
                payload: { message, files }
              });
            },
            (currentDir) => {
              ws.broadcast({
                type: "librarian:scan_progress",
                payload: {
                  jobId,
                  scanned: 0,
                  total: 0,
                  currentFile: path.basename(currentDir) || currentDir,
                  status: "discovering",
                  planOnly: activeScan.planOnly,
                }
              });
            }
          );
          
          const orderedDirs = await strategy.orderDirectories(dirs, order);
          let scanned = 0;

          for (const target of orderedDirs) {
            if (activeScan.isCancelled) {
              console.log("Scan cancelled by user");
              break;
            }

            const displayName = Array.isArray(target) ? path.basename(target[0]) : path.basename(target);

            ws.broadcast({
              type: "librarian:scan_progress",
              payload: {
                jobId,
                scanned,
                total: orderedDirs.length,
                currentFile: displayName,
                status: "scanning",
                planOnly: activeScan.planOnly,
              }
            });

            try {
              // Scan the target
              const book = await scanner.scanTarget(target);
              
              if (book.audio_files.length > 0) {
                const action = await organizer.organizeBook(book);
                const itemId = ingestStore.addItem(jobId, action);
                activeScan.itemIds.set(action.source_path,itemId);
                if (shouldAutoExecuteScanAction(action.action_type, planOnly)) {
                  console.log(`[Auto-Acquisition] Clean book detected: "${book.title}". Automatically integrating into library.`);
                  try {
                    ingestStore.transitionItem(itemId,'approved');
                    ingestStore.transitionItem(itemId,'staging');
                    await organizer.executeAction(action);
                    await finalizeInAbs(itemId,jobId,action);
                    console.log(`[Auto-Acquisition] Successfully moved "${book.title}" to ${action.target_path}.`);
                  } catch(err: any) {
                    ingestStore.transitionItem(itemId,'failed',err.message);
                    console.error(`[Auto-Acquisition] Failed to integrate "${book.title}":`, err);
                    action.action_type = 'error';
                    action.error_message = err.message;
                    activeScan.results.push(action);
                    ws.broadcast({ type: "librarian:scan_action", payload: action });
                  }
                } else if (action.action_type !== "skip") {
                  if (planOnly && (action.action_type === "move" || action.action_type === "rename")) {
                    console.log(`[Plan Only] Proposed ${action.action_type} for "${book.title}"; no files were changed.`);
                  }
                  if (action.action_type === "duplicate") {
                     console.warn(`[Auto-Acquisition] Duplicate detected for "${book.title}". Pausing for user review.`);
                  }
                  activeScan.results.push(action);
                  ws.broadcast({
                    type: "librarian:scan_action",
                    payload: action
                  });
                }
              }
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.warn(`Skipped ${Array.isArray(target) ? 'files' : target} during scan:`, errMsg);
            }
            scanned++;
          }

          ws.broadcast({
            type: "librarian:scan_progress",
            payload: {
              jobId,
              scanned,
              total: orderedDirs.length,
              currentFile: "",
              status: activeScan.isCancelled ? "cancelled" : "completed",
              planOnly: activeScan.planOnly,
              results: activeScan.results
            }
          });
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error("Scan error", errMsg);
          ws.broadcast({
            type: "librarian:scan_progress",
            payload: {
              jobId,
              scanned: 0,
              total: 0,
              currentFile: "",
              status: "error",
              planOnly: activeScan.planOnly,
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

  router.post("/scan/cancel", requireRole('librarian'), (req, res) => {
    if (!activeScan.isRunning) {
      return res.status(400).json({ error: "No scan is currently running" });
    }
    activeScan.isCancelled = true;
    if(activeScan.jobId) ingestStore.cancelJob(activeScan.jobId);
    res.json({ success: true, message: "Scan cancellation requested" });
  });

  router.post("/scan/delete", requireRole('administrator'), async (req, res) => {
    if (rejectPlanOnlyMutation(res)) return;
    const { source_path } = req.body;
    if (!source_path) {
      return res.status(400).json({ error: "No source path provided" });
    }

    try {
      const inboxDir = SettingsStore.getInstance().getSettings().inboxDir;
      const resolvedSource = path.resolve(source_path);
      const resolvedInbox = path.resolve(inboxDir);

      await assertContained(resolvedSource, resolvedInbox, { mustExist: true });

      if (fs.existsSync(resolvedSource)) {
        await fs.promises.rm(resolvedSource, { recursive: true, force: true });
      }

      // Remove from activeScan results if present
      activeScan.results = activeScan.results.filter(a => a.source_path !== source_path);

      res.json({ success: true, message: "File deleted successfully" });
    } catch (e: any) {
      console.error(`Failed to delete file ${source_path}`, e);
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/scan/integrate-duplicate", requireRole('librarian'), async (req, res) => {
    if (rejectPlanOnlyMutation(res)) return;
    const { source_path } = req.body;
    if (!source_path) {
      return res.status(400).json({ error: "No source path provided" });
    }

    try {
      const actionIndex = activeScan.results.findIndex(a => a.source_path === source_path);
      if (actionIndex === -1) {
        return res.status(404).json({ error: "No pending duplicate action found for this path" });
      }

      const action = activeScan.results[actionIndex];
      // Force the action to act like a move
      action.action_type = "move";
      action.executed = false;
      const itemId=activeScan.itemIds.get(source_path); if(itemId){ingestStore.transitionItem(itemId,'approved');ingestStore.transitionItem(itemId,'staging');}
      
      console.log(`[Auto-Acquisition] Force integrating duplicate "${action.book.title}".`);
      await organizer.executeAction(action);
      if(itemId&&activeScan.jobId)await finalizeInAbs(itemId,activeScan.jobId,action);
      
      // Remove it from the pending results
      activeScan.results.splice(actionIndex, 1);
      
      console.log(`[Auto-Acquisition] Successfully forced integrated duplicate "${action.book.title}".`);
      res.json({ success: true, message: "Book integrated successfully" });
    } catch (e: any) {
      console.error(`Failed to force integrate duplicate ${source_path}`, e);
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/scan/commit", requireRole('librarian'), async (req, res) => {
    if (rejectPlanOnlyMutation(res)) return;
    if (activeScan.isRunning) {
      return res.status(400).json({ error: "Cannot commit while a scan is running" });
    }
    if (activeScan.results.length === 0) {
      return res.status(400).json({ error: "No actions to commit" });
    }

    const { selectedPaths } = req.body || {};
    let actionsToExecute = [...activeScan.results];
    
    if (selectedPaths && Array.isArray(selectedPaths)) {
      actionsToExecute = actionsToExecute.filter(a => selectedPaths.includes(a.source_path));
      activeScan.results = activeScan.results.filter(a => !selectedPaths.includes(a.source_path));
    } else {
      activeScan.results = []; // Clear them all out if none specified
    }
    
    if (actionsToExecute.length === 0) {
      return res.status(400).json({ error: "No selected actions to commit" });
    }
    
    // Send immediate response
    res.json({ success: true, message: "Started committing changes", total: actionsToExecute.length });

    // Execute asynchronously
    setImmediate(async () => {
      let executed = 0;
      const successfulActions: typeof actionsToExecute = [];
      // Collected rather than only logged: the terminal broadcast carries these
      // so the review screen can show what did not move instead of reporting an
      // unqualified "completed".
      const failures: { sourcePath: string; title: string; error: string }[] = [];

      const describe = (action: OrganizationAction) =>
        action.book.title || path.basename(action.source_path);

      for (const action of actionsToExecute) {
        try {
          ws.broadcast({
            type: "librarian:commit_progress",
            payload: {
              executed,
              total: actionsToExecute.length,
              currentFile: describe(action),
              status: "processing",
              failures: []
            }
          });

          await organizer.executeAction(action);
          const itemId=activeScan.itemIds.get(action.source_path); if(itemId&&activeScan.jobId){if(action.success)await finalizeInAbs(itemId,activeScan.jobId,action);else ingestStore.transitionItem(itemId,'failed',action.error_message);}
          if (action.success) {
            successfulActions.push(action);
          } else {
            failures.push({
              sourcePath: action.source_path,
              title: describe(action),
              error: action.error_message || "Action did not complete"
            });
          }
          executed++;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`Failed to execute action for ${action.source_path}`, e);
          failures.push({ sourcePath: action.source_path, title: describe(action), error: message });
        }
      }

      ws.broadcast({
        type: "librarian:commit_progress",
        payload: {
          executed,
          total: actionsToExecute.length,
          currentFile: "",
          status: "completed",
          failures
        }
      });
      
      if (successfulActions.length > 0) {
        const HistoryStore = (await import("../../config/history.js")).HistoryStore;
        HistoryStore.getInstance().addBatch(successfulActions);
      }
      
      console.log(`Finished committing ${executed}/${actionsToExecute.length} actions.`);
    });
  });

  router.post("/scan/rollback", async (req, res) => {
    if (rejectPlanOnlyMutation(res)) return;
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

      const sysSettings = settingsStore.getSettings();
      const summary = await rollbackBatch(batchToRollback.actions, {
        inboxDir: sysSettings.inboxDir,
        libraryDir: sysSettings.libraryDir,
      });

      // Discard the history entry only when there is nothing left to retry.
      // Dropping it after a partial rollback used to destroy the only record of
      // what still needed undoing.
      if (summary.complete) history.removeBatch(batchToRollback.id);

      for (const failure of summary.results.filter((result) => result.status === "failed")) {
        console.error(`Failed to rollback ${failure.targetPath}: ${failure.error}`);
      }

      res.status(summary.complete ? 200 : 207).json({
        success: summary.complete,
        batchId: batchToRollback.id,
        retained: !summary.complete,
        message: summary.complete
          ? `Rolled back ${summary.rolledBack} actions successfully`
          : `Rolled back ${summary.rolledBack} of ${summary.rolledBack + summary.failed} actions; ${summary.failed} failed and the history entry was kept so it can be retried`,
        summary,
      });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("Rollback failed:", errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  router.post("/scan/enhance-metadata", async (req, res) => {
    if (rejectPlanOnlyMutation(res)) return;
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
        }),
        // Generous: local inference on CPU is slow. Bounded anyway so a wedged
        // Ollama cannot hold the request open forever.
        signal: AbortSignal.timeout(180_000)
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
      const newAction = await organizer.organizeBook(book);

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

  const processInboxItem = async (inboxPath: string, itemName: string) => {
    const jobId = ingestStore.create(inboxPath, undefined, false);
    try {
      const settings = settingsStore.getSettings();
      if (settings.absUrl && settings.absToken) {
        const client = new ABSClient(settings.absUrl, settings.absToken);
        const libraries = await client.getLibraries();
        const items = (await Promise.all(libraries.map((library) => client.getLibraryItems(library.id)))).flat();
        organizer.setAbsCache(items);
      } else {
        organizer.setAbsCache([]);
      }

      const book = await scanner.scanTarget(inboxPath);
      if (book.audio_files.length === 0) throw new Error(`Target contains no supported audio files: ${inboxPath}`);
      const action = await organizer.organizeBook(book);
      const itemId = ingestStore.addItem(jobId, action);
      if (shouldAutoExecuteScanAction(action.action_type, false)) {
        ingestStore.transitionItem(itemId, "approved");
        ingestStore.transitionItem(itemId, "staging");
        await organizer.executeAction(action);
        await finalizeInAbs(itemId, jobId, action);
        console.log(`[Auto-Acquisition] Successfully imported "${itemName}" into the library.`);
      } else {
        // Duplicates, ambiguous conflicts, and errors remain in Inbox for review.
        ws.broadcast({ type: "librarian:scan_action", payload: action });
        console.warn(`[Auto-Acquisition] Held "${itemName}" for review: ${action.reason}`);
      }
    } catch (error) {
      console.error(`[Auto-Acquisition] Failed to process "${itemName}":`, error);
    }
  };

  const abbService = new AudiobookBayService();
  const qbtService = new QBittorrentService();
  
  const torrentMonitor = new TorrentMonitorService(qbtService, async (inboxPath, torrent) => {
    await processInboxItem(inboxPath, torrent.name);
  });
  
  const inboxPoller = new InboxPollerService(ingestStore, async (inboxPath, itemName) => {
    console.log(`[Inbox Poller] Discovered untracked item: ${itemName}`);
    await processInboxItem(inboxPath, itemName);
  });

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
            headers: { "Authorization": `Bearer ${sysSettings.absToken}` },
            signal: AbortSignal.timeout(10_000)
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

      let proxyOk = false;
      let proxyIp: string | null = null;
      let proxyLocation: string | null = null;
      const useProxy = sysSettings.useProxy ?? true;
      const proxyUrl = sysSettings.proxyUrl;
      const proxyEnabled = useProxy && !!proxyUrl;

      if (proxyEnabled && proxyUrl) {
        try {
          const { ProxyAgent } = await import("undici");
          const dispatcher = new ProxyAgent({
            uri: proxyUrl,
            requestTls: { rejectUnauthorized: false }
          });
          const ipRes = await fetch("https://am.i.mullvad.net/json", {
            dispatcher: dispatcher,
            signal: AbortSignal.timeout(5000)
          } as any);
          if (ipRes.ok) {
            proxyOk = true;
            const ipData = await ipRes.json();
            proxyIp = ipData.ip || null;
            proxyLocation = [ipData.city, ipData.country].filter(Boolean).join(", ") || null;
          }
        } catch (e) {
          console.error("Proxy status fetch failed", e);
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
            activeDownloads: monitorStats.activeDownloads,
            completedTorrents: qbtTorrents.length,
            importedTorrents: monitorStats.importedCount
          },
          audiobookshelf: {
            connected: absOk,
            libraries: absLibraries,
            books: absBooks
          },
          proxy: {
            enabled: proxyEnabled,
            working: proxyOk,
            ip: proxyIp,
            location: proxyLocation
          }
        }
      });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMsg });
    }
  });

  // 3-hour cache for popular books
  const bestsellersService = new BestsellersService();
  let bestsellersCache: { audible: any[], audiobooksnow: any[], apple: any[], nytFiction: any[], nytNonfiction: any[] } | null = null;
  let bestsellersCacheTime = 0;
  const CACHE_TTL = 3 * 60 * 60 * 1000;

  router.get("/downloads/queue", async (req, res) => {
    try {
      // Get all torrents to show the active queue
      const torrents = await qbtService.getTorrents("all", "audiobooks");
      // Filter out completed ones that aren't seeding or whatever, or just return all and let frontend decide
      // Or just return everything in audiobooks category
      res.json({ success: true, data: torrents });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to get downloads queue" });
    }
  });

  router.get("/downloads/pipeline", async (_req, res) => {
    try {
      const torrents = await qbtService.getTorrents("all", "audiobooks");
      res.json(buildAcquisitionPipeline(torrents, ingestStore.list()));
    } catch (error) {
      console.error("Failed to build acquisitions pipeline", error);
      res.status(500).json({ error: "Failed to get acquisitions pipeline" });
    }
  });

  router.post("/downloads/reconcile", requireRole("librarian"), async (req, res) => {
    try {
      const rawHashes = req.body?.hashes;
      if (rawHashes !== undefined && (!Array.isArray(rawHashes) || rawHashes.some((hash) => typeof hash !== "string" || hash.length < 1 || hash.length > 128))) {
        return res.status(400).json({ error: "hashes must be an array of torrent hash strings" });
      }
      const hashes = rawHashes === undefined ? undefined : Array.from(new Set(rawHashes as string[]));
      // Explicitly selected hashes are a recovery action and may retry entries
      // recorded before a development restart interrupted later processing.
      const results = await torrentMonitor.checkAndImport(hashes, hashes !== undefined);
      res.json({ success: true, data: results });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  router.get("/bestsellers", async (req, res) => {
    try {
      if (Date.now() - bestsellersCacheTime < CACHE_TTL && bestsellersCache) {
        return res.json({ success: true, results: bestsellersCache });
      }

      const nytApiKey = settingsStore.getSettings().nytApiKey;
      const [audible, audiobooksnow, apple, nytFiction, nytNonfiction] = await Promise.all([
        bestsellersService.fetchAudibleBestsellers(),
        bestsellersService.fetchAudiobooksNowBestsellers(),
        bestsellersService.fetchAppleBestsellers(),
        bestsellersService.fetchNytBestsellers(nytApiKey, "audio-fiction"),
        bestsellersService.fetchNytBestsellers(nytApiKey, "audio-nonfiction")
      ]);

      bestsellersCache = { audible, audiobooksnow, apple, nytFiction, nytNonfiction };
      bestsellersCacheTime = Date.now();

      res.json({ success: true, results: bestsellersCache });
    } catch (e: unknown) {
      if (e instanceof AntiBotChallengeError) {
        return res.status(403).json({
          error: "Anti-bot challenge detected",
          requiresChallenge: true,
          challengeUrl: e.url
        });
      }
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("Bestsellers fetch failed:", errMsg);
      res.json({ success: false, results: { audible: [], audiobooksnow: [], apple: [], nytFiction: [], nytNonfiction: [] }, warning: "Failed to load bestsellers." });
    }
  });

  // Proxy for ABB Anti-Bot Challenge
  router.use('/abb/proxy', async (req, res, next) => {
    try {
      const targetDomain = await abbService.resolveActiveDomain();
      // Cached per domain. This used to construct a fresh proxy middleware —
      // and with it a new agent and socket pool — on every single request.
      let proxy = abbProxyCache.get(targetDomain);
      if (!proxy) {
        proxy = createProxyMiddleware({
          target: targetDomain,
          changeOrigin: true,
          secure: false, // Bypass SSL cert errors for proxies
          on: {
            proxyRes: (proxyRes: any, _req: any, _res: any) => {
              // Intercept set-cookie header to capture cf_clearance
              const cookies = proxyRes.headers['set-cookie'];
              if (cookies) {
                const clearanceCookie = cookies.find((c: string) => c.includes('cf_clearance'));
                if (clearanceCookie) {
                  console.log("[ABB Proxy] Captured cf_clearance cookie!");
                  abbService.setClearanceCookie(cookies.map((c: string) => c.split(';')[0]).join('; '));
                }
              }

              // Remove frame restrictions so we can embed it
              delete proxyRes.headers['x-frame-options'];
              delete proxyRes.headers['content-security-policy'];
            }
          }
        });
        abbProxyCache.set(targetDomain, proxy);
      }
      proxy(req, res, next);
    } catch (e) {
      next(e);
    }
  });

  router.get("/search", async (req, res) => {
    try {
      const query = req.query.q as string;
      let cat = req.query.cat as string | string[] | undefined;
      if (Array.isArray(cat)) {
        cat = cat.join(",");
      }
      if (!cat || cat === "undefined" || cat === "undefined,undefined" || cat === "null") {
        cat = "";
      }
      
      const page = parseInt(req.query.page as string, 10) || 1;
      
      if (!query) {
        return res.status(400).json({ error: "Missing search query" });
      }
      
      const { results, totalPages, currentPage } = await abbService.search(query, cat, page);
      res.json({ success: true, results, totalPages, currentPage });
    } catch (e: unknown) {
      if (e instanceof AntiBotChallengeError) {
        return res.status(403).json({
          error: "Anti-bot challenge detected",
          requiresChallenge: true,
          challengeUrl: e.url
        });
      }
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

  router.get("/realign/scan", requireRole('librarian'), async (req, res) => {
    try {
      const realignService = new RealignService();
      const candidates = await realignService.scanLibrary();
      res.json({ success: true, results: candidates });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMsg });
    }
  });

  router.post("/realign/execute", requireRole('librarian'), async (req, res) => {
    try {
      const { candidates } = req.body;
      if (!Array.isArray(candidates)) {
        return res.status(400).json({ error: "Missing or invalid candidates array" });
      }
      const realignService = new RealignService();
      const result = await realignService.executeRealign(candidates);
      res.json({ success: true, moved: result.success, failed: result.failed, errors: result.errors });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMsg });
    }
  });

  router.get("/health/library", async (req, res) => {
    try {
      const settingsStore = SettingsStore.getInstance();
      const sysSettings = settingsStore.getSettings();
      if (!sysSettings.absUrl || !sysSettings.absToken) {
        return res.status(503).json({ error: "ABS not configured" });
      }
      const client = new ABSClient(sysSettings.absUrl, sysSettings.absToken);
      const libraries = await client.getLibraries();
      let totalBooks = 0;
      let completeMetadata = 0;
      let totalM4b = 0;
      const allItems: any[] = [];
      
      for (const lib of libraries) {
        if (lib.mediaType !== 'book') continue;
        const items = await client.getLibraryItems(lib.id);
        totalBooks += items.length;
        allItems.push(...items);
        
        for (const item of items) {
          const meta = item.media?.metadata || {};
          // Deliberately NOT checking meta.tags. Tags live in curator.db and
          // only reach ABS when AUTO_PUSH is enabled, which it is not by
          // default — so requiring them pinned this metric near 0% and dragged
          // overallScore down by a quarter no matter how well tagging ran.
          // This measures what the endpoint can actually see: metadata
          // completeness *in AudiobookShelf*.
          if (meta.title && meta.authorName && meta.description) {
            completeMetadata++;
          }
          const audioFiles: any[] = (item.media as any)?.audioFiles || (item.media as any)?.tracks || [];
          if (audioFiles.some((f: any) => f?.metadata?.ext?.toLowerCase() === '.m4b')) {
            totalM4b++;
          }
        }
      }
      
      // Structure is NOT measured here, and `scanLibrary()` is deliberately not
      // called. It flagged 811 of 950 books, which measured nothing about the
      // library: it does a strict full-path equality against one hardcoded
      // scheme (`{libraryDir}/{Author}/{Series}/{Title}`), and this library
      // already uses a richer convention —
      //   /audiobooks/Larry Correia/The Adventures of Tom Stranger/
      //     2019 - #1 in Customer Service- … - {Adam Baldwin, Larry Correia}
      // — carrying a year and narrator the scheme has no slot for. Every such
      // folder mismatches, so the number reported "you don't use our naming
      // scheme", not "your library is disordered", while costing a quarter of
      // overallScore.
      //
      // Skipping the call also removes a real failure mode: the scan crawls
      // every ABS item and generates a path per book, and /realign/scan has
      // been observed returning 502 at the reverse proxy. Health should not
      // depend on an operation that cannot reliably finish.
      //
      // A meaningful structure metric needs a configurable leaf pattern — see
      // the plan's §10 K.
      const structureIssues: number | null = null;

      // Simple duplicate detection
      let duplicates = 0;
      const seen = new Set();
      for (const item of allItems) {
        const key = `${item.media?.metadata?.title}-${item.media?.metadata?.authorName}`.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (key.length > 5) {
          if (seen.has(key)) duplicates++;
          else seen.add(key);
        }
      }
      
      // Unmeasured metrics score 100 so they cannot drag the overall figure —
      // the same rule applied to the M4B count above.
      const structureScorePct = 100;

      let dupesScorePct = totalBooks === 0 ? 100 : Math.round(((totalBooks - duplicates) / totalBooks) * 100);
      if (dupesScorePct < 0) dupesScorePct = 0;

      const health = {
        metadata: {
          score: totalBooks === 0 ? 100 : Math.round((completeMetadata / totalBooks) * 100),
          status: (completeMetadata / (totalBooks || 1)) >= 0.95 ? 'Great' : (completeMetadata / (totalBooks || 1)) >= 0.85 ? 'Good' : 'Attention'
        },
        files: totalM4b === 0 && totalBooks > 0
          // ABS returns MINIFIED media on /libraries/{id}/items — no audioFiles
          // array unless `expanded=1` is requested, which getLibraryItems does
          // not do. So this counts zero for every book on every library, and a
          // flat 0% here is a measurement failure, not a library with no M4Bs.
          // Reporting Unknown is the honest answer until the fetch is fixed;
          // scoring it 100 keeps a metric we cannot measure from dragging
          // overallScore down the way the metadata/tags check used to.
          ? { score: 100, status: 'Unknown', note: 'ABS list responses omit audioFiles; needs expanded=1' }
          : {
              score: Math.round((totalM4b / (totalBooks || 1)) * 100),
              status: (totalM4b / (totalBooks || 1)) >= 0.95 ? 'Great' : (totalM4b / (totalBooks || 1)) >= 0.80 ? 'Good' : 'Attention'
            },
        structure: {
          score: 100,
          status: 'Unknown',
          note: 'Needs a configurable folder pattern; the old check compared against one hardcoded scheme',
        },
        duplicates: {
          score: duplicates,
          // One collision in a thousand books is not "Attention". The key is
          // title+author normalised, which genuinely collides on reissues and
          // multi-part editions, so allow a small tolerance before alarming.
          status: duplicates === 0 ? 'Great' : duplicates <= Math.max(3, totalBooks * 0.01) ? 'Good' : 'Attention'
        }
      };

      const overallScore = Math.round((health.metadata.score + health.files.score + structureScorePct + dupesScorePct) / 4);

      // Counts travel with the statuses so the UI can say *why* a metric is
      // amber rather than showing a bare word next to an icon.
      res.json({
        success: true,
        health,
        overallScore,
        totals: { books: totalBooks, completeMetadata, m4b: totalM4b, structureIssues, duplicates },
        // Named so the UI (and a future reader) can tell "we measured this and
        // it is fine" apart from "we did not measure this".
        unmeasured: ['structure', ...(totalM4b === 0 && totalBooks > 0 ? ['files'] : [])],
        generatedAt: Date.now(),
      });
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/recently-added", async (req, res) => {
    try {
      const settingsStore = SettingsStore.getInstance();
      const sysSettings = settingsStore.getSettings();
      if (!sysSettings.absUrl || !sysSettings.absToken) {
        return res.status(503).json({ error: "ABS not configured" });
      }
      const baseUrl = sysSettings.absUrl.replace(/\/+$/, '');
      const client = new ABSClient(baseUrl, sysSettings.absToken);
      const libraries = await client.getLibraries();
      const allItems: any[] = [];
      for (const lib of libraries) {
        if (lib.mediaType !== 'book') continue;
        const items = await client.getLibraryItems(lib.id);
        allItems.push(...items);
      }
      
      allItems.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      const recent = allItems.slice(0, 5).map(item => ({
        id: item.id,
        title: item.media?.metadata?.title || "Unknown",
        author: item.media?.metadata?.authorName || "Unknown",
        addedAt: item.addedAt,
        coverUrl: item.media?.coverPath ? `${baseUrl}/api/items/${item.id}/cover?token=${sysSettings.absToken}` : null
      }));
      res.json({ success: true, results: recent });
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
