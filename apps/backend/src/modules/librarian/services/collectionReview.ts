import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Book, OrganizationAction } from "@audioshelf/shared";
import { errorCode, errorMessage } from "@audioshelf/shared";
import { assertContained, PathSecurityError } from "../../../security/paths.js";
import type { IngestStore } from "../ingestStore.js";
import type { IngestRunner } from "./ingestRunner.js";
import { analyzeCollection, type CollectionCandidate, type CollectionPreview } from "./collectionAnalyzer.js";
import { AUDIO_EXTENSIONS } from "./audioLayout.js";

export const COLLECTION_STAGING = ".collection-staging";
const RECEIPT = ".audioshelf-collection-receipt";

export interface CollectionGroup {
  title: string;
  author: string;
  files: string[];
}

interface ApprovedGroup extends CollectionGroup {
  id: string;
  fingerprint: string;
  state: "pending" | "imported" | "held" | "failed";
  message?: string;
  itemId?: string;
  automatic?: boolean;
}

interface ReviewRecord {
  groups: ApprovedGroup[];
}

export class CollectionConflict extends Error {}

interface CollectionReviewDeps {
  store: IngestStore;
  runner: Pick<IngestRunner, "importActions">;
  scan: (stage: string) => Promise<Book>;
  organize: (book: Book) => Promise<OrganizationAction>;
  refreshLibrary?: () => Promise<boolean>;
  inbox: () => string;
  library: () => string;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenFor = (source: string, group: ApprovedGroup) => hash(JSON.stringify([source, group.fingerprint, group.id]));

function proposedCandidate<T extends CollectionCandidate>(preview: { candidates: T[] }, group: CollectionGroup) {
  return preview.candidates.find(entry => JSON.stringify(entry.files) === JSON.stringify(group.files));
}

function groupFingerprint(preview: CollectionPreview, group: CollectionGroup): string | undefined {
  const listed = new Map(preview.files.map(file => [file.path, file]));
  const files = [...group.files, ...(proposedCandidate(preview, group)?.extras ?? [])].map(file => listed.get(file));
  return files.every(file => file !== undefined) ? hash(JSON.stringify(files)) : undefined;
}

function audioName(filename: string, index: number): string {
  const basename = path.basename(filename);
  const order = String(index + 1).padStart(5, "0");
  return Buffer.byteLength(basename) <= 245 ? order + " - " + basename : order + path.extname(basename);
}

export function within(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

async function present(candidate: string): Promise<boolean> {
  try { await fs.lstat(candidate); return true; }
  catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
    return false;
  }
}

async function exactPath(candidate: string, root: string, mustExist = true): Promise<string> {
  const result = await assertContained(candidate, root, { mustExist });
  if (path.relative(candidate, result)) throw new PathSecurityError("Collection path changed");
  return result;
}

type AudioFile = CollectionPreview["files"][number];

function unchanged(stat: Awaited<ReturnType<typeof fs.lstat>>, file: AudioFile): boolean {
  return stat.isFile() && stat.size === file.size && stat.mtimeMs === file.mtimeMs
    && stat.ctimeMs === file.ctimeMs && stat.dev === file.dev && stat.ino === file.ino;
}

async function copySnapshot(file: AudioFile, source: string, target: string): Promise<void> {
  const src = await exactPath(path.resolve(source, file.path), source);
  if (!unchanged(await fs.lstat(src), file)) throw new CollectionConflict("A collection file changed. Build a fresh preview.");
  const input = await fs.open(src, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!unchanged(await input.stat(), file) || !unchanged(await fs.lstat(src), file)) {
      throw new CollectionConflict("A collection file changed. Build a fresh preview.");
    }
    const output = await fs.open(target, "wx");
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let remaining = file.size;
      while (remaining > 0) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(remaining, buffer.length), null);
        if (!bytesRead) break;
        await output.writeFile(buffer.subarray(0, bytesRead));
        remaining -= bytesRead;
      }
      if (!unchanged(await input.stat(), file) || (await output.stat()).size !== file.size) {
        throw new CollectionConflict("A collection file changed while staging");
      }
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

export class CollectionReview {
  private importing = false;
  private stopping = false;

  constructor(private readonly deps: CollectionReviewDeps) {}

  get busy(): boolean { return this.importing; }
  stop(): void { this.stopping = true; }

  async source(input: string): Promise<string> {
    const source = await assertContained(input, this.deps.inbox(), { mustExist: true });
    const inbox = await fs.realpath(this.deps.inbox());
    if (!(await fs.lstat(source)).isDirectory() || within(source, path.join(inbox, COLLECTION_STAGING))) {
      throw new PathSecurityError("Choose an inbox collection directory");
    }
    return source;
  }

  private record(source: string): ReviewRecord {
    const json = this.deps.store.readCollection(source);
    const record: ReviewRecord = json ? JSON.parse(json) as ReviewRecord : { groups: [] };
    for (const group of record.groups) {
      const item = group.itemId ? this.deps.store.getItem(group.itemId) : undefined;
      if (item?.state === "complete") {
        group.state = "imported";
        group.message = item.error ?? undefined;
      } else if (item?.state === "discarded") {
        group.state = "pending";
        group.automatic = false;
        group.message = "Restored from the library. Ready to retry.";
      }
    }
    return record;
  }

  private write(source: string, record: ReviewRecord): void {
    this.deps.store.writeCollection(source, JSON.stringify(record));
  }

  private async wasPublished(source: string, group: ApprovedGroup): Promise<boolean> {
    const item = group.itemId ? this.deps.store.getItem(group.itemId) : undefined;
    if (!item) return false;
    const library = await fs.realpath(this.deps.library());
    const target = await assertContained(item.action.target_path, library).catch(() => null);
    return Boolean(target && await this.hasReceipt(target, tokenFor(source, group), library));
  }

  private async reconcile(source: string, preview: CollectionPreview) {
    const record = this.record(source);
    const expired: ApprovedGroup[] = [];
    const current: ApprovedGroup[] = [];
    for (const group of record.groups) {
      if (group.state === "imported" || groupFingerprint(preview, group) === group.fingerprint) {
        current.push(group);
        continue;
      }
      if (await this.wasPublished(source, group)) {
        // The source changed after publication and before ingest finalized.
        // Keep ownership of these files so a stale source cannot be shelved again.
        group.state = "held";
        group.message = "A copy reached the library before the source changed. Check the library copy before retrying.";
        current.push(group);
      } else {
        expired.push(group);
      }
    }
    return { record: { groups: current }, expired };
  }

  async preview(input: string, signal?: AbortSignal, libraryAvailable = true) {
    const source = await this.source(input);
    const preview = await analyzeCollection(source, { signal });
    return this.view(source, preview, libraryAvailable);
  }

  private async view(source: string, preview: CollectionPreview, libraryAvailable: boolean) {
    const { record, expired } = await this.reconcile(source, preview);
    const done = new Set(record.groups.filter(group => group.state === "imported").flatMap(group => group.files));
    const reserved = new Set(record.groups.flatMap(group => group.files));
    const candidates = [];
    for (const candidate of preview.candidates) {
      if (candidate.files.every(file => done.has(file))) {
        candidates.push({ ...candidate, ready: false, duplicate: undefined });
        continue;
      }
      const title = candidate.title;
      const action = await this.deps.organize({
        title, authors: [candidate.author], source_path: source,
        audio_files: candidate.files.map(file => path.join(source, file)), metadata_source: "filename",
        confidence_score: 0, is_series: Boolean(candidate.series), series: candidate.series,
        series_number: candidate.seriesNumber, narrator: candidate.narrator, needs_processing: true,
      });
      const duplicate = action.action_type === "duplicate" ? action.reason : undefined;
      const ready = libraryAvailable && !preview.incompleteInventory && candidate.autoImportEligible
        && !candidate.files.some(file => reserved.has(file))
        && (action.action_type === "move" || action.action_type === "rename");
      candidates.push({ ...candidate, duplicate, ready });
    }
    const counts = {
      imported: record.groups.filter(group => group.state === "imported").length,
      held: record.groups.filter(group => group.state === "held").length,
      failed: record.groups.filter(group => group.state === "failed").length,
      remaining: preview.candidates.filter(group => group.files.some(file => !done.has(file))).length,
      unassigned: preview.unassigned.filter(file => !done.has(file)).length,
      incomplete: preview.incompleteInventory,
    };

    const progress = record.groups.map(({ id, title, author, files, state, message }) =>
      ({ id, title, author, files, state, message }));
    const warnings = [...preview.warnings, ...expired.map(group => `Files changed for "${group.title}". Review the new grouping before importing.`)];
    return { libraryAvailable, fingerprint: preview.fingerprint, unassigned: preview.unassigned, extras: preview.extras, warnings, candidates, progress, counts };
  }

  async approve(
    input: string,
    fingerprint: string | null,
    groups: CollectionGroup[] | null,
    libraryId?: string,
    onProgress?: (processed: number) => void,
  ) {
    if (this.importing || this.stopping) throw new CollectionConflict("A collection is already importing or AudioShelf is shutting down");
    this.importing = true;
    try {
      const libraryAvailable = await this.deps.refreshLibrary?.() ?? true;
      const source = await this.source(path.resolve(input));
      const preview = await analyzeCollection(source);
      if (fingerprint !== null && preview.fingerprint !== fingerprint) {
        throw new CollectionConflict("The collection changed. Refresh its preview.");
      }
      const automatic = groups === null;
      if (groups === null) {
        const current = await this.view(source, preview, libraryAvailable);
        if (!libraryAvailable || preview.incompleteInventory) return current;
        const { record } = await this.reconcile(source, preview);
        const pending: ApprovedGroup[] = [];
        let changed = false;
        for (const group of record.groups) {
          if (!group.automatic || group.state !== "pending" || groupFingerprint(preview, group) !== group.fingerprint) continue;
          const candidate = proposedCandidate(current, group);
          if ((candidate?.autoImportEligible && !candidate.duplicate) || await this.wasPublished(source, group)) {
            pending.push(group);
          } else {
            group.state = "held";
            group.message = candidate?.duplicate ?? "The book's evidence changed. Review this import.";
            changed = true;
          }
        }
        if (changed) this.write(source, record);
        groups = [...pending, ...current.candidates.filter(candidate => candidate.ready)].slice(0, 100)
          .map(({ title, author, files }) => ({ title, author, files }));
        if (!groups.length) return changed ? this.view(source, preview, libraryAvailable) : current;
      }
      const { record, expired } = await this.reconcile(source, preview);
      const audio = new Set(preview.files.filter(file => AUDIO_EXTENSIONS.has(path.extname(file.path).toLowerCase())).map(file => file.path));
      const selected = new Set<string>();
      const approved = groups.map(group => {
        for (const file of group.files) {
          if (!audio.has(file) || selected.has(file)) throw new CollectionConflict("Each selected audio file must belong to exactly one book");
          selected.add(file);
        }
        const id = hash(JSON.stringify([...group.files].sort()));
        const matching = record.groups.find(existing => existing.id === id);
        if (record.groups.some(existing => existing.id !== id && existing.files.some(file => group.files.includes(file)))) {
          throw new CollectionConflict("Some selected files already belong to a saved book");
        }
        const snapshot = groupFingerprint(preview, group);
        if (!snapshot) throw new CollectionConflict("A selected file is no longer available");
        if (matching) {
          if (matching.state !== "imported" && (matching.fingerprint !== snapshot
            || JSON.stringify(group.files) !== JSON.stringify(matching.files)
            || group.title !== matching.title || group.author !== matching.author)) {
            throw new CollectionConflict("Use the saved book details to retry this import");
          }
          return matching;
        }
        return { ...group, id, fingerprint: snapshot, state: "pending", automatic } satisfies ApprovedGroup;
      });
      for (const group of approved) {
        if (!record.groups.includes(group)) record.groups.push(group);
      }
      this.write(source, record);
      for (const group of expired) {
        if (group.itemId) this.deps.store.transitionItem(group.itemId, "cancelled", "The collection files changed");
      }
      for (const [index, group] of approved.entries()) {
        if (this.stopping) break;
        if (group.state !== "imported") {
          try {
            await this.importBook(source, record, group, preview, libraryId);
          } catch (err) {
            group.state = err instanceof CollectionConflict ? "held" : "failed";
            group.message = errorMessage(err);
          }
          this.write(source, record);
        }
        onProgress?.(index + 1);
      }
      return this.view(source, preview, libraryAvailable);
    } finally {
      this.importing = false;
    }
  }

  private async importBook(source: string, record: ReviewRecord, group: ApprovedGroup, preview: CollectionPreview, libraryId?: string) {
    const { store, runner } = this.deps;
    const token = tokenFor(source, group);
    const inbox = await fs.realpath(this.deps.inbox());
    const staging = path.join(inbox, COLLECTION_STAGING, token);
    const candidate = proposedCandidate(preview, group);
    let item = group.itemId ? store.getItem(group.itemId) : undefined;
    if (group.itemId && !item) throw new CollectionConflict("The saved ingest item is missing");
    if (item?.state === "complete") {
      group.state = "imported";
      group.message = item.error ?? undefined;
      return;
    }
    if (!item) {
      await this.stage(source, staging, token, group, preview.files, candidate);
      const book = await this.deps.scan(staging);
      book.title = group.title;
      book.authors = [group.author];
      if (candidate?.narrator) book.narrator = candidate.narrator;
      if (candidate?.series && candidate.seriesNumber !== undefined) {
        book.series = candidate.series;
        book.series_number = candidate.seriesNumber;
        book.is_series = true;
      }
      const action = await this.deps.organize(book);
      if (action.action_type !== "move" && action.action_type !== "rename") {
        throw new CollectionConflict(action.reason);
      }
      const jobId = store.create(staging, libraryId);
      store.registerCollectionAction(jobId, action, source, itemId => {
        group.itemId = itemId;
        return JSON.stringify(record);
      });
      item = store.getItem(group.itemId!);
      if (!item) throw new Error("Failed to load saved ingest item");
    }
    const action = { ...item.action, executed: false, success: false };
    if (path.relative(staging, action.source_path)) throw new CollectionConflict("The saved staging location changed");
    const library = await fs.realpath(this.deps.library());
    const target = await assertContained(action.target_path, library);
    const existingTarget = await present(target);
    const recover = existingTarget && await this.hasReceipt(target, token, library);
    if (group.automatic && !recover && !existingTarget) {
      const fresh = await this.deps.organize(action.book);
      if ((fresh.action_type !== "move" && fresh.action_type !== "rename")
        || path.resolve(fresh.target_path) !== path.resolve(action.target_path)) {
        throw new CollectionConflict(fresh.reason || "Library destination changed. Review this book.");
      }
    }
    if (existingTarget && !recover) throw new CollectionConflict("A different book already occupies the library destination");
    if (recover) {
      if (!await this.hasAudio(target, group, preview.files, library)) {
        throw new CollectionConflict("The previously moved book is incomplete at its library destination");
      }
      if (await present(staging)) {
        if (!await this.hasReceipt(staging, token, inbox)) {
          throw new CollectionConflict("An unrelated path blocks recovery of the staged book");
        }
        // Destination published by an interrupted cross-device move. The
        // original collection remains, and removing this copy enables rollback.
        await fs.rm(await exactPath(staging, inbox), { recursive: true });
      }
    } else if (!await this.hasReceipt(staging, token, inbox) || !await this.hasAudio(staging, group, preview.files, inbox)) {
      throw new CollectionConflict("The staged book is missing or has changed");
    }
    const { results: [result] } = await runner.importActions([{ action, itemId: item.id, jobId: item.jobId, recoverMoved: recover }]);
    if (!result.moved) throw new Error(result.error ?? "The book did not move");
    group.state = "imported";
    group.message = result.absWarning;
  }

  private async hasReceipt(directory: string, token: string, root: string): Promise<boolean> {
    try {
      const filename = await exactPath(path.join(directory, RECEIPT), root);
      const stat = await fs.lstat(filename);
      return stat.isFile() && stat.size === token.length && await fs.readFile(filename, "utf8") === token;
    } catch (err) {
      if (err instanceof PathSecurityError || errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return false;
      throw err;
    }
  }

  private async hasAudio(directory: string, group: CollectionGroup, inventory: AudioFile[], root: string): Promise<boolean> {
    const files = new Map(inventory.map(file => [file.path, file]));
    const audio = new Map(group.files.map((file, index) => [audioName(file, index), files.get(file)?.size]));
    const entries = await fs.readdir(await exactPath(directory, root), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) return false;
      if (!AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fs.lstat(await exactPath(path.join(directory, entry.name), root));
      if (!stat.isFile() || stat.size !== audio.get(entry.name)) return false;
      audio.delete(entry.name);
    }
    return audio.size === 0;
  }

  private async stage(source: string, staging: string, token: string, group: CollectionGroup, inventory: AudioFile[], candidate?: CollectionCandidate) {
    const inbox = await fs.realpath(this.deps.inbox());
    const parent = await exactPath(path.dirname(staging), inbox, false);
    await fs.mkdir(parent, { recursive: true });
    await exactPath(parent, inbox);
    if (await present(staging)) {
      if (!await this.hasReceipt(staging, token, inbox)) throw new CollectionConflict("Collection staging destination already exists");
      if (await this.hasAudio(staging, group, inventory, inbox)) return;
      await fs.rm(await exactPath(staging, inbox), { recursive: true });
    }

    const temporary = await exactPath(path.join(parent, ".incoming-" + randomUUID()), inbox, false);
    await fs.mkdir(temporary);
    const files = new Map(inventory.map(file => [file.path, file]));
    try {
      for (const [index, filename] of [...group.files, ...(candidate?.extras ?? [])].entries()) {
        const file = files.get(filename);
        if (!file) throw new CollectionConflict("A proposed collection file is missing");
        const basename = path.basename(filename);
        const name = index < group.files.length ? audioName(filename, index)
          : basename.toLowerCase() === "metadata.json" ? "metadata.json" : basename;
        const destination = await exactPath(path.join(temporary, name), inbox, false);
        await copySnapshot(file, source, destination);
      }
      const sidecar = await exactPath(path.join(temporary, "metadata.json"), inbox, false);
      let metadata: Record<string, unknown> = {};
      if (await present(sidecar) && (await fs.lstat(sidecar)).size <= 1024 * 1024) {
        const existing: unknown = await fs.readFile(sidecar, "utf8").then(text => JSON.parse(text) as unknown).catch(() => null);
        if (existing && typeof existing === "object" && !Array.isArray(existing)) metadata = { ...existing };
      }
      if (candidate?.series && candidate.seriesNumber !== undefined) {
        metadata.series = [{ name: candidate.series, sequence: candidate.seriesNumber }];
      }
      if (candidate?.narrator && !metadata.narrator) metadata.narrator = candidate.narrator;
      await fs.writeFile(sidecar, JSON.stringify({ ...metadata, title: group.title, authors: [group.author] }, null, 2));
      for (const filename of [...group.files, ...(candidate?.extras ?? [])]) {
        const file = files.get(filename)!;
        const original = await exactPath(path.resolve(source, file.path), source);
        if (!unchanged(await fs.lstat(original), file)) {
          throw new CollectionConflict("A collection file changed while staging");
        }
      }
      await fs.writeFile(await exactPath(path.join(temporary, RECEIPT), inbox, false), token, { flag: "wx" });
      await exactPath(staging, inbox, false);
      if (await present(staging)) throw new CollectionConflict("Collection staging destination already exists");
      await fs.rename(temporary, staging);
    } catch (err) {
      const cleanup = await exactPath(temporary, inbox, false).catch(() => null);
      if (cleanup) await fs.rm(cleanup, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }
}
