import path from "path";
import fs from "fs";
import type { Book, OrganizationAction, ActionType } from "@audioshelf/shared";
import type { Config } from "@audioshelf/shared";

import { SettingsStore } from "../../../config/settings.js";

export class AudiobookOrganizer {
  private config: Config;
  private absCache: any[] = [];

  private static readonly INVALID_CHARS = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
  private static readonly CHAR_REPLACEMENTS: Record<string, string> = {
    ':': ' -',
    '?': '',
    '"': "'",
    '*': 'x',
    '<': '(',
    '>': ')',
    '|': '-',
  };

  constructor(config: Config) {
    this.config = config;
  }

  public setAbsCache(items: any[]) {
    this.absCache = items;
  }

  public getAbsCache(): any[] {
    return this.absCache;
  }

  public async organizeBook(book: Book): Promise<OrganizationAction> {
    try {
      const targetPath = await this.generateTargetPath(book);
      const { type: actionType, detail, absItemId } = await this.determineActionType(book, targetPath);
      const reason = this.generateActionReason(book, actionType, targetPath, detail);

      return {
        book,
        action_type: actionType,
        source_path: book.source_path,
        target_path: targetPath,
        reason,
        duplicate_abs_item_id: absItemId,
        executed: false,
        success: false,
      };
    } catch (e: any) {
      return {
        book,
        action_type: "error",
        source_path: book.source_path,
        target_path: book.source_path,
        reason: `Error organizing book: ${e.message}`,
        error_message: e.message,
        executed: false,
        success: false,
      };
    }
  }

  public async generateTargetPath(book: Book): Promise<string> {
    const sysSettings = SettingsStore.getInstance().getSettings();
    const libraryPath = sysSettings.libraryDir || "/library";
    const author = this.cleanDirectoryName(book.authors[0]);

    // Check if we should use series structure
    // (Assuming true for now, in a full config we might add prefer_series_structure)
    const useSeriesStructure = book.is_series && book.series && book.series_number !== null && book.series_number !== undefined;

    let targetPath = "";
    if (useSeriesStructure) {
      const seriesName = this.cleanDirectoryName(book.series as string);
      const bookFolder = this.generateSeriesBookFolderName(book);
      targetPath = path.join(libraryPath, author, seriesName, bookFolder);
    } else {
      const titleFolder = this.generateStandaloneFolderName(book);
      targetPath = path.join(libraryPath, author, titleFolder);
    }

    // If the source is a single file, ensure we preserve its extension
    try {
      if (book.source_path) {
        try {
          const stats = await fs.promises.stat(book.source_path);
          if (stats.isFile()) {
            const ext = path.extname(book.source_path);
            if (ext && !targetPath.endsWith(ext)) {
              targetPath += ext;
            }
          }
        } catch (accessErr) {
          // File doesn't exist or no access, ignore
        }
      }
    } catch (e) {
      // Ignore stat errors and fall back to whatever was generated
    }

    return targetPath;
  }

  private generateSeriesBookFolderName(book: Book): string {
    const title = this.cleanDirectoryName(book.title);
    // Format series number (remove .0)
    let bookNumber = String(book.series_number);
    if (bookNumber.endsWith(".0")) {
      bookNumber = bookNumber.slice(0, -2);
    }

    let folderName = `${bookNumber} - ${title}`;

    // Note: Assuming year/narrator inclusions are false for now unless added to Config
    // If they are added later:
    // if (this.config.include_year_in_titles && book.published_year) ...

    return folderName;
  }

  private generateStandaloneFolderName(book: Book): string {
    let title = this.cleanDirectoryName(book.title);
    return title;
  }

  public cleanDirectoryName(name: string): string {
    if (!name) return "Unknown";

    let cleaned = name;
    
    // Replacements
    for (const [invalidChar, replacement] of Object.entries(AudiobookOrganizer.CHAR_REPLACEMENTS)) {
      cleaned = cleaned.split(invalidChar).join(replacement);
    }

    // Remaining invalid characters removal
    for (const char of AudiobookOrganizer.INVALID_CHARS) {
      cleaned = cleaned.split(char).join("");
    }

    // Whitespace and formatting
    cleaned = cleaned.replace(/\s+/g, " ");
    cleaned = cleaned.trim();
    
    // Remove trailing punctuation (.-_)
    cleaned = cleaned.replace(/^[.\-_]+|[.\-_]+$/g, '');

    if (!cleaned) return "Unknown";

    if (cleaned.length > 200) {
      cleaned = cleaned.substring(0, 200).trim();
    }

    return cleaned;
  }

  public calculateSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
    const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    if (s1 === s2) return 1;
    if (s1.length === 0 || s2.length === 0) return 0;
    
    // Levenshtein
    const matrix = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));
    for (let i = 0; i <= s1.length; i += 1) { matrix[0][i] = i; }
    for (let j = 0; j <= s2.length; j += 1) { matrix[j][0] = j; }
    for (let j = 1; j <= s2.length; j += 1) {
      for (let i = 1; i <= s1.length; i += 1) {
        const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1, // deletion
          matrix[j - 1][i] + 1, // insertion
          matrix[j - 1][i - 1] + indicator // substitution
        );
      }
    }
    const distance = matrix[s2.length][s1.length];
    const maxLen = Math.max(s1.length, s2.length);
    return (maxLen - distance) / maxLen;
  }

  private async determineActionType(book: Book, targetPath: string): Promise<{ type: ActionType, detail?: string, absItemId?: string }> {
    const sourceResolved = path.resolve(book.source_path);
    const targetResolved = path.resolve(targetPath);

    if (sourceResolved === targetResolved) {
      return { type: "skip" };
    }

    // Check ABS Cache FIRST
    for (const item of this.absCache) {
      const title = item.media?.metadata?.title || "";
      const author = item.media?.metadata?.authorName || "";
      
      const titleSim = this.calculateSimilarity(book.title, title);
      const authorSim = this.calculateSimilarity(book.authors[0] || "", author);
      
      if (titleSim > 0.85 && authorSim > 0.85) {
        return { type: "duplicate", detail: title, absItemId: item.id };
      }
    }

    let targetExists = false;
    try {
      await fs.promises.access(targetResolved);
      targetExists = true;
    } catch { }

    if (targetExists && sourceResolved !== targetResolved) {
      return { type: "duplicate", detail: path.basename(targetResolved) };
    }
    
    // Fuzzy Duplicate Detection Logic
    const targetParent = path.dirname(targetResolved);
    let parentExists = false;
    try {
      await fs.promises.access(targetParent);
      parentExists = true;
    } catch { }

    if (parentExists) {
      try {
        const entries = await fs.promises.readdir(targetParent, { withFileTypes: true });
        const existingFolders = entries
          .filter(dirent => dirent.isDirectory())
          .map(dirent => dirent.name);
          
        for (const existingFolder of existingFolders) {
          // If the book is part of a series, checking if the folder name matches strictly is safer
          if (book.is_series && book.series && book.series_number) {
            let sn = String(book.series_number);
            if (sn.endsWith(".0")) sn = sn.slice(0, -2);
            // Must contain both the series name and the series number
            if (existingFolder.toLowerCase().includes(book.series.toLowerCase()) && 
                existingFolder.includes(sn)) {
              return { type: "duplicate", detail: existingFolder };
            }
          }
          
          // Fuzzy check the title
          const similarity = this.calculateSimilarity(book.title, existingFolder);
          if (similarity > 0.85) { // bumped to 0.85 to avoid false positives
            return { type: "duplicate", detail: existingFolder };
          }
        }
      } catch (e) {
        // Ignore read errors
      }
    }

    if (path.dirname(sourceResolved) === path.dirname(targetResolved)) {
      return { type: "rename" };
    }

    return { type: "move" };
  }

  private generateActionReason(book: Book, actionType: ActionType, targetPath: string, detail?: string): string {
    if (actionType === "skip") return "Book is already properly organized";
    if (actionType === "error") return `Conflict or error at target: ${path.basename(targetPath)}`;
    if (actionType === "rename") return `Rename to follow AudioBookShelf naming convention: ${path.basename(targetPath)}`;
    if (actionType === "duplicate") return `Duplicate detected: a similar copy exists as '${detail || 'Unknown'}' in the target directory (view here)`;
    
    if (actionType === "move") {
      const parts = [];
      if (book.is_series) {
        parts.push(`Organize into series structure: ${book.authors[0]}/${book.series}`);
        if (book.series_number) {
          let sn = String(book.series_number);
          if (sn.endsWith(".0")) sn = sn.slice(0, -2);
          const cleanTitle = this.cleanDirectoryName(book.title);
          parts.push(`Apply series naming: ${sn} - ${cleanTitle}`);
        }
      } else {
        parts.push(`Organize into author structure: ${book.authors[0]}`);
      }
      return parts.join(" | ");
    }
    
    return `Perform ${actionType} operation`;
  }

  private async cleanupEmptyDirs(currentDir: string, baseDir: string): Promise<void> {
    const resolvedCurrent = path.resolve(currentDir);
    const resolvedBase = path.resolve(baseDir);
    if (!resolvedCurrent.startsWith(resolvedBase) || resolvedCurrent === resolvedBase) {
      return;
    }
    
    try {
      const files = await fs.promises.readdir(resolvedCurrent);
      if (files.length === 0) {
        await fs.promises.rmdir(resolvedCurrent);
        await this.cleanupEmptyDirs(path.dirname(resolvedCurrent), resolvedBase);
      }
    } catch (e) {
      // Ignore errors (e.g. dir doesn't exist, permission denied, etc)
    }
  }

  public async executeAction(action: OrganizationAction): Promise<void> {
    if (action.executed) return;
    
    if (action.action_type === "skip" || action.action_type === "error" || action.action_type === "duplicate") {
      action.executed = true;
      action.success = action.action_type === "skip" || action.action_type === "duplicate";
      return;
    }

    try {
      // Ensure target directory's parent exists
      const targetParent = path.dirname(action.target_path);
      await fs.promises.mkdir(targetParent, { recursive: true });

      try {
        await fs.promises.rename(action.source_path, action.target_path);
      } catch (err: any) {
        if (err.code === 'EXDEV') {
          // Cross-device link error, use copy and remove instead
          await fs.promises.cp(action.source_path, action.target_path, { recursive: true });
          await fs.promises.rm(action.source_path, { recursive: true, force: true });
        } else {
          throw err;
        }
      }

      // Cleanup empty source directories in the inbox
      const sysSettings = SettingsStore.getInstance().getSettings();
      const baseInbox = sysSettings.inboxDir || "/inbox";
      await this.cleanupEmptyDirs(path.dirname(action.source_path), baseInbox);

      action.executed = true;
      action.success = true;
      action.execution_time = new Date().toISOString();
    } catch (e: any) {
      action.executed = true;
      action.success = false;
      action.error_message = e.message;
      throw e;
    }
  }
}
