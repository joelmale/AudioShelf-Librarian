import { describe, expect, it } from 'vitest';

import { DESCRIPTION_SOURCES } from '../types.js';
import type { Book } from '../types.js';
import { cleanHarvestedDescription, DESCRIPTION_SOURCE_PRECEDENCE, resolveDescription } from './descriptionText.js';

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b1',
    title: 'Test Book',
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
    ...overrides,
  };
}

describe('cleanHarvestedDescription', () => {
  it('replaces block-level close tags with a single space and strips remaining tags, with no doubled spaces', () => {
    const raw =
      '<p>Detective <b>Anna Pigeon</b> heads to the Dry Tortugas.</p><p>What she finds there will change her.</p>';
    expect(cleanHarvestedDescription(raw)).toBe(
      'Detective Anna Pigeon heads to the Dry Tortugas. What she finds there will change her.'
    );
  });

  it('decodes entities in a single pass, so &amp;lt; becomes the literal text &lt; and never double-decodes to <', () => {
    expect(cleanHarvestedDescription('&amp;lt;b&amp;gt; is how you escape a tag')).toBe(
      '&lt;b&gt; is how you escape a tag'
    );
  });

  it('decodes the named-entity table plus numeric decimal forms', () => {
    expect(cleanHarvestedDescription('&quot;Superb.&quot; &mdash;The Times &amp; Star&#39;s reviewer')).toBe(
      "\"Superb.\" —The Times & Star's reviewer"
    );
  });

  it('leaves a literal "<" in prose untouched and an unknown named entity verbatim', () => {
    expect(cleanHarvestedDescription('He knew 5 < 6 and that <em>speed</em> mattered.&trade;')).toBe(
      'He knew 5 < 6 and that speed mattered.&trade;'
    );
  });

  it('is idempotent on its own output for the tag-heavy case and for already-plain text', () => {
    const html =
      '<p>Detective <b>Anna Pigeon</b> heads to the Dry Tortugas.</p><p>What she finds there will change her.</p>';
    const once = cleanHarvestedDescription(html);
    expect(cleanHarvestedDescription(once)).toBe(once);

    const plain =
      'A quiet fishing town on the edge of the Gulf, where nothing ever happens until it does.';
    const cleanedPlain = cleanHarvestedDescription(plain);
    expect(cleanedPlain).toBe(plain);
    expect(cleanHarvestedDescription(cleanedPlain)).toBe(cleanedPlain);
  });

  it('collapses <br> variants and decodes &nbsp; to a plain space after whitespace collapse', () => {
    expect(cleanHarvestedDescription('Line one.<br>Line two.<br/>Line three.<br />Line four.')).toBe(
      'Line one. Line two. Line three. Line four.'
    );
    expect(cleanHarvestedDescription('A&nbsp;title&nbsp;here')).toBe('A title here');
  });

  // Adversarial-review finding (major): decoding used to run AFTER tag
  // stripping, so entity-escaped markup — common in publisher/ONIX-derived
  // Google Books payloads — was decoded back into LIVE tags on the very next
  // read and reached the card, the embedding text and the tagging prompt
  // verbatim. Decoding now runs first (see the function's docblock), so this
  // markup is stripped like any other tag instead of resurrected.
  it('strips markup that arrived HTML-entity-escaped, instead of decoding it back into live tags', () => {
    const raw =
      'A gripping tale of the deep. &lt;i&gt;Now a major motion picture&lt;/i&gt;. More padding to clear the floor.';
    const cleaned = cleanHarvestedDescription(raw);
    expect(cleaned).toBe('A gripping tale of the deep. Now a major motion picture. More padding to clear the floor.');
    expect(cleaned).not.toContain('<');
    expect(cleaned).not.toContain('>');
  });

  it('still decodes &amp;lt; to the literal text &lt; in one pass, not to a live "<" — reordering does not reintroduce double-decoding', () => {
    expect(cleanHarvestedDescription('&amp;lt;b&amp;gt; is how you escape a tag')).toBe(
      '&lt;b&gt; is how you escape a tag'
    );
  });

  it('drops HTML comments entirely, including their content', () => {
    expect(cleanHarvestedDescription('Real text before.<!-- hidden marketing --> Real text after.')).toBe(
      'Real text before. Real text after.'
    );
  });

  it('drops <style> and <script> elements together with their inner content, not just the tags', () => {
    expect(cleanHarvestedDescription('<style>p{color:red}</style>Real text here.')).toBe('Real text here.');
    expect(cleanHarvestedDescription('<script>alert(1)</script>Real text here.')).toBe('Real text here.');
  });

  it('also drops an entity-escaped <script> element and its content, not just a literal one', () => {
    expect(cleanHarvestedDescription('&lt;script&gt;alert(1)&lt;/script&gt;Real text here.')).toBe(
      'Real text here.'
    );
  });

  // Adversarial-review finding (minor): a malformed numeric entity used to
  // throw a RangeError out of `String.fromCodePoint`, which escaped the
  // per-book try/catch one level up in `computeDescriptionWinner` and cost
  // the book its next-best-precedence candidate. It must degrade to "leave
  // it verbatim", the same as an unrecognised named entity.
  it('leaves an out-of-range numeric entity verbatim instead of throwing', () => {
    expect(() => cleanHarvestedDescription('Broken: &#99999999999; end.')).not.toThrow();
    expect(cleanHarvestedDescription('Broken: &#99999999999; end.')).toBe('Broken: &#99999999999; end.');
    expect(() => cleanHarvestedDescription('Broken hex: &#xFFFFFFFF; end.')).not.toThrow();
  });
});

describe('resolveDescription', () => {
  it('returns the ABS description with source "abs" when non-blank, even when a harvested value is also present', () => {
    const book = makeBook({
      description: 'A Key West caper. Nothing goes to plan.',
      descriptionEnriched: 'A'.repeat(900),
      descriptionSource: 'googlebooks',
    });
    expect(resolveDescription(book)).toEqual({
      text: 'A Key West caper. Nothing goes to plan.',
      source: 'abs',
    });
  });

  it('does not compare lengths: a 40-char ABS description beats a 900-char harvested one', () => {
    const shortAbs = 'A Key West caper. Nothing goes to plan.';
    expect(shortAbs.length).toBeLessThan(100);
    const book = makeBook({ description: shortAbs, descriptionEnriched: 'B'.repeat(900), descriptionSource: 'audnexus' });
    expect(resolveDescription(book).text).toBe(shortAbs);
    expect(resolveDescription(book).source).toBe('abs');
  });

  it('treats a whitespace-only ABS description as absent and falls back to the harvested value', () => {
    const book = makeBook({ description: '   \n  ', descriptionEnriched: 'Harvested text.', descriptionSource: 'audnexus' });
    expect(resolveDescription(book)).toEqual({ text: 'Harvested text.', source: 'audnexus' });
  });

  it('falls back to the harvested description when ABS is null', () => {
    const book = makeBook({ description: null, descriptionEnriched: 'Harvested text.', descriptionSource: 'googlebooks' });
    expect(resolveDescription(book)).toEqual({ text: 'Harvested text.', source: 'googlebooks' });
  });

  it('returns a null text/source pair when neither ABS nor a harvested description is present', () => {
    const book = makeBook({ description: null, descriptionEnriched: null, descriptionSource: null });
    expect(resolveDescription(book)).toEqual({ text: null, source: null });
  });

  it('is safe against a Book-shaped object missing description/descriptionEnriched entirely (not just null)', () => {
    // Some call sites in this codebase construct partial Book-shaped test
    // doubles where the field is simply absent, not explicitly null (e.g.
    // mcp/server.test.ts's fixture books). resolveDescription must not throw.
    const partial = { id: 'x', title: 'X' } as unknown as Book;
    expect(() => resolveDescription(partial)).not.toThrow();
    expect(resolveDescription(partial)).toEqual({ text: null, source: null });
  });

  // Found 2026-09-03 on 5 real Key West Capers books: a re-encode with the
  // fre:ac tool leaked its own name into ABS's description field, and
  // resolveDescription's "ABS wins whenever non-blank" rule then fed that
  // sentinel to the tagger and the entity-notability scorer as if it were a
  // real blurb.
  it('treats the known fre:ac encoder-signature sentinel as absent, not a real ABS blurb', () => {
    const book = makeBook({
      description: 'fre:ac - free audio converter',
      descriptionEnriched: 'Harvested text.',
      descriptionSource: 'audnexus',
    });
    expect(resolveDescription(book)).toEqual({ text: 'Harvested text.', source: 'audnexus' });
  });

  it('matches the junk sentinel case-insensitively and around incidental whitespace', () => {
    const book = makeBook({ description: '  FRE:AC - Free Audio Converter  ', descriptionEnriched: null });
    expect(resolveDescription(book)).toEqual({ text: null, source: null });
  });

  it('does not treat a real description merely containing "fre:ac" as junk — only an exact sentinel match', () => {
    const real = 'Recorded and mastered with fre:ac before release, this Key West caper follows Pete Amsterdam.';
    const book = makeBook({ description: real });
    expect(resolveDescription(book)).toEqual({ text: real, source: 'abs' });
  });
});

// R5/R8 contract-widening commit (docs/enrichment-sources-review.md, R5/R8
// binding decision). These two guard the property the decision's whole
// safety argument rests on: DESCRIPTION_SOURCES (the decode-validation set,
// `core/types.ts`) and DESCRIPTION_SOURCE_PRECEDENCE (the winner-selection
// order, this file) must always name exactly the same four providers.
// TypeScript cannot prove that on its own — DescriptionSource is derived
// FROM DESCRIPTION_SOURCES, so a member present in precedence but absent
// from the union would already fail to typecheck, but the reverse (a member
// validated on decode yet never consulted by computeDescriptionWinner) is
// invisible to the type system and would only surface as a book silently
// unable to ever attribute to that source. Only a runtime check catches it.
describe('DescriptionSource contract shape (R5/R8 widening)', () => {
  it('DESCRIPTION_SOURCES and DESCRIPTION_SOURCE_PRECEDENCE contain exactly the same members, no duplicates', () => {
    const sources = new Set(DESCRIPTION_SOURCES);
    const precedence = new Set(DESCRIPTION_SOURCE_PRECEDENCE);
    expect(sources).toEqual(precedence);
    expect(DESCRIPTION_SOURCES.length).toBe(sources.size);
    expect(DESCRIPTION_SOURCE_PRECEDENCE.length).toBe(precedence.size);
    expect(DESCRIPTION_SOURCES.length).toBe(4);
    expect(DESCRIPTION_SOURCE_PRECEDENCE.length).toBe(4);
  });

  // Pinned exactly, not just set-compared: a reorder rewrites already-
  // backfilled description attribution the next time backfillDescriptions
  // runs (computeDescriptionWinner recomputes every book's winner from
  // scratch, from whatever is currently cached, on every run — see that
  // module's docblock). A future reorder must show up here as a deliberate,
  // reviewable diff to this assertion, not as a quiet constant edit.
  it('pins the exact precedence order: audnexus, wikidata, googlebooks, openlibrary', () => {
    expect(DESCRIPTION_SOURCE_PRECEDENCE).toEqual(['audnexus', 'wikidata', 'googlebooks', 'openlibrary']);
  });
});
