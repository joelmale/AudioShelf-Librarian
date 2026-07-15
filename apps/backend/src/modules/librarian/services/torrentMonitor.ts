import cron, { type ScheduledTask } from "node-cron";
import fs from "fs";
import path from "path";
import { QBittorrentService, type QbitTorrent } from "./qbittorrent.js";
import { SettingsStore } from "../../../config/settings.js";

export type TorrentImportResult =
  | { hash: string; name: string; status: "imported"; inboxPath: string }
  | { hash: string; name: string; status: "conflict" | "unavailable"; reason: string };

type ImportCallback = (inboxPath: string, torrent: QbitTorrent) => Promise<void> | void;

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
    setImmediate(() => void this.checkAndImport().catch((error) =>
      console.error("Initial qBittorrent reconciliation failed:", error)));
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

  async checkAndImport(): Promise<TorrentImportResult[]> {
    if (this.running) return this.running;
    this.running = this.reconcile().finally(() => { this.running = null; });
    return this.running;
  }

  private async reconcile(): Promise<TorrentImportResult[]> {
    const inboxPath = path.resolve(SettingsStore.getInstance().getSettings().inboxDir || "/inbox");
    await fs.promises.mkdir(inboxPath, { recursive: true });
    const torrents = await this.qbtService.getTorrents("completed", "audiobooks");
    const results: TorrentImportResult[] = [];

    for (const torrent of torrents) {
      if (torrent.progress < 1 || this.knownImported.has(torrent.hash)) continue;
      const source = torrent.content_path || torrent.save_path;
      if (!source || !fs.existsSync(source)) {
        results.push({ hash: torrent.hash, name: torrent.name, status: "unavailable", reason: `Download path is not visible to AudioShelf: ${source || "(empty)"}` });
        continue;
      }

      const sourcePath = path.resolve(source);
      const destination = path.resolve(inboxPath, path.basename(sourcePath));
      try {
        if (sourcePath !== destination && fs.existsSync(destination)) {
          results.push({ hash: torrent.hash, name: torrent.name, status: "conflict", reason: `Inbox destination already exists: ${destination}` });
          continue;
        }

        // Move first so a filesystem failure leaves qBittorrent able to retry and
        // keeps the completed payload discoverable.
        if (sourcePath !== destination) await this.move(sourcePath, destination);
        // The payload is now safely in Inbox. Remove only the torrent record and
        // never ask qBittorrent to delete files.
        await this.qbtService.removeTorrent(torrent.hash, false);
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

  private async move(source: string, destination: string): Promise<void> {
    try {
      await fs.promises.rename(source, destination);
    } catch (error: any) {
      if (error?.code !== "EXDEV") throw error;
      await fs.promises.cp(source, destination, { recursive: true, errorOnExist: true });
      await fs.promises.rm(source, { recursive: true, force: true });
    }
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
