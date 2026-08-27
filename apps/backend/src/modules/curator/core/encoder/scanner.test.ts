import { describe, expect, it, vi } from 'vitest';
import type { ABSClient } from '../absClient.js';
import { scanLibrary } from './scanner.js';

const audio = (ext: string, filename: string) => ({ metadata: { ext, filename } });
/** The library-list (minified) shape: author flattened to `authorName`. */
const item = (id: string, files?: Array<ReturnType<typeof audio>>) => ({
  id,
  size: 1024,
  media: {
    metadata: { title: `Title ${id}`, authorName: `Author ${id}` },
    ...(files ? { audioFiles: files } : {}),
  },
});

/**
 * The item-detail (plain) shape: an `authors[]` array and NO `authorName`.
 * Using `item()` for both sides of the detail fetch is what hid the bug where
 * the scanner adopted this response's metadata wholesale — the fixture made
 * the two serializations identical, so nothing could go wrong in a test.
 */
const detailItem = (id: string, files: Array<ReturnType<typeof audio>>, authors = [{ name: `Author ${id}` }]) => ({
  id,
  size: 1024,
  media: {
    metadata: { title: `Title ${id}`, authors },
    audioFiles: files,
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
      detail: detailItem('detail', [audio('.mp3', 'part-1.mp3'), audio('.mp3', 'part-2.mp3')]),
    });
    const result = await scanLibrary({ absClient, libraryId: 'library' });

    expect(absClient.getBook).toHaveBeenCalledWith('detail');
    expect(result[0]?.files).toEqual(['part-1.mp3', 'part-2.mp3']);
  });

  /**
   * Regression guard: every candidate rendered as "Unknown Author" in the
   * encoder UI because the detail fetch — which fires for nearly every book,
   * since the list response strips audioFiles — replaced the list metadata
   * with the plain serialization, which has no `authorName`. Titles survived
   * (both shapes carry `title`), which is why only the author column broke.
   */
  it('keeps the list metadata author when the detail response names no author at all', async () => {
    // Detail metadata carries NEITHER `authorName` NOR `authors[]`, so the
    // merge is the only thing that can supply the author here. This isolates
    // it from readAuthor's array fallback, which would otherwise mask a
    // regression to the old replace-wholesale behaviour.
    const absClient = client([item('detail')], {
      detail: {
        id: 'detail',
        size: 1024,
        media: { metadata: { title: 'Title detail' }, audioFiles: [audio('.mp3', 'part-1.mp3')] },
      },
    });
    const result = await scanLibrary({ absClient, libraryId: 'library' });

    expect(result[0]?.author).toBe('Author detail');
    expect(result[0]?.name).toBe('Title detail');
  });

  it('reads the detail authors[] array when the list entry supplies no author', async () => {
    const absClient = client([item('detail')], {
      detail: detailItem('detail', [audio('.mp3', 'part-1.mp3')]),
    });
    const result = await scanLibrary({ absClient, libraryId: 'library' });

    // The list entry's `authorName` wins where both are present...
    expect(result[0]?.author).toBe('Author detail');
  });

  it('falls back to the detail authors[] array when the list entry has no metadata', async () => {
    const absClient = client([{ id: 'bare', size: 1024, media: {} }], {
      bare: detailItem('bare', [audio('.mp3', 'part-1.mp3')], [{ name: 'Laurence Shames' }, { name: 'Co Author' }]),
    });
    const result = await scanLibrary({ absClient, libraryId: 'library' });

    expect(result[0]?.author).toBe('Laurence Shames, Co Author');
  });

  it('still reports Unknown Author when neither shape names one', async () => {
    const absClient = client([{ id: 'anon', size: 1024, media: {} }], {
      anon: { id: 'anon', size: 1024, media: { metadata: { title: 'Anonymous' }, audioFiles: [audio('.mp3', 'a.mp3')] } },
    });
    const result = await scanLibrary({ absClient, libraryId: 'library' });

    expect(result[0]?.author).toBe('Unknown Author');
  });

  it('reads the author straight from the list entry when no detail fetch is needed', async () => {
    const absClient = client([item('inline', [audio('.mp3', 'book.mp3')])]);
    const result = await scanLibrary({ absClient, libraryId: 'library' });

    expect(absClient.getBook).not.toHaveBeenCalled();
    expect(result[0]?.author).toBe('Author inline');
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
