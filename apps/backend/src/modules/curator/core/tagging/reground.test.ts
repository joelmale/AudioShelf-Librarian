import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../db.js';
import { TAG_SCHEMA_VERSION, type Book, type GeneratedTag } from '../types.js';
import { composeBookTags, evaluableTagCategories } from './compose.js';
import { regroundBooks } from './reground.js';
import { serializeProposals, tagComposeHash, tagPromptHash, vocabularyFingerprint } from './tagInputs.js';

const MODEL = 'claude-test';

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
  durationSeconds: 4 * 3600,
  publishedYear: 1986,
  genres: [],
  description: null,
  coverPath: null,
  absAddedAt: null,
  lastSyncedAt: 1000,
};

const PROPOSALS: GeneratedTag[] = [
  { tag: 'Ben Hannigan', category: 'character', confidence: 0.8 },
  { tag: 'HardSciFi', category: 'genre', confidence: 0.9 },
];

/**
 * Do what `tagger.ts` does after a successful model call: compose, store, and
 * record the run's freshness identity — without calling a model.
 */
function tagAsTaggerWould(db: CuratorDb, book: Book, proposals: GeneratedTag[], at: number): void {
  const entities = db.getEntitiesForBook(book.id);
  const fingerprint = vocabularyFingerprint(db.getVocabFingerprintRows());
  db.replaceBookTags(book.id, composeBookTags(book, proposals, db), at);
  db.recordTagRun(book.id, evaluableTagCategories(book, entities), TAG_SCHEMA_VERSION, at, {
    proposals: serializeProposals(proposals),
    promptHash: tagPromptHash(book, MODEL, TAG_SCHEMA_VERSION),
    composeHash: tagComposeHash(book, entities, fingerprint, db.getTagSuppressionsForBook(book.id)),
  });
}

function tagStrings(db: CuratorDb, bookId: string): string[] {
  return db
    .getTagsForBook(bookId)
    .map((t) => `${t.category}:${t.tag}@${t.source}`)
    .sort();
}

describe('regroundBooks', () => {
  it('recovers a dropped character after enrichment supplies the entity, with no model call', async () => {
    // The exact loop that was broken: enrichment improves the grounding
    // allowlist, and until now the only way to apply it was a paid retagAll.
    const db = freshDb();
    db.upsertBook(BOOK);
    tagAsTaggerWould(db, BOOK, PROPOSALS, 1000);

    // Tagged with no allowlist and no description: the character was dropped.
    expect(tagStrings(db, 'it')).not.toContain('character:benjamin-hanscom@external:openlibrary');
    expect(db.getTagsForBook('it').some((t) => t.category === 'character')).toBe(false);

    db.replaceBookEntities('it', [{ entity: 'Benjamin Hanscom', kind: 'person', sources: ['openlibrary'] }]);

    const result = await regroundBooks(db, { taggingModel: MODEL, now: () => 2000 });

    expect(result.needsRetag).toBe(0);
    expect(result.regroundable).toBe(1);
    expect(result.changed).toBe(1);
    expect(result.changedBookIds).toEqual(['it']);
    expect(result.byReason['compose-changed']).toBe(1);
    expect(tagStrings(db, 'it')).toContain('character:benjamin-hanscom@external:openlibrary');
  });

  it('writes nothing and reports no change when the recomposed tags are identical', async () => {
    // Vocabulary edits mark the whole library compose-stale. That is only
    // affordable because a no-op recompose costs no write and triggers no
    // re-embed.
    const db = freshDb();
    db.upsertBook(BOOK);
    tagAsTaggerWould(db, BOOK, PROPOSALS, 1000);
    const before = tagStrings(db, 'it');

    // An entity the proposals cannot match: the allowlist moved, the output cannot.
    db.replaceBookEntities('it', [{ entity: 'Someone Unrelated', kind: 'person', sources: ['openlibrary'] }]);

    const result = await regroundBooks(db, { taggingModel: MODEL, now: () => 2000 });

    expect(result.regroundable).toBe(1);
    expect(result.changed).toBe(0);
    expect(result.changedBookIds).toEqual([]);
    expect(tagStrings(db, 'it')).toEqual(before);
  });

  it('leaves a book whose run kept no proposals alone, and counts it as needing the model', async () => {
    const db = freshDb();
    db.upsertBook(BOOK);
    // A pre-mechanism run: tags exist, no proposals, no hashes.
    db.replaceBookTags(db.getBook('it')!.id, composeBookTags(BOOK, PROPOSALS, db), 1000);
    db.recordTagRun('it', evaluableTagCategories(BOOK, []), TAG_SCHEMA_VERSION, 1000);
    const before = tagStrings(db, 'it');

    const result = await regroundBooks(db, { taggingModel: MODEL, now: () => 2000 });

    expect(result.needsRetag).toBe(1);
    expect(result.regroundable).toBe(0);
    expect(result.byReason['never-recorded']).toBe(1);
    expect(tagStrings(db, 'it')).toEqual(before);
  });

  it('reports a prompt change as needing the model instead of re-grounding stale proposals', async () => {
    const db = freshDb();
    db.upsertBook(BOOK);
    tagAsTaggerWould(db, BOOK, PROPOSALS, 1000);
    const before = tagStrings(db, 'it');

    // A harvested description lands: the model would now be told something
    // it was never told before, so its cached proposals are not a valid
    // basis for a recompose.
    // Via the dedicated setter: `upsertBook` deliberately does not touch the
    // harvested-description columns (it is the ABS mirror path).
    db.setEnrichedDescription('it', { text: 'Seven children face a shapeshifting evil.', source: 'openlibrary' });

    const result = await regroundBooks(db, { taggingModel: MODEL, now: () => 2000 });

    expect(result.byReason['prompt-changed']).toBe(1);
    expect(result.needsRetag).toBe(1);
    expect(result.changed).toBe(0);
    expect(tagStrings(db, 'it')).toEqual(before);
  });

  it('skips a book whose stored hashes still match', async () => {
    const db = freshDb();
    db.upsertBook(BOOK);
    tagAsTaggerWould(db, BOOK, PROPOSALS, 1000);

    const result = await regroundBooks(db, { taggingModel: MODEL, now: () => 2000 });

    expect(result.booksScanned).toBe(1);
    expect(result.regroundable).toBe(0);
    expect(result.needsRetag).toBe(0);
    expect(Object.values(result.byReason).every((n) => n === 0)).toBe(true);
  });

  it('writes nothing on a dry run but still reports what would change', async () => {
    const db = freshDb();
    db.upsertBook(BOOK);
    tagAsTaggerWould(db, BOOK, PROPOSALS, 1000);
    const before = tagStrings(db, 'it');
    db.replaceBookEntities('it', [{ entity: 'Benjamin Hanscom', kind: 'person', sources: ['openlibrary'] }]);

    const result = await regroundBooks(db, { taggingModel: MODEL, dryRun: true, now: () => 2000 });

    expect(result.changed).toBe(1);
    expect(result.examples).toHaveLength(1);
    expect(tagStrings(db, 'it')).toEqual(before);
    // `changedBookIds` is still reported — it is the plan — so `dryRun` is
    // what the route gates the re-embed on. See the tags route.
    expect(result.dryRun).toBe(true);
    expect(result.changedBookIds).toEqual(['it']);
  });

  it('records a fresh identity for a no-op recompose so the next pass stops re-examining it', async () => {
    const db = freshDb();
    db.upsertBook(BOOK);
    tagAsTaggerWould(db, BOOK, PROPOSALS, 1000);
    db.replaceBookEntities('it', [{ entity: 'Someone Unrelated', kind: 'person', sources: ['openlibrary'] }]);

    await regroundBooks(db, { taggingModel: MODEL, now: () => 2000 });
    const second = await regroundBooks(db, { taggingModel: MODEL, now: () => 3000 });

    expect(second.regroundable).toBe(0);
    expect(second.byReason['compose-changed']).toBe(0);
  });

  it('scopes to bookIds when given', async () => {
    const db = freshDb();
    const other: Book = { ...BOOK, id: 'other', title: 'Other' };
    db.upsertBook(BOOK);
    db.upsertBook(other);
    tagAsTaggerWould(db, BOOK, PROPOSALS, 1000);
    tagAsTaggerWould(db, other, PROPOSALS, 1000);
    db.replaceBookEntities('it', [{ entity: 'Benjamin Hanscom', kind: 'person', sources: ['openlibrary'] }]);
    db.replaceBookEntities('other', [{ entity: 'Benjamin Hanscom', kind: 'person', sources: ['openlibrary'] }]);

    const result = await regroundBooks(db, { taggingModel: MODEL, bookIds: ['it'], now: () => 2000 });

    expect(result.booksScanned).toBe(1);
    expect(result.changedBookIds).toEqual(['it']);
    expect(db.getTagsForBook('other').some((t) => t.category === 'character')).toBe(false);
  });
});

describe('regroundBooks — human suppressions', () => {
  it('applies a curator retraction for free, and it survives the next re-tag', async () => {
    // The loop this whole store exists for. A hand-deleted book_tags row
    // survives exactly until the next re-tag proposes the tag again; a
    // suppression is an input to compose, so it holds.
    const db = freshDb();
    db.upsertBook(BOOK);
    tagAsTaggerWould(db, BOOK, PROPOSALS, 1000);
    expect(tagStrings(db, 'it')).toContain('genre:hard-sci-fi@vocab');

    db.addTagSuppression('it', 'hard-sci-fi', 'genre', 1500, 'horror, not sci-fi');

    // Recording the verdict moved composeHash alone, so the book routes to a
    // free recompose from stored proposals — never a paid re-tag.
    const result = await regroundBooks(db, { taggingModel: MODEL, now: () => 2000 });
    expect(result.needsRetag).toBe(0);
    expect(result.regroundable).toBe(1);
    expect(result.changed).toBe(1);
    expect(result.byReason['compose-changed']).toBe(1);
    expect(tagStrings(db, 'it')).not.toContain('genre:hard-sci-fi@vocab');

    // The model proposes it again on the very next run. It must not come back.
    tagAsTaggerWould(db, BOOK, PROPOSALS, 3000);
    expect(tagStrings(db, 'it')).not.toContain('genre:hard-sci-fi@vocab');
  });

  it('settles: a suppressed book is not re-examined forever by later passes', async () => {
    const db = freshDb();
    db.upsertBook(BOOK);
    tagAsTaggerWould(db, BOOK, PROPOSALS, 1000);
    db.addTagSuppression('it', 'hard-sci-fi', 'genre', 1500);

    await regroundBooks(db, { taggingModel: MODEL, now: () => 2000 });
    // The first pass recorded a run at the new composeHash, so the second
    // finds nothing stale — the suppression is applied, not re-applied.
    const second = await regroundBooks(db, { taggingModel: MODEL, now: () => 3000 });
    expect(second.changed).toBe(0);
    expect(second.needsRetag).toBe(0);
  });
});
