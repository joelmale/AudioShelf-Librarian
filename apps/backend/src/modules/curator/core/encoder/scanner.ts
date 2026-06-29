import type { ABSClient } from '../absClient.js';
import type { EncodeCandidate } from './encodeTypes.js';
import type { ABSLibraryItem } from '../types.js';

export interface ScanDeps {
  absClient: ABSClient;
  libraryId: string;
}

export async function scanLibrary(deps: ScanDeps): Promise<EncodeCandidate[]> {
  const items = await deps.absClient.getLibraryItems(deps.libraryId);
  const out: EncodeCandidate[] = [];
  
  for (const item of items) {
    // Media metadata is typically within item.media
    const media = (item as any).media || {};
    const audioFiles = media.audioFiles || [];
    
    // Check if it already has an m4b
    const hasM4b = audioFiles.some((f: any) => f.metadata?.ext?.toLowerCase() === '.m4b');
    const looseFiles = audioFiles.filter((f: any) => {
      const ext = f.metadata?.ext?.toLowerCase();
      return ext === '.mp3' || ext === '.m4a';
    });

    if (looseFiles.length > 1 && !hasM4b) {
      out.push({
        libraryItemId: item.id,
        libraryId: deps.libraryId,
        name: media.metadata?.title || 'Unknown Title',
        author: media.metadata?.authorName || 'Unknown Author',
        files: looseFiles.map((f: any) => f.metadata?.filename || ''),
        totalBytes: typeof item.size === 'number' ? item.size : Number(item.size) || 0,
      });
    }
  }

  return out;
}
