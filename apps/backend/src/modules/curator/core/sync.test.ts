/**
 * Narrow test for `mapItemToBook`'s narrator handling — the ABS-sync side of
 * `books.narrator` (see `docs/enrichment-sources-review.md` R3). Does not
 * attempt broader `sync.ts` coverage; the rest of the module has no
 * colocated tests as of this change.
 */
import { describe, expect, it } from 'vitest';

import { mapItemToBook } from './sync.js';
import type { ABSLibraryItem } from './types.js';

function item(narratorName: string | null | undefined): ABSLibraryItem {
  return {
    id: 'b1',
    media: {
      metadata: {
        title: 'A Book',
        narratorName,
      },
    },
  } as ABSLibraryItem;
}

describe('mapItemToBook narrator parsing', () => {
  it('splits a comma-joined narratorName into a list', () => {
    const book = mapItemToBook(item('Jefferson Mays, Marc Thompson'), Date.now());
    expect(book.narrator).toEqual(['Jefferson Mays', 'Marc Thompson']);
  });

  it('wraps a single narrator name in a one-element list', () => {
    const book = mapItemToBook(item('R.C. Bray'), Date.now());
    expect(book.narrator).toEqual(['R.C. Bray']);
  });

  it('trims whitespace around each split name', () => {
    const book = mapItemToBook(item('  Jefferson Mays  ,  Marc Thompson  '), Date.now());
    expect(book.narrator).toEqual(['Jefferson Mays', 'Marc Thompson']);
  });

  it('maps a missing or null narratorName to null, not an empty array', () => {
    expect(mapItemToBook(item(null), Date.now()).narrator).toBeNull();
    expect(mapItemToBook(item(undefined), Date.now()).narrator).toBeNull();
  });

  it('maps an empty-string narratorName to null', () => {
    expect(mapItemToBook(item(''), Date.now()).narrator).toBeNull();
  });

  it('drops empty segments from a trailing/doubled comma without producing blank entries', () => {
    const book = mapItemToBook(item('Jefferson Mays,, '), Date.now());
    expect(book.narrator).toEqual(['Jefferson Mays']);
  });
});
