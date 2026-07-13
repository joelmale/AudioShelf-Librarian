import path from "path";
import fs from "fs";
import { ABSClient } from "../../curator/core/absClient.js";
import { SettingsStore } from "../../../config/settings.js";
import { AudiobookOrganizer } from "./organizer.js";
import type { Book } from "@audioshelf/shared";

export interface RealignCandidate {
  bookId: string;
  title: string;
  author: string;
  currentPath: string;
  proposedPath: string;
  libraryId: string;
}

export class RealignService {
  private organizer: AudiobookOrganizer;

  constructor() {
    this.organizer = new AudiobookOrganizer({} as any); // Organizer config is minimal right now
  }

  private getAbsClient(): ABSClient {
    const settings = SettingsStore.getInstance().getSettings();
    if (!settings.absUrl || !settings.absToken) {
      throw new Error("Audiobookshelf connection is not configured.");
    }
    return new ABSClient(settings.absUrl, settings.absToken);
  }

  public async scanLibrary(): Promise<RealignCandidate[]> {
    const client = this.getAbsClient();
    const libraries = await client.getLibraries();
    const candidates: RealignCandidate[] = [];

    for (const lib of libraries) {
      if (lib.mediaType !== 'book') continue; // only process audiobooks
      const items = await client.getLibraryItems(lib.id);
      
      for (const item of items) {
        if (!item.path) continue; // Skip if no path
        
        // Map ABS item to our shared Book interface for generateTargetPath
        const metadata = item.media?.metadata || {};
        const book: Book = {
          title: metadata.title || "Unknown Title",
          authors: metadata.authorName ? [metadata.authorName] : ["Unknown Author"],
          series: metadata.seriesName || null,
          series_number: metadata.series && metadata.series.length > 0 ? Number(metadata.series[0].sequence) || null : null,
          is_series: !!metadata.seriesName,
          source_path: item.path,
          // filler for required fields
          audio_files: [],
          needs_processing: false,
          confidence_score: 1,
          metadata_source: "abs_json"
        };
        
        const proposedPath = await this.organizer.generateTargetPath(book);
        
        // Compare paths
        // Convert to absolute normalized paths for safe comparison
        const currentNorm = path.resolve(item.path);
        const proposedNorm = path.resolve(proposedPath);
        
        // If the current path is a directory (it should be), does it match proposed?
        if (currentNorm !== proposedNorm) {
          candidates.push({
            bookId: item.id,
            libraryId: lib.id,
            title: book.title,
            author: book.authors[0],
            currentPath: currentNorm,
            proposedPath: proposedNorm
          });
        }
      }
    }
    
    return candidates;
  }

  public async executeRealign(candidates: RealignCandidate[]): Promise<{ success: number, failed: number, errors: string[] }> {
    let successCount = 0;
    let failedCount = 0;
    const errors: string[] = [];
    const client = this.getAbsClient();
    const librariesToScan = new Set<string>();

    for (const candidate of candidates) {
      try {
        const currentPath = candidate.currentPath;
        const proposedPath = candidate.proposedPath;
        
        // Safety check: Ensure current path exists
        if (!fs.existsSync(currentPath)) {
          throw new Error(`Current path does not exist: ${currentPath}`);
        }
        
        // Safety check: Ensure target does not exist
        if (fs.existsSync(proposedPath)) {
          throw new Error(`Target path already exists: ${proposedPath}`);
        }
        
        // Ensure parent dir of proposed path exists
        await fs.promises.mkdir(path.dirname(proposedPath), { recursive: true });
        
        // Move the directory
        await fs.promises.rename(currentPath, proposedPath);
        
        successCount++;
        librariesToScan.add(candidate.libraryId);
      } catch (err: any) {
        failedCount++;
        errors.push(`Failed to move ${candidate.title}: ${err.message}`);
      }
    }
    
    // Trigger ABS scans for affected libraries
    for (const libId of librariesToScan) {
      try {
        await client.triggerLibraryScan(libId);
      } catch (err: any) {
        errors.push(`Failed to trigger ABS scan for library ${libId}: ${err.message}`);
      }
    }
    
    return { success: successCount, failed: failedCount, errors };
  }
}
