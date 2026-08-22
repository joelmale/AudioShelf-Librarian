import { describe, expect, it, afterEach } from 'vitest';

import { CuratorDb } from '../db.js';
import { canonicalizeTags, normalizeTagForm } from './canonicalize.js';

const databases: CuratorDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function freshDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

describe('normalizeTagForm', () => {
  it('splits camel/PascalCase on lower->upper boundaries before lowercasing', () => {
    expect(normalizeTagForm('ThePowerOfFriendship')).toBe('the-power-of-friendship');
  });

  it('lowercases and collapses non-alphanumeric runs to a single hyphen', () => {
    expect(normalizeTagForm('Coastal   Town!!')).toBe('coastal-town');
  });

  it('trims leading/trailing hyphens', () => {
    expect(normalizeTagForm('--spooky--')).toBe('spooky');
  });

  it('collapses repeated separators', () => {
    expect(normalizeTagForm('found---family')).toBe('found-family');
  });
});

describe('canonicalizeTags', () => {
  it('maps a tag that already matches a seed vocab term directly, with source vocab', () => {
    const db = freshDb();
    const out = canonicalizeTags([{ tag: 'dark', category: 'mood', confidence: 0.9 }], db);
    expect(out).toEqual([{ tag: 'dark', category: 'mood', confidence: 0.9, source: 'vocab' }]);
  });

  it('maps a normalized form through an alias to its canonical vocab term', () => {
    const db = freshDb();
    db.upsertTagAlias('spooky', 'dark', 'mood');
    const out = canonicalizeTags([{ tag: 'Spooky', category: 'mood', confidence: 0.7 }], db);
    expect(out).toEqual([{ tag: 'dark', category: 'mood', confidence: 0.7, source: 'vocab' }]);
  });

  it('normalizes camelCase input before the vocab/alias lookup', () => {
    const db = freshDb();
    db.setVocabTermStatus('found-family', 'trope', 'promoted', 1000);
    const out = canonicalizeTags([{ tag: 'FoundFamily', category: 'trope', confidence: 0.8 }], db);
    expect(out).toEqual([{ tag: 'found-family', category: 'trope', confidence: 0.8, source: 'vocab' }]);
  });

  it('the friendship-cluster fixture: Friendship / FriendshipSacrifices(alias) / ThePowerOfFriendship all collapse to one friendship vocab tag, keeping max confidence', () => {
    const db = freshDb();
    db.setVocabTermStatus('friendship', 'theme', 'promoted', 1000);
    db.upsertTagAlias('friendship-sacrifices', 'friendship', 'theme');

    const out = canonicalizeTags(
      [
        { tag: 'Friendship', category: 'theme', confidence: 0.5 },
        { tag: 'FriendshipSacrifices', category: 'theme', confidence: 0.95 },
        { tag: 'ThePowerOfFriendship', category: 'theme', confidence: 0.7 },
      ],
      db
    );

    expect(out).toEqual([{ tag: 'friendship', category: 'theme', confidence: 0.95, source: 'vocab' }]);
  });

  it('rule 4: an unambiguous single-token vocab hit inside a multi-token folded form canonicalizes', () => {
    const db = freshDb();
    // 'dark' is a seed mood term; 'very' and 'vibe' are not.
    const out = canonicalizeTags([{ tag: 'very-dark-vibe', category: 'mood', confidence: 0.6 }], db);
    expect(out).toEqual([{ tag: 'dark', category: 'mood', confidence: 0.6, source: 'vocab' }]);
  });

  it('rule 4 ambiguity: two qualifying tokens in the folded form stays llm-open rather than guessing', () => {
    const db = freshDb();
    // Both 'dark' and 'hopeful' are seed mood terms; 'and' is a stopword and drops out.
    const out = canonicalizeTags([{ tag: 'dark-and-hopeful-blend', category: 'mood', confidence: 0.6 }], db);
    expect(out).toEqual([{ tag: 'dark-and-hopeful-blend', category: 'mood', confidence: 0.6, source: 'llm-open' }]);
  });

  it('an unmapped tag stays llm-open in its normalized form', () => {
    const db = freshDb();
    const out = canonicalizeTags([{ tag: 'GlimmeringVoidscape', category: 'mood', confidence: 0.4 }], db);
    expect(out).toEqual([{ tag: 'glimmering-voidscape', category: 'mood', confidence: 0.4, source: 'llm-open' }]);
  });

  it('passes character/setting tags through untouched, marked llm-open, without canonicalization', () => {
    const db = freshDb();
    db.setVocabTermStatus('derry', 'setting', 'promoted', 1000);
    const out = canonicalizeTags(
      [
        { tag: 'Beverly Marsh', category: 'character', confidence: 0.9 },
        { tag: 'Derry', category: 'setting', confidence: 0.8 },
      ],
      db
    );
    expect(out).toEqual([
      { tag: 'Beverly Marsh', category: 'character', confidence: 0.9, source: 'llm-open' },
      { tag: 'Derry', category: 'setting', confidence: 0.8, source: 'llm-open' },
    ]);
  });

  it('dedupes to the highest confidence when two raw tags canonicalize onto the same (tag, category)', () => {
    const db = freshDb();
    const out = canonicalizeTags(
      [
        { tag: 'Dark', category: 'mood', confidence: 0.3 },
        { tag: 'dark', category: 'mood', confidence: 0.9 },
      ],
      db
    );
    expect(out).toEqual([{ tag: 'dark', category: 'mood', confidence: 0.9, source: 'vocab' }]);
  });
});
