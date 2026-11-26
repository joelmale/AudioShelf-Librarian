import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import type { WsRouter } from "../../websocket/index.js";
import type { Config } from "@audioshelf/shared";
import { errorCode, errorMessage } from "@audioshelf/shared";
import { MetadataScanner } from "./services/scanner.js";
import { ScanStrategy, type ScanOrder } from "./services/scanStrategies.js";
import { AudiobookBayService, AntiBotChallengeError, isAudiobookBayUrl } from "./services/audiobookbay.js";
import { BestsellersService } from "./services/bestsellers.js";
import type {
  BestsellerBook,
  BestsellerSource,
  SourceFreshness,
} from "./services/bestsellers.js";

/** The five browse buckets the bestsellers endpoint returns, keyed for the UI. */
type BestsellerResultKey = "audible" | "audiobooksnow" | "apple" | "nytFiction" | "nytNonfiction";

/**
 * ABS exposes per-file metadata outside the validated schema (the item schema is
 * `passthrough`), so this is the narrow shape the m4b probe actually reads.
 */
interface AbsAudioFileProbe {
  metadata?: { ext?: string | null } | null;
}

/** Per-source freshness the UI renders beside each bucket. */
interface BestsellerSourceStatus {
  status: SourceFreshness;
  errorMessage?: string | null;
  attributionUrl: string;
  publicationDate?: string | null;
  itemCount: number;
}
import { QBittorrentService } from "./services/qbittorrent.js";
import { TorrentMonitorService } from "./services/torrentMonitor.js";
import { InboxPollerService } from "./services/inboxPoller.js";
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OrganizationAction } from "@audioshelf/shared";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { SettingsStore } from "../../config/settings.js";
import { ABSClient } from "../curator/core/absClient.js";
import type { ABSLibrary, ABSLibraryItem, IntentType, AcquisitionStatus } from "../curator/core/types.js";
import { CuratorDb } from "../curator/core/db.js";
import { RevisionConflictError } from "../curator/core/errors.js";
import { assertContained, assertContainedInAny, PathSecurityError } from "../../security/paths.js";
import { IngestStore, type IngestJobItem } from "./ingestStore.js";
import { requireRole } from "../../security/auth.js";
import { RealignService, measureLibraryStructure } from "./services/realign.js";
import { buildAcquisitionPipeline } from "./services/acquisitionPipeline.js";
import { discardMissingAcquisitionInputs } from "./services/acquisitionReconciler.js";
import { rollbackBatch } from "./services/rollback.js";
import { AcquisitionService } from "./services/acquisitionService.js";
import { IngestRunner, placeholderAction, shouldAutoExecuteScanAction, type ImportEntry, type ImportJournal } from "./services/ingestRunner.js";
import { AudiobookOrganizer, findInterruptedTransfers } from "./services/organizer.js";
import { INBOX_INCOMING_PREFIX } from "./services/torrentMonitor.js";
import { HistoryStore } from "../../config/history.js";
import { z } from "zod";
import { COLLECTION_REVIEW_REASON } from "./services/audioLayout.js";
import { inspectInbox } from "./services/inboxOverview.js";
import { CollectionReview, CollectionConflict, COLLECTION_STAGING, within } from "./services/collectionReview.js";

export const RealignExecuteRequestSchema = z.object({
  planId: z.string().trim().min(1).max(200),
  bookIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "bookIds must be unique"),
}).strict();

const CollectionApprovalSchema = z.union([z.object({
  fingerprint: z.string().min(1).max(128),
  groups: z.array(z.object({
    title: z.string().trim().min(1).max(500),
    author: z.string().trim().min(1).max(500),
    files: z.array(z.string().min(1).max(4096)).min(1).max(5000),
  }).strict()).min(1).max(100),
}).strict(), z.object({ fingerprint: z.string().min(1).max(128), mode: z.literal("clear"), candidateIds: z.array(z.string().min(1).max(128)).min(1).max(100) }).strict()]);

const isCollectionStage = (candidate: string) => path.resolve(candidate).split(path.sep).includes(COLLECTION_STAGING);
const isCollectionHold = (action: OrganizationAction) =>
  action.action_type === "error" && action.reason === COLLECTION_REVIEW_REASON;

type CollectionImportStatus =
  | { state: "running"; processed: number; total: number }
  | { state: "complete"; preview: Awaited<ReturnType<CollectionReview["approve"]>> }
  | { state: "failed"; status: number; error: string };

export { shouldAutoExecuteScanAction };

/**
 * Backoff between checks for a moved book in Audiobookshelf (about 30s in
 * all). The old fixed six seconds was shorter than a scan of a large library,
 * so a completed move was routinely reported as a failure.
 */
const ABS_RESOLVE_DELAYS_MS = [1_000, 2_000, 3_000, 5_000, 8_000, 11_000];

/** How long shutdown waits for an in-flight move before giving up on it. */
const SHUTDOWN_DRAIN_MS = 8_000;

/** Proxy reachability is checked against an outside service; don't on every poll. */
const PROXY_STATUS_TTL_MS = 5 * 60_000;

async function authorizeScanTarget(requestedTarget: string, roots: string[]): Promise<string> {
  // Accept both configured aliases and their trusted canonical root paths.
  const realRoots = await Promise.all(roots.map(async root => {
    try {
      return await fs.promises.realpath(root);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      return root;
    }
  }));
  for (const root of new Set([...roots, ...realRoots])) {
    // Reject outside paths before the canonical check touches the request path.
    const relative = path.relative(root, requestedTarget);
    if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) continue;
    return assertContainedInAny(requestedTarget, roots, { allowRoot: true, mustExist: true });
  }
  throw new PathSecurityError("Path is outside all configured roots");
}

export function createLibrarianRouter(
  config: Config,
  ws: WsRouter,
  dependencies: {
    realignService?: RealignService;
    ingestStore?: IngestStore;
    curatorDb?: CuratorDb;
    bestsellersService?: BestsellersService;
    acquisitionService?: AcquisitionService;
    /** Rollback journal; defaults to the shared HistoryStore. */
    history?: ImportJournal;
    /** Receives a hook that stops background work and drains in-flight moves. */
    onShutdown?: (hook: () => Promise<void>) => void;
  } = {},
): Router {
  const router = Router();
  /** One proxy middleware per resolved ABB domain, not one per request. */
  const abbProxyCache = new Map<string, ReturnType<typeof createProxyMiddleware>>();
  const scanner = new MetadataScanner(config);
  const strategy = new ScanStrategy();
  const settingsStore = SettingsStore.getInstance();
  const ingestStore = dependencies.ingestStore ?? new IngestStore();
  const curatorDb = dependencies.curatorDb;
  let acquisitionServiceInstance = dependencies.acquisitionService;
  // Plans are deliberately process-local and bound to this long-lived router.
  const realignService = dependencies.realignService ?? new RealignService();

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
    const target=path.resolve(action.target_path);
    for(const delay of ABS_RESOLVE_DELAYS_MS){
      await new Promise(r=>setTimeout(r,delay));
      const items=await client.getLibraryItems(job.libraryId);
      const found=items.find(i=>i.path&&path.resolve(i.path)===target);
      if(found){ingestStore.transitionItem(itemId,'abs_item_resolved',null,found.id);ingestStore.transitionItem(itemId,'complete',null,found.id);return;}
    }
    throw new Error('the library scan did not list it within 30 seconds');
  };

  const history: ImportJournal = dependencies.history ?? {
    addBatch: (actions) => HistoryStore.getInstance().addBatch(actions),
    updateBatch: (id, actions) => HistoryStore.getInstance().updateBatch(id, actions),
    removeBatch: (id) => HistoryStore.getInstance().removeBatch(id),
    getBatchActions: (id) => HistoryStore.getInstance().getBatchActions(id),
  };
  const ingestRunner = new IngestRunner({
    ingestStore,
    executeAction: (action) => organizer.executeAction(action),
    journal: history,
    resolveInAbs: finalizeInAbs,
  });

  /** Load the Audiobookshelf duplicate cache, degrading to filesystem checks. */
  const refreshAbsCache = async (target = organizer): Promise<boolean> => {
    const settings = settingsStore.getSettings();
    if (!settings.absUrl || !settings.absToken) {
      target.setAbsCache([]);
      return !settings.absUrl && !settings.absToken;
    }
    try {
      const client = new ABSClient(settings.absUrl, settings.absToken);
      const libraries = await client.getLibraries();
      target.setAbsCache((await Promise.all(libraries.map((library) => client.getLibraryItems(library.id)))).flat());
      return true;
    } catch (err) {
      console.warn("Failed to populate ABS cache for duplicate detection, gracefully degrading to local filesystem checks.", err);
      target.setAbsCache([]);
      return false;
    }
  };

  const collectionOrganizer = new AudiobookOrganizer(config);
  let collectionCacheRefresh: Promise<boolean> | undefined;
  const refreshCollectionCache = () => collectionCacheRefresh ??= refreshAbsCache(collectionOrganizer)
    .finally(() => { collectionCacheRefresh = undefined; });
  const activeAutomaticCollections = new Set<string>();
  const collectionReview = new CollectionReview({
    store: ingestStore,
    runner: ingestRunner,
    scan: target => scanner.scanTarget(target),
    organize: book => collectionOrganizer.organizeBook(book),
    refreshLibrary: refreshCollectionCache,
    inbox: () => settingsStore.getSettings().inboxDir,
    library: () => settingsStore.getSettings().libraryDir,
  });
  const collectionSources = () => new Set([
    ...ingestStore.collectionSources(),
    ...ingestStore.pendingReviewItems().filter(item => isCollectionHold(item.action)).map(item => path.resolve(item.action.source_path)),
  ]);
  const collectionParent = (id: string) => {
    const item = ingestStore.getItem(id);
    if (!item || !isCollectionHold(item.action) || !["discovered", "failed", "complete"].includes(item.state)) return;
    if (ingestStore.get(item.jobId)?.planOnly) return;
    return item;
  };
  const recordCollectionProgress = (item: NonNullable<ReturnType<typeof collectionParent>>, counts: Awaited<ReturnType<CollectionReview["approve"]>>["counts"]) => {
    const latest = collectionParent(item.id);
    if (!latest) return;
    const { remaining, unassigned, incomplete } = counts;
    if (counts.imported && !remaining && !unassigned && !incomplete && latest.state !== "complete") {
      ingestStore.transitionItem(item.id, "complete");
    }
    if (acquisitionServiceInstance || curatorDb) getAcquisitionService().onCollectionProgress(item, counts);
  };

  let drainingAutomaticCollections = false;
  let stoppingIntake = false;
  const drainAutomaticCollections = async () => {
    if (drainingAutomaticCollections || stoppingIntake || activeScan.isRunning || collectionReview.busy) return;
    drainingAutomaticCollections = true;
    try {
      for (const id of ingestStore.queuedCollectionItems()) {
        if (stoppingIntake || activeScan.isRunning || collectionReview.busy) break;
        const item = collectionParent(id);
        if (!item || item.state === "complete" || settingsStore.getSettings().collectionImportMode !== "automatic") {
          ingestStore.dequeueCollection(id);
          continue;
        }
        activeAutomaticCollections.add(id);
        let hasAnotherBatch = false;
        try {
          const result = await collectionReview.approve(item.action.source_path, null, null);
          recordCollectionProgress(item, result.counts);
          hasAnotherBatch = result.candidates.some(candidate => candidate.ready);
        } catch (error) {
          console.warn("[Collection intake] Left for review:", errorMessage(error));
        } finally {
          activeAutomaticCollections.delete(id);
          if (!stoppingIntake && !hasAnotherBatch) ingestStore.dequeueCollection(id);
        }
      }
    } finally {
      drainingAutomaticCollections = false;
    }
  };

  const collectionImports = new Map<string, { itemId: string; status: CollectionImportStatus }>();
  const isCollectionImportActive = (itemId: string) => activeAutomaticCollections.has(itemId)
    || [...collectionImports.values()].some(operation => operation.itemId === itemId && operation.status.state === "running");

  router.get("/inbox", requireRole("librarian"), async (_req, res) => {
    const configured = settingsStore.getSettings().inboxDir;
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once("close", abort);
    try {
      const snapshot = await inspectInbox(configured, controller.signal);
      const configuredPaths = snapshot.entries.map(entry => path.resolve(configured, entry.name));
      const records = new Map<string, IngestJobItem>();
      for (const item of ingestStore.latestInboxItems([...configuredPaths, ...snapshot.entries.map(entry => entry.path)])) {
        const key = path.resolve(item.action.source_path);
        if (!records.has(key)) records.set(key, item);
      }
      const queued = new Set(ingestStore.queuedCollectionItems());
      const processing = new Set(["approved", "staging", "finalized", "scan_requested", "abs_item_resolved", "enriched"]);
      const rows = snapshot.entries.map((entry, index) => {
        const item = records.get(configuredPaths[index]) ?? records.get(entry.path);
        const collection = item && collectionParent(item.id);
        const saved = collection ? collectionReview.savedProgress(entry.path) : undefined;
        const retained = collection?.state === "complete" && saved && saved.books > 0
          && !entry.partial && !saved.attention && saved.files.size === entry.audioFiles
          && entry.audioPaths.every(file => saved.files.has(file));
        let status: "waiting" | "review" | "importing" | "queued" | "retained" | "other" | "dismissed" = "waiting";
        if (item && (isCollectionImportActive(item.id) || processing.has(item.state))) status = "importing";
        else if (item && queued.has(item.id) && collection) status = "queued";
        else if (retained) status = "retained";
        else if (item?.state === "discarded") status = "dismissed";
        else if (collection || item?.state === "failed" || item?.action.action_type === "duplicate" || entry.partial) status = "review";
        else if (!entry.audioFiles) status = "other";
        return {
          name: entry.name, kind: entry.kind, audioFiles: entry.audioFiles, otherFiles: entry.otherFiles,
          partial: entry.partial, status, importedBooks: saved?.books,
          collectionId: collection?.id,
          itemId: item?.id,
          detail: item && !collection && (status === "review" || status === "dismissed")
            ? item.error ?? item.action.reason : undefined,
        };
      });
      const shown = new Set(rows.map(row => row.collectionId));
      const additional = [];
      const candidates = ingestStore.collectionReviewItems(COLLECTION_REVIEW_REASON).filter(item => !shown.has(item.id));
      const trackedPaths = new Set(snapshot.entries.map(entry => entry.path));
      for (const item of candidates.slice(0, 100)) {
        controller.signal.throwIfAborted();
        const source = await collectionReview.source(item.action.source_path).catch(() => null);
        if (!source || trackedPaths.has(source)) continue;
        trackedPaths.add(source);
        const saved = collectionReview.savedProgress(source);
        const status = isCollectionImportActive(item.id) ? "importing" : queued.has(item.id) ? "queued"
          : item.state === "complete" && saved.books > 0 && !saved.attention ? "retained" : "review";
        additional.push({
          name: item.action.book.title, kind: "directory", status, collectionId: item.id,
          importedBooks: saved.books, partial: false, sourceRelative: path.relative(snapshot.root, source),
        });
      }
      res.json({ data: { path: configured, rows: [...rows, ...additional], itemsOnDisk: rows.length,
        partial: snapshot.omitted || candidates.length > 100 || rows.some(row => row.partial) } });
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn("[inbox] Unable to inspect configured inbox:", errorMessage(error));
        res.status(503).json({ error: "The configured inbox is unavailable." });
      }
    } finally {
      res.off("close", abort);
    }
  });

  router.get("/collections", requireRole("librarian"), async (_req, res) => {
    const pending = ingestStore.collectionReviewItems(COLLECTION_REVIEW_REASON);
    const sources = new Set<string>();
    const queued = new Set(ingestStore.queuedCollectionItems());
    const entries: Array<{ id: string; title: string; complete: boolean; importing?: boolean; queued?: boolean }> = [];
    for (const item of pending) {
      const source = await collectionReview.source(item.action.source_path).catch(() => null);
      if (!source || sources.has(source)) continue;
      sources.add(source);
      entries.push({ id: item.id, title: item.action.book.title, complete: item.state === "complete",
        importing: activeAutomaticCollections.has(item.id) || undefined, queued: queued.has(item.id) || undefined });
    }
    res.json({ data: entries });
  });

  router.get("/collections/:id", requireRole("librarian"), async (req, res) => {
    const item = collectionParent(String(req.params.id));
    if (!item) { res.status(404).json({ error: "No collection is waiting for review" }); return; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once("close", abort);
    try {
      const libraryAvailable = !collectionReview.busy && await refreshCollectionCache();
      const preview = await collectionReview.preview(item.action.source_path, controller.signal, libraryAvailable);
      res.json({ data: { ...preview, title: item.action.book.title } });
    } catch (err) {
      if (!controller.signal.aborted) {
        res.status(err instanceof PathSecurityError ? 400 : 422).json({ error: errorMessage(err) });
      }
    } finally {
      res.off("close", abort);
    }
  });

  router.post("/collections/:id", requireRole("librarian"), async (req, res) => {
    const item = collectionParent(String(req.params.id));
    if (!item) { res.status(404).json({ error: "No collection is waiting for review" }); return; }
    const approval = CollectionApprovalSchema.safeParse(req.body);
    if (!approval.success) { res.status(400).json({ error: "Select at least one book with title, author and audio files" }); return; }
    if (activeScan.isRunning || collectionReview.busy) {
      res.status(409).json({ error: "Wait for the current scan or collection import to finish" });
      return;
    }
    const { fingerprint } = approval.data;
    const groups = "groups" in approval.data ? approval.data.groups : null;
    const candidateIds = "candidateIds" in approval.data ? new Set(approval.data.candidateIds) : undefined;
    const operationId = randomUUID();
    // Retain recent results in memory for the polling UI. The approved
    // groups and ingest outcomes themselves live in SQLite.
    if (collectionImports.size >= 5) {
      const oldest = collectionImports.keys().next().value;
      if (oldest) collectionImports.delete(oldest);
    }
    const operation: { itemId: string; status: CollectionImportStatus } = {
      itemId: item.id, status: { state: "running", processed: 0, total: groups?.length ?? 0 },
    };
    collectionImports.set(operationId, operation);
    void collectionReview.approve(
      item.action.source_path, fingerprint, groups, ingestStore.get(item.jobId)?.libraryId ?? undefined,
      (processed, total) => { operation.status = { state: "running", total, processed }; },
      candidateIds,
    ).then(result => {
      recordCollectionProgress(item, result.counts);
      operation.status = { state: "complete", preview: result };
    }).catch(err => {
      operation.status = { state: "failed", status: err instanceof CollectionConflict ? 409 : err instanceof PathSecurityError ? 400 : 422,
        error: errorMessage(err) };
    });
    res.status(202).json({ data: { operationId } });
  });

  router.get("/collections/:id/imports/:operationId", requireRole("librarian"), (req, res) => {
    const operation = collectionImports.get(String(req.params.operationId));
    if (!operation || operation.itemId !== req.params.id) {
      res.status(404).json({ error: "Import status is unavailable. Refresh the collection preview to check saved progress." });
      return;
    }
    const { status } = operation;
    if (status.state === "failed") { res.status(status.status).json({ error: status.error }); return; }
    res.json({ data: status });
  });

  /**
   * Bring in an item a human chose to import despite a duplicate warning.
   * Works from the persisted ingest item, so it is available for poller-held
   * items and after a restart, not just for the current in-memory scan.
   */
  const forceImport = async (itemId: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const item = ingestStore.getItem(itemId);
    if (!item || (item.state !== 'discovered' && item.state !== 'failed')) {
      return { status: 404, body: { error: "No pending item to import" } };
    }
    if (isCollectionStage(item.action.source_path)) {
      return { status: 409, body: { error: "Retry this book from Split collection" } };
    }
    if (ingestStore.get(item.jobId)?.planOnly) {
      return { status: 409, body: { error: "Plan-only scan sessions cannot modify files.", code: "PLAN_ONLY_SESSION" } };
    }
    const action = item.action;
    if (action.action_type === 'duplicate') {
      action.action_type = path.dirname(path.resolve(action.source_path)) === path.dirname(path.resolve(action.target_path)) ? 'rename' : 'move';
    }
    if (action.action_type !== 'move' && action.action_type !== 'rename') {
      return { status: 400, body: { error: "This item has nothing to import; dismiss it or rescan the folder" } };
    }
    action.executed = false;
    action.success = false;
    console.log(`[Auto-Acquisition] Force integrating "${action.book.title}".`);
    const { results: [result] } = await ingestRunner.importActions([{ action, itemId, jobId: item.jobId }]);
    activeScan.results = activeScan.results.filter((a) => path.resolve(a.source_path) !== path.resolve(action.source_path));
    if (result.error) return { status: 500, body: { error: result.error } };
    return { status: 200, body: { success: true, message: "Book integrated successfully", warning: result.absWarning } };
  };

  router.get('/jobs', requireRole('viewer'), (_req,res) => res.json({ success:true, data:ingestStore.list() }));
  router.get('/jobs/:id', requireRole('viewer'), (req,res) => { const id=String(req.params.id); const job=ingestStore.get(id); if(!job)return res.status(404).json({error:'Job not found'}); res.json({success:true,data:job}); });
  router.post('/jobs/:id/cancel', requireRole('librarian'), (req, res) => {
    const id = String(req.params.id);
    if (ingestStore.get(id)?.items.some(item => isCollectionImportActive(item.id) || isCollectionStage(item.action.source_path))) {
      res.status(409).json({ error: "A collection import owns this job. Review its progress in Intake." });
      return;
    }
    ingestStore.cancelJob(id);
    if (activeScan.jobId === id) activeScan.isCancelled = true;
    res.json({ success: true });
  });
  router.post('/jobs/:id/retry',requireRole('librarian'),async(req,res)=>{const id=String(req.params.id);if(rejectPlanOnlyMutation(res,id))return;const job=ingestStore.get(id);if(!job)return res.status(404).json({error:'Job not found'});if(job.items.some(i=>isCollectionStage(i.action.source_path))){res.status(409).json({error:'Retry this book from Split collection'});return;}const failed=job.items.filter(i=>i.state==='failed');await ingestRunner.importActions(failed.map((item):ImportEntry=>({action:{...item.action,executed:false,success:false},itemId:item.id,jobId:id,recoverMoved:true})));res.json({success:true,data:ingestStore.get(id)});});

  router.post("/scan", requireRole('librarian'), rateLimit({
    windowMs: 60_000,
    limit: 20,
    // Scans share one runner. Forwarded addresses do not change its budget.
    keyGenerator: () => "manual-scan",
    legacyHeaders: false,
    standardHeaders: "draft-8",
    message: { error: "Too many scan requests. Try again shortly." },
  }), async (req, res) => {
    if (activeScan.isRunning) {
      return res.status(400).json({ error: "A scan is already running" });
    }

    const sysSettings = settingsStore.getSettings();
    const baseDir = path.resolve(sysSettings.inboxDir || "/inbox");
    const allowedLibraryDir = path.resolve(sysSettings.libraryDir || "/audiobooks");
    const requestedPath: unknown = req.body?.targetDir;
    if (requestedPath !== undefined && (typeof requestedPath !== "string" || requestedPath.includes("\0"))) {
      return res.status(400).json({ error: "Scan target must be a valid path string." });
    }
    const requestedTarget = requestedPath ? path.resolve(requestedPath) : baseDir;
    const planOnly = req.body?.planOnly === true;

    const order: ScanOrder = req.body?.scanOrder || "alphabetical";

    try {
      const scanRoots = [baseDir, allowedLibraryDir];
      const targetDir = await authorizeScanTarget(requestedTarget, scanRoots);
      if (!fs.existsSync(targetDir)) {
        return res.status(400).json({ error: `Directory does not exist: ${targetDir}` });
      }

      const realInbox = await fs.promises.realpath(baseDir);
      // Scan the authorized filesystem path, then use the configured inbox
      // spelling for the durable keys shared by Intake and acquisitions.
      const inboxIdentity = (candidate: string): string => {
        const relative = path.relative(realInbox, candidate);
        if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) return candidate;
        return path.join(baseDir, relative);
      };
      if (activeScan.isRunning) return res.status(400).json({ error: "A scan is already running" });
      if (isCollectionStage(targetDir)) return res.status(409).json({ error: "Review staged books through Split collection" });
      if (!planOnly && collectionReview.busy) return res.status(409).json({ error: "Wait for the current collection import to finish" });
      const heldSources = new Set((await Promise.all([...collectionSources()].map(source => fs.promises.realpath(source).catch(() => source)))));
      if (!planOnly && [...heldSources].some(source => within(targetDir, source))) {
        return res.status(409).json({ error: "Review this folder through Split collection" });
      }
      if (activeScan.isRunning || (!planOnly && collectionReview.busy)) return res.status(409).json({ error: "Another scan or import is already running" });
      const jobId = ingestStore.create(inboxIdentity(targetDir), typeof req.body?.libraryId === 'string' ? req.body.libraryId : undefined, planOnly);
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
          await refreshAbsCache();
          // Every book this scan imports shares one rollback entry.
          let scanBatchId: string | null = null;

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
            },
            scanRoots,
          );
          
          const eligible = planOnly ? dirs : dirs.filter(target => ![...heldSources].some(source => within(target, source) || within(source, target)));
          const orderedDirs = await strategy.orderDirectories(eligible, order);
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
              const book = await scanner.scanTarget(target, { protectCollection: typeof target === "string" && within(target, realInbox) });
              book.source_path = inboxIdentity(book.source_path);
              book.audio_files = book.audio_files.map(inboxIdentity);
              if (book.cover_file) book.cover_file = inboxIdentity(book.cover_file);
              
              if (book.audio_files.length > 0) {
                const action = await organizer.organizeBook(book);
                const itemId = ingestStore.addItem(jobId, action);
                activeScan.itemIds.set(action.source_path,itemId);
                if (shouldAutoExecuteScanAction(action.action_type, planOnly)) {
                  console.log(`[Auto-Acquisition] Clean book detected: "${book.title}". Automatically integrating into library.`);
                  const { results: [result], batchId } = await ingestRunner.importActions(
                    [{ action, itemId, jobId }],
                    { appendToBatch: scanBatchId },
                  );
                  scanBatchId = batchId ?? scanBatchId;
                  if (result.error) {
                    console.error(`[Auto-Acquisition] Failed to integrate "${book.title}": ${result.error}`);
                    action.action_type = 'error';
                    action.error_message = result.error;
                    activeScan.results.push(action);
                    ws.broadcast({ type: "librarian:scan_action", payload: action });
                  } else {
                    if (result.absWarning) console.warn(`[Auto-Acquisition] "${book.title}": ${result.absWarning}`);
                    console.log(`[Auto-Acquisition] Successfully moved "${book.title}" to ${action.target_path}.`);
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
              if (errMsg === COLLECTION_REVIEW_REASON && typeof target === "string" && within(target, realInbox)) {
                const action = placeholderAction(inboxIdentity(target), errMsg);
                ingestStore.addItem(jobId, action);
                activeScan.results.push(action);
                ws.broadcast({ type: "librarian:scan_action", payload: action });
              }
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

      // The persisted ingest item is the Desk pipeline's source of truth. A
      // successful operator discard must resolve every pending record for the
      // exact path, including records created by the inbox poller.
      ingestStore.discardPendingItemsBySourcePath(resolvedSource);

      // Remove from activeScan results if present
      activeScan.results = activeScan.results.filter(a => path.resolve(a.source_path) !== resolvedSource);

      res.json({ success: true, message: "File deleted successfully" });
    } catch (e) {
      console.error(`Failed to delete file ${source_path}`, e);
      res.status(500).json({ error: errorMessage(e) });
    }
  });

  router.post("/scan/integrate-duplicate", requireRole('librarian'), async (req, res) => {
    if (rejectPlanOnlyMutation(res)) return;
    const { source_path } = req.body;
    if (!source_path) {
      return res.status(400).json({ error: "No source path provided" });
    }

    try {
      // The in-memory scan only knows its own session; the persisted item also
      // covers poller-held duplicates and anything from before a restart.
      const resolved = path.resolve(String(source_path));
      const itemId = activeScan.itemIds.get(source_path)
        ?? ingestStore.pendingReviewItems().find((item) => path.resolve(item.action.source_path) === resolved)?.id;
      if (!itemId) {
        return res.status(404).json({ error: "No pending duplicate action found for this path" });
      }
      const outcome = await forceImport(itemId);
      res.status(outcome.status).json(outcome.body);
    } catch (e) {
      console.error(`Failed to force integrate duplicate ${source_path}`, e);
      res.status(500).json({ error: errorMessage(e) });
    }
  });

  router.post("/ingest/items/:id/import", requireRole('librarian'), async (req, res) => {
    try {
      const outcome = await forceImport(String(req.params.id));
      res.status(outcome.status).json(outcome.body);
    } catch (e) {
      console.error(`Failed to import ingest item ${req.params.id}`, e);
      res.status(500).json({ error: errorMessage(e) });
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
      const describe = (action: OrganizationAction) =>
        action.book.title || path.basename(action.source_path);
      // Collected rather than only logged: the terminal broadcast carries these
      // so the review screen can show what did not move instead of reporting an
      // unqualified "completed".
      const failures: { sourcePath: string; title: string; error: string }[] = [];
      let executed = 0;

      ws.broadcast({
        type: "librarian:commit_progress",
        payload: { executed, total: actionsToExecute.length, currentFile: describe(actionsToExecute[0]), status: "processing", failures: [] }
      });
      // One batch, journaled before the first move, so the whole commit rolls
      // back as a unit -- including moves interrupted by a crash.
      const { results, batchId } = await ingestRunner.importActions(actionsToExecute.map((action): ImportEntry => ({
        action,
        itemId: activeScan.itemIds.get(action.source_path),
        jobId: activeScan.jobId ?? undefined,
      })));
      for (const result of results) {
        if (result.moved) executed++;
        else failures.push({ sourcePath: result.action.source_path, title: describe(result.action), error: result.error ?? "Action did not complete" });
      }

      ws.broadcast({
        type: "librarian:commit_progress",
        payload: {
          executed,
          total: actionsToExecute.length,
          currentFile: "",
          status: "completed",
          failures,
          batchId
        }
      });
      console.log(`Finished committing ${executed}/${actionsToExecute.length} actions.`);
    });
  });

  let undoActive = false;
  const undoImport = async (res: Response, batchId?: string) => {
    if (undoActive || activeScan.isRunning || collectionReview.busy || ingestRunner.busy) {
      res.status(409).json({ error: "Wait for current imports to finish before undoing a batch." });
      return;
    }
    undoActive = true;
    try {
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
        additionalRoots: (sysSettings.libraryFolderPatterns ?? []).map((pattern) => pattern.rootDir),
      });

      // Discard the history entry only when there is nothing left to retry.
      // Dropping it after a partial rollback used to destroy the only record of
      // what still needed undoing.
      if (summary.complete) history.removeBatch(batchToRollback.id);

      // The restored folder is a deliberate undo, not a new arrival. Dismiss the
      // ingest items for it (after the move, so their timestamp is newer than
      // anything the restore touched) or the poller imports it again.
      for (const restored of summary.results.filter((result) => result.status === "rolled_back")) {
        try { ingestStore.discardItemsBySourcePath(restored.sourcePath); }
        catch (dismissError) { console.error(`Could not dismiss ingest items for ${restored.sourcePath}:`, dismissError); }
      }

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
    } finally {
      undoActive = false;
    }
  };

  router.post("/scan/rollback", requireRole("librarian"), async (req, res) => {
    if (rejectPlanOnlyMutation(res)) return;
    await undoImport(res, req.body?.batchId);
  });
  router.post("/scan/history/:id/undo", requireRole("librarian"), async (req, res) => {
    await undoImport(res, String(req.params.id));
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
      const history = HistoryStore.getInstance().getHistory();
      res.json({ success: true, data: history });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMsg });
    }
  });

  const processInboxItem = async (inboxPath: string, itemName: string) => {
    const canonical = await fs.promises.realpath(inboxPath).catch(() => path.resolve(inboxPath));
    if (isCollectionStage(canonical) || ingestStore.collectionSources().some(source => within(canonical, source))) return;
    return ingestRunner.processInbox(inboxPath, itemName, {
    planAction: async (target) => {
      await refreshAbsCache();
      let book;
      try { book = await scanner.scanTarget(target, { inboxEntry: true }); }
      catch (err) {
        if (errorMessage(err) === COLLECTION_REVIEW_REASON && (await fs.promises.lstat(target)).isDirectory()) {
          return placeholderAction(target, COLLECTION_REVIEW_REASON);
        }
        throw err;
      }
      if (book.audio_files.length === 0) throw new Error(`Target contains no supported audio files: ${target}`);
      return organizer.organizeBook(book);
    },
    onHeld: async (action, name, itemId) => {
      // Duplicates, ambiguous conflicts, and errors remain in Inbox for review.
      ws.broadcast({ type: "librarian:scan_action", payload: action });
      console.warn(`[Auto-Acquisition] Held "${name}" for review: ${action.reason}`);
      if (!isCollectionHold(action) || settingsStore.getSettings().collectionImportMode !== "automatic") return;
      ingestStore.enqueueCollection(itemId);
      await drainAutomaticCollections();
    },
    onImported: (_action, name) => console.log(`[Auto-Acquisition] Successfully imported "${name}" into the library.`),
    onFailed: (target, message) => {
      console.error(`[Auto-Acquisition] Failed to process "${itemName}": ${message}`);
      // Without this the acquisition stays on "importing": the torrent is
      // already recorded as imported, so nothing would ever retry or report it.
      if (curatorDb || dependencies.acquisitionService) {
        getAcquisitionService().onInboxProcessingFailed(target, message);
      }
    },
  });

  };

  const abbService = new AudiobookBayService();
  const qbtService = new QBittorrentService();
  const getAcquisitionService = () => {
    if (!acquisitionServiceInstance) {
      const db = curatorDb ?? new CuratorDb();
      acquisitionServiceInstance = new AcquisitionService(
        db,
        abbService,
        qbtService,
        ingestStore,
      );
      ingestStore.onItemUpdated((item) => acquisitionServiceInstance!.onIngestItemUpdated(item));
    }
    return acquisitionServiceInstance;
  };

  const torrentMonitor = new TorrentMonitorService(qbtService, async (inboxPath, torrent) => {
    if (curatorDb || dependencies.acquisitionService) {
      getAcquisitionService().onTorrentImported(inboxPath, torrent);
    }
    await processInboxItem(inboxPath, torrent.name);
  }, (torrent, reason) => {
    if (curatorDb || dependencies.acquisitionService) {
      getAcquisitionService().onImportBlocked(torrent.hash, reason);
    }
  });

  // No ingest or torrent event arrives for an acquisition whose item was held,
  // discarded before this service listened, or lost to a restart. Sweep so those
  // surface with a reason instead of sitting in "in progress" indefinitely.
  const sweepStuckAcquisitions = () => {
    if (!curatorDb && !dependencies.acquisitionService) return;
    try {
      const flagged = getAcquisitionService().sweepStuck(ingestStore.list().flatMap((job) => job.items));
      if (flagged > 0) console.info(`[acquisitions] sweep updated ${flagged} stuck acquisition(s)`);
    } catch (error) {
      console.error("[acquisitions] stuck-acquisition sweep failed:", error);
    }
  };
  const automaticTimer = process.env.NODE_ENV === "test" ? undefined : setInterval(() => {
    void drainAutomaticCollections().catch(error => console.warn("[Collection intake] Could not process queue:", errorMessage(error)));
  }, 10_000).unref();
  const sweepStartTimer = setTimeout(sweepStuckAcquisitions, 30_000).unref();
  const sweepTimer = setInterval(sweepStuckAcquisitions, 5 * 60_000).unref();

  const inboxPoller = new InboxPollerService(ingestStore, async (inboxPath, itemName) => {
    console.log(`[Inbox Poller] Discovered untracked item: ${itemName}`);
    await processInboxItem(inboxPath, itemName);
  }, { isPaused: () => activeScan.isRunning || collectionReview.busy });

  dependencies.onShutdown?.(async () => {
    inboxPoller.stop();
    torrentMonitor.stop();
    stoppingIntake = true;
    clearInterval(automaticTimer);
    collectionReview.stop();
    clearTimeout(sweepStartTimer);
    clearInterval(sweepTimer);
    activeScan.isCancelled = true;
    if (!await ingestRunner.drain(SHUTDOWN_DRAIN_MS)) {
      console.warn("[shutdown] an import was still running; a restart will mark it interrupted");
    }
  });

  // A crash or forced stop mid-transfer can leave copies parked where the
  // library and the poller never look. Say so on startup rather than letting
  // them sit unnoticed; deleting them is left to a human.
  if (process.env.NODE_ENV !== "test") {
    setImmediate(() => {
      const settings = settingsStore.getSettings();
      void findInterruptedTransfers(settings.libraryDir, settings.inboxDir, INBOX_INCOMING_PREFIX)
        .then((leftovers) => {
          for (const leftover of leftovers) {
            console.warn(`[startup] interrupted transfer left behind (inspect, then restore or delete by hand): ${leftover}`);
          }
        })
        .catch((error) => console.error("[startup] could not check for interrupted transfers:", error));
    });
  }

  let proxyStatusCache: { url: string; at: number; result: { ok: boolean; ip: string | null; location: string | null } } | null = null;
  /** Exit IP of the scraper proxy, cached: it calls an outside service. */
  const checkProxy = async (proxyUrl: string) => {
    if (proxyStatusCache && proxyStatusCache.url === proxyUrl && Date.now() - proxyStatusCache.at < PROXY_STATUS_TTL_MS) {
      return proxyStatusCache.result;
    }
    let result: { ok: boolean; ip: string | null; location: string | null } = { ok: false, ip: null, location: null };
    try {
      const { ProxyAgent } = await import("undici");
      const dispatcher = new ProxyAgent({ uri: proxyUrl });
      const ipRes = await fetch("https://am.i.mullvad.net/json", {
        dispatcher: dispatcher,
        signal: AbortSignal.timeout(5000)
      } as RequestInit & { dispatcher: typeof dispatcher });
      if (ipRes.ok) {
        const ipData = await ipRes.json();
        result = {
          ok: true,
          ip: ipData.ip || null,
          location: [ipData.city, ipData.country].filter(Boolean).join(", ") || null,
        };
      }
    } catch (e) {
      console.error("Proxy status fetch failed", e);
    }
    proxyStatusCache = { url: proxyUrl, at: Date.now(), result };
    return result;
  };

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

      const useProxy = sysSettings.useProxy ?? true;
      const proxyUrl = sysSettings.proxyUrl;
      const proxyEnabled = useProxy && !!proxyUrl;
      const proxy = proxyEnabled && proxyUrl ? await checkProxy(proxyUrl) : { ok: false, ip: null, location: null };
      const proxyOk = proxy.ok;
      const proxyIp = proxy.ip;
      const proxyLocation = proxy.location;

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
  const bestsellersService = dependencies.bestsellersService ?? new BestsellersService();
  let bestsellersCache: {
    results: Partial<Record<BestsellerResultKey, BestsellerBook[]>>;
    sources?: Record<BestsellerSource, BestsellerSourceStatus>;
  } | null = null;
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
      // Log what reconciliation actually concluded. Without this an item stuck
      // in "Requires input" is indistinguishable from one legitimately waiting
      // on a decision: `skippedOutsideInbox` means the pass could not prove
      // anything about it, and `rootMissing` means the mount was down and
      // nothing was touched at all.
      const inboxDir = settingsStore.getSettings().inboxDir;
      if (inboxDir) {
        const reconciled = await discardMissingAcquisitionInputs(ingestStore, inboxDir);
        if (reconciled.rootMissing) {
          console.warn(`[acquisitions] inbox root "${inboxDir}" is not a readable directory — skipped reconciliation entirely rather than treating every pending item as deleted`);
        } else if (reconciled.discarded > 0 || reconciled.discardedEmpty > 0 || reconciled.skippedOutsideInbox > 0) {
          console.info(`[acquisitions] reconciled pending review items: ${reconciled.discarded} discarded (source gone), ${reconciled.discardedEmpty} discarded (folder left behind with no importable audio), ${reconciled.keptExisting} still present, ${reconciled.skippedOutsideInbox} outside "${inboxDir}"`);
          // Named individually: the rows are resolved but the folders are
          // still on disk, and only a human should delete them.
          for (const folder of reconciled.emptyFolders) {
            console.warn(`[acquisitions] leftover folder holds no importable audio and can be removed: ${folder}`);
          }
        } else {
          // The "nothing to do" case used to be silent, which made a correct
          // queue indistinguishable from a broken reconciler — that ambiguity
          // cost a full investigation on 2026-09-01.
          console.debug(`[acquisitions] reconciliation found nothing to resolve: ${reconciled.keptExisting} pending item(s) still have their source media`);
        }
      } else {
        console.warn('[acquisitions] no inboxDir configured — pending review items whose files were deleted outside the app cannot be reconciled and will persist');
      }
      const torrents = await qbtService.getTorrents("all", "audiobooks");
      if (curatorDb || dependencies.acquisitionService) {
        getAcquisitionService().reconcileTorrents(torrents);
      }
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

  const handleDiscardDownloadItem = (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (isCollectionImportActive(id)) {
      res.status(409).json({ error: "Wait for the current collection import to finish" });
      return;
    }
    const ok = ingestStore.discardItem(id);
    if (ok) ingestStore.dequeueCollection(id);
    if (!ok) {
      return res.status(404).json({ error: "Item not found or already completed" });
    }
    res.json({ success: true });
  };

  router.post("/downloads/items/:id/discard", requireRole("librarian"), handleDiscardDownloadItem);
  router.post("/downloads/items/:id/dismiss", requireRole("librarian"), handleDiscardDownloadItem);

  router.get("/bestsellers", async (req, res) => {
    try {
      if (Date.now() - bestsellersCacheTime < CACHE_TTL && bestsellersCache) {
        return res.json({
          success: true,
          results: bestsellersCache.results,
          sources: bestsellersCache.sources,
        });
      }

      const nytApiKey = settingsStore.getSettings().nytApiKey;
      const [audibleResult, abnResult, appleResult, nytFicResult, nytNonResult] = await Promise.all([
        bestsellersService.fetchAudibleBestsellersDetailed(),
        bestsellersService.fetchAudiobooksNowBestsellersDetailed(),
        bestsellersService.fetchAppleBestsellersDetailed(),
        bestsellersService.fetchNytBestsellersDetailed(nytApiKey, "audio-fiction"),
        bestsellersService.fetchNytBestsellersDetailed(nytApiKey, "audio-nonfiction"),
      ]);

      const sourceResults = [audibleResult, abnResult, appleResult, nytFicResult, nytNonResult];
      const processedResults: Partial<Record<BestsellerResultKey, BestsellerBook[]>> = {};
      const processedSources = {} as Record<BestsellerSource, BestsellerSourceStatus>;

      for (const item of sourceResults) {
        let books = item.books;
        let status = item.status;
        const sourceErrorMessage = item.errorMessage;

        if (curatorDb) {
          const prevSnapshot = curatorDb.getSourceSnapshot(item.source);

          if (status === 'ready' || status === 'empty') {
            for (const b of books) {
              curatorDb.upsertCandidate({
                id: b.id,
                source: b.source,
                sourceItemId: b.sourceItemId,
                sourceUrl: b.sourceUrl,
                title: b.title,
                author: b.author,
                coverUrl: b.coverUrl,
                description: b.description,
              });
            }

            curatorDb.saveSourceSnapshot({
              source: item.source,
              status,
              lastSuccessAt: status === 'ready' ? Date.now() : prevSnapshot?.lastSuccessAt,
              lastAttemptAt: Date.now(),
              errorMessage: null,
              attributionUrl: item.attributionUrl,
              publicationDate: item.publicationDate ?? prevSnapshot?.publicationDate,
              itemCount: books.length,
              snapshotJson: JSON.stringify(books),
              updatedAt: Date.now(),
            });
          } else if (status === 'failed' && prevSnapshot && prevSnapshot.snapshotJson && prevSnapshot.snapshotJson !== '[]') {
            try {
              books = JSON.parse(prevSnapshot.snapshotJson);
              status = 'stale';
            } catch {
              // fallback to empty
            }
            curatorDb.saveSourceSnapshot({
              source: item.source,
              status: 'stale',
              lastSuccessAt: prevSnapshot.lastSuccessAt,
              lastAttemptAt: Date.now(),
              errorMessage: item.errorMessage,
              attributionUrl: item.attributionUrl,
              publicationDate: prevSnapshot.publicationDate,
              itemCount: books.length,
              snapshotJson: prevSnapshot.snapshotJson,
              updatedAt: Date.now(),
            });
          } else if (status === 'not-configured') {
            curatorDb.saveSourceSnapshot({
              source: item.source,
              status: 'not-configured',
              lastSuccessAt: null,
              lastAttemptAt: Date.now(),
              errorMessage: item.errorMessage,
              attributionUrl: item.attributionUrl,
              publicationDate: null,
              itemCount: 0,
              snapshotJson: '[]',
              updatedAt: Date.now(),
            });
          }

          if (books.length > 0) {
            const matches = curatorDb.matchCandidateOwnership(books.map((b) => ({ title: b.title, author: b.author })));
            books = books.map((b) => {
              const key = `${b.title.trim().toLowerCase()}::${b.author.trim().toLowerCase()}`;
              const match = matches.get(key);
              return {
                ...b,
                ownership: match?.ownership ?? 'unowned',
                isFinished: match?.isFinished ?? false,
              };
            });
          }
        }

        const resKey: BestsellerResultKey =
          item.source === 'nyt-fiction' ? 'nytFiction' : item.source === 'nyt-nonfiction' ? 'nytNonfiction' : item.source;
        processedResults[resKey] = books;
        processedSources[item.source] = {
          status,
          errorMessage: sourceErrorMessage,
          attributionUrl: item.attributionUrl,
          publicationDate: item.publicationDate,
          itemCount: books.length,
        };
      }

      bestsellersCache = {
        results: processedResults,
        sources: processedSources,
      };
      bestsellersCacheTime = Date.now();

      res.json({
        success: true,
        results: processedResults,
        sources: processedSources,
      });
    } catch (e: unknown) {
      if (e instanceof AntiBotChallengeError) {
        return res.status(403).json({
          error: "Anti-bot challenge detected",
          requiresChallenge: true,
          challengeUrl: e.url,
        });
      }
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("Bestsellers fetch failed:", errMsg);
      res.json({
        success: false,
        results: { audible: [], audiobooksnow: [], apple: [], nytFiction: [], nytNonfiction: [] },
        sources: {
          audible: { status: 'failed', errorMessage: errMsg },
          audiobooksnow: { status: 'failed', errorMessage: errMsg },
          apple: { status: 'failed', errorMessage: errMsg },
          "nyt-fiction": { status: 'failed', errorMessage: errMsg },
          "nyt-nonfiction": { status: 'failed', errorMessage: errMsg },
        },
        warning: "Failed to load bestsellers.",
      });
    }
  });

  // Candidate intent & saved routes forwarded under /librarian/candidates/*
  router.get("/candidates/intents", (req, res) => {
    if (!curatorDb) return res.status(503).json({ error: "Curator database unavailable" });
    const actorId = req.principal?.subject ?? 'internal';
    const rawIds = req.query.candidateIds;
    let candidateIds: string[] | undefined;
    if (typeof rawIds === 'string') candidateIds = rawIds.split(',').map((s) => s.trim()).filter(Boolean);
    else if (Array.isArray(rawIds)) candidateIds = rawIds.map(String).map((s) => s.trim()).filter(Boolean);
    const intents = curatorDb.getCandidateIntents(actorId, candidateIds);
    res.json({ success: true, actor: actorId, isShared: actorId === 'internal', intents });
  });

  router.post("/candidates/intent", (req, res) => {
    if (!curatorDb) return res.status(503).json({ error: "Curator database unavailable" });
    const actorId = req.principal?.subject ?? 'internal';
    const { candidateId, intent, expectedRevision, requestId, notes, candidate } = req.body;
    if (!candidateId || !intent) return res.status(400).json({ error: "candidateId and intent are required" });
    try {
      const result = curatorDb.setCandidateIntent({
        actorId,
        candidateId,
        intent: intent as IntentType,
        expectedRevision,
        requestId,
        notes,
        candidateMetadata: candidate,
      });
      res.json({ success: true, actor: actorId, isShared: actorId === 'internal', intent: result.intent, changed: result.changed });
    } catch (err: unknown) {
      if (err instanceof RevisionConflictError) {
        return res.status(409).json({
          error: err.message,
          code: 'CONFLICT',
          currentRevision: err.currentRevision,
          currentIntent: err.currentIntent,
        });
      }
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/candidates/intent/undo", (req, res) => {
    if (!curatorDb) return res.status(503).json({ error: "Curator database unavailable" });
    const actorId = req.principal?.subject ?? 'internal';
    const { candidateId, requestId } = req.body;
    if (!candidateId) return res.status(400).json({ error: "candidateId is required" });
    const result = curatorDb.undoCandidateIntent({ actorId, candidateId, requestId });
    res.json({ success: true, actor: actorId, isShared: actorId === 'internal', intent: result.intent, previousIntent: result.previousIntent, changed: result.changed });
  });

  router.get("/candidates/saved", (req, res) => {
    if (!curatorDb) return res.status(503).json({ error: "Curator database unavailable" });
    const actorId = req.principal?.subject ?? 'internal';
    const rawIntent = req.query.intent;
    const intent = rawIntent === 'want' || rawIntent === 'later' || rawIntent === 'pass' ? (rawIntent as IntentType) : undefined;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
    const items = curatorDb.listSavedCandidates(actorId, { intent, limit, offset });
    const allIntents = curatorDb.getCandidateIntents(actorId);
    const values = Object.values(allIntents);
    const counts = {
      all: values.length,
      want: values.filter((i) => i.intent === 'want').length,
      later: values.filter((i) => i.intent === 'later').length,
      pass: values.filter((i) => i.intent === 'pass').length,
    };
    res.json({ success: true, actor: actorId, isShared: actorId === 'internal', items, counts });
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
            proxyRes: (proxyRes: IncomingMessage, _req: IncomingMessage, _res: ServerResponse) => {
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
      const { bookUrl, candidateId, editionTitle } = req.body;
      if (!bookUrl) {
        return res.status(400).json({ error: "Missing bookUrl" });
      }
      if (!isAudiobookBayUrl(bookUrl)) {
        return res.status(400).json({ error: "bookUrl must be an AudiobookBay page" });
      }

      const result = await getAcquisitionService().startAcquisition({
        bookUrl,
        candidateId,
        editionTitle,
      });

      res.json({
        success: true,
        duplicate: result.duplicate,
        acquisition: result.acquisition,
        message: result.error ? `Started with warning: ${result.error}` : "Sent to qBittorrent",
      });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("Download failed:", errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  router.get("/acquisitions", async (req, res) => {
    try {
      const candidateId = typeof req.query.candidateId === "string" ? req.query.candidateId : undefined;
      const statusQuery = typeof req.query.status === "string" ? (req.query.status.split(",") as AcquisitionStatus[]) : undefined;
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
      const list = getAcquisitionService().listAcquisitions({
        candidateId,
        status: statusQuery,
        limit,
      });
      res.json({ success: true, data: list });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMsg });
    }
  });

  router.get("/acquisitions/by-candidate/:candidateId", async (req, res) => {
    try {
      const candidateId = String(req.params.candidateId);
      const acq = getAcquisitionService().getAcquisitionByCandidate(candidateId);
      res.json({ success: true, data: acq });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMsg });
    }
  });

  router.get("/acquisitions/:id", async (req, res) => {
    try {
      const id = String(req.params.id);
      const acq = getAcquisitionService().getAcquisition(id);
      if (!acq) return res.status(404).json({ error: "Acquisition not found" });
      res.json({ success: true, data: acq });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMsg });
    }
  });

  router.post("/acquisitions/:id/retry", requireRole("librarian"), async (req, res) => {
    try {
      const id = String(req.params.id);
      const acq = await getAcquisitionService().retryAcquisition(id);
      if (!acq) return res.status(404).json({ error: "Acquisition not found" });
      res.json({ success: true, data: acq });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMsg });
    }
  });

  router.post("/acquisitions/:id/dismiss", requireRole("librarian"), async (req, res) => {
    try {
      const id = String(req.params.id);
      const success = getAcquisitionService().dismissAcquisition(id);
      res.json({ success });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMsg });
    }
  });

  router.get("/realign/scan", requireRole('librarian'), async (req, res) => {
    try {
      const plan = await realignService.scanLibrary();
      res.json({ success: true, ...plan });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMsg });
    }
  });

  router.post("/realign/execute", requireRole('librarian'), async (req, res) => {
    try {
      const parsed = RealignExecuteRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid realignment execution request", issues: parsed.error.issues });
      const result = await realignService.executeRealign(parsed.data.planId, parsed.data.bookIds);
      res.json({ success: true, moved: result.success, failed: result.failed, errors: result.errors, scanErrors: result.scanErrors, historyBatchId: result.historyBatchId });
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
      const allItems: ABSLibraryItem[] = [];
      const libraryItems: Array<{ library: ABSLibrary; items: ABSLibraryItem[] }> = [];
      
      for (const lib of libraries) {
        if (lib.mediaType !== 'book') continue;
        const items = await client.getLibraryItems(lib.id);
        libraryItems.push({ library: lib, items });
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
          const media = item.media as {
            audioFiles?: AbsAudioFileProbe[];
            tracks?: AbsAudioFileProbe[];
          } | undefined;
          const audioFiles = media?.audioFiles ?? media?.tracks ?? [];
          if (audioFiles.some((f) => f?.metadata?.ext?.toLowerCase() === '.m4b')) {
            totalM4b++;
          }
        }
      }
      
      // Reuse the ABS items fetched above. Structure is measurable only for a
      // library with a confirmed convention and eligible metadata; this never
      // invokes the realignment scan or touches the filesystem.
      const structure = await measureLibraryStructure(libraryItems, sysSettings);
      const structureIssues = structure.issues;

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
      const structureScorePct = structure.score;

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
        structure: structure.status === 'Unknown'
          ? { ...structure, note: 'No confirmed folder pattern or insufficient eligible metadata' }
          : structure,
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
        unmeasured: [...(structure.status === 'Unknown' ? ['structure'] : []), ...(totalM4b === 0 && totalBooks > 0 ? ['files'] : [])],
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
      const allItems: ABSLibraryItem[] = [];
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
