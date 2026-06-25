import cron from "node-cron";
import fs from "fs";
import path from "path";
import { QBittorrentService } from "./qbittorrent.js";
import { AudiobookOrganizer } from "./organizer.js";

export class TorrentMonitorService {
  private qbtService: QBittorrentService;
  private organizer: AudiobookOrganizer;
  private inboxPath: string;
  private knownImported: Set<string> = new Set();

  constructor(qbtService?: QBittorrentService) {
    this.qbtService = qbtService || new QBittorrentService();
    // Assuming ABS Inbox path from the system or config, we'll hardcode a default for now
    this.inboxPath = process.env.INBOX_DIR || "/audiobooks/inbox";
    const destPath = process.env.LIBRARY_DIR || "/audiobooks";
    this.organizer = new AudiobookOrganizer({
      LIBRARY_DIR: destPath,
      INBOX_DIR: this.inboxPath
    } as any);

    // Run every 5 minutes
    cron.schedule("*/5 * * * *", () => {
      console.log("Running scheduled torrent monitor check...");
      this.checkAndImport().catch(console.error);
    });
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

        // We choose to COPY the files to preserve seeding
        try {
          const stats = fs.statSync(sourcePath);
          const destPath = path.join(this.inboxPath, path.basename(sourcePath));
          
          if (stats.isDirectory()) {
            fs.cpSync(sourcePath, destPath, { recursive: true });
          } else {
            fs.copyFileSync(sourcePath, destPath);
          }
          
          console.log(`Copied ${t.name} to Inbox. Triggering Organizer...`);
          // Note: In a real system, you might trigger the metadata scanner/organizer pipeline here.
          // For now we just mark it as processed so we don't copy it again.
          
          this.knownImported.add(t.hash);
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
