import { describe, expect, it, vi } from 'vitest';
import type { ABSClient } from '../absClient.js';
import { scanLibrary } from './scanner.js';

const audio = (ext: string, filename: string) => ({ metadata: { ext, filename } });
const item = (id: string, files?: Array<ReturnType<typeof audio>>) => ({
  id,
  size: 1024,
  media: {
    metadata: { title: `Title ${id}`, authorName: `Author ${id}` },
    ...(files ? { audioFiles: files } : {}),
  },
});

function client(items: unknown[], details: Record<string, unknown | Error> = {}) {
  return {
    getLibraryItems: vi.fn().mockResolvedValue(items),
    getBook: vi.fn(async (id: string) => {
      const detail = details[id];
      if (detail instanceof Error) throw detail;
      return detail;
    }),
  } as unknown as ABSClient;
}

describe('scanLibrary', () => {
  it('includes single-file MP3 and M4A books as M4B candidates', async () => {
    const result = await scanLibrary({
      absClient: client([
        item('mp3', [audio('.mp3', 'book.mp3')]),
        item('m4a', [audio('m4a', 'book.m4a')]),
      ]),
      libraryId: 'library',
    });

    expect(result.map((candidate) => candidate.libraryItemId).sort()).toEqual(['m4a', 'mp3']);
  });

  it('fetches full item details when the library summary omits audio files', async () => {
    const absClient = client([item('detail')], {
      detail: item('detail', [audio('.mp3', 'part-1.mp3'), audio('.mp3', 'part-2.mp3')]),
    });
    const result = await scanLibrary({ absClient, libraryId: 'library' });

    expect(absClient.getBook).toHaveBeenCalledWith('detail');
    expect(result[0]?.files).toEqual(['part-1.mp3', 'part-2.mp3']);
  });

  it('excludes existing M4B, mixed M4B, unsupported, and queued items', async () => {
    const result = await scanLibrary({
      absClient: client([
        item('m4b', [audio('.m4b', 'book.m4b')]),
        item('mixed', [audio('.mp3', 'part.mp3'), audio('.m4b', 'book.m4b')]),
        item('flac', [audio('.flac', 'book.flac')]),
        item('queued', [audio('.mp3', 'book.mp3')]),
      ]),
      libraryId: 'library',
      excludeIds: new Set(['queued']),
    });

    expect(result).toEqual([]);
  });

  it('isolates a failed detail request so other candidates still load', async () => {
    const result = await scanLibrary({
      absClient: client([item('broken'), item('good', [audio('.mp3', 'good.mp3')])], {
        broken: new Error('ABS unavailable'),
      }),
      libraryId: 'library',
    });

    expect(result.map((candidate) => candidate.libraryItemId)).toEqual(['good']);
  });
});
