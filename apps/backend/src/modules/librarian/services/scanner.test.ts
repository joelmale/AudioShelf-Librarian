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
  ABS_URL: "http://localhost",
  ABS_TOKEN: "mock",
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

    const book = await scanner.scanDirectory('/mock/inbox/Book Dir');
    
    expect(book.title).toBe('ABS Title');
    expect(book.authors).toEqual(['ABS Author']);
    expect(book.published_year).toBe(2023);
    expect(book.series).toBe('ABS Series');
    expect(book.series_number).toBe(5);
    expect(book.confidence_score).toBe(1.0);
    expect(book.metadata_source).toBe('abs_json');
  });
});
