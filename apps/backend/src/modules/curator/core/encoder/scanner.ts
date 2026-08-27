import pLimit from 'p-limit';
import type { ABSClient } from '../absClient.js';
import type { EncodeCandidate } from './encodeTypes.js';
import type { ABSLibraryItem } from '../types.js';

export interface ScanDeps {
  absClient: ABSClient;
  libraryId: string;
  /** IDs of items already in the encode queue — excluded from candidates. */
  excludeIds?: Set<string>;
}

/**
 * The subset of ABS book metadata this scanner reads.
 *
 * ABS serializes the same book two different ways and we see both. The
 * library-list response (`/api/libraries/:id/items`) is the *minified* form,
 * which flattens the author to `authorName`. The item-detail response
 * (`/api/items/:id`, no `expanded=1`) is the plain form, which carries an
 * `authors[]` array and no `authorName` at all. Both carry `title`, which is
 * why this only ever went wrong for authors.
 */
interface AbsMetadataShape {
  title?: string | null;
  authorName?: string | null;
  authors?: Array<{ name?: string | null }> | null;
}

/** Read the author from whichever of the two shapes we were handed. */
function readAuthor(metadata: AbsMetadataShape): string {
  const flat = metadata.authorName?.trim();
  if (flat) return flat;
  const names = (metadata.authors ?? [])
    .map((author) => author?.name?.trim())
    .filter((name): name is string => Boolean(name));
  return names.length > 0 ? names.join(', ') : 'Unknown Author';
}

export async function scanLibrary(deps: ScanDeps): Promise<EncodeCandidate[]> {
  const items = await deps.absClient.getLibraryItems(deps.libraryId);
  const out: EncodeCandidate[] = [];
  const exclude = deps.excludeIds ?? new Set<string>();

  // Use p-limit to fetch full items concurrently without overwhelming ABS
  const limit = pLimit(5);

  const tasks = items.map(item => limit(async () => {
    // Skip items that are already being processed or queued
    if (exclude.has(item.id)) return;

    const listMedia = (item as any).media || {};
    let metadata: AbsMetadataShape = listMedia.metadata ?? {};
    let audioFiles = listMedia.audioFiles || listMedia.tracks;

    // ABS /api/libraries/:id/items endpoint usually strips audioFiles.
    // If missing, fetch the full item detail.
    if (!audioFiles || audioFiles.length === 0) {
      try {
        const fullItem = await deps.absClient.getBook(item.id);
        const detailMedia = (fullItem as any).media || {};
        audioFiles = detailMedia.audioFiles || detailMedia.tracks || [];
        // MERGE, don't replace. We fetched the detail response for its file
        // list, but it is the other serialization (see AbsMetadataShape), so
        // adopting its metadata wholesale silently lost the author on every
        // candidate. List keys win; detail only fills gaps — which also covers
        // a list entry that carried no metadata of its own.
        metadata = { ...(detailMedia.metadata ?? {}), ...(listMedia.metadata ?? {}) };
      } catch (err) {
        // Skip on error
        return;
      }
    }

    if (!audioFiles || audioFiles.length === 0) return;

    // Check if it already has an m4b — if so, skip entirely.
    // This handles the case where ABS encoded the file but we still have it
    // in our candidate cache.
    const extension = (file: any): string => {
      const raw = file.metadata?.ext?.toLowerCase() || '';
      return raw && !raw.startsWith('.') ? `.${raw}` : raw;
    };
    const hasM4b = audioFiles.some((file: any) => extension(file) === '.m4b');
    if (hasM4b) return;

    const looseFiles = audioFiles.filter((f: any) => {
      const ext = extension(f);
      return ext === '.mp3' || ext === '.m4a';
    });

    // A single MP3/M4A still needs conversion just as much as a multi-track book.
    if (looseFiles.length > 0) {
      out.push({
        libraryItemId: item.id,
        libraryId: deps.libraryId,
        name: metadata.title || 'Unknown Title',
        author: readAuthor(metadata),
        files: looseFiles.map((f: any) => f.metadata?.filename || ''),
        totalBytes: typeof item.size === 'number' ? item.size : Number(item.size) || 0,
      });
    }
  }));

  await Promise.all(tasks);

  return out;
}
