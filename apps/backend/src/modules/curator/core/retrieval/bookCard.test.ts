import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book, BookEntity, BookTag } from '../types.js';
import { cardHash, composeBookCard, composeBookCardFromDb } from './bookCard.js';
import type { FixtureBook } from './fixtures/library.js';
import { FIXTURE_NOW, fixtureBook, seedFixtureLibrary } from './fixtures/library.js';

// ── Fixture conversion helpers ────────────────────────────────────────────
// FixtureBook/FixtureTag/FixtureEntity (fixtures/library.ts) are the seed
// shapes used to populate the db; composeBookCard takes the domain types
// (Book/BookTag/BookEntity) as read back from CuratorDb, so tests that call
// composeBookCard directly (without a db round-trip) convert between them.

function toBook(fb: FixtureBook): Book {
  return {
    id: fb.id,
    title: fb.title,
    author: fb.author,
    series: fb.series,
    seriesSequence: fb.seriesSequence,
    durationSeconds: fb.durationSeconds,
    publishedYear: fb.publishedYear,
    genres: fb.genres,
    description: fb.description,
    coverPath: null,
    absAddedAt: FIXTURE_NOW,
    lastSyncedAt: FIXTURE_NOW,
  };
}

function toTags(fb: FixtureBook): BookTag[] {
  return fb.tags.map((t, i) => ({
    id: i + 1,
    bookId: fb.id,
    tag: t.tag,
    category: t.category,
    confidence: t.confidence,
    taggedAt: FIXTURE_NOW,
    source: t.source,
  }));
}

function toEntities(fb: FixtureBook): BookEntity[] {
  return fb.entities.map((e) => ({
    bookId: fb.id,
    entity: e.entity,
    kind: e.kind,
    sources: e.sources,
  }));
}

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'test-book',
    title: 'Test Book',
    author: 'Test Author',
    series: null,
    seriesSequence: null,
    durationSeconds: 3600,
    publishedYear: 2020,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
    ...overrides,
  };
}

describe('composeBookCard', () => {
  it('produces the exact golden card for fx-01', () => {
    const fb = fixtureBook('fx-01');
    const card = composeBookCard(toBook(fb), toTags(fb), toEntities(fb));

    const expectedText = [
      'Title: The Lighthouse at Bell Harbor',
      'Author: Elena Marsh',
      'genre: literary-fiction',
      'mood: melancholic, wistful',
      'era: modern',
      'pacing: slow-burn',
      'length: medium',
      'audience: adult',
      'setting: coastal-town, autumn',
      'People: Elena Ward',
      'Places: Bell Harbor, Maine',
      'Times: 1990s',
      'Description: Every autumn, the fog rolls into Bell Harbor and swallows the lighthouse whole, ' +
        'and every autumn Marguerite climbs the spiral stairs to keep a vigil no one asked her to keep. ' +
        "Twenty years after her sister vanished into that same fog, she still measures the seasons by " +
        'the particular melancholy of a Maine coastline in October — the wet slate light, the gulls ' +
        "gone quiet, the smell of woodsmoke over brine. A stranger's arrival unsettles the town's " +
        'careful grief, and Marguerite must decide whether wistful remembering has become its own kind ' +
        'of hiding.',
    ].join('\n');

    // Pinned literal digest (not `cardHash(expectedText)`) — card_hash is a
    // persisted column, so this must catch a change to the hash algorithm
    // itself (e.g. sha256 -> sha1, or dropping the 'utf8' encoding), not
    // just assert the function agrees with its own output.
    const expectedHash = '77e83a460f6af5f110da474a78ad7dc8db809d995cb6dd7002d8a25ae11e26c2';

    expect(card.bookId).toBe('fx-01');
    expect(card.text).toBe(expectedText);
    expect(card.hash).toBe(cardHash(expectedText));
    expect(card.hash).toBe(expectedHash);
    expect(card.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('formats a series with a sequence number as "Series: <name>, Book <n>"', () => {
    const kestrelOne = fixtureBook('fx-24');
    const cardOne = composeBookCard(toBook(kestrelOne), toTags(kestrelOne), toEntities(kestrelOne));
    expect(cardOne.text.split('\n')).toContain('Series: The Kestrel Line, Book 1');

    const kestrelTwo = fixtureBook('fx-25');
    const cardTwo = composeBookCard(toBook(kestrelTwo), toTags(kestrelTwo), toEntities(kestrelTwo));
    expect(cardTwo.text.split('\n')).toContain('Series: The Kestrel Line, Book 2');

    const hearthglowOne = fixtureBook('fx-27');
    const cardHearth = composeBookCard(
      toBook(hearthglowOne),
      toTags(hearthglowOne),
      toEntities(hearthglowOne)
    );
    expect(cardHearth.text.split('\n')).toContain('Series: Hearthglow, Book 1');
  });

  it('contains the vibe-facet lines that vibe queries depend on', () => {
    const fb = fixtureBook('fx-01');
    const card = composeBookCard(toBook(fb), toTags(fb), toEntities(fb));

    expect(card.text).toContain('mood: melancholic');
    const settingLine = card.text.split('\n').find((l) => l.startsWith('setting:'));
    expect(settingLine).toBeDefined();
    expect(settingLine).toContain('coastal-town');
    expect(settingLine).toContain('autumn');
  });

  it('is deterministic across repeated calls and independent of input array order', () => {
    const fb = fixtureBook('fx-01');
    const book = toBook(fb);
    const tags = toTags(fb);
    const entities = toEntities(fb);

    const first = composeBookCard(book, tags, entities);
    const second = composeBookCard(book, tags, entities);
    expect(second.text).toBe(first.text);
    expect(second.hash).toBe(first.hash);

    // Shuffling (reversing) the input arrays must not change the output —
    // the internal sort is what fixes the order, not the input order.
    const shuffled = composeBookCard(book, [...tags].reverse(), [...entities].reverse());
    expect(shuffled.text).toBe(first.text);
    expect(shuffled.hash).toBe(first.hash);
  });

  it('changes the hash when a tag confidence change reorders a tag line', () => {
    const fb = fixtureBook('fx-01');
    const book = toBook(fb);
    const tags = toTags(fb);
    const entities = toEntities(fb);
    const original = composeBookCard(book, tags, entities);

    // Bump 'wistful' above 'melancholic' so the mood line's order flips.
    const reordered = tags.map((t) => (t.tag === 'wistful' ? { ...t, confidence: 0.99 } : t));
    const changed = composeBookCard(book, reordered, entities);

    expect(changed.text).not.toBe(original.text);
    expect(changed.hash).not.toBe(original.hash);
  });

  it('changes the hash when the title changes', () => {
    const fb = fixtureBook('fx-01');
    const book = toBook(fb);
    const tags = toTags(fb);
    const entities = toEntities(fb);
    const original = composeBookCard(book, tags, entities);

    const retitled = { ...book, title: 'A Completely Different Title' };
    const changed = composeBookCard(retitled, tags, entities);

    expect(changed.hash).not.toBe(original.hash);
  });

  it('truncates a long description at a whitespace boundary and appends an ellipsis', () => {
    const words = Array.from({ length: 200 }, (_, i) => `lighthouse${i}`);
    const longDescription = words.join(' ');
    const book = makeBook({ description: longDescription });
    const card = composeBookCard(book, [], []);

    const descLine = card.text.split('\n').find((l) => l.startsWith('Description: '));
    expect(descLine).toBeDefined();
    const content = descLine!.slice('Description: '.length);

    expect(content.length).toBeLessThanOrEqual(801); // descriptionChars(800) + ellipsis char
    expect(content.endsWith('…')).toBe(true);

    const withoutEllipsis = content.slice(0, -1);
    expect(longDescription.startsWith(withoutEllipsis)).toBe(true);
    // Cut lands on a whitespace boundary: the next original character must be
    // a space (or nothing), never a mid-word character.
    const nextChar = longDescription[withoutEllipsis.length];
    expect(nextChar === ' ' || nextChar === undefined).toBe(true);
  });

  it('respects a custom descriptionChars option', () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`);
    const longDescription = words.join(' ');
    const book = makeBook({ description: longDescription });
    const card = composeBookCard(book, [], [], { descriptionChars: 20 });

    const descLine = card.text.split('\n').find((l) => l.startsWith('Description: '));
    const content = descLine!.slice('Description: '.length);
    expect(content.length).toBeLessThanOrEqual(21);
    expect(content.endsWith('…')).toBe(true);
  });

  it('emits a short description verbatim with no ellipsis', () => {
    const book = makeBook({ description: 'A short summary of the book.' });
    const card = composeBookCard(book, [], []);
    expect(card.text).toContain('Description: A short summary of the book.');
    expect(card.text).not.toContain('…');
  });

  it('collapses whitespace runs (including newlines) identically to the pre-collapsed equivalent', () => {
    const messy = 'A   book\nabout\n\n  strange   weather.\nTitle line too.';
    const clean = 'A book about strange weather. Title line too.';
    const cardMessy = composeBookCard(makeBook({ description: messy }), [], []);
    const cardClean = composeBookCard(makeBook({ description: clean }), [], []);
    expect(cardMessy.text).toBe(cardClean.text);
  });

  it('produces just the Title line when author, series, tags, entities and description are all absent', () => {
    const book = makeBook({
      title: 'Bare Bones',
      author: null,
      series: null,
      seriesSequence: null,
      description: null,
    });
    const card = composeBookCard(book, [], []);
    expect(card.text).toBe('Title: Bare Bones');
  });

  it('sorts entities that differ only in case deterministically, independent of input order', () => {
    // book_entities has no case-normalizing constraint (PRIMARY KEY is BINARY
    // collation), so 'Bell Harbor' and 'bell harbor' can legally coexist for
    // the same book if two providers disagree on casing. A comparator keyed
    // on a lowercased-only value can't distinguish them and falls back to
    // input order, which would make the hash order-dependent.
    const book = makeBook({ author: null });
    const entities: BookEntity[] = [
      { bookId: book.id, entity: 'Bell Harbor', kind: 'place', sources: [] },
      { bookId: book.id, entity: 'bell harbor', kind: 'place', sources: [] },
    ];

    const forward = composeBookCard(book, [], entities);
    const reversed = composeBookCard(book, [], [...entities].reverse());

    expect(forward.text).toBe('Title: Test Book\nPlaces: Bell Harbor, bell harbor');
    expect(reversed.text).toBe(forward.text);
    expect(reversed.hash).toBe(forward.hash);
  });

  it('breaks a confidence tie between same-category tags alphabetically, independent of input order', () => {
    // No two fixture-library tags in the same category share a confidence,
    // so without a real test the alphabetical tiebreak could be deleted
    // without any test going red. Two same-category tags at equal
    // confidence are entirely plausible in production LLM output.
    const book = makeBook({ author: null });
    const tags: BookTag[] = [
      { id: 1, bookId: book.id, tag: 'zesty', category: 'mood', confidence: 0.8, taggedAt: 0, source: 'vocab' },
      { id: 2, bookId: book.id, tag: 'amused', category: 'mood', confidence: 0.8, taggedAt: 0, source: 'vocab' },
    ];

    const forward = composeBookCard(book, tags, []);
    const reversed = composeBookCard(book, [...tags].reverse(), []);

    expect(forward.text).toBe('Title: Test Book\nmood: amused, zesty');
    expect(reversed.text).toBe(forward.text);
    expect(reversed.hash).toBe(forward.hash);
  });

  it('omits the Description line entirely when descriptionChars is zero or negative', () => {
    const book = makeBook({ description: 'Some description text that would otherwise be included.' });

    const zero = composeBookCard(book, [], [], { descriptionChars: 0 });
    const negative = composeBookCard(book, [], [], { descriptionChars: -5 });

    expect(zero.text).toBe('Title: Test Book\nAuthor: Test Author');
    expect(negative.text).toBe(zero.text);
  });

  it('backs a truncation cut off by one code unit rather than splitting a surrogate pair', () => {
    // U+1D306 TETRAGRAM FOR CENTRE is a single codepoint spanning two UTF-16
    // code units. Placed so the pair straddles the default 800-char cutoff,
    // and with no whitespace anywhere in the string (exercising the
    // no-whitespace-in-range hard-cut path at the same time), a naive
    // `slice(0, 800)` would emit a lone high surrogate.
    const astral = '\u{1D306}';
    const longDescription = 'x'.repeat(799) + astral + 'y'.repeat(50);
    const book = makeBook({ description: longDescription });
    const card = composeBookCard(book, [], []);

    const descLine = card.text.split('\n').find((l) => l.startsWith('Description: '));
    expect(descLine).toBeDefined();
    const content = descLine!.slice('Description: '.length);

    expect(content.endsWith('…')).toBe(true);
    // A lone surrogate is invalid UTF-16/UTF-8; encodeURIComponent throws a
    // URIError on one, so this is a direct check for "no orphaned surrogate".
    expect(() => encodeURIComponent(content)).not.toThrow();
  });
});

describe('composeBookCardFromDb', () => {
  const databases: CuratorDb[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function seededDb(): CuratorDb {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-bookcard-'));
    tempDirs.push(dir);
    const db = new CuratorDb(path.join(dir, 'lib.db'));
    databases.push(db);
    seedFixtureLibrary(db);
    return db;
  }

  it('matches composeBookCard called with the same book/tags/entities read back from the db', () => {
    const db = seededDb();

    const card = composeBookCardFromDb(db, 'fx-01');
    expect(card).not.toBeNull();

    const book = db.getBook('fx-01');
    expect(book).toBeDefined();
    const tags = db.getTagsForBook('fx-01');
    const entities = db.getEntitiesForBook('fx-01');
    const expected = composeBookCard(book!, tags, entities);

    expect(card).toEqual(expected);
  });

  it('returns null for an unknown book id', () => {
    const db = seededDb();
    expect(composeBookCardFromDb(db, 'not-a-real-id')).toBeNull();
  });

  it('passes options through to composeBookCard (e.g. a custom descriptionChars)', () => {
    // Both prior db tests call composeBookCardFromDb with no options, so
    // dropping the `options` argument at the call site would still pass them.
    const db = seededDb();

    const withDefault = composeBookCardFromDb(db, 'fx-01');
    const withCustom = composeBookCardFromDb(db, 'fx-01', { descriptionChars: 20 });
    expect(withDefault).not.toBeNull();
    expect(withCustom).not.toBeNull();
    expect(withCustom!.text).not.toBe(withDefault!.text);

    const descLine = withCustom!.text.split('\n').find((l) => l.startsWith('Description: '));
    expect(descLine).toBeDefined();
    expect(descLine!.slice('Description: '.length).length).toBeLessThanOrEqual(21);
  });
});
