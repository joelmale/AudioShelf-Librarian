import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetadataScanner } from './scanner.js';
import type { Config } from '@audioshelf/shared';
import fs from 'fs';
import path from 'path';

// Mock music-metadata so we don't need real audio files
vi.mock('music-metadata', () => {
  return {
    parseFile: vi.fn().mockResolvedValue({
      common: {
        title: 'ID3 Title',
        artist: 'ID3 Artist',
        album: 'ID3 Series - 2',
        year: 2021
      },
      format: {
        duration: 3600
      }
    })
  };
});

const mockConfig: Config = {
  PORT: 3050
};

describe('MetadataScanner', () => {
  let scanner: MetadataScanner;

  beforeEach(() => {
    scanner = new MetadataScanner(mockConfig);
    vi.restoreAllMocks();
  });

  it('should parse metadata from path fallback correctly', async () => {
    // The directory name "Andy Weir - Project Hail Mary (2021) {Ray Porter}"
    // Parent dir: "SciFi"
    const dirPath = '/mock/inbox/SciFi/Andy Weir - Project Hail Mary (2021) {Ray Porter}';
    
    // We can directly test the private scanFromPath method by bypassing TS via any cast
    const metadata = (scanner as any).scanFromPath(dirPath);
    
    expect(metadata.authors).toEqual(['Andy Weir']);
    expect(metadata.title).toBe('Project Hail Mary');
    expect(metadata.published_year).toBe(2021);
    expect(metadata.narrator).toBe('Ray Porter');
    expect(metadata.confidence_score).toBe(0.3);
  });
  
  it('should extract series info from path', () => {
    const dirPath = '/mock/inbox/James SA Corey - Leviathan Wakes #1';
    const metadata = (scanner as any).scanFromPath(dirPath);
    
    expect(metadata.series).toBe('Leviathan Wakes');
    expect(metadata.series_number).toBe(1);
  });

  it('should merge metadata preferring higher confidence', () => {
    const book: any = {
      title: 'Bad Title',
      authors: ['Bad Author'],
      confidence_score: 0.3
    };

    const newMetadata = {
      title: 'Good Title',
      authors: ['Good Author'],
      confidence_score: 0.8
    };

    const merged = (scanner as any).mergeMetadata(book, newMetadata, 'id3_tags');
    expect(merged.title).toBe('Good Title');
    expect(merged.authors).toEqual(['Good Author']);
    expect(merged.confidence_score).toBe(0.8);
    expect(merged.metadata_source).toBe('id3_tags');
  });

  it('should scan completely using mocked FS', async () => {
    // Setup FS mock for abs_json
    vi.spyOn(fs.promises, 'readdir').mockResolvedValue([
      { name: 'track1.mp3', isFile: () => true, isDirectory: () => false },
      { name: 'metadata.json', isFile: () => true, isDirectory: () => false }
    ] as any);
    
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(JSON.stringify({
      title: 'ABS Title',
      authors: [{name: 'ABS Author'}],
      publishYear: 2023,
      series: [{name: 'ABS Series', sequence: 5}]
    }));

    const book = await scanner.scanTarget('/mock/inbox/Book Dir');
    
    expect(book.title).toBe('ABS Title');
    expect(book.authors).toEqual(['ABS Author']);
    expect(book.published_year).toBe(2023);
    expect(book.series).toBe('ABS Series');
    expect(book.series_number).toBe(5);
    expect(book.confidence_score).toBe(1.0);
    expect(book.metadata_source).toBe('abs_json');
  });

  describe('discoverTargets', () => {
    it('should correctly identify discrete directories and loose files', async () => {
      vi.spyOn(fs.promises, 'readdir').mockImplementation(async (dirPath) => {
        const normalized = path.normalize(dirPath.toString());
        if (normalized === path.normalize('/mock/inbox')) {
          return [
            { name: 'Book One', isFile: () => false, isDirectory: () => true },
            { name: 'Book Two', isFile: () => false, isDirectory: () => true },
            { name: 'Loose Book 1.mp3', isFile: () => true, isDirectory: () => false },
            { name: 'Loose Book 2.mp3', isFile: () => true, isDirectory: () => false },
            { name: 'Standalone Book.m4b', isFile: () => true, isDirectory: () => false }
          ] as any;
        }
        if (normalized === path.normalize('/mock/inbox/Book One')) {
          return [
            { name: 'audio.m4b', isFile: () => true, isDirectory: () => false }
          ] as any;
        }
        if (normalized === path.normalize('/mock/inbox/Book Two')) {
          return [
            { name: 'CD1', isFile: () => false, isDirectory: () => true },
            { name: 'CD2', isFile: () => false, isDirectory: () => true }
          ] as any;
        }
        if (normalized.startsWith(path.normalize('/mock/inbox/Book Two/CD'))) {
          return [
            { name: 'track.mp3', isFile: () => true, isDirectory: () => false }
          ] as any;
        }
        return [] as any;
      });

      const onWarning = vi.fn();
      const targets = await scanner.discoverTargets('/mock/inbox', onWarning);

      expect(targets).toHaveLength(4);
      
      // Should find standard book directories
      expect(targets).toContain(path.join('/mock/inbox', 'Book One'));
      expect(targets).toContain(path.join('/mock/inbox', 'Book Two'));

      // Should find standalone m4b
      expect(targets).toContain(path.join('/mock/inbox', 'Standalone Book.m4b'));

      // Should group Loose Book 1 and 2
      const looseGroup = targets.find(t => Array.isArray(t)) as string[];
      expect(looseGroup).toBeDefined();
      expect(looseGroup).toEqual([
        path.join('/mock/inbox', 'Loose Book 1.mp3'),
        path.join('/mock/inbox', 'Loose Book 2.mp3')
      ]);

      // Should call onWarning for the grouped loose files
      expect(onWarning).toHaveBeenCalledWith(
        expect.stringContaining('Grouped 2 loose files into a single book'),
        looseGroup
      );
    });
  });

  describe('scanTarget with string array', () => {
    it('should scan correctly with an array of files', async () => {
      const { parseFile } = await import('music-metadata');
      vi.mocked(parseFile).mockRejectedValue(new Error('no id3'));

      vi.spyOn(fs.promises, 'stat').mockImplementation(async (filePath) => {
        if (filePath.toString().includes('cover.jpg')) {
           return { isFile: () => true } as any;
        }
        return { isFile: () => false } as any; // mock default failure
      });

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      const files = [
        '/mock/inbox/Loose Book 1.mp3',
        '/mock/inbox/Loose Book 2.mp3'
      ];
      
      const book = await scanner.scanTarget(files);
      
      // Title should be extracted from the filename pattern and cleaned
      expect(book.title).toBe('Loose');
      expect(book.source_path).toBe('/mock/inbox');
      expect(book.audio_files).toEqual(files);
    });
  });
});
