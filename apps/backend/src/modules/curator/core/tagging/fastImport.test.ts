import { describe, expect, it, afterEach } from 'vitest';

import { CuratorDb } from '../db.js';
import { importFastAliases, parseFastNTriples } from './fastImport.js';

const databases: CuratorDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function freshDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

// A small fixture mimicking a slice of the real FAST N-triples dump:
//  - fast/1  Survival        (matches the seed `survival` theme term)
//            altLabels: "Self-preservation", "Staying alive"
//  - fast/2  Escaped \"Quote\" Term   (prefLabel needs unescaping; matches nothing)
//  - fast[3] a non-matching concept ("Berwickshire", no seed hit)
//  - fast/4  Dark             (matches the seed `dark` mood term)
//            altLabel "Survival" collides with the theme vocab term but is a
//            different category here, so it's still a valid alias for mood.
//  - fast/5  Political         (matches the seed `political` theme term)
//            altLabel "Survival" — normalizes to an existing THEME vocab
//            term, so it must be skipped (never alias a real term away).
//  - garbage: blank line, a non-literal triple, an unmatched predicate.
const FIXTURE = [
  '<http://id.worldcat.org/fast/1> <http://www.w3.org/2004/02/skos/core#prefLabel> "Survival"@en .',
  '<http://id.worldcat.org/fast/1> <http://www.w3.org/2004/02/skos/core#altLabel> "Self-preservation"@en .',
  '<http://id.worldcat.org/fast/1> <http://www.w3.org/2004/02/skos/core#altLabel> "Staying alive"@en .',
  '',
  '<http://id.worldcat.org/fast/2> <http://www.w3.org/2004/02/skos/core#prefLabel> "Escaped \\"Quote\\" Term"@en .',
  '<http://id.worldcat.org/fast/3> <http://www.w3.org/2004/02/skos/core#prefLabel> "Berwickshire"@en .',
  '<http://id.worldcat.org/fast/3> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2004/02/skos/core#Concept> .',
  'this is not a valid n-triples line at all',
  '<http://id.worldcat.org/fast/4> <http://www.w3.org/2004/02/skos/core#prefLabel> "Dark"@en .',
  '<http://id.worldcat.org/fast/4> <http://www.w3.org/2004/02/skos/core#altLabel> "Survival"@en .',
  '<http://id.worldcat.org/fast/5> <http://www.w3.org/2004/02/skos/core#prefLabel> "Political"@en .',
  '<http://id.worldcat.org/fast/5> <http://www.w3.org/2004/02/skos/core#altLabel> "Survival"@en .',
  '<http://id.worldcat.org/fast/5> <http://www.w3.org/2004/02/skos/core#broader> <http://id.worldcat.org/fast/999> .',
];

describe('parseFastNTriples', () => {
  it('groups prefLabel/altLabel triples by subject, unescapes quotes, and drops alt-only/garbage lines', () => {
    const entries = parseFastNTriples(FIXTURE);

    expect(entries).toEqual([
      {
        uri: 'http://id.worldcat.org/fast/1',
        prefLabel: 'Survival',
        altLabels: ['Self-preservation', 'Staying alive'],
      },
      {
        uri: 'http://id.worldcat.org/fast/2',
        prefLabel: 'Escaped "Quote" Term',
        altLabels: [],
      },
      {
        uri: 'http://id.worldcat.org/fast/3',
        prefLabel: 'Berwickshire',
        altLabels: [],
      },
      {
        uri: 'http://id.worldcat.org/fast/4',
        prefLabel: 'Dark',
        altLabels: ['Survival'],
      },
      {
        uri: 'http://id.worldcat.org/fast/5',
        prefLabel: 'Political',
        altLabels: ['Survival'],
      },
    ]);
  });

  it('skips a subject with only an altLabel and no prefLabel', () => {
    const entries = parseFastNTriples([
      '<http://id.worldcat.org/fast/9> <http://www.w3.org/2004/02/skos/core#altLabel> "Orphan"@en .',
    ]);
    expect(entries).toEqual([]);
  });
});

describe('importFastAliases', () => {
  it('imports aliases only for entries whose prefLabel matches an existing vocab term, skipping collisions', () => {
    const db = freshDb();
    // 'survival' and 'political' are seed theme terms; 'dark' is a seed mood term.
    const entries = parseFastNTriples(FIXTURE);

    const themeResult = importFastAliases(db, entries, 'theme');
    // Entries 1 (survival) and 5 (political) match the theme vocab; 2, 3, 4 don't.
    expect(themeResult).toEqual({ matched: 2, aliasesAdded: 2 });

    expect(db.getTagAlias('self-preservation', 'theme')).toEqual({
      alias: 'self-preservation',
      canonical: 'survival',
      category: 'theme',
    });
    expect(db.getTagAlias('staying-alive', 'theme')).toEqual({
      alias: 'staying-alive',
      canonical: 'survival',
      category: 'theme',
    });
    // entry 5's altLabel "Survival" normalizes to the theme vocab term
    // itself, so it must never become an alias in that category.
    expect(db.getTagAlias('survival', 'theme')).toBeNull();

    const moodResult = importFastAliases(db, entries, 'mood');
    // Only entry 4 (Dark) matches the mood vocab.
    expect(moodResult).toEqual({ matched: 1, aliasesAdded: 1 });
    // Here "Survival" is a distinct category (mood), so it's a legitimate alias.
    expect(db.getTagAlias('survival', 'mood')).toEqual({
      alias: 'survival',
      canonical: 'dark',
      category: 'mood',
    });
  });

  it('is a no-op when no entries match the vocabulary', () => {
    const db = freshDb();
    const entries = parseFastNTriples([
      '<http://id.worldcat.org/fast/3> <http://www.w3.org/2004/02/skos/core#prefLabel> "Berwickshire"@en .',
    ]);
    expect(importFastAliases(db, entries, 'theme')).toEqual({ matched: 0, aliasesAdded: 0 });
  });

  it('never aliases a term onto itself when prefLabel and altLabel normalize the same', () => {
    const db = freshDb();
    const entries = parseFastNTriples([
      '<http://id.worldcat.org/fast/1> <http://www.w3.org/2004/02/skos/core#prefLabel> "Survival"@en .',
      '<http://id.worldcat.org/fast/1> <http://www.w3.org/2004/02/skos/core#altLabel> "SURVIVAL"@en .',
    ]);
    const result = importFastAliases(db, entries, 'theme');
    expect(result).toEqual({ matched: 1, aliasesAdded: 0 });
    expect(db.getTagAlias('survival', 'theme')).toBeNull();
  });
});
