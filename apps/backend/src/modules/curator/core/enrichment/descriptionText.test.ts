import { describe, expect, it } from 'vitest';

import type { Book } from '../types.js';
import { cleanHarvestedDescription, resolveDescription } from './descriptionText.js';

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
});
