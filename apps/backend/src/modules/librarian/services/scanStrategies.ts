import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { ScanOrder } from "@audioshelf/shared";
export type { ScanOrder };

export interface ScanProgress {
  scan_id: string;
  total_directories: number;
  completed_directories: number;
  current_directory: string | null;
  scan_order: ScanOrder;
  start_time: number;
  last_update_time: number;
  
  books_found: number;
  directories_processed: string[];
  errors_encountered: string[];
  
  resume_point: string | null;
  remaining_directories: string[];
}

export class ScanStrategy {
  private progressFile: string;

  constructor(progressFile?: string) {
    this.progressFile = progressFile || path.resolve(process.cwd(), ".audioshelf_scan_progress.json");
  }

  public async orderDirectories(
    directories: (string | string[])[], 
    scanOrder: ScanOrder,
    resumeFrom: string | null = null
  ): Promise<(string | string[])[]> {
    let validDirs: (string | string[])[] = [];
    
    // Filter out invalid directories or files
    for (const d of directories) {
      try {
        if (Array.isArray(d)) {
          if (d.length > 0) validDirs.push(d);
        } else {
          const stat = await fs.promises.stat(d);
          if (stat.isDirectory() || stat.isFile()) validDirs.push(d);
        }
      } catch {
        // Skip
      }
    }

    let ordered: (string | string[])[] = [];

    const getName = (item: string | string[]) => {
      if (Array.isArray(item)) return path.basename(item[0]);
      return path.basename(item);
    };

    switch (scanOrder) {
      case "alphabetical":
        ordered = [...validDirs].sort((a, b) => getName(a).toLowerCase().localeCompare(getName(b).toLowerCase()));
        break;
      case "reverse":
        ordered = [...validDirs].sort((a, b) => getName(b).toLowerCase().localeCompare(getName(a).toLowerCase()));
        break;
      case "random":
        ordered = [...validDirs].sort(() => Math.random() - 0.5);
        break;
      case "quarters":
        ordered = this.splitIntoParts(validDirs, 4);
        break;
      case "eighths":
        ordered = this.splitIntoParts(validDirs, 8);
        break;
      case "size-asc":
      case "size-desc":
        ordered = await this.orderBySize(validDirs, scanOrder === "size-asc");
        break;
      case "recent":
      case "oldest":
        ordered = await this.orderByModificationTime(validDirs, scanOrder === "recent");
        break;
      default:
        ordered = [...validDirs].sort((a, b) => getName(a).toLowerCase().localeCompare(getName(b).toLowerCase()));
    }

    if (resumeFrom) {
      const idx = ordered.findIndex(d => getName(d).toLowerCase().includes(resumeFrom.toLowerCase()));
      if (idx !== -1) {
        ordered = ordered.slice(idx);
      }
    }

    return ordered;
  }

  private splitIntoParts(directories: (string | string[])[], parts: number): (string | string[])[] {
    if (directories.length === 0) return [];
    
    const getName = (item: string | string[]) => {
      if (Array.isArray(item)) return path.basename(item[0]);
      return path.basename(item);
    };
    const sorted = [...directories].sort((a, b) => getName(a).toLowerCase().localeCompare(getName(b).toLowerCase()));
    
    const partSize = Math.floor(sorted.length / parts);
    const remainder = sorted.length % parts;
    const firstPartSize = partSize + (remainder > 0 ? 1 : 0);
    
    return sorted.slice(0, firstPartSize);
  }

  private async orderBySize(directories: (string | string[])[], ascending: boolean): Promise<(string | string[])[]> {
    const getDirSize = async (dir: string): Promise<number> => {
      let size = 0;
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile()) {
            const st = await fs.promises.stat(path.join(dir, e.name));
            size += st.size;
          } else if (e.isDirectory()) {
            size += await getDirSize(path.join(dir, e.name));
          }
        }
      } catch {
        return 0;
      }
      return size;
    };

    const withSizes = await Promise.all(directories.map(async d => {
      let size = 0;
      if (Array.isArray(d)) {
        for (const f of d) {
          try {
            const st = await fs.promises.stat(f);
            size += st.size;
          } catch {}
        }
      } else {
        size = await getDirSize(d);
      }
      return { d, size };
    }));
    withSizes.sort((a, b) => ascending ? a.size - b.size : b.size - a.size);
    return withSizes.map(x => x.d);
  }

  private async orderByModificationTime(directories: (string | string[])[], recentFirst: boolean): Promise<(string | string[])[]> {
    const withTimes = await Promise.all(directories.map(async d => {
      try {
        const item = Array.isArray(d) ? d[0] : d;
        const stat = await fs.promises.stat(item);
        return { d, mtime: stat.mtimeMs };
      } catch {
        return { d, mtime: 0 };
      }
    }));
    withTimes.sort((a, b) => recentFirst ? b.mtime - a.mtime : a.mtime - b.mtime);
    return withTimes.map(x => x.d);
  }

  public async saveProgress(progress: ScanProgress): Promise<boolean> {
    try {
      await fs.promises.writeFile(this.progressFile, JSON.stringify(progress, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  public async loadProgress(scanId?: string): Promise<ScanProgress | null> {
    try {
      if (!fs.existsSync(this.progressFile)) return null;
      const data = JSON.parse(await fs.promises.readFile(this.progressFile, 'utf-8')) as ScanProgress;
      if (scanId && data.scan_id !== scanId) return null;
      return data;
    } catch {
      return null;
    }
  }

  public createScanId(basePath: string, scanOrder: ScanOrder): string {
    const content = `${path.resolve(basePath)}_${scanOrder}_${Date.now()}`;
    const hash = crypto.createHash('md5').update(content).digest('hex').substring(0, 12);
    return `scan_${hash}`;
  }
}
