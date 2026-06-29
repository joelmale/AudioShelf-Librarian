import fs from "fs";
import path from "path";
import { parseFile } from "music-metadata";
import type { Book, Config, MetadataSource } from "@audioshelf/shared";
import { AudiobookOrganizer } from "./organizer.js";

export class MetadataScanner {
  private config: Config;
  private organizer: AudiobookOrganizer;

  private static readonly AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.m4b', '.flac', '.ogg', '.opus', '.wav', '.aac']);
  private static readonly IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']);
  
  private static readonly PATTERNS = {
    book_number: /\b(?:book|bk|vol|volume)\.?\s*(\d+(?:\.\d+)?)\b/i,
    series_with_number: /^(.+?)\s*[#\-]\s*(\d+(?:\.\d+)?)(?:\s|$)/i,
    year: /\((\d{4})\)/,
    narrator: /\{([^}]+)\}/,
    author_title: /^([^-]+?)\s*-\s*(.+)$/
  };

  constructor(config: Config) {
    this.config = config;
    this.organizer = new AudiobookOrganizer(config);
  }

  public async scanDirectory(dirPath: string): Promise<Book> {
    const audioFiles = await this.findAudioFiles(dirPath);
    const coverFile = await this.findCoverImage(dirPath);
    
    let book: Book = {
      title: "Unknown Title",
      authors: [],
      source_path: dirPath,
      audio_files: audioFiles,
      cover_file: coverFile || null,
      metadata_source: "filename",
      confidence_score: 0,
      is_series: false,
      needs_processing: true
    };

    const priorities: MetadataSource[] = ["abs_json", "id3_tags", "filename"];

    for (const source of priorities) {
      try {
        let metadata = null;
        if (source === "abs_json") metadata = await this.scanFromAbsJson(dirPath);
        else if (source === "id3_tags") metadata = await this.scanFromId3Tags(audioFiles);
        else if (source === "filename") metadata = this.scanFromPath(dirPath);

        if (metadata) {
          book = this.mergeMetadata(book, metadata, source);
        }
      } catch (e) {
        // Log and continue
        console.warn(`Failed to scan from ${source} for ${dirPath}`, e);
      }
    }

    return this.postProcessBook(book);
  }

  private async findAudioFiles(dirPath: string): Promise<string[]> {
    const files: string[] = [];
    const walk = async (currentDir: string) => {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && MetadataScanner.AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          files.push(fullPath);
        }
      }
    };
    await walk(dirPath);
    
    // Natural sort
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    files.sort((a, b) => collator.compare(path.basename(a), path.basename(b)));
    
    return files;
  }

  private async findCoverImage(dirPath: string): Promise<string | null> {
    const coverNames = ['cover', 'folder', 'front', 'album', 'artwork'];
    for (const name of coverNames) {
      for (const ext of MetadataScanner.IMAGE_EXTENSIONS) {
        const coverPath = path.join(dirPath, `${name}${ext}`);
        if (fs.existsSync(coverPath)) return coverPath;
      }
    }
    // Fallback any image
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && MetadataScanner.IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        return path.join(dirPath, entry.name);
      }
    }
    return null;
  }

  private async scanFromAbsJson(dirPath: string): Promise<Partial<Book> | null> {
    const jsonPath = path.join(dirPath, 'metadata.json');
    if (!fs.existsSync(jsonPath)) return null;

    try {
      const data = JSON.parse(await fs.promises.readFile(jsonPath, 'utf-8'));
      
      let authors: string[] = [];
      if (Array.isArray(data.authors)) {
        authors = data.authors.map((a: any) => typeof a === 'string' ? a : a.name).filter(Boolean);
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
      
      let title = common.album || common.title || "Unknown Title";

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
      let totalDuration = 0;
      for (const f of audioFiles) {
        try {
          const m = await parseFile(f);
          if (m.format.duration) totalDuration += m.format.duration;
        } catch {}
      }
      if (totalDuration > 0) res.duration = totalDuration;

      return res;
    } catch (e) {
      return null;
    }
  }

  private scanFromPath(dirPath: string): Partial<Book> | null {
    const dirName = path.basename(dirPath);
    const parentName = path.basename(path.dirname(dirPath));

    let title = dirName;
    const res: Partial<Book> & { confidence_score: number } = {
      confidence_score: 0.3
    };

    const authorTitleMatch = MetadataScanner.PATTERNS.author_title.exec(title);
    if (authorTitleMatch) {
      res.authors = [authorTitleMatch[1].trim()];
      title = authorTitleMatch[2].trim();
    } else if (parentName && !['audiobooks', 'books'].includes(parentName.toLowerCase())) {
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
    const seriesWithNumberRegex = /^\[?(.+?)\s*[#\-]\s*(\d+(?:\.\d+)?)(?:\]|\s|$|-|:)/i;
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

  private mergeMetadata(book: Book, metadata: any, source: MetadataSource): Book {
    const newConf = metadata.confidence_score || 0;
    const currConf = book.confidence_score;

    const shouldUpdate = (fieldValue: any) => {
      return (newConf > currConf) || (!fieldValue) || (fieldValue === 'Unknown Title') || (Array.isArray(fieldValue) && fieldValue[0] === 'Unknown Author');
    };

    if (metadata.title && shouldUpdate(book.title)) book.title = metadata.title;
    if (metadata.authors?.length > 0 && shouldUpdate(book.authors)) book.authors = metadata.authors;
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
        // @ts-ignore
        book[f] = metadata[f];
      }
    }

    if (newConf > currConf) {
      book.metadata_source = source;
      book.confidence_score = newConf;
    }

    return book;
  }

  private postProcessBook(book: Book): Book {
    if (!book.authors || book.authors.length === 0) {
      book.authors = ["Unknown Author"];
    }

    if (book.title) {
      book.title = this.cleanTitle(book.title);
    }

    book.is_series = !!(book.series && book.series_number);
    
    const target = this.organizer.generateTargetPath(book);
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

  private parseYear(val: any): number | null {
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
