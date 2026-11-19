import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetadataScanner } from './scanner.js';
import type { Config } from '@audioshelf/shared';
import fs from 'fs';
import os from 'os';
import { parseFile } from 'music-metadata';
import path from 'path';

// Mock music-metadata so we don't need real audio files
vi.mock('music-metadata', () => ({ parseFile: vi.fn() }));

const mockConfig: Config = {
  PORT: 3050
};

describe('MetadataScanner', () => {
  let scanner: MetadataScanner;
  let inbox: string;
  let library: string;
  let sandbox: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(parseFile).mockReset();
    vi.mocked(parseFile).mockRejectedValue(new Error('No ID3 tags in fixture'));
    scanner = new MetadataScanner(mockConfig);
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-scanner-'));
    inbox = path.join(sandbox, 'inbox');
    library = path.join(sandbox, 'library');
    fs.mkdirSync(inbox);
    fs.mkdirSync(library);
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function writeFixture(directory: string, name: string, contents = 'synthetic fixture'): string {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    fs.writeFileSync(file, contents);
    return file;
  }

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

  it('uses metadata and the generic cover inside a dedicated multi-disc book folder', async () => {
    const directory = path.join(inbox, 'A Dedicated Book');
    const firstTrack = writeFixture(path.join(directory, 'CD1'), 'track 01.mp3');
    const secondTrack = writeFixture(path.join(directory, 'CD2'), 'track 02.mp3');
    const cover = writeFixture(directory, 'cover.jpg');
    writeFixture(directory, 'metadata.json', JSON.stringify({
      title: 'ABS Title',
      authors: [{ name: 'ABS Author' }],
      publishYear: 2023,
      series: [{ name: 'ABS Series', sequence: 5 }],
    }));

    const warning = vi.fn();
    expect(await scanner.discoverTargets(directory, warning, undefined, [inbox, library])).toEqual([directory]);
    expect(warning).not.toHaveBeenCalled();
    const book = await scanner.scanTarget(directory, { inboxEntry: true });

    expect(book).toMatchObject({
      title: 'ABS Title',
      authors: ['ABS Author'],
      published_year: 2023,
      series: 'ABS Series',
      series_number: 5,
      confidence_score: 1,
      metadata_source: 'abs_json',
      source_path: directory,
      cover_file: cover,
      audio_files: [firstTrack, secondTrack],
    });
  });

  it('discovers separate files in a flat inbox and ignores inbox-level metadata and generic artwork', async () => {
    writeFixture(inbox, 'metadata.json', JSON.stringify({ title: 'Wrong Title', authors: ['Wrong Author'] }));
    writeFixture(inbox, 'cover.png');
    const first = writeFixture(inbox, 'First Title.m4b');
    const second = writeFixture(inbox, 'Second Author - Second Title.m4b');
    const exactCover = writeFixture(inbox, 'Second Author - Second Title.JPG');
    fs.mkdirSync(path.join(inbox, 'First Title.jpg'));

    const targets = await scanner.discoverTargets(inbox, undefined, undefined, [inbox, library]);
    expect(targets).toEqual(expect.arrayContaining([first, second]));
    expect(targets).toHaveLength(2);
    await expect(scanner.scanTarget(first)).resolves.toMatchObject({
      title: 'First Title',
      authors: ['Unknown Author'],
      metadata_source: 'filename',
      audio_files: [first],
      source_path: first,
      cover_file: null,
    });
    await expect(scanner.scanTarget(second, { inboxEntry: true })).resolves.toMatchObject({
      title: 'Second Title',
      authors: ['Second Author'],
      metadata_source: 'filename',
      audio_files: [second],
      source_path: second,
      cover_file: exactCover,
    });
  });

  it('prefers embedded tags over the filename for a loose audiobook', async () => {
    const source = writeFixture(inbox, 'Filename Author - Filename Title.m4b');
    writeFixture(inbox, 'metadata.json', JSON.stringify({ title: 'Wrong Title', authors: ['Wrong Author'] }));
    vi.mocked(parseFile).mockResolvedValue({
      common: {
        title: 'Embedded Title',
        artist: 'Embedded Author',
        disk: { no: null, of: null },
        track: { no: null, of: null },
        movementIndex: { no: null, of: null },
      },
      format: { duration: 3600, tagTypes: [], trackInfo: [] },
      native: {},
      quality: { warnings: [] },
    });

    await expect(scanner.scanTarget(source, { inboxEntry: true })).resolves.toMatchObject({
      title: 'Embedded Title',
      authors: ['Embedded Author'],
      metadata_source: 'id3_tags',
      source_path: source,
    });
  });

  it('treats the configured library root as a collection of books', async () => {
    const book = writeFixture(library, 'Standalone.m4b');
    expect(await scanner.discoverTargets(library, undefined, undefined, [inbox, library])).toEqual([book]);
  });

  it('treats a directory alias of the configured inbox as a collection of books', async () => {
    const alias = path.join(sandbox, 'inbox-alias');
    fs.symlinkSync(inbox, alias, 'junction');
    writeFixture(inbox, 'Standalone.m4b');
    expect(await scanner.discoverTargets(alias, undefined, undefined, [inbox, library]))
      .toEqual([path.join(alias, 'Standalone.m4b')]);
  });

  it('fails closed when a configured collection root cannot be inspected', async () => {
    writeFixture(inbox, 'Standalone.m4b');
    const failure = Object.assign(new Error('Temporary root I/O error'), { code: 'EIO' });
    vi.spyOn(fs.promises, 'stat').mockRejectedValueOnce(failure);

    await expect(scanner.discoverTargets(inbox, undefined, undefined, [inbox, library])).rejects.toThrow(failure);
  });

  it('protects the configured path if its first stat reports it missing', async () => {
    const book = writeFixture(inbox, 'Standalone.m4b');
    fs.rmdirSync(library);
    vi.spyOn(fs.promises, 'stat').mockRejectedValueOnce(Object.assign(new Error('Missing'), { code: 'ENOENT' }));

    await expect(scanner.discoverTargets(inbox, undefined, undefined, [inbox, library])).resolves.toEqual([book]);
  });

  it('holds ambiguous loose parts in a mixed folder while discovering independent books', async () => {
    const mixed = path.join(inbox, 'Mixed');
    const first = writeFixture(mixed, 'Loose Book Part 1.mp3');
    const second = writeFixture(mixed, 'loose book part 2.mp3');
    const unrelated = writeFixture(mixed, 'Standalone.m4b');
    const directory = path.join(mixed, 'Another Book');
    writeFixture(directory, 'audio.m4b');
    const warning = vi.fn();

    const targets = await scanner.discoverTargets(inbox, warning, undefined, [inbox, library]);

    expect(targets).toHaveLength(2);
    expect(targets).toEqual(expect.arrayContaining([unrelated, directory]));
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('dedicated book folder'), expect.arrayContaining([first, second]));
    await expect(scanner.scanTarget([first, second])).rejects.toThrow('dedicated book folder');
    await expect(scanner.scanTarget(first, { inboxEntry: true })).rejects.toThrow('dedicated book folder');
    await expect(scanner.scanTarget(second, { inboxEntry: true })).rejects.toThrow('dedicated book folder');
  });

  it('holds multipart folders directly at the inbox root in both discovery and automatic intake', async () => {
    const first = path.join(inbox, 'CD1');
    const second = path.join(inbox, 'CD2');
    writeFixture(first, 'Track 01.mp3');
    writeFixture(second, 'Track 02.mp3');
    const warning = vi.fn();

    expect(await scanner.discoverTargets(inbox, warning, undefined, [inbox, library])).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('dedicated book folder'), expect.arrayContaining([first, second]));
    expect(await scanner.discoverTargets(first, warning, undefined, [inbox, library])).toEqual([]);
    expect(warning).toHaveBeenLastCalledWith(expect.stringContaining('dedicated book folder'), [first]);
    await expect(scanner.scanTarget(first, { inboxEntry: true })).rejects.toThrow('dedicated book folder');
    await expect(scanner.scanTarget(second, { inboxEntry: true })).rejects.toThrow('dedicated book folder');
  });

  it('holds numbered chapter files without a common title', async () => {
    const first = writeFixture(inbox, '01.mp3');
    const second = writeFixture(inbox, '02 - Chapter One.mp3');
    const sameDirectoryBook = writeFixture(inbox, '1984.m4b');
    const warning = vi.fn();

    expect(await scanner.discoverTargets(inbox, warning, undefined, [inbox, library])).toEqual([sameDirectoryBook]);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('dedicated book folder'), expect.arrayContaining([first, second]));
    await expect(scanner.scanTarget(first, { inboxEntry: true })).rejects.toThrow('dedicated book folder');
    await expect(scanner.scanTarget(second, { inboxEntry: true })).rejects.toThrow('dedicated book folder');
  });

  it('holds a mixed package in automatic intake before applying its metadata', async () => {
    const mixed = path.join(inbox, 'Package');
    writeFixture(mixed, 'Part 1.mp3');
    writeFixture(mixed, 'Part 2.mp3');
    writeFixture(mixed, 'metadata.json', JSON.stringify({ title: 'Unrelated Title' }));
    writeFixture(path.join(mixed, 'Another Book'), 'audio.m4b');

    await expect(scanner.scanTarget(mixed, { inboxEntry: true })).rejects.toThrow('dedicated book folder');
    expect(parseFile).not.toHaveBeenCalled();
  });
});
