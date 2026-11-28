import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { errorCode, type PathMapping } from "@audioshelf/shared";
import { z } from "zod";
import { assertContained, PathSecurityError } from "../../../security/paths.js";
import { AUDIO_EXTENSIONS } from "./audioLayout.js";
import { CollectionConflict, type CollectionReview, within } from "./collectionReview.js";
import type { QBittorrentService } from "./qbittorrent.js";
import { applyPathMapping } from "./torrentMonitor.js";

export const INBOX_ARCHIVE = ".intake-archive";
const MANIFEST = "manifest.json";
const PAYLOAD = "source";
const MAX_ENTRIES = 12_000;
const MAX_DEPTH = 12;

const ArchiveItem = z.object({
  id: z.string().uuid(),
  title: z.string(),
  archivedAt: z.string().datetime(),
  audioFiles: z.number().int().nonnegative(),
  otherFiles: z.number().int().nonnegative(),
  sourceName: z.string().min(1).refine(name => !name.startsWith(".") && !name.startsWith("@") && !/[\\/:]/.test(name)),
});
type ArchiveItem = z.infer<typeof ArchiveItem>;

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function exact(file: string, root: string, mustExist = true): Promise<string> {
  const canonical = await assertContained(file, root, { mustExist });
  if (path.relative(file, canonical)) throw new PathSecurityError("An inbox archive path is linked or changed.");
  return canonical;
}

const overlaps = (one: string, other: string) => within(one, other) || within(other, one);

// Bind-mounted aliases can designate the same directory under different names.
// Compare both roots with the ancestors of the opposite path, never two ancestors.
async function ancestors(file: string) {
  const identities: string[] = [];
  for (let candidate = file; ; candidate = path.dirname(candidate)) {
    try {
      const info = await fs.stat(candidate, { bigint: true });
      identities.push(info.ino ? `${info.dev}:${info.ino}` : "");
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw error;
      identities.push("");
    }
    if (path.dirname(candidate) === candidate) return identities;
  }
}

export async function torrentArchiveBlocker(source: string, qbit: Pick<QBittorrentService, "getTorrents">, mappings: PathMapping[],
  sourceDirectories: ReadonlySet<string> = new Set()) {
  const unavailable = "Could not verify. Check the qBittorrent connection and download path mappings.";
  try {
    const torrents = await qbit.getTorrents("all");
    if (!Array.isArray(torrents)) return unavailable;
    const sourceParents = await ancestors(source);
    let unknown = false;
    for (const torrent of torrents) {
      const content = typeof torrent?.content_path === "string" && applyPathMapping(torrent.content_path, mappings);
      const save = typeof torrent?.save_path === "string" && applyPathMapping(torrent.save_path, mappings);
      if (!content || !path.isAbsolute(content) || !save || !path.isAbsolute(save)) { unknown = true; continue; }
      const target = path.resolve(content);
      if (overlaps(source, target)) return "A registered torrent still uses this source. Release it in qBittorrent before archiving.";
      const canonicalTarget = await assertContained(target, path.parse(target).root, { allowRoot: true });
      const targetParents = await ancestors(canonicalTarget);
      if (overlaps(source, canonicalTarget)) return "A registered torrent still uses this source. Release it in qBittorrent before archiving.";
      if ((targetParents[0] && sourceParents.includes(targetParents[0]))
        || (sourceParents[0] && targetParents.includes(sourceParents[0]))
        || targetParents.some(identity => sourceDirectories.has(identity))) {
        return "A registered torrent still uses this source. Release it in qBittorrent before archiving.";
      }
      // The client path must resolve locally, or its mapped save directory must
      // resolve locally (the payload may not exist yet for a queued download).
      if (!targetParents[0]) {
        const savePath = path.resolve(save);
        if (!within(target, savePath) || !(await ancestors(savePath))[0]) unknown = true;
      }
    }
    return unknown ? unavailable : undefined;
  } catch {
    return unavailable;
  }
}

async function inventory(source: string) {
  const files = new Map<string, boolean>();
  const directories = new Set<string>();
  const digest = createHash("sha256");
  let entries = 0;
  async function walk(folder: string, depth: number) {
    if (depth > MAX_DEPTH) throw new CollectionConflict("The source contains folders nested too deeply to preview.");
    const before = await fs.lstat(folder);
    if (!before.isDirectory()) throw new CollectionConflict("A source folder changed while it was being checked.");
    const identity = await fs.lstat(folder, { bigint: true });
    if (identity.ino) directories.add(`${identity.dev}:${identity.ino}`);
    const children = (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const child of children) {
      if (++entries > MAX_ENTRIES) throw new CollectionConflict("The source contains too many entries to preview.");
      const file = await exact(path.join(folder, child.name), source);
      const stat = await fs.lstat(file);
      const relative = path.relative(source, file).split(path.sep).join("/");
      digest.update(JSON.stringify([relative, stat.mode, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
      if (stat.isDirectory()) await walk(file, depth + 1);
      else if (stat.isFile()) files.set(relative, AUDIO_EXTENSIONS.has(path.extname(child.name).toLowerCase()));
      else throw new CollectionConflict("The source contains a linked or unsupported entry.");
    }
    const after = await fs.lstat(folder);
    if (!after.isDirectory() || before.ino !== after.ino || before.dev !== after.dev
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new CollectionConflict("The source changed while it was being checked.");
    }
    digest.update(JSON.stringify([before.dev, before.ino, before.mtimeMs, before.ctimeMs]));
  }
  await walk(source, 0);
  return { files, directories, fingerprint: digest.digest("hex") };
}

async function syncDirectory(directory: string) {
  // Windows does not support opening directory handles through fs.open.
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); }
  catch (error) {
    if (errorCode(error) !== "EINVAL" && errorCode(error) !== "ENOTSUP") throw error;
  } finally { await handle.close(); }
}

export class InboxArchive {
  constructor(private readonly deps: {
    inbox: () => string;
    library: () => string;
    review: Pick<CollectionReview, "cleanupCoverage">;
    torrentBlocker: (source: string, sourceDirectories: ReadonlySet<string>) => Promise<string | undefined>;
  }) {}

  private async roots() {
    const inbox = await fs.realpath(this.deps.inbox());
    const root = await exact(path.join(inbox, INBOX_ARCHIVE), inbox, false);
    return { inbox, root };
  }

  async preview(input: string, title: string) {
    const { inbox, root } = await this.roots();
    const result = { title, importedBooks: 0, duplicateBooks: 0, audioFiles: 0, otherFiles: 0,
      blockers: [] as string[], token: undefined as string | undefined, destination: path.join(this.deps.inbox(), INBOX_ARCHIVE) };
    const source = await assertContained(input, inbox, { mustExist: true });
    const relative = path.relative(inbox, source);
    // Keep the whole-folder move scoped to an independent inbox entry.
    if (relative.includes(path.sep) || !ArchiveItem.shape.sourceName.safeParse(relative).success
      || path.relative(path.join(inbox, path.basename(input)), source)
      || path.relative(await fs.realpath(path.dirname(input)), inbox)
      || !(await fs.lstat(input)).isDirectory()) {
      result.blockers.push("Only top-level inbox collection folders can be archived.");
      return result;
    }
    const library = await fs.realpath(this.deps.library()).catch(() => undefined);
    if (!library || overlaps(source, library) || overlaps(root, library)) {
      result.blockers.push("Verify that the library and archive are separate locations.");
      return result;
    }
    try {
      const snap = await inventory(source);
      const coverage = await this.deps.review.cleanupCoverage(source);
      result.importedBooks = coverage.importedBooks;
      result.duplicateBooks = coverage.duplicateBooks;
      result.audioFiles = [...snap.files.values()].filter(Boolean).length;
      result.otherFiles = snap.files.size - result.audioFiles;
      result.blockers.push(...coverage.blockers);
      if ([...snap.files].some(([file, audio]) => audio && !coverage.covered.has(file)) && !coverage.blockers.length) {
        result.blockers.push("The folder still contains audio without a resolved book decision.");
      }
      const torrent = await this.deps.torrentBlocker(source, snap.directories);
      if (torrent) result.blockers.push(torrent);
      if (!result.blockers.length) result.token = snap.fingerprint;
    } catch (error) {
      result.blockers.push(error instanceof CollectionConflict ? error.message : "Could not verify every file in the source folder.");
    }
    return result;
  }

  async archive(input: string, title: string, token: string, bindSource?: (source: string) => void) {
    const preview = await this.preview(input, title);
    if (!preview.token || preview.token !== token) {
      throw new CollectionConflict(preview.blockers[0] ?? "The inbox source changed. Refresh the cleanup preview.");
    }
    const { inbox, root } = await this.roots();
    const source = await exact(path.join(inbox, path.basename(input)), inbox);
    const item = ArchiveItem.parse({ id: randomUUID(), title, archivedAt: new Date().toISOString(),
      sourceName: path.basename(source), audioFiles: preview.audioFiles, otherFiles: preview.otherFiles });
    await fs.mkdir(root, { recursive: true });
    await exact(root, inbox);
    const entry = await exact(path.join(root, item.id), inbox, false);
    await fs.mkdir(entry);
    const manifest = await exact(path.join(entry, MANIFEST), inbox, false);
    const payload = await exact(path.join(entry, PAYLOAD), inbox, false);
    // Write the recovery information before publishing the move. A manifest
    // without a payload is ignored, including after a successful restore.
    const file = await fs.open(manifest, "wx");
    try {
      await file.writeFile(JSON.stringify(item), "utf8");
      await file.sync();
    } finally { await file.close(); }
    await syncDirectory(entry);
    await syncDirectory(root);
    await syncDirectory(inbox);
    if ((await inventory(source)).fingerprint !== token || await exists(payload)) {
      throw new CollectionConflict("The inbox source or archive changed. Refresh the cleanup preview.");
    }
    bindSource?.(source);
    await fs.rename(await exact(source, inbox), await exact(payload, inbox, false));
    return this.publicItem(item);
  }

  private publicItem({ id, title, archivedAt, audioFiles, otherFiles }: ArchiveItem) {
    return { id, title, archivedAt, audioFiles, otherFiles };
  }

  private async read(root: string, id: string) {
    if (!ArchiveItem.shape.id.safeParse(id).success) return;
    const entry = path.join(root, id);
    if (!await exists(entry)) return;
    const payload = path.join(entry, PAYLOAD);
    if (!await exists(payload)) return;
    const manifest = await exact(path.join(entry, MANIFEST), root);
    const info = await fs.lstat(manifest);
    if (!info.isFile() || info.size > 64 * 1024) throw new CollectionConflict("The archive recovery record is invalid.");
    const item = ArchiveItem.parse(JSON.parse(await fs.readFile(manifest, "utf8")));
    const source = await exact(payload, root);
    if (item.id !== id || !(await fs.lstat(source)).isDirectory()) throw new CollectionConflict("The archive recovery record changed.");
    return { item, source };
  }

  async list() {
    const { root } = await this.roots();
    if (!await exists(root)) return [];
    const items = [];
    for (const id of await fs.readdir(root)) {
      try {
        const archived = await this.read(root, id);
        if (archived) items.push(this.publicItem(archived.item));
      } catch { console.warn("[Inbox cleanup] An archive recovery record could not be read."); }
    }
    return items.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }

  async restore(id: string) {
    const { inbox, root } = await this.roots();
    const archived = await this.read(root, id);
    if (!archived) throw new CollectionConflict("This folder is no longer in the archive.");
    const target = path.join(inbox, archived.item.sourceName);
    if (await exists(target)) throw new CollectionConflict("A folder or file already occupies the original inbox location.");
    await fs.rename(archived.source, await exact(target, inbox, false));
    return { restored: true };
  }
}
