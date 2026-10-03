import cron, { type ScheduledTask } from "node-cron";
import fs from "fs";
import path from "path";
import { errorCode, type PathMapping } from "@audioshelf/shared";
import { QBittorrentService, type QbitTorrent } from "./qbittorrent.js";
import { SettingsStore } from "../../../config/settings.js";

export type TorrentImportResult =
  | { hash: string; name: string; status: "imported"; inboxPath: string }
  | { hash: string; name: string; status: "conflict" | "unavailable"; reason: string };

type ImportCallback = (inboxPath: string, torrent: QbitTorrent) => Promise<void> | void;

export type InboxMoveStrategy = "renamed" | "copied-and-removed" | "copied-needs-client-delete";

export const AUDIO_EXTENSIONS = [".m4b", ".mp3", ".m4a", ".flac", ".opus", ".ogg", ".aac", ".wma"];

export function applyPathMapping(rawPath: string, mappings: readonly PathMapping[]): string {
  if (!rawPath || mappings.length === 0) return rawPath;
  const normalized = rawPath.replace(/\\/g, "/");
  for (const mapping of mappings) {
    if (!mapping.remotePath || !mapping.localPath) continue;
    const normalizedRemote = mapping.remotePath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized === normalizedRemote || normalized.startsWith(normalizedRemote + "/")) {
      const remainder = normalized.slice(normalizedRemote.length).replace(/^\/+/, "");
      return remainder ? path.join(mapping.localPath, remainder) : mapping.localPath;
    }
  }
  return rawPath;
}

export function checkPathAccessible(targetPath: string): { accessible: boolean; error?: string } {
  try {
    fs.accessSync(targetPath, fs.constants.R_OK);
    return { accessible: true };
  } catch (error) {
    const code = errorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      return {
        accessible: false,
        error: `Permission denied reading download path "${targetPath}": the AudioShelf container user does not have permission to read this directory.`,
      };
    }
    return { accessible: false };
  }
}

export interface TorrentPathResolution {
  found: boolean;
  sourcePath?: string;
  reason?: string;
}

export async function resolveTorrentSourcePath(
  torrent: QbitTorrent,
  pathMappings: readonly PathMapping[],
  qbtService?: Pick<QBittorrentService, "getTorrentFiles">,
): Promise<TorrentPathResolution> {
  const triedPaths: string[] = [];
  let permissionError: string | null = null;

  const tryCandidate = (candidate: string): string | null => {
    if (!candidate) return null;
    const mapped = path.resolve(applyPathMapping(candidate, pathMappings));
    if (triedPaths.includes(mapped)) return null;
    triedPaths.push(mapped);

    const access = checkPathAccessible(mapped);
    if (access.accessible) return mapped;
    if (access.error && !permissionError) permissionError = access.error;

    return null;
  };

  // 1. Direct content_path
  if (torrent.content_path) {
    const hit = tryCandidate(torrent.content_path);
    if (hit) return { found: true, sourcePath: hit };

    // 2. content_path with common audio extensions
    for (const ext of AUDIO_EXTENSIONS) {
      const hitExt = tryCandidate(torrent.content_path + ext);
      if (hitExt) return { found: true, sourcePath: hitExt };
    }
  }

  // 3. save_path + torrent.name
  if (torrent.save_path && torrent.name) {
    const nameInSave = path.join(torrent.save_path, torrent.name);
    const hit = tryCandidate(nameInSave);
    if (hit) return { found: true, sourcePath: hit };

    // 4. save_path + torrent.name with audio extensions
    for (const ext of AUDIO_EXTENSIONS) {
      const hitExt = tryCandidate(nameInSave + ext);
      if (hitExt) return { found: true, sourcePath: hitExt };
    }
  }

  // 5. Query qBittorrent for torrent's internal files
  if (qbtService?.getTorrentFiles && torrent.hash) {
    try {
      const files = await qbtService.getTorrentFiles(torrent.hash);
      if (Array.isArray(files) && files.length > 0 && torrent.save_path) {
        // Multi-file torrents: check if all files share a common root directory
        const topDirs = new Set(
          files
            .map((f) => f.name.replace(/\\/g, "/").split("/")[0])
            .filter(Boolean),
        );
        if (topDirs.size === 1) {
          const [dirName] = topDirs;
          const hit = tryCandidate(path.join(torrent.save_path, dirName));
          if (hit) return { found: true, sourcePath: hit };
        }

        // Single-file or loose files: check each file path
        for (const file of files) {
          const hit = tryCandidate(path.join(torrent.save_path, file.name));
          if (hit) return { found: true, sourcePath: hit };
        }
      }
    } catch {
      // getTorrentFiles is best-effort
    }
  }

  // 6. Inspect save_path directory contents if accessible
  if (torrent.save_path) {
    const mappedSave = path.resolve(applyPathMapping(torrent.save_path, pathMappings));
    const access = checkPathAccessible(mappedSave);
    if (access.accessible) {
      try {
        const stat = fs.statSync(mappedSave);
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(mappedSave);
          const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
          const targetClean = clean(torrent.name);

          // Find entry matching torrent name
          const match = entries.find((entry) => {
            if (entry.startsWith(".")) return false;
            const entryClean = clean(path.parse(entry).name);
            return (
              entryClean === targetClean ||
              (targetClean.length > 5 &&
                (entryClean.includes(targetClean) || targetClean.includes(entryClean)))
            );
          });

          if (match) {
            const hit = tryCandidate(path.join(mappedSave, match));
            if (hit) return { found: true, sourcePath: hit };
          }
        }
      } catch (dirError) {
        const code = errorCode(dirError);
        if (code === "EACCES" || code === "EPERM") {
          permissionError = `Permission denied reading save directory "${mappedSave}": the AudioShelf container user does not have permission to read this directory.`;
        }
      }
    } else if (access.error && !permissionError) {
      permissionError = access.error;
    }
  }

  if (permissionError) {
    return { found: false, reason: permissionError };
  }

  const displaySource = applyPathMapping(
    torrent.content_path || torrent.save_path || "",
    pathMappings,
  );
  return {
    found: false,
    reason: `Download path is not visible to AudioShelf: ${displaySource || "(empty)"}`,
  };
}

export function isTorrentEligible(
  torrent: QbitTorrent,
  knownImported: ReadonlySet<string>,
  onlyHashes?: ReadonlySet<string>,
  force = false,
): boolean {
  return torrent.progress >= 1
    && (!onlyHashes || onlyHashes.has(torrent.hash))
    && (force || !knownImported.has(torrent.hash));
}

export async function moveIntoInbox(source: string, destination: string): Promise<InboxMoveStrategy> {
  try {
    await fs.promises.rename(source, destination);
    return "renamed";
  } catch (error) {
    const code = errorCode(error);
    if (!code || !["EXDEV", "EACCES", "EPERM", "EROFS"].includes(code)) throw error;
    await fs.promises.cp(source, destination, { recursive: true, errorOnExist: true });
    
    if (code === "EXDEV") {
      try {
        await fs.promises.rm(source, { recursive: true, force: true });
        return "copied-and-removed";
      } catch (rmError) {
        const rmCode = errorCode(rmError);
        if (!rmCode || !["EACCES", "EPERM", "EROFS"].includes(rmCode)) throw rmError;
        // Fall through to copied-needs-client-delete if we can't remove it
      }
    }
    
    // A read-only download mount can still be copied. qBittorrent owns the
    // writable side of that mount and will remove the verified source for us.
    return "copied-needs-client-delete";
  }
}

export class TorrentMonitorService {
  private readonly qbtService: QBittorrentService;
  private readonly knownImported = new Set<string>();
  private readonly statePath: string;
  private readonly task: ScheduledTask;
  private running: Promise<TorrentImportResult[]> | null = null;

  constructor(qbtService?: QBittorrentService, private readonly onImported?: ImportCallback) {
    this.qbtService = qbtService || new QBittorrentService();
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
    this.statePath = path.join(dataDir, "imported_torrents.json");
    this.loadState();
    this.task = cron.schedule("*/1 * * * *", () => void this.checkAndImport().catch(console.error));
    // Reconcile downloads which completed while AudioShelf was stopped.
    setImmediate(() => void this.checkAndImport().catch((error) => {
      // qBittorrent is an optional integration. When it is simply not present
      // — no container, no DNS entry — that is a configuration state, not a
      // fault, so report it in one line instead of dumping a DNS stack trace
      // on every start and into every test run that constructs this service.
      const code = errorCode(error) ?? errorCode((error as { cause?: unknown })?.cause);
      if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED") {
        console.warn(`qBittorrent not reachable (${code}); skipping startup reconciliation`);
        return;
      }
      console.error("Initial qBittorrent reconciliation failed:", error);
    }));
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf-8"));
        if (Array.isArray(parsed)) for (const hash of parsed) this.knownImported.add(String(hash));
      }
    } catch (error) {
      console.error("Error loading imported_torrents state:", error);
    }
  }

  private async saveState(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.promises.writeFile(
      this.statePath,
      JSON.stringify(Array.from(this.knownImported), null, 2),
      "utf-8",
    );
  }

  async checkAndImport(hashes?: string[], force = false): Promise<TorrentImportResult[]> {
    if (this.running) return this.running;
    const onlyHashes = hashes ? new Set(hashes) : undefined;
    this.running = this.reconcile(onlyHashes, force).finally(() => { this.running = null; });
    return this.running;
  }

  private async reconcile(onlyHashes?: ReadonlySet<string>, force = false): Promise<TorrentImportResult[]> {
    const inboxPath = path.resolve(SettingsStore.getInstance().getSettings().inboxDir || "/inbox");
    await fs.promises.mkdir(inboxPath, { recursive: true });
    const torrents = await this.qbtService.getTorrents("completed", "audiobooks");
    const results: TorrentImportResult[] = [];

    for (const torrent of torrents) {
      if (!isTorrentEligible(torrent, this.knownImported, onlyHashes, force)) continue;

      const pathMappings = SettingsStore.getInstance().getSettings().pathMappings;
      const resolution = await resolveTorrentSourcePath(torrent, pathMappings, this.qbtService);

      if (!resolution.found || !resolution.sourcePath) {
        results.push({
          hash: torrent.hash,
          name: torrent.name,
          status: "unavailable",
          reason: resolution.reason || `Download path is not visible to AudioShelf: ${torrent.content_path || torrent.save_path || "(empty)"}`,
        });
        continue;
      }

      const sourcePath = path.resolve(resolution.sourcePath);
      const destination = path.resolve(inboxPath, path.basename(sourcePath));
      try {
        if (sourcePath !== destination && fs.existsSync(destination)) {
          results.push({ hash: torrent.hash, name: torrent.name, status: "conflict", reason: `Inbox destination already exists: ${destination}` });
          continue;
        }

        // Move first so a filesystem failure leaves qBittorrent able to retry and
        // keeps the completed payload discoverable.
        const moveStrategy = sourcePath === destination
          ? "renamed"
          : await moveIntoInbox(sourcePath, destination);
        // The payload is now safely in Inbox. Remove only the torrent record and
        // ask qBittorrent to delete the source only when our mount was read-only.
        await this.qbtService.removeTorrent(torrent.hash, moveStrategy === "copied-needs-client-delete");
        this.knownImported.add(torrent.hash);
        await this.saveState();
        await this.onImported?.(destination, torrent);
        results.push({ hash: torrent.hash, name: torrent.name, status: "imported", inboxPath: destination });
      } catch (error) {
        results.push({ hash: torrent.hash, name: torrent.name, status: "unavailable", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  async getStats() {
    const [downloading, completed] = await Promise.all([
      this.qbtService.getTorrents("downloading", "audiobooks"),
      this.qbtService.getTorrents("completed", "audiobooks"),
    ]);
    return { importedCount: this.knownImported.size, activeDownloads: downloading.length, completedDownloads: completed.length };
  }

  stop(): void { this.task.stop(); }
}
