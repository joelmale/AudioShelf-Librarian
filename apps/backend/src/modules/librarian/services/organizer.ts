import path from "path";
import fs from "fs";
import type { Book, OrganizationAction, ActionType } from "@audioshelf/shared";
import type { Config } from "@audioshelf/shared";

export class AudiobookOrganizer {
  private config: Config;

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

  public organizeBook(book: Book): OrganizationAction {
    try {
      const targetPath = this.generateTargetPath(book);
      const actionType = this.determineActionType(book.source_path, targetPath);
      const reason = this.generateActionReason(book, actionType, targetPath);

      return {
        book,
        action_type: actionType,
        source_path: book.source_path,
        target_path: targetPath,
        reason,
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

  public generateTargetPath(book: Book): string {
    const libraryPath = this.config.LIBRARY_DIR || "/library";
    const author = this.cleanDirectoryName(book.authors[0]);

    // Check if we should use series structure
    // (Assuming true for now, in a full config we might add prefer_series_structure)
    const useSeriesStructure = book.is_series && book.series && book.series_number !== null && book.series_number !== undefined;

    if (useSeriesStructure) {
      const seriesName = this.cleanDirectoryName(book.series as string);
      const bookFolder = this.generateSeriesBookFolderName(book);
      return path.join(libraryPath, author, seriesName, bookFolder);
    } else {
      const titleFolder = this.generateStandaloneFolderName(book);
      return path.join(libraryPath, author, titleFolder);
    }
  }

  private generateSeriesBookFolderName(book: Book): string {
    const seriesName = this.cleanDirectoryName(book.series as string);
    // Format series number (remove .0)
    let bookNumber = String(book.series_number);
    if (bookNumber.endsWith(".0")) {
      bookNumber = bookNumber.slice(0, -2);
    }

    let folderName = `${seriesName} - ${bookNumber}`;

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

  private determineActionType(sourcePath: string, targetPath: string): ActionType {
    const sourceResolved = path.resolve(sourcePath);
    const targetResolved = path.resolve(targetPath);

    if (sourceResolved === targetResolved) {
      return "skip";
    }

    if (fs.existsSync(targetResolved) && sourceResolved !== targetResolved) {
      // In JS, check case insensitive paths or actual conflict
      // We will just do basic exist check.
      return "error";
    }

    if (path.dirname(sourceResolved) === path.dirname(targetResolved)) {
      return "rename";
    }

    return "move";
  }

  private generateActionReason(book: Book, actionType: ActionType, targetPath: string): string {
    if (actionType === "skip") return "Book is already properly organized";
    if (actionType === "error") return `Conflict or error at target: ${path.basename(targetPath)}`;
    if (actionType === "rename") return `Rename to follow AudioBookShelf naming convention: ${path.basename(targetPath)}`;
    
    if (actionType === "move") {
      const parts = [];
      if (book.is_series) {
        parts.push(`Organize into series structure: ${book.authors[0]}/${book.series}`);
        if (book.series_number) {
          let sn = String(book.series_number);
          if (sn.endsWith(".0")) sn = sn.slice(0, -2);
          parts.push(`Apply series naming: ${book.series} - ${sn}`);
        }
      } else {
        parts.push(`Organize into author structure: ${book.authors[0]}`);
      }
      return parts.join(" | ");
    }
    
    return `Perform ${actionType} operation`;
  }

  public async executeAction(action: OrganizationAction): Promise<void> {
    if (action.executed) return;
    
    if (action.action_type === "skip" || action.action_type === "error") {
      action.executed = true;
      action.success = action.action_type === "skip";
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
