import fs from "fs";
import path from "path";
import pLimit from "p-limit";
import { parseFile } from "music-metadata";
import type { Book, Config, MetadataSource } from "@audioshelf/shared";
import { errorCode, readNumber } from "@audioshelf/shared";
import { AudiobookOrganizer } from "./organizer.js";

/**
 * Caps concurrent directory traversal. The recursive walk fans out over every
 * subdirectory at once; on a library with thousands of author folders that
 * exhausts the process file-descriptor limit (EMFILE) before it finishes.
 */
const walkLimit = pLimit(16);

/**
 * Extensions that make a folder worth importing.
 *
 * Exported so nothing grows a SECOND opinion about what "has audio in it"
 * means. `acquisitionReconciler.ts` uses this to decide whether an inbox
 * folder still holds anything importable; if the two lists drifted, a folder
 * could be treated as media-bearing by one and as an empty leftover by the
 * other.
 */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3', '.m4a', '.m4b', '.flac', '.ogg', '.opus', '.wav', '.aac',
]);

const PART_FOLDER_PREFIXES = ['cd', 'disc', 'disk', 'part', 'pt'];
const LOOSE_PART_SUFFIXES = [...PART_FOLDER_PREFIXES, 'book', 'bk', 'vol', 'volume'];
const LOOSE_PARTS_WARNING = 'Place each book and all of its parts in a dedicated book folder before importing.';

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isPartFolder(name: string): boolean {
  const lowerName = name.toLowerCase();
  const prefix = PART_FOLDER_PREFIXES.find(value => lowerName.startsWith(value));
  if (!prefix) return false;
  let number = name.slice(prefix.length).trimStart();
  if (number.startsWith('-') || number.startsWith('_')) number = number.slice(1).trimStart();
  return isDigit(number.charCodeAt(0));
}

function withoutNumberSuffix(value: string): string | undefined {
  const text = value.trimEnd();
  let end = text.length;
  while (end > 0 && isDigit(text.charCodeAt(end - 1))) end--;
  if (end === text.length) return undefined;
  return text.slice(0, end).trimEnd();
}

function looseGroupName(filename: string): string {
  const stem = path.basename(filename, path.extname(filename)).toLowerCase();
  // Tracks named "01" or "02 - Chapter" can belong to the same book
  // even when their names have no shared title prefix.
  if (/^\d{1,3}$|^\d{1,3}\s*[-._]\s*\S|^0\d{1,2}\s+\S/.test(stem)) return '';
  const numberedStem = withoutNumberSuffix(stem);
  if (numberedStem === undefined) return stem.trim() || stem;
  const group = numberedStem.endsWith('of') ? withoutNumberSuffix(numberedStem.slice(0, -2)) ?? numberedStem : numberedStem;
  const marker = LOOSE_PART_SUFFIXES.find(value => group.endsWith(value));
  let title = marker ? group.slice(0, -marker.length).trimEnd() : group;
  if (title.endsWith('-') || title.endsWith('_')) title = title.slice(0, -1);
  return title.trim() || stem;
}

function directoryIdentity(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino].join(':');
}

export class MetadataScanner {
  private config: Config;
  private organizer: AudiobookOrganizer;

  private static readonly IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']);
  
  private static readonly PATTERNS = {
    book_number: /\b(?:book|bk|vol|volume)\.?\s*(\d+(?:\.\d+)?)\b/i,
    series_with_number: /^(.+?)\s*[#-]\s*(\d+(?:\.\d+)?)(?:\s|$)/i,
    year: /\((\d{4})\)/,
    narrator: /\{([^}]+)\}/,
    author_title: /^([^-]+?)\s*-\s*(.+)$/
  };

  constructor(config: Config) {
    this.config = config;
    this.organizer = new AudiobookOrganizer(config);
  }

  public getOrganizer(): AudiobookOrganizer {
    return this.organizer;
  }

  public async discoverTargets(
    dir: string,
    onWarning?: (msg: string, files: string[]) => void,
    onProgress?: (currentDir: string) => void,
    collectionRoots: readonly string[] = [dir],
  ): Promise<string[]> {
    const paths: string[] = [];
    // Compare filesystem identities so another alias of the same configured
    // root (such as a second bind mount) cannot become a book directory.
    const roots = collectionRoots.map(root => path.resolve(root));
    const rootIds = new Set(await Promise.all(roots.map(async root => {
      try {
        return directoryIdentity(await fs.promises.stat(root, { bigint: true }));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        return null;
      }
    })));
    const isCollectionDir = (directory: string, stat: fs.BigIntStats) => (
      roots.some(root => path.relative(root, directory) === '') || rootIds.has(directoryIdentity(stat))
    );

    const walk = async (currentDir: string) => {
      onProgress?.(currentDir);
      const { entries, isCollectionRoot } = await walkLimit(async () => {
        const stat = await fs.promises.stat(currentDir, { bigint: true });
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        return { entries, isCollectionRoot: isCollectionDir(currentDir, stat) };
      });
      if (!isCollectionRoot && currentDir === dir && isPartFolder(path.basename(dir))) {
        const parent = path.dirname(dir);
        if (isCollectionDir(parent, await fs.promises.stat(parent, { bigint: true }))) {
          onWarning?.(LOOSE_PARTS_WARNING, [dir]);
          return;
        }
      }
      const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('@'));
      const audioFiles = entries.filter(e => e.isFile() && !e.name.startsWith('.') && AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase()));
      const partDirs = dirs.filter(d => isPartFolder(d.name));

      if (!isCollectionRoot && dirs.length === partDirs.length && (audioFiles.length > 0 || partDirs.length > 0)) {
        paths.push(currentDir);
        return;
      }

      const groups = new Map<string, string[]>();
      for (const { name } of audioFiles) {
        const key = looseGroupName(name);
        const file = path.join(currentDir, name);
        const group = groups.get(key);
        if (group) group.push(file);
        else groups.set(key, [file]);
      }

      for (const group of groups.values()) {
        // An action moves one source path. Using the group's parent would also
        // move unrelated files and books in that directory.
        if (group.length > 1) onWarning?.(LOOSE_PARTS_WARNING, group);
        else paths.push(group[0]);
      }

      if (partDirs.length > 0) {
        onWarning?.(LOOSE_PARTS_WARNING, partDirs.map(d => path.join(currentDir, d.name)));
      }
      await Promise.all(dirs.filter(d => !isPartFolder(d.name)).map(d => walk(path.join(currentDir, d.name))));
    };

    await walk(dir);
    return paths;
  }

  public async scanTarget(targetPath: string | string[], options: { inboxEntry?: boolean } = {}): Promise<Book> {
    if (Array.isArray(targetPath)) throw new Error(LOOSE_PARTS_WARNING);
    const stat = await fs.promises.stat(targetPath);
    const isFile = stat.isFile();
    const siblings = isFile ? await fs.promises.readdir(path.dirname(targetPath), { withFileTypes: true }) : [];
    if (options.inboxEntry) {
      const name = path.basename(targetPath);
      if (stat.isDirectory() && isPartFolder(name)) throw new Error(LOOSE_PARTS_WARNING);
      if (isFile && AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())) {
        const groupName = looseGroupName(name);
        if (siblings.some(sibling => sibling.name !== name && !sibling.name.startsWith('.') && sibling.isFile()
          && AUDIO_EXTENSIONS.has(path.extname(sibling.name).toLowerCase())
          && looseGroupName(sibling.name) === groupName)) {
          throw new Error(LOOSE_PARTS_WARNING);
        }
      }
    }
    const audioFiles = await this.findAudioFiles(targetPath, isFile);
    if (options.inboxEntry && stat.isDirectory()) {
      // Numbered disc directories belong to their enclosing book. Audio in
      // separate ordinary subdirectories can represent entirely different books.
      const audioFolders = new Set(audioFiles.map(file => path.relative(targetPath, file).split(path.sep)
        .slice(0, -1).filter(directory => !isPartFolder(directory)).join(path.sep)));
      if (audioFolders.size > 1) throw new Error(LOOSE_PARTS_WARNING);
    }
    const coverFile = await this.findCoverImage(targetPath, isFile ? siblings : undefined);

    let book: Book = {
      title: "Unknown Title",
      authors: [],
      source_path: targetPath,
      audio_files: audioFiles,
      cover_file: coverFile || null,
      metadata_source: "filename",
      confidence_score: 0,
      is_series: false,
      needs_processing: true
    };

    const priorities: MetadataSource[] = isFile ? ["id3_tags", "filename"] : ["abs_json", "id3_tags", "filename"];

    for (const source of priorities) {
      try {
        let metadata = null;
        if (source === "abs_json") metadata = await this.scanFromAbsJson(targetPath);
        else if (source === "id3_tags") metadata = await this.scanFromId3Tags(audioFiles);
        else if (source === "filename") metadata = this.scanFromPath(targetPath, isFile);

        if (metadata) {
          book = this.mergeMetadata(book, metadata, source);
        }
      } catch (e: unknown) {
        // Log and continue
        const errStr = e instanceof Error ? e.message : String(e);
        console.warn(`Failed to scan from ${source} for ${targetPath}`, errStr);
      }
    }

    return this.postProcessBook(book);
  }

  private async findAudioFiles(targetPath: string, isFile: boolean): Promise<string[]> {
    if (isFile) return AUDIO_EXTENSIONS.has(path.extname(targetPath).toLowerCase()) ? [targetPath] : [];

    const files: string[] = [];
    const walk = async (currentDir: string) => {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          files.push(fullPath);
        }
      }
    };
    await walk(targetPath);
    
    // Natural sort
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    files.sort((a, b) => collator.compare(path.basename(a), path.basename(b)));
    
    return files;
  }

  private async findCoverImage(targetPath: string, siblings?: fs.Dirent[]): Promise<string | null> {
    if (siblings) {
      // A loose book only owns a cover named after its own audio file.
      const directory = path.dirname(targetPath);
      const stem = path.basename(targetPath, path.extname(targetPath));
      for (const ext of MetadataScanner.IMAGE_EXTENSIONS) {
        const cover = siblings.find(entry => {
          const entryExtension = path.extname(entry.name);
          return entry.isFile() && entryExtension.toLowerCase() === ext && path.basename(entry.name, entryExtension) === stem;
        });
        if (cover) return path.join(directory, cover.name);
      }
      return null;
    }

    try {
      const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
      const images = entries.filter(entry => entry.isFile() && MetadataScanner.IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
      const coverNames = ['cover', 'folder', 'front', 'album', 'artwork'];
      for (const name of coverNames) {
        for (const ext of MetadataScanner.IMAGE_EXTENSIONS) {
          const cover = images.find(entry => entry.name === name + ext);
          if (cover) return path.join(targetPath, cover.name);
        }
      }
      if (images[0]) return path.join(targetPath, images[0].name);
    } catch {
      // Ignore
    }
    return null;
  }

  private async scanFromAbsJson(targetPath: string): Promise<Partial<Book> | null> {
    try {
      const metadataPath = path.join(targetPath, 'metadata.json');
      const noFollow = fs.constants.O_NOFOLLOW;
      // Where the OS lacks no-follow opens, skip known links at discovery
      // and compare the opened file to the path before reading the handle.
      if (noFollow === undefined) {
        const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
        if (!entries.some(entry => entry.name.toLowerCase() === 'metadata.json' && entry.isFile())) return null;
      }
      const flags = fs.constants.O_RDONLY | (noFollow ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
      const sidecar = await fs.promises.open(metadataPath, flags);
      let data;
      try {
        const opened = await sidecar.stat({ bigint: true });
        if (!opened.isFile()) return null;
        if (noFollow === undefined) {
          const named = await fs.promises.lstat(metadataPath, { bigint: true });
          if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) return null;
        }
        data = JSON.parse(await sidecar.readFile('utf-8'));
      } finally {
        await sidecar.close();
      }

      let authors: string[] = [];
      if (Array.isArray(data.authors)) {
        authors = data.authors.map((a: unknown) => {
          if (typeof a === 'string') return a;
          if (a && typeof a === 'object' && 'name' in a) return String((a as { name: string }).name);
          return null;
        }).filter(Boolean) as string[];
      }

      const res: Partial<Book> & { confidence_score: number } = {
        title: (data.title || '').replace(/_/g, ' '),
        authors,
        narrator: data.narrator,
        publisher: data.publisher,
        published_year: this.parseYear(data.publishYear),
        isbn: data.isbn,
        language: data.language,
        genre: data.genre,
        description: data.description,
        confidence_score: 1.0
      };

      if (data.series && data.series.length > 0) {
        const s = data.series[0];
        res.series = typeof s === 'string' ? s : s.name;
        res.series_number = typeof s === 'object' ? s.sequence : null;
      }

      return res;
    } catch {
      return null;
    }
  }

  private async scanFromId3Tags(audioFiles: string[]): Promise<Partial<Book> | null> {
    if (audioFiles.length === 0) return null;
    
    try {
      const metadata = await parseFile(audioFiles[0]);
      const common = metadata.common;
      
      const title = common.album || common.title || "Unknown Title";

      const res: Partial<Book> & { confidence_score: number } = {
        title,
        authors: common.artist ? common.artist.split(/[,;&]| and /i).map(s => s.trim()) : [],
        narrator: common.composer ? common.composer.join(', ') : undefined,
        genre: common.genre ? common.genre.join(', ') : undefined,
        published_year: this.parseYear(common.year || common.date),
        confidence_score: 0.8
      };

      // Series extraction from the resolved title (which is usually the album)
      const parsedSeries = this.parseSeriesFromText(title);
      if (parsedSeries) {
        res.series = parsedSeries.series;
        res.series_number = parsedSeries.series_number;
        if (parsedSeries.remainingText) {
          res.title = parsedSeries.remainingText;
        }
      }

      // Compute total duration by picking duration from the metadata
      const parsePromises = audioFiles.map(f => parseFile(f).catch(() => null));
      const metadatas = await Promise.all(parsePromises);
      const totalDuration = metadatas.reduce((sum, m) => sum + (m?.format?.duration || 0), 0);

      if (totalDuration > 0) res.duration = totalDuration;

      return res;
    } catch (e: unknown) {
      return null;
    }
  }

  private scanFromPath(targetPath: string, isFile = false): Partial<Book> | null {
    const parentName = path.basename(path.dirname(targetPath));
    let title = path.basename(targetPath, isFile ? path.extname(targetPath) : undefined);
    const res: Partial<Book> & { confidence_score: number } = {
      confidence_score: 0.3
    };

    const authorTitleMatch = MetadataScanner.PATTERNS.author_title.exec(title);
    if (authorTitleMatch) {
      res.authors = [authorTitleMatch[1].trim()];
      title = authorTitleMatch[2].trim();
    } else if (!isFile && parentName && !['audiobooks', 'books'].includes(parentName.toLowerCase())) {
      if (!/\d/.test(parentName)) { 
        res.authors = [parentName];
      }
    }

    const yearMatch = MetadataScanner.PATTERNS.year.exec(title);
    if (yearMatch) {
      res.published_year = parseInt(yearMatch[1], 10);
      title = title.replace(MetadataScanner.PATTERNS.year, '');
    }

    const narratorMatch = MetadataScanner.PATTERNS.narrator.exec(title);
    if (narratorMatch) {
      res.narrator = narratorMatch[1].trim();
      title = title.replace(MetadataScanner.PATTERNS.narrator, '');
    }

    const seriesInfo = this.parseSeriesFromText(title);
    if (seriesInfo) {
      res.series = seriesInfo.series;
      res.series_number = seriesInfo.series_number;
      title = seriesInfo.remainingText;
    }

    res.title = this.cleanTitle(title);
    return res;
  }

  private parseSeriesFromText(text: string): { series: string, series_number: number, remainingText: string } | null {
    // We can use a local regex that is more forgiving of trailing characters like ] or -
    const seriesWithNumberRegex = /^\[?(.+?)\s*[#-]\s*(\d+(?:\.\d+)?)(?:\]|\s|$|-|:)/i;
    const hashMatch = seriesWithNumberRegex.exec(text);
    if (hashMatch) {
      return { 
        series: hashMatch[1].trim(), 
        series_number: parseFloat(hashMatch[2]),
        remainingText: text.replace(seriesWithNumberRegex, '').trim()
      };
    }

    const bookMatch = MetadataScanner.PATTERNS.book_number.exec(text);
    if (bookMatch) {
      const series = text.replace(MetadataScanner.PATTERNS.book_number, '').trim();
      if (series) {
        return { 
          series, 
          series_number: parseFloat(bookMatch[1]),
          remainingText: series // if we stripped book number, what's left is the series (and likely title)
        };
      }
    }
    return null;
  }

  private mergeMetadata(book: Book, metadata: Partial<Book> & Record<string, unknown>, source: MetadataSource): Book {
    const newConf = readNumber(metadata, 'confidence_score') ?? 0;
    const currConf = book.confidence_score;

    const shouldUpdate = (fieldValue: unknown) => {
      return (newConf > currConf) || (!fieldValue) || (fieldValue === 'Unknown Title') || (Array.isArray(fieldValue) && fieldValue[0] === 'Unknown Author');
    };

    if (metadata.title && shouldUpdate(book.title)) book.title = metadata.title;
    if (metadata.authors && metadata.authors.length > 0 && shouldUpdate(book.authors)) book.authors = metadata.authors;
    if (metadata.series && shouldUpdate(book.series)) {
      book.series = metadata.series;
      book.is_series = true;
    }
    if (metadata.series_number !== undefined && shouldUpdate(book.series_number)) {
      book.series_number = metadata.series_number;
      book.is_series = true;
    }

    const fields = ['narrator', 'publisher', 'published_year', 'isbn', 'language', 'genre', 'description', 'duration'] as const;
    for (const f of fields) {
      if (metadata[f] !== undefined && shouldUpdate(book[f])) {
        // @ts-expect-error TypeScript cannot correlate the two independent
        // index accesses through the union of `fields`, so it widens each side
        // to the union of all field types. The loop is sound: `f` indexes the
        // same key on both objects.
        book[f] = metadata[f];
      }
    }

    if (newConf > currConf) {
      book.metadata_source = source;
      book.confidence_score = newConf;
    }

    return book;
  }

  private async postProcessBook(book: Book): Promise<Book> {
    if (!book.authors || book.authors.length === 0) {
      book.authors = ["Unknown Author"];
    }

    if (book.title) {
      book.title = this.cleanTitle(book.title);
    }

    book.is_series = !!(book.series && book.series_number);
    
    const target = await this.organizer.generateTargetPath(book);
    book.needs_processing = path.resolve(book.source_path) !== path.resolve(target);

    return book;
  }

  private cleanTitle(title: string): string {
    if (!title) return "Unknown Title";
    let t = title.replace(/\s*\([^)]*\)\s*$/, ''); // trail parens
    t = t.replace(/\s*\{[^}]*\}\s*$/, ''); // trail braces
    t = t.replace(/\s*[-_]\s*$/, ''); // trail dash
    t = t.replace(/^[-_\s]+/, ''); // lead dash
    t = t.replace(/\s+/g, ' ');
    return t.trim() || "Unknown Title";
  }

  private parseYear(val: unknown): number | null {
    if (!val) return null;
    if (typeof val === 'number') return val;
    const m = /(\d{4})/.exec(String(val));
    if (m) {
      const y = parseInt(m[1], 10);
      if (y >= 1800 && y <= 2100) return y;
    }
    return null;
  }
}
