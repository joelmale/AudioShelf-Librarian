import { describe, expect, it } from 'vitest';

import type { BookEntity } from '../types.js';
import { groundEntityTags } from './ground.js';

// Real Open Library-derived allowlist shape for Stephen King's IT, reused
// (with sources added) from core/enrichment/entityMatcher.test.ts's IT_ALLOWLIST.
const IT_ALLOWLIST: BookEntity[] = [
  { bookId: 'it', entity: 'Benjamin Hanscom', kind: 'person', sources: ['openlibrary'], notable: true },
  { bookId: 'it', entity: 'Beverly Marsh', kind: 'person', sources: ['openlibrary', 'wikidata'], notable: true },
  { bookId: 'it', entity: 'Derry', kind: 'place', sources: ['openlibrary'], notable: true },
  { bookId: 'it', entity: 'Maine', kind: 'place', sources: ['wikidata'], notable: true },
];

describe('groundEntityTags — character', () => {
  it('repairs "Ben Hannigan" to the grounded canonical, marked external with the matched entity\'s sources', () => {
    const out = groundEntityTags(
      [{ tag: 'Ben Hannigan', category: 'character', confidence: 0.8 }],
      IT_ALLOWLIST,
      null
    );
    expect(out).toEqual([
      { tag: 'benjamin-hanscom', category: 'character', confidence: 0.8, source: 'external:openlibrary' },
    ]);
  });

  it('sorts multiple sources into the external: tag deterministically', () => {
    const out = groundEntityTags(
      [{ tag: 'Beverly Marsh', category: 'character', confidence: 0.9 }],
      IT_ALLOWLIST,
      null
    );
    expect(out).toEqual([
      { tag: 'beverly-marsh', category: 'character', confidence: 0.9, source: 'external:openlibrary+wikidata' },
    ]);
  });

  it('drops "Adrian Dover" when the book has a person allowlist and nothing matches (hallucination filter)', () => {
    const out = groundEntityTags(
      [{ tag: 'Adrian Dover', category: 'character', confidence: 0.6 }],
      IT_ALLOWLIST,
      null
    );
    expect(out).toEqual([]);
  });

  it('keeps an unmatched character as llm-open when the book has NO person allowlist and the name is in the description', () => {
    const out = groundEntityTags(
      [{ tag: 'Susan Delgado', category: 'character', confidence: 0.5 }],
      [],
      'A story about Susan Delgado wandering the plains of Mid-World.'
    );
    expect(out).toEqual([
      { tag: 'susan-delgado', category: 'character', confidence: 0.5, source: 'llm-open' },
    ]);
  });

  it('drops an unmatched character with no allowlist when the name is absent from the description', () => {
    const out = groundEntityTags(
      [{ tag: 'Susan Delgado', category: 'character', confidence: 0.5 }],
      [],
      'A completely unrelated synopsis mentioning nobody by that name.'
    );
    expect(out).toEqual([]);
  });

  it('drops an unmatched character with no allowlist and no description at all', () => {
    const out = groundEntityTags([{ tag: 'Susan Delgado', category: 'character', confidence: 0.5 }], [], null);
    expect(out).toEqual([]);
  });
});

describe('groundEntityTags — setting', () => {
  it('two-token "derry-maine" does not match either single-token place entity, and stays llm-open', () => {
    const out = groundEntityTags(
      [{ tag: 'derry-maine', category: 'setting', confidence: 0.7 }],
      IT_ALLOWLIST,
      null
    );
    expect(out).toEqual([
      { tag: 'derry-maine', category: 'setting', confidence: 0.7, source: 'llm-open' },
    ]);
  });

  it('"Derry" matches the grounded place exactly, marked external', () => {
    const out = groundEntityTags([{ tag: 'Derry', category: 'setting', confidence: 0.85 }], IT_ALLOWLIST, null);
    expect(out).toEqual([
      { tag: 'derry', category: 'setting', confidence: 0.85, source: 'external:openlibrary' },
    ]);
  });

  it('a generic unmatched setting like "coastal-town" is kept as llm-open, never dropped', () => {
    const out = groundEntityTags(
      [{ tag: 'coastal-town', category: 'setting', confidence: 0.4 }],
      IT_ALLOWLIST,
      null
    );
    expect(out).toEqual([
      { tag: 'coastal-town', category: 'setting', confidence: 0.4, source: 'llm-open' },
    ]);
  });
});

describe('groundEntityTags — dedupe', () => {
  it('keeps the highest-confidence entry when two candidates ground onto the same (tag, category)', () => {
    const out = groundEntityTags(
      [
        { tag: 'Ben Hannigan', category: 'character', confidence: 0.3 },
        { tag: 'Benjamin Hanscom', category: 'character', confidence: 0.95 },
      ],
      IT_ALLOWLIST,
      null
    );
    expect(out).toEqual([
      { tag: 'benjamin-hanscom', category: 'character', confidence: 0.95, source: 'external:openlibrary' },
    ]);
  });
});
