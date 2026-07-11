import cron from "node-cron";
import fs from "fs";
import path from "path";
import { QBittorrentService } from "./qbittorrent.js";
import { AudiobookOrganizer } from "./organizer.js";
import { SettingsStore } from "../../../config/settings.js";

export class TorrentMonitorService {
  private qbtService: QBittorrentService;
  private organizer: AudiobookOrganizer;
  private inboxPath: string;
  private knownImported: Set<string> = new Set();
  private statePath: string;

  constructor(qbtService?: QBittorrentService) {
    this.qbtService = qbtService || new QBittorrentService();
    const sysSettings = SettingsStore.getInstance().getSettings();
    this.inboxPath = sysSettings.inboxDir || "/inbox";
    const destPath = sysSettings.libraryDir || "/audiobooks";

    this.organizer = new AudiobookOrganizer({
      LIBRARY_DIR: destPath,
      INBOX_DIR: this.inboxPath
    } as any);

    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
    this.statePath = path.join(dataDir, "imported_torrents.json");
    this.loadState();

    // Run every 5 minutes
    cron.schedule("*/5 * * * *", () => {
      console.log("Running scheduled torrent monitor check...");
      this.checkAndImport().catch(console.error);
    });
  }

  private loadState() {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.knownImported = new Set(parsed);
        }
      }
    } catch (e) {
      console.error("Error loading imported_torrents state:", e);
    }
  }

  private saveState() {
    try {
      const dataDir = path.dirname(this.statePath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const data = Array.from(this.knownImported);
      fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      console.error("Error saving imported_torrents state:", e);
    }
  }

  async checkAndImport() {
    const torrents = await this.qbtService.getTorrents("completed", "audiobooks");

    for (const t of torrents) {
      if (t.progress === 1 && !this.knownImported.has(t.hash)) {
        console.log(`Found newly completed torrent: ${t.name}`);

        const sourcePath = t.content_path || t.save_path;
        if (!sourcePath || !fs.existsSync(sourcePath)) {
          console.error(`Source path for ${t.name} does not exist: ${sourcePath}`);
          continue;
        }

        try {
          const stats = fs.statSync(sourcePath);
          const destPath = path.join(this.inboxPath, path.basename(sourcePath));

          if (sourcePath !== destPath) {
            // We choose to COPY the files to preserve seeding if they are in a different dir
            if (stats.isDirectory()) {
              fs.cpSync(sourcePath, destPath, { recursive: true });
            } else {
              fs.copyFileSync(sourcePath, destPath);
            }
            console.log(`Copied ${t.name} to Inbox.`);
            
            // Remove from qBittorrent and delete the original downloaded files since we copied them to the inbox
            console.log(`Removing ${t.name} from qBittorrent and deleting original files...`);
            await this.qbtService.removeTorrent(t.hash, true);
          } else {
            console.log(`${t.name} is already in the Inbox. Skipping copy.`);
            
            // Remove from qBittorrent but DO NOT delete files, since they are already in the inbox!
            console.log(`Removing ${t.name} from qBittorrent (keeping files)...`);
            await this.qbtService.removeTorrent(t.hash, false);
          }

          this.knownImported.add(t.hash);
          this.saveState();
        } catch (e) {
          console.error(`Failed to import ${t.name}:`, e);
        }
      }
    }
  }

  async getStats() {
    const downloading = await this.qbtService.getTorrents("downloading", "audiobooks");
    const completed = await this.qbtService.getTorrents("completed", "audiobooks");
    return {
      importedCount: this.knownImported.size,
      activeDownloads: downloading.length,
      completedDownloads: completed.length
    };
  }
}
