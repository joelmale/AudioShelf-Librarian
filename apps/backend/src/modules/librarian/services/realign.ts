import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Book, LibraryFolderPattern, OrganizationAction, SystemSettings } from "@audioshelf/shared";
import { LibraryFolderPatternSchema } from "@audioshelf/shared";
import { ABSClient } from "../../curator/core/absClient.js";
import type { ABSLibrary, ABSLibraryItem } from "../../curator/core/types.js";
import { HistoryStore } from "../../../config/history.js";
import { SettingsStore } from "../../../config/settings.js";
import { assertContained } from "../../../security/paths.js";
import { AudiobookOrganizer } from "./organizer.js";
import { renderFolderPattern } from "./folderPattern.js";

const DEFAULT_PLAN_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_PLANS = 20;
export const STRUCTURE_MEASUREMENT_MINIMUM_COVERAGE = 0.75;

/**
 * Do two paths name the same directory?
 *
 * Exact string equality was wrong on a real library. Synology and macOS write
 * filenames in NFD (a decomposed apostrophe or accent), while metadata coming
 * back from Audiobookshelf is typically NFC — so `Nerilka's Story` could
 * compare unequal to itself and be proposed for a move that changes nothing.
 * `path.resolve` normalizes separators and `.` / `..`; it does not normalize
 * Unicode.
 *
 * CASE IS DELIBERATELY NOT FOLDED. On a case-sensitive volume — which the
 * Linux bind mount of the audiobook share is — `Piers Anthony` and
 * `piers anthony` really are two different directories, and treating them as
 * equal would silently skip a rename the user asked for. Case-insensitive
 * shares exist, but folding blindly trades a visible false positive for an
 * invisible false negative, and this function guards a filesystem move.
 */
function samePath(left: string, right: string): boolean {
  return path.resolve(left).normalize("NFC") === path.resolve(right).normalize("NFC");
}

export interface RealignCandidate { bookId: string; title: string; author: string; currentPath: string; proposedPath: string; libraryId: string }
export interface StructureMeasurement {
  status: "Great" | "Good" | "Attention" | "Unknown";
  score: number;
  total: number | null;
  observed: number;
  configuredObserved: number;
  eligible: number;
  matched: number;
  issues: number | null;
  coverage: number;
}
export interface RealignLibraryPlan extends StructureMeasurement { libraryId: string; name: string }
export interface RealignPlan { planId: string; createdAt: string; expiresAt: string; libraries: RealignLibraryPlan[]; candidates: RealignCandidate[] }
interface PlannedBook extends RealignCandidate { patternFingerprint: string }
interface StoredPlan extends RealignPlan { plannedBooks: Map<string, PlannedBook>; state: "ready" | "in-flight" | "consumed" }

export interface RealignClient {
  getLibraries(): Promise<ABSLibrary[]>;
  getLibraryItems(libraryId: string): Promise<ABSLibraryItem[]>;
  triggerLibraryScan(libraryId: string): Promise<void>;
}
export interface RealignHistory {
  addBatch(actions: OrganizationAction[]): string;
  updateBatch(id: string, actions: OrganizationAction[]): void;
  removeBatch(id: string): void;
}
export interface RealignDependencies {
  getSettings: () => SystemSettings;
  createClient: (settings: SystemSettings) => RealignClient;
  history: RealignHistory;
  organizer: AudiobookOrganizer;
  now: () => number;
  uuid: () => string;
  planTtlMs: number;
  maxPlans: number;
}
export interface RealignExecutionResult { success: number; failed: number; errors: string[]; scanErrors: string[]; historyBatchId: string | null }

function defaults(): RealignDependencies {
  return {
    getSettings: () => SettingsStore.getInstance().getSettings(),
    createClient: (settings) => {
      if (!settings.absUrl || !settings.absToken) throw new Error("Audiobookshelf connection is not configured.");
      return new ABSClient(settings.absUrl, settings.absToken);
    },
    history: {
      addBatch: (actions) => HistoryStore.getInstance().addBatch(actions),
      updateBatch: (id, actions) => HistoryStore.getInstance().updateBatch(id, actions),
      removeBatch: (id) => HistoryStore.getInstance().removeBatch(id),
    },
    organizer: new AudiobookOrganizer({ PORT: 0 }),
    now: Date.now, uuid: randomUUID, planTtlMs: DEFAULT_PLAN_TTL_MS, maxPlans: DEFAULT_MAX_PLANS,
  };
}
function positiveNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Faithful ABS-to-librarian mapping. Missing values remain missing. */
export function mapAbsItemToBook(item: ABSLibraryItem, libraryId: string): Book | null {
  if (!item.path || !path.isAbsolute(item.path)) return null;
  const metadata = item.media?.metadata;
  const title = metadata?.title?.trim(); const author = metadata?.authorName?.trim();
  if (!title || !author) return null;
  const seriesEntry = metadata.series?.[0];
  const series = metadata.seriesName?.trim() || seriesEntry?.name?.trim() || null;
  const sequence = positiveNumber(seriesEntry?.sequence);
  return {
    title, authors: [author], series, series_number: sequence,
    narrator: metadata.narratorName?.trim() || null,
    published_year: positiveNumber(metadata.publishedYear),
    source_path: path.resolve(item.path), audio_files: [], metadata_source: "abs_json",
    confidence_score: 1, abs_item_id: item.id, abs_library_id: libraryId,
    is_series: Boolean(series), needs_processing: false,
  };
}
async function patternFingerprint(pattern: LibraryFolderPattern): Promise<string> {
  const canonicalRoot = await fs.promises.realpath(path.resolve(pattern.rootDir));
  return JSON.stringify([pattern.libraryId, canonicalRoot, pattern.standalone, pattern.series, pattern.source]);
}
function statusFor(score: number): StructureMeasurement["status"] { return score >= 95 ? "Great" : score >= 85 ? "Good" : "Attention" }
function nested(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function overlaps(left: string, right: string): boolean { return nested(left, right) || nested(right, left) }
function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code }
async function usablePatterns(settings: SystemSettings): Promise<Map<string, LibraryFolderPattern>> {
  const result = new Map<string, LibraryFolderPattern>();
  for (const raw of settings.libraryFolderPatterns ?? []) {
    const parsed = LibraryFolderPatternSchema.safeParse(raw); if (!parsed.success) continue;
    try { await fs.promises.realpath(path.resolve(parsed.data.rootDir)); result.set(parsed.data.libraryId, parsed.data); } catch { /* unavailable root is unknown */ }
  }
  return result;
}

async function evaluateLibrary(library: ABSLibrary, items: readonly ABSLibraryItem[], pattern: LibraryFolderPattern | undefined, organizer: AudiobookOrganizer): Promise<{ measurement: RealignLibraryPlan; candidates: RealignCandidate[] }> {
  const unknown = (eligible = 0, matched = 0): RealignLibraryPlan => ({
    libraryId: library.id,
    name: library.name,
    status: "Unknown",
    score: 100,
    total: null,
    observed: items.length,
    configuredObserved: pattern ? items.length : 0,
    eligible,
    matched,
    issues: null,
    coverage: items.length === 0 ? 0 : eligible / items.length,
  });
  if (!pattern) return { measurement: unknown(), candidates: [] };
  let eligible = 0; let matched = 0; const candidates: RealignCandidate[] = [];
  for (const item of items) {
    const book = mapAbsItemToBook(item, library.id); if (!book) continue;
    try {
      await assertContained(book.source_path, pattern.rootDir, { mustExist: true });
      const proposedPath = await organizer.generatePatternTargetPath(book, pattern); eligible += 1;
      if (samePath(book.source_path, proposedPath)) matched += 1;
      else candidates.push({ bookId: item.id, libraryId: library.id, title: book.title, author: book.authors[0], currentPath: path.resolve(book.source_path), proposedPath: path.resolve(proposedPath) });
    } catch { /* unsafe or incomplete items are unknown */ }
  }
  const coverage = items.length === 0 ? 0 : eligible / items.length;
  if (eligible === 0 || coverage < STRUCTURE_MEASUREMENT_MINIMUM_COVERAGE) {
    return { measurement: unknown(eligible, matched), candidates: [] };
  }
  const score = Math.round((matched / eligible) * 100);
  return { measurement: { libraryId: library.id, name: library.name, status: statusFor(score), score, total: eligible, observed: items.length, configuredObserved: items.length, eligible, matched, issues: eligible - matched, coverage }, candidates };
}

/** Uses already-fetched ABS items and performs no scan or filesystem stat. */
export async function measureLibraryStructure(librariesWithItems: ReadonlyArray<{ library: ABSLibrary; items: readonly ABSLibraryItem[] }>, settings: SystemSettings): Promise<StructureMeasurement> {
  const rawPatterns = new Map((settings.libraryFolderPatterns ?? []).map((pattern) => [pattern.libraryId, pattern]));
  let observed = 0; let configuredObserved = 0; let eligible = 0; let matched = 0; let everyObservedLibraryConfigured = true;
  for (const { library, items } of librariesWithItems) {
    observed += items.length;
    const parsed = LibraryFolderPatternSchema.safeParse(rawPatterns.get(library.id));
    if (!parsed.success) { if (items.length > 0) everyObservedLibraryConfigured = false; continue; }
    configuredObserved += items.length;
    for (const item of items) {
      const book = mapAbsItemToBook(item, library.id); if (!book) continue;
      const relative = path.relative(path.resolve(parsed.data.rootDir), path.resolve(book.source_path));
      if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      const rendered = renderFolderPattern(book.is_series ? parsed.data.series : parsed.data.standalone, {
        author: book.authors[0], title: book.title, series: book.series,
        series_number: book.series_number, year: book.published_year, narrator: book.narrator,
      });
      if (!rendered.eligible) continue;
      const target = path.resolve(parsed.data.rootDir, rendered.relativePath);
      eligible += 1;
      if (samePath(target, book.source_path)) matched += 1;
    }
  }
  const coverage = configuredObserved === 0 ? 0 : eligible / configuredObserved;
  if (!everyObservedLibraryConfigured || observed === 0 || eligible === 0 || coverage < STRUCTURE_MEASUREMENT_MINIMUM_COVERAGE) {
    return { status: "Unknown", score: 100, total: null, observed, configuredObserved, eligible, matched, issues: null, coverage };
  }
  const score = Math.round((matched / eligible) * 100);
  return { status: statusFor(score), score, total: eligible, observed, configuredObserved, eligible, matched, issues: eligible - matched, coverage };
}

export class RealignService {
  private readonly deps: RealignDependencies;
  private readonly plans = new Map<string, StoredPlan>();
  private executing = false;
  constructor(dependencies: Partial<RealignDependencies> = {}) { this.deps = { ...defaults(), ...dependencies } }

  async scanLibrary(): Promise<RealignPlan> {
    const settings = this.deps.getSettings(); const client = this.deps.createClient(settings); const patterns = await usablePatterns(settings);
    const libraries = (await client.getLibraries()).filter((library) => library.mediaType === "book");
    const measurements: RealignLibraryPlan[] = []; const candidates: RealignCandidate[] = []; const plannedBooks = new Map<string, PlannedBook>();
    for (const library of libraries) {
      const evaluated = await evaluateLibrary(library, await client.getLibraryItems(library.id), patterns.get(library.id), this.deps.organizer);
      measurements.push(evaluated.measurement); candidates.push(...evaluated.candidates);
      const pattern = patterns.get(library.id);
      if (pattern) {
        const fingerprint = await patternFingerprint(pattern);
        for (const candidate of evaluated.candidates) {
          if (plannedBooks.has(candidate.bookId)) throw new Error(`Audiobookshelf returned duplicate book ID: ${candidate.bookId}`);
          plannedBooks.set(candidate.bookId, { ...candidate, patternFingerprint: fingerprint });
        }
      }
    }
    const created = this.deps.now();
    const stored: StoredPlan = { planId: this.deps.uuid(), createdAt: new Date(created).toISOString(), expiresAt: new Date(created + this.deps.planTtlMs).toISOString(), libraries: measurements, candidates, plannedBooks, state: "ready" };
    this.prune(created); this.plans.set(stored.planId, stored); while (this.plans.size > this.deps.maxPlans) this.plans.delete(this.plans.keys().next().value!);
    const { plannedBooks: _private, state: _state, ...plan } = stored; return plan;
  }

  async executeRealign(planId: string, bookIds: readonly string[]): Promise<RealignExecutionResult> {
    const plan = this.plans.get(planId);
    if (!plan || Date.parse(plan.expiresAt) <= this.deps.now()) { this.plans.delete(planId); throw new Error("Realignment plan is unknown or expired") }
    if (plan.state !== "ready") throw new Error("Realignment plan is already in flight or consumed");
    if (bookIds.length === 0 || new Set(bookIds).size !== bookIds.length) throw new Error("Book IDs must be non-empty and unique");
    const selected = bookIds.map((id) => { const candidate = plan.plannedBooks.get(id); if (!candidate) throw new Error(`Book ID is not part of this plan: ${id}`); return candidate });
    for (const candidate of selected) {
      const measurement = plan.libraries.find((library) => library.libraryId === candidate.libraryId);
      if (!measurement || measurement.status === "Unknown" || measurement.coverage < STRUCTURE_MEASUREMENT_MINIMUM_COVERAGE) {
        throw new Error(`Library structure is not sufficiently measured for execution: ${candidate.libraryId}`);
      }
    }
    if (this.executing) throw new Error("Another realignment execution is already in progress");
    this.executing = true;
    plan.state = "in-flight";
    try {
      const settings = this.deps.getSettings(); const patterns = await usablePatterns(settings); const client = this.deps.createClient(settings);
      const refreshed = new Map<string, Map<string, ABSLibraryItem>>();
      for (const libraryId of new Set(selected.map((candidate) => candidate.libraryId))) {
        const pattern = patterns.get(libraryId); if (!pattern) throw new Error(`Library is no longer configured: ${libraryId}`);
        if (await patternFingerprint(pattern) !== selected.find((candidate) => candidate.libraryId === libraryId)!.patternFingerprint) throw new Error(`Library convention or root changed since the plan was created: ${libraryId}`);
        const itemMap = new Map<string, ABSLibraryItem>();
        for (const item of await client.getLibraryItems(libraryId)) { if (itemMap.has(item.id)) throw new Error(`Audiobookshelf returned duplicate item ID: ${item.id}`); itemMap.set(item.id, item) }
        refreshed.set(libraryId, itemMap);
      }
      const prepared: Array<{ candidate: PlannedBook; pattern: LibraryFolderPattern; book: Book; source: string; target: string }> = [];
      for (const candidate of selected) {
        const item = refreshed.get(candidate.libraryId)?.get(candidate.bookId); if (!item) throw new Error(`Book is no longer present in Audiobookshelf: ${candidate.bookId}`);
        const book = mapAbsItemToBook(item, candidate.libraryId); if (!book || path.resolve(book.source_path) !== candidate.currentPath) throw new Error(`Book source changed since the plan was created: ${candidate.bookId}`);
        const pattern = patterns.get(candidate.libraryId)!; const target = await this.deps.organizer.generatePatternTargetPath(book, pattern);
        if (path.resolve(target) !== candidate.proposedPath) throw new Error(`Book target changed since the plan was created: ${candidate.bookId}`);
        prepared.push({ candidate, pattern, book, source: path.resolve(book.source_path), target: path.resolve(target) });
      }
      await this.preflight(prepared);

      const journalActions: OrganizationAction[] = prepared.map((move) => ({
        book: move.book,
        action_type: path.dirname(move.source) === path.dirname(move.target) ? "rename" : "move",
        source_path: move.source,
        target_path: move.target,
        reason: "Realign to the confirmed library folder convention",
        executed: false,
        success: false,
      }));
      // Durably journal the complete reversible batch before the first mkdir or rename.
      const historyBatchId = this.deps.history.addBatch(journalActions);
      const errors: string[] = []; const successfulLibraries = new Set<string>(); let success = 0;
      for (let index = 0; index < prepared.length; index += 1) {
        const move = prepared[index];
        try {
          await assertContained(move.source, move.pattern.rootDir, { mustExist: true });
          await assertContained(move.target, move.pattern.rootDir);
          const stat = await fs.promises.lstat(move.source); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Source is no longer a real directory");
          try { await fs.promises.lstat(move.target); throw new Error("Target now exists") } catch (error: unknown) { if (errorCode(error) !== "ENOENT") throw error }
          const parent = path.dirname(move.target);
          await fs.promises.mkdir(parent, { recursive: true });
          // mkdir may have raced with a symlink/junction replacement. Re-check
          // the exact parent and target immediately before the rename.
          await assertContained(parent, move.pattern.rootDir, { allowRoot: true, mustExist: true });
          const parentStat = await fs.promises.lstat(parent);
          if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Target parent is no longer a safe directory");
          if (await patternFingerprint(move.pattern) !== move.candidate.patternFingerprint) throw new Error("Library root changed during execution");
          await assertContained(move.target, move.pattern.rootDir);
          try { await fs.promises.lstat(move.target); throw new Error("Target now exists") } catch (error: unknown) { if (errorCode(error) !== "ENOENT") throw error }
          await fs.promises.rename(move.source, move.target);
          journalActions[index] = { ...journalActions[index], executed: true, success: true, execution_time: new Date(this.deps.now()).toISOString() };
          success += 1; successfulLibraries.add(move.candidate.libraryId);
        } catch (error) { errors.push(`${move.candidate.bookId}: ${error instanceof Error ? error.message : String(error)}`) }
      }
      if (success === 0) {
        this.deps.history.removeBatch(historyBatchId);
      } else {
        this.deps.history.updateBatch(historyBatchId, journalActions);
      }
      const scanErrors: string[] = [];
      for (const libraryId of successfulLibraries) try { await client.triggerLibraryScan(libraryId) } catch (error) { scanErrors.push(`${libraryId}: ${error instanceof Error ? error.message : String(error)}`) }
      return { success, failed: prepared.length - success, errors, scanErrors, historyBatchId: success > 0 ? historyBatchId : null };
    } finally {
      plan.state = "consumed";
      this.executing = false;
    }
  }

  private async preflight(moves: Array<{ pattern: LibraryFolderPattern; source: string; target: string }>): Promise<void> {
    const sources = new Set<string>(); const targets = new Set<string>();
    for (const move of moves) {
      const lexicalSource = move.source;
      const lexicalStat = await fs.promises.lstat(lexicalSource);
      if (!lexicalStat.isDirectory() || lexicalStat.isSymbolicLink()) throw new Error("Realignment source must be a real directory");
      move.source = await assertContained(lexicalSource, move.pattern.rootDir, { mustExist: true });
      move.target = await assertContained(move.target, move.pattern.rootDir);
      if (sources.has(move.source)) throw new Error("Realignment batch contains duplicate sources"); if (targets.has(move.target)) throw new Error("Realignment batch contains duplicate targets"); sources.add(move.source); targets.add(move.target);
      const stat = await fs.promises.lstat(move.source); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Realignment source must be a real directory");
      try { await fs.promises.lstat(move.target); throw new Error("Realignment target already exists") } catch (error: unknown) { if (errorCode(error) !== "ENOENT") throw error }
      let existing = path.dirname(move.target);
      while (true) { try { const parentStat = await fs.promises.lstat(existing); if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Target parent is not a safe directory"); await assertContained(existing, move.pattern.rootDir, { allowRoot: true, mustExist: true }); await fs.promises.access(existing, fs.constants.W_OK); break } catch (error: unknown) { if (errorCode(error) !== "ENOENT") throw error; const next = path.dirname(existing); if (next === existing) throw new Error("Target has no safely creatable parent"); existing = next } }
    }
    for (let left = 0; left < moves.length; left += 1) for (let right = left; right < moves.length; right += 1) {
      const a = moves[left]; const b = moves[right];
      if (overlaps(a.source, b.target) || overlaps(a.target, b.source)) throw new Error("Realignment source and target paths overlap");
      if (left !== right && (overlaps(a.source, b.source) || overlaps(a.target, b.target))) throw new Error("Realignment batch paths overlap");
    }
  }
  private prune(now: number): void { for (const [id, plan] of this.plans) if (Date.parse(plan.expiresAt) <= now) this.plans.delete(id) }
}
