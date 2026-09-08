import { describe, expect, it } from 'vitest';

import type { Book, BookEntity } from '../types.js';
import {
  parseProposals,
  serializeProposals,
  tagComposeHash,
  tagPromptHash,
  vocabularyFingerprint,
} from './tagInputs.js';

const BOOK: Book = {
  id: 'it',
  title: 'It',
  author: 'Stephen King',
  series: null,
  seriesSequence: null,
  durationSeconds: 4 * 3600,
  publishedYear: 1986,
  genres: [],
  description: 'Seven children face a shapeshifting evil in Derry.',
  coverPath: null,
  absAddedAt: null,
  lastSyncedAt: Date.now(),
};

function entity(name: string, sources: string[] = ['openlibrary']): BookEntity {
  return { bookId: 'it', entity: name, kind: 'person', sources, notable: true };
}

describe('tagPromptHash', () => {
  it('is stable for identical inputs', () => {
    expect(tagPromptHash(BOOK, 'claude-x', 1)).toBe(tagPromptHash(BOOK, 'claude-x', 1));
  });

  it('moves when the model changes, because tags from another model are not interchangeable', () => {
    expect(tagPromptHash(BOOK, 'claude-x', 1)).not.toBe(tagPromptHash(BOOK, 'llama-y', 1));
  });

  it('moves when the schema version changes', () => {
    expect(tagPromptHash(BOOK, 'claude-x', 1)).not.toBe(tagPromptHash(BOOK, 'claude-x', 2));
  });

  it('moves when a backfilled description changes the bytes sent to the model', () => {
    const backfilled: Book = { ...BOOK, description: null, descriptionEnriched: 'A harvested synopsis.' };
    expect(tagPromptHash(backfilled, 'claude-x', 1)).not.toBe(tagPromptHash(BOOK, 'claude-x', 1));
  });

  it('ignores fields the prompt never sends, so a cover path change costs no re-tag', () => {
    const recovered: Book = { ...BOOK, coverPath: '/covers/it.jpg' };
    expect(tagPromptHash(recovered, 'claude-x', 1)).toBe(tagPromptHash(BOOK, 'claude-x', 1));
  });
});

describe('tagComposeHash', () => {
  const vocab = vocabularyFingerprint([['t', 'genre', 'hard-sci-fi']]);

  it('is stable for identical inputs and independent of entity ordering', () => {
    const a = tagComposeHash(BOOK, [entity('Beverly Marsh'), entity('Ben Hanscom')], vocab);
    const b = tagComposeHash(BOOK, [entity('Ben Hanscom'), entity('Beverly Marsh')], vocab);
    expect(a).toBe(b);
  });

  it('moves when the grounding allowlist gains an entity', () => {
    const before = tagComposeHash(BOOK, [entity('Beverly Marsh')], vocab);
    const after = tagComposeHash(BOOK, [entity('Beverly Marsh'), entity('Ben Hanscom')], vocab);
    expect(before).not.toBe(after);
  });

  it('moves when only an entity name is repaired — the MARC-qualifier case re-derive fixes', () => {
    const before = tagComposeHash(BOOK, [entity('Dios (Fictitious character)')], vocab);
    const after = tagComposeHash(BOOK, [entity('Dios')], vocab);
    expect(before).not.toBe(after);
  });

  it('moves when a second provider confirms an entity, because that provenance is persisted', () => {
    const one = tagComposeHash(BOOK, [entity('Beverly Marsh', ['openlibrary'])], vocab);
    const two = tagComposeHash(BOOK, [entity('Beverly Marsh', ['openlibrary', 'wikidata'])], vocab);
    expect(one).not.toBe(two);
  });

  it('moves when the vocabulary fingerprint changes', () => {
    const promoted = vocabularyFingerprint([
      ['t', 'genre', 'hard-sci-fi'],
      ['t', 'theme', 'found-family'],
    ]);
    expect(tagComposeHash(BOOK, [], vocab)).not.toBe(tagComposeHash(BOOK, [], promoted));
  });

  it('moves when a derived tag changes, without naming the field that drives it', () => {
    // Duration drives deriveLength; the hash covers deriveTags' OUTPUT, so
    // this invalidates with no per-field bookkeeping in tagInputs.ts.
    const longer: Book = { ...BOOK, durationSeconds: 40 * 3600 };
    expect(tagComposeHash(longer, [], vocab)).not.toBe(tagComposeHash(BOOK, [], vocab));
  });
});

describe('vocabularyFingerprint', () => {
  it('distinguishes a term from an alias with the same text', () => {
    expect(vocabularyFingerprint([['t', 'genre', 'scifi']])).not.toBe(
      vocabularyFingerprint([['a', 'genre', 'scifi']])
    );
  });
});

describe('proposal round-trip', () => {
  it('survives serialize -> parse', () => {
    const tags = [
      { tag: 'Ben Hannigan', category: 'character' as const, confidence: 0.8 },
      { tag: 'HardSciFi', category: 'genre' as const, confidence: 0.9 },
    ];
    expect(parseProposals(serializeProposals(tags))).toEqual(tags);
  });

  it('distinguishes "the model proposed nothing" from "no proposals were stored"', () => {
    // The whole point: [] is a real answer, null means we cannot re-ground.
    // Collapsing them would silently strip a book back to derived tags only.
    expect(parseProposals(serializeProposals([]))).toEqual([]);
    expect(parseProposals(null)).toBeNull();
    expect(parseProposals('')).toBeNull();
  });

  it('returns null for an unreadable payload rather than a partial tag set', () => {
    expect(parseProposals('{not json')).toBeNull();
    expect(parseProposals('{"tags":[]}')).toBeNull();
  });

  it('drops malformed entries but keeps well-formed ones', () => {
    const parsed = parseProposals('[{"tag":"ai","category":"theme","confidence":0.7},{"category":"genre"},null]');
    expect(parsed).toEqual([{ tag: 'ai', category: 'theme', confidence: 0.7 }]);
  });
});
