import { describe, expect, it } from 'vitest';

import type { VocabTerm } from '../types.js';
import { categoryCollisionTerms, suggestVocabAliases } from './vocabReview.js';

function term(value: string, category: VocabTerm['category'], status: VocabTerm['status']): VocabTerm {
  return { term: value, category, status, bookCount: 1, firstSeen: 1, origin: 'tagger' };
}

describe('vocabulary review helpers', () => {
  const vocabulary = [
    term('cozy-mystery', 'genre', 'seed'),
    term('haunted-house', 'setting', 'seed'),
    term('space-opera', 'genre', 'promoted'),
    term('adventure', 'theme', 'proposed'),
    term('adventure', 'mood', 'proposed'),
    term('discarded', 'genre', 'rejected'),
  ];

  it('suggests conservative plural, hyphen, and one-character spelling variants', () => {
    expect(suggestVocabAliases('cozy-mysteries', 'genre', vocabulary)).toContain('cozy-mystery');
    expect(suggestVocabAliases('haunted-houses', 'setting', vocabulary)).toContain('haunted-house');
    expect(suggestVocabAliases('spaceopera', 'genre', vocabulary)).toContain('space-opera');
    expect(suggestVocabAliases('cozy-mystrey', 'genre', vocabulary)).toContain('cozy-mystery');
  });

  it('only flags live cross-category collisions', () => {
    expect(categoryCollisionTerms(vocabulary)).toEqual(new Set(['adventure']));
  });
});
