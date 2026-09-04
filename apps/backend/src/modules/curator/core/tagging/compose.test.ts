import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book, BookEntity } from '../types.js';
import { composeBookTags, evaluableTagCategories } from './compose.js';
import { groundEntityTags } from './ground.js';

const databases: CuratorDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function freshDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

const BOOK: Book = {
  id: 'it',
  title: 'It',
  author: 'Stephen King',
  series: null,
  seriesSequence: null,
  durationSeconds: 4 * 3600, // -> derived length 'short'
  publishedYear: 1986,
  genres: [],
  description: null,
  coverPath: null,
  absAddedAt: null,
  lastSyncedAt: Date.now(),
};

describe('composeBookTags', () => {
  it('repairs a groundable character, drops a fabricated one, canonicalizes a genre, and lets derived length win over the LLM length tag', () => {
    const db = freshDb();
    db.upsertBook(BOOK);
    db.replaceBookEntities('it', [{ entity: 'Benjamin Hanscom', kind: 'person', sources: ['openlibrary'] }]);

    const llmTags = [
      { tag: 'Ben Hannigan', category: 'character' as const, confidence: 0.8 },
      { tag: 'Adrian Dover', category: 'character' as const, confidence: 0.6 },
      { tag: 'HardSciFi', category: 'genre' as const, confidence: 0.9 },
      { tag: 'epic', category: 'length' as const, confidence: 0.5 },
    ];

    const composed = composeBookTags(BOOK, llmTags, db);

    // Repair: the groundable character is present, canonicalized, external-sourced.
    expect(composed).toContainEqual({
      tag: 'benjamin-hanscom',
      category: 'character',
      confidence: 0.8,
      source: 'external:openlibrary',
    });

    // Drop: the fabricated character never appears in any form.
    expect(composed.some((t) => t.category === 'character' && t.tag !== 'benjamin-hanscom')).toBe(false);
    expect(composed.some((t) => t.tag === 'adrian-dover')).toBe(false);

    // Canonicalization: the genre maps onto the seed vocab term.
    expect(composed).toContainEqual({ tag: 'hard-sci-fi', category: 'genre', confidence: 0.9, source: 'vocab' });

    // Derived wins: length is 'short' (derived from duration), not the LLM's 'epic'.
    expect(composed).toContainEqual({ tag: 'short', category: 'length', confidence: 1, source: 'derived' });
    expect(composed.some((t) => t.category === 'length' && t.source !== 'derived')).toBe(false);

    // Exactly one entry per category, per the precedence rules above.
    const lengthEntries = composed.filter((t) => t.category === 'length');
    expect(lengthEntries).toHaveLength(1);
  });

  it('never asks the ground/canonicalize steps to touch a category the derive step already claimed', () => {
    const db = freshDb();
    db.upsertBook({ ...BOOK, id: 'era-book', publishedYear: 1950 });

    const composed = composeBookTags(
      { ...BOOK, id: 'era-book', publishedYear: 1950 },
      [{ tag: 'Modern', category: 'era' as const, confidence: 0.7 }],
      db
    );

    expect(composed).toContainEqual({ tag: 'golden-age', category: 'era', confidence: 1, source: 'derived' });
    expect(composed.some((t) => t.tag === 'modern')).toBe(false);
  });

  /**
   * The reason EXCLUSIVE_DERIVED_CATEGORIES exists. `full-cast` describes the
   * production and `multi-pov` describes the narrative; both are true of the
   * same GraphicAudio title. When any derived tag claimed its whole category,
   * adding full-cast to `structure` would have silently deleted the POV tag
   * from every dramatized book in the library.
   */
  it('lets a derived structure tag coexist with the LLM structure tag, unlike length', () => {
    const db = freshDb();
    const book = { ...BOOK, id: 'ga', title: 'Amazon Gate Full Cast (GraphicAudio)' };
    db.upsertBook(book);

    const composed = composeBookTags(
      book,
      [
        { tag: 'multi-pov', category: 'structure' as const, confidence: 0.8 },
        { tag: 'epic', category: 'length' as const, confidence: 0.9 },
      ],
      db
    );

    // Merged: the derived production tag and the LLM's narrative tag both survive.
    expect(composed).toContainEqual({ tag: 'full-cast', category: 'structure', confidence: 1, source: 'derived' });
    expect(composed.some((t) => t.tag === 'multi-pov' && t.category === 'structure')).toBe(true);
    expect(composed.filter((t) => t.category === 'structure')).toHaveLength(2);

    // Still exclusive: length remains single-valued and derived still wins it.
    expect(composed.filter((t) => t.category === 'length')).toHaveLength(1);
    expect(composed.some((t) => t.tag === 'epic')).toBe(false);
  });

  /**
   * `book_tags` is unique on (book_id, tag) rather than (book_id, tag,
   * category), so an LLM tag sharing a derived tag's string would overwrite
   * the derived row on insert and demote its source away from 'derived'.
   */
  it('drops an LLM tag that duplicates a derived tag string, even in another category', () => {
    const db = freshDb();
    const book = { ...BOOK, id: 'dup', title: 'Something Dramatized' };
    db.upsertBook(book);

    const composed = composeBookTags(book, [{ tag: 'full-cast', category: 'genre' as const, confidence: 0.9 }], db);

    const fullCastEntries = composed.filter((t) => t.tag === 'full-cast');
    expect(fullCastEntries).toHaveLength(1);
    expect(fullCastEntries[0]).toMatchObject({ category: 'structure', source: 'derived' });
  });
});

/**
 * `evaluableTagCategories`
 * decides whether `character` was ATTEMPTED for a book by re-stating
 * `groundCharacter`'s drop condition BY HAND, in a different file. They agree
 * today. Nothing structurally forces them to keep agreeing, and the failure is
 * silent in the worst direction: if `ground.ts`'s description fallback is ever
 * removed (with `ground.test.ts` updated alongside it), `compose.ts` keeps
 * claiming `character` was attempted for description-only books, so
 * `getTagCoverage` reports a confident `absent` for a check that could never
 * have succeeded — invariant 5, in the one place that now looks handled.
 *
 * So this asserts the biconditional rather than the one-way implication the
 * exit criterion names, because the one-way version does not catch that
 * direction. For each structural shape a book can have, we hand grounding its
 * BEST-CASE character candidate — the one that grounds if the mechanism works
 * at all (an allowlist entity when there is an allowlist; a name that really
 * appears in the description when there is only a description; an arbitrary
 * name when there is neither, since nothing could ground) — and require:
 *
 *   evaluableTagCategories(...) includes 'character'
 *     ⟺ groundEntityTags(bestCase, ...) kept something
 *
 * Drop the exclusion in `compose.ts` and the ungroundable cases fail. Drop the
 * description fallback in `ground.ts` and the description-only case fails.
 */
describe('evaluableTagCategories is coupled to what groundEntityTags can actually do', () => {
  const PERSON_ALLOWLIST: BookEntity[] = [
    { bookId: 'b', entity: 'Benjamin Hanscom', kind: 'person', sources: ['openlibrary'], notable: true },
  ];
  const PLACE_ONLY_ALLOWLIST: BookEntity[] = [
    { bookId: 'b', entity: 'Derry', kind: 'place', sources: ['openlibrary'], notable: true },
  ];

  const cases: Array<{ name: string; description: string | null; allowlist: BookEntity[]; bestCase: string }> = [
    {
      name: 'person allowlist, no description — grounds against the allowlist',
      description: null,
      allowlist: PERSON_ALLOWLIST,
      bestCase: 'Ben Hannigan',
    },
    {
      name: 'no allowlist, description naming the character — grounds via the weak substring fallback',
      description: 'A story about Susan Delgado wandering the plains of Mid-World.',
      allowlist: [],
      bestCase: 'Susan Delgado',
    },
    {
      name: 'person allowlist AND description — grounds against the allowlist',
      description: 'Seven kids in Derry, among them Ben Hanscom.',
      allowlist: PERSON_ALLOWLIST,
      bestCase: 'Ben Hannigan',
    },
    {
      name: 'place-only allowlist, no description — nothing to ground a person against',
      description: null,
      allowlist: PLACE_ONLY_ALLOWLIST,
      bestCase: 'Anyone At All',
    },
    {
      name: 'no allowlist, no description — nothing to ground against',
      description: null,
      allowlist: [],
      bestCase: 'Anyone At All',
    },
    {
      name: 'no allowlist, whitespace-only description — still nothing to ground against',
      description: '   \n  ',
      allowlist: [],
      bestCase: 'Anyone At All',
    },
  ];

  for (const c of cases) {
    it(`agrees on 'character' — ${c.name}`, () => {
      const book: Book = { ...BOOK, id: 'coupled', description: c.description };

      const claimsAttempted = evaluableTagCategories(book, c.allowlist).includes('character');
      const grounded = groundEntityTags(
        [{ tag: c.bestCase, category: 'character', confidence: 0.8 }],
        c.allowlist,
        book.description
      );
      const groundingCanSucceed = grounded.some((t) => t.category === 'character');

      expect(
        claimsAttempted,
        claimsAttempted
          ? `evaluableTagCategories claims 'character' was attempted, but groundEntityTags dropped its best-case candidate "${c.bestCase}" — coverage would report a confident 'absent' for a check that could not succeed`
          : `evaluableTagCategories excludes 'character', but groundEntityTags kept "${c.bestCase}" — a real character tag would be recorded as never attempted`
      ).toBe(groundingCanSucceed);
    });
  }

  /**
   * The exit criterion as literally stated: not just "the best-case candidate
   * was dropped" but "EVERY candidate is dropped" for a book whose `character`
   * category is not evaluable. Grounding has no input that could rescue it.
   */
  it("drops every character candidate for a book whose 'character' category is not evaluable", () => {
    const book: Book = { ...BOOK, id: 'unevaluable', description: null };
    const allowlist = PLACE_ONLY_ALLOWLIST;

    expect(evaluableTagCategories(book, allowlist)).not.toContain('character');

    const candidates = [
      'Benjamin Hanscom',
      'Derry',
      'ben-hannigan',
      'A Name With Spaces',
      'unknown-person',
      'Susan Delgado',
    ].map((tag) => ({ tag, category: 'character' as const, confidence: 0.9 }));

    const grounded = groundEntityTags(candidates, allowlist, book.description);
    expect(grounded.filter((t) => t.category === 'character')).toEqual([]);
  });
});

// R2 wiring: evaluableTagCategories/composeBookTags must read the RESOLVED
// (ABS-or-harvested) description via `enrichment/descriptionText.ts`, not
// `book.description` directly — otherwise a book R2 backfilled would still
// report `character` as un-evaluable even though `groundCharacter`'s
// fallback gate (which itself reads the resolved value) can now succeed.
describe('evaluableTagCategories reads the resolved description, not book.description directly', () => {
  it('includes character for a book with no person allowlist, null books.description, and an eligible descriptionEnriched', () => {
    const book: Book = {
      ...BOOK,
      id: 'r2-wired',
      description: null,
      descriptionEnriched: 'A story about Susan Delgado wandering the plains of Mid-World.',
      descriptionSource: 'audnexus',
    };

    expect(evaluableTagCategories(book, [])).toContain('character');
  });

  it('excludes character when both books.description and descriptionEnriched are absent', () => {
    const book: Book = { ...BOOK, id: 'r2-unwired', description: null, descriptionEnriched: null };
    expect(evaluableTagCategories(book, [])).not.toContain('character');
  });

  // Adversarial-review finding (minor): evaluableTagCategories reading the
  // resolved description was covered above, but composeBookTags' OWN
  // groundEntityTags call site (the thing that actually decides which
  // character tags survive) had no equivalent test — reverting just that
  // argument back to `book.description` left the full suite green. This
  // closes that gap directly, exercising composeBookTags end to end rather
  // than evaluableTagCategories.
  it('composeBookTags grounds a character tag via the R2-backfilled descriptionEnriched fallback when book.description is null and there is no person allowlist', () => {
    const db = freshDb();
    const book: Book = {
      ...BOOK,
      id: 'r2-grounds',
      description: null,
      descriptionEnriched: 'A story about Susan Delgado wandering the plains of Mid-World.',
      descriptionSource: 'audnexus',
    };
    db.upsertBook(book);
    // Deliberately no `db.replaceBookEntities` call: no person allowlist at all.

    const composed = composeBookTags(
      book,
      [{ tag: 'Susan Delgado', category: 'character' as const, confidence: 0.7 }],
      db
    );

    expect(composed).toContainEqual({
      tag: 'susan-delgado',
      category: 'character',
      confidence: 0.7,
      source: 'llm-open',
    });
  });
});
