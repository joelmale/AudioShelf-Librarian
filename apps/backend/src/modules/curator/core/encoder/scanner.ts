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

export async function scanLibrary(deps: ScanDeps): Promise<EncodeCandidate[]> {
  const items = await deps.absClient.getLibraryItems(deps.libraryId);
  const out: EncodeCandidate[] = [];
  const exclude = deps.excludeIds ?? new Set<string>();

  // Use p-limit to fetch full items concurrently without overwhelming ABS
  const limit = pLimit(5);

  const tasks = items.map(item => limit(async () => {
    // Skip items that are already being processed or queued
    if (exclude.has(item.id)) return;

    const media = (item as any).media || {};
    const numTracks = media.numTracks ?? media.numAudioFiles ?? 0;

    // Skip items that only have 1 track (likely already an m4b or a single mp3)
    if (numTracks <= 1) return;

    let audioFiles = media.audioFiles || media.tracks;

    // ABS /api/libraries/:id/items endpoint usually strips audioFiles.
    // If missing, fetch the full item detail.
    if (!audioFiles || audioFiles.length === 0) {
      try {
        const fullItem = await deps.absClient.getBook(item.id);
        audioFiles = (fullItem as any).media?.audioFiles || (fullItem as any).media?.tracks || [];
      } catch (err) {
        // Skip on error
        return;
      }
    }

    if (!audioFiles || audioFiles.length === 0) return;

    // Check if it already has an m4b — if so, skip entirely.
    // This handles the case where ABS encoded the file but we still have it
    // in our candidate cache.
    const hasM4b = audioFiles.some((f: any) => f.metadata?.ext?.toLowerCase() === '.m4b');
    if (hasM4b) return;

    const looseFiles = audioFiles.filter((f: any) => {
      const ext = f.metadata?.ext?.toLowerCase();
      return ext === '.mp3' || ext === '.m4a';
    });

    if (looseFiles.length > 1) {
      out.push({
        libraryItemId: item.id,
        libraryId: deps.libraryId,
        name: media.metadata?.title || 'Unknown Title',
        author: media.metadata?.authorName || 'Unknown Author',
        files: looseFiles.map((f: any) => f.metadata?.filename || ''),
        totalBytes: typeof item.size === 'number' ? item.size : Number(item.size) || 0,
      });
    }
  }));

  await Promise.all(tasks);

  return out;
}
