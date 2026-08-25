/**
 * Filename-derived title parsing.
 *
 * Audiobook titles arrive shaped by whoever named the files, not by a
 * cataloguer: `24 - Snow Crash - Neal Stephenson - 1992`, `2_ Apt Pupil`,
 * `3 Past Midnight - The Library Policeman`. A live probe against Open
 * Library confirmed six of seven such titles resolve once cleaned, so this
 * is the largest single lever on enrichment coverage — larger than adding
 * another provider, because every provider receives the same broken query.
 *
 * Two rules shape the whole module:
 *
 * 1. **Parse, never destroy.** This function is pure and returns components.
 *    A caller may use them to fill *missing* metadata, but the original title
 *    is echoed back untouched and is never implied to be replaceable. For
 *    many books the author or year exists ONLY inside the title string.
 *
 * 2. **A known author is a verifier, not just a target.** A naive
 *    "longest segment wins" heuristic picks `Neal Stephenson` out of
 *    `24 - Snow Crash - Neal Stephenson - 1992`, and a probe then returned
 *    *Reamde* — a real, wrong book by the same author. A false match is worse
 *    than no match, because it writes plausible entities for the wrong work.
 *    When `knownAuthor` identifies a segment, that segment is removed with
 *    certainty and what remains is confidently the title.
 *
 * Where the parser genuinely cannot know which segment is the title — the
 * `3 Past Midnight - The Library Policeman` shape, where either half could be
 * it — it does not guess once and commit. It returns `candidateTitles`
 * best-first so the caller can try each against a provider that already
 * performs match verification.
 */

export interface TitleParse {
  /** The input, echoed verbatim. Nothing here replaces it. */
  original: string;
  /** Best-guess title. Never empty — falls back to the cleaned original. */
  normalizedTitle: string;
  /**
   * `normalizedTitle` first, then other plausible titles, deduped. Callers
   * should try these in order against a verifying lookup rather than trusting
   * the first.
   */
  candidateTitles: string[];
  /** Only when confidently identified. Never invented. */
  author: string | null;
  year: number | null;
  /**
   * A leading number, recorded but deliberately NOT to be written to
   * `seriesSequence` by callers: the same syntax means a personal list
   * position in `52 - Frankenstein` and a story index in `2_ Apt Pupil`.
   * A wrong series number reorders a library, which is worse than none.
   */
  ordinal: number | null;
  /**
   * Series name and position, from a leading `<Series> <NN>` segment.
   *
   * Deliberately separate from `ordinal`, and trustworthy where `ordinal` is
   * not. A bare leading number could be a personal list position (`52 -
   * Frankenstein`), which is why callers must never write `ordinal` to
   * `series_sequence`. `Pern 09 - Nerilka's Story` names the series next to the
   * number, so the ambiguity that justified that caution does not apply — this
   * IS the ninth Pern book. 127 of 954 books here carry this shape, across
   * Outlanders, Xanth, Survivalist, Doomsday Warrior, Pern and Dragonlance.
   */
  series: string | null;
  seriesSequence: number | null;
  /** `high` once the author is confirmed or only one candidate survives. */
  confidence: 'high' | 'low';
}

/** Plausible publication years. Bounded so `2001: A Space Odyssey` is a title. */
const MIN_YEAR = 1400;
const MAX_YEAR = 2100;

/**
 * Split on ` - ` style separators, but never inside brackets: a real title
 * `A Dangerous Fortune (24 MP3s - U)` was otherwise cut mid-parenthesis into
 * `A Dangerous Fortune (24 MP3s`.
 */
function splitSegments(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);

    if (depth === 0 && /\s/.test(ch)) {
      const rest = value.slice(i);
      const sep = rest.match(/^\s+[-–—]\s+/);
      if (sep) {
        out.push(current);
        current = '';
        i += sep[0].length - 1;
        continue;
      }
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * Compare PERSON names ignoring case, punctuation, spacing, and **word
 * order**.
 *
 * AudiobookShelf commonly catalogues authors surname-first. A sequence-based
 * comparison scored `Stephenson, Neal` against a title's `Neal Stephenson` as
 * a mismatch, so the author could not be confirmed and the parse fell back to
 * low-confidence inference. On a 958-book run that left 144 rows flagged
 * low-confidence for what was purely a formatting difference, which drowns the
 * rows carrying real uncertainty.
 *
 * Token-set comparison is safe for names and only for names — two different
 * authors sharing the same name tokens in a different order does not happen in
 * practice. It is NOT safe for titles, which is why `titleKey` stays
 * order-sensitive.
 */
function nameKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Compare TITLES ignoring case, punctuation, and spacing — but NOT word order.
 * Deliberately distinct from `nameKey`: order carries meaning in a title, and
 * an order-insensitive key would merge genuinely different candidates.
 */
function titleKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isYearToken(token: string): boolean {
  if (!/^\d{4}$/.test(token)) return false;
  const n = Number(token);
  return n >= MIN_YEAR && n <= MAX_YEAR;
}

function stripEditionMarkers(value: string): string {
  return value.replace(/\s*\((?:un)?abridged\)\s*/gi, ' ');
}

function tidy(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—_.:,]+/, '')
    .replace(/[\s\-–—_.:,]+$/, '')
    .trim();
}

/**
 * Remove a leading ordinal from one segment.
 *
 * Deliberately conservative in two ways:
 *  - a number in the year range is never an ordinal, so `2001: A Space
 *    Odyssey` survives intact;
 *  - a number followed by a lowercase word is part of the title, so
 *    `#1 in Customer Service: …` survives intact.
 */
function splitLeadingOrdinal(segment: string): { ordinal: number | null; rest: string } {
  const match = segment.match(/^#?(\d{1,4})(\s*[-_.:]\s*|\s+)(.*)$/s);
  if (!match) return { ordinal: null, rest: segment };

  const [, digits, separator, remainder] = match;
  if (isYearToken(digits)) return { ordinal: null, rest: segment };
  if (remainder.trim().length === 0) return { ordinal: null, rest: segment };

  // A bare space before a lowercase word means the number is part of the
  // sentence ("#1 in Customer Service"), not a catalogue prefix.
  const hardSeparator = /[-_.:]/.test(separator);
  if (!hardSeparator && !/^[A-Z0-9"'(]/.test(remainder.trim())) {
    return { ordinal: null, rest: segment };
  }

  return { ordinal: Number(digits), rest: remainder };
}

/**
 * Recognise a leading `<Series Name> <NN>` segment.
 *
 * The number must END the segment, which is what separates this from the
 * shapes the parser already handles: `3 Past Midnight` (number leads, so it is
 * a collection prefix) and `24` (bare number, so it is an ordinal of unknown
 * meaning). Here the words before the digits name the series, so both parts
 * are recoverable.
 *
 * Absorbs an optional "Volume"/"Book"/"Part" noise word so
 * `Dragonlance Legends Volume 2` yields series `Dragonlance Legends`, not
 * `Dragonlance Legends Volume`.
 *
 * Returns null for a year, so a hypothetical `Something 1984 - Title` is not
 * read as book 1984 of a series.
 */
function splitSeriesSequence(segment: string): { series: string; sequence: number } | null {
  // Capture ALL trailing digits, not up to three: `(\d{1,3})$` matched just
  // "984" of `Something 1984`, leaving the leading "1" in the name and letting
  // a year through as series position 984.
  const match = segment.match(/^(.*[A-Za-z].*?)\s*(\d+)$/);
  if (!match) return null;

  const [, name, digits] = match;
  if (digits.length > 3 || isYearToken(digits)) return null;

  // Strip the noise word AFTER matching rather than inside the pattern: the
  // leading group is greedy, so an optional `(?:volume|book)?` alternative
  // never gets a chance and `Dragonlance Legends Volume 2` keeps "Volume".
  const series = tidy(name).replace(/[\s,]*(?:volumes?|vol\.?|books?|parts?|no\.?|#)$/i, '');
  // A one-character "series" is noise, not a name.
  if (series.length < 2) return null;

  return { series, sequence: Number(digits) };
}

/**
 * Roman numerals accepted as a series position.
 *
 * An explicit set, not a pattern: `[ivxlcdm]+` matches "mix" (a valid roman
 * numeral for 1009) and "civil", so a regex would classify *Mix* and *Civil*
 * as series labels. Single `i`/`v`/`x` are excluded for the same reason — they
 * are plausible one-letter titles.
 */
const ROMAN_POSITIONS = new Set(['ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix', 'xi', 'xii', 'xiii', 'xiv', 'xv']);

/** A bare volume word, as the whole prefix or trailing it. */
const VOLUME_WORD = /^(?:volumes?|vol\.?|books?|parts?|pt\.?|no\.?|#)$/i;

/**
 * True when a segment reads as a series/volume LABEL (`Chronicles 01`,
 * `The Murderbot Diaries 07`, `Companions Codex II`, `Vol 2`) rather than the
 * name of a work.
 *
 * Only used to demote such a segment below a sibling that looks like a real
 * title — never to discard one. See the demotion note in `parseTitle`.
 *
 * The prefix test is what separates a label from a title that merely ends in a
 * part number: `Rise of the King pt 1` ends with a volume word before the
 * digit, which marks it as a work subdivided into parts, so it is NOT a label.
 * `The Murderbot Diaries 07` has no such word and IS one.
 */
export function looksLikeSeriesLabel(segment: string): boolean {
  const match = segment.match(/^(.+?)[\s,]+(\d{1,3}|[A-Za-z]+)$/);
  if (!match) return false;

  const [, prefix, position] = match;
  const isArabic = /^\d{1,3}$/.test(position);
  if (!isArabic && !ROMAN_POSITIONS.has(position.toLowerCase())) return false;

  const words = prefix.trim().split(/\s+/);
  // `Vol 2` — the prefix is nothing but the volume word, so the whole segment
  // is a label with no series name at all.
  if (words.length === 1 && VOLUME_WORD.test(words[0]!)) return true;
  // `Rise of the King pt 1` — a work divided into parts, not a series slot.
  if (words.length > 1 && VOLUME_WORD.test(words[words.length - 1]!)) return false;
  return true;
}

/**
 * Decompose a filename-derived title into its parts.
 *
 * `knownAuthor` should be the book's catalogued author when one exists; it
 * raises confidence and prevents the author segment being mistaken for the
 * title.
 */
export function parseTitle(rawTitle: string, knownAuthor?: string | null): TitleParse {
  const original = rawTitle ?? '';
  const cleaned = tidy(stripEditionMarkers(original));

  const empty: TitleParse = {
    original,
    normalizedTitle: cleaned,
    candidateTitles: cleaned ? [cleaned] : [],
    author: null,
    year: null,
    ordinal: null,
    series: null,
    seriesSequence: null,
    confidence: 'low',
  };
  if (!cleaned) return empty;

  const rawSegments = splitSegments(cleaned).map(tidy).filter(Boolean);
  if (rawSegments.length === 0) return empty;

  // A lone 4-digit segment is the title, not a year: the book `1984` was
  // otherwise parsed as publishedYear 1984 (it was published in 1949).
  const multiSegment = rawSegments.length > 1;

  let ordinal: number | null = null;
  let year: number | null = null;
  const remaining: string[] = [];
  /**
   * Set when the ordinal was stripped from *inside* a segment that still had
   * text (`3 Past Midnight` → `Past Midnight`), as opposed to a standalone
   * number (`24 - …`). That shape means "item N of <collection> - <work>", so
   * the remainder is a collection name and the real title is a later segment.
   * Ranking it first matched *Four Past Midnight* (357 indexed names) instead
   * of *The Library Policeman* — precisely the cross-work contamination this
   * pipeline exists to avoid.
   */
  let collectionRemainder: string | null = null;
  let series: string | null = null;
  let seriesSequence: number | null = null;
  /** See the note where this is set — blocks a confident single-candidate parse. */
  let soleSegmentYearStripped = false;

  rawSegments.forEach((segment, index) => {
    // `<Series> <NN> - <Title>`. Only on the leading segment, and only when a
    // later segment can carry the real title — otherwise `Wool 12` would lose
    // its own name to a series that does not exist.
    if (index === 0 && multiSegment && series === null) {
      const parsed = splitSeriesSequence(segment);
      if (parsed) {
        series = parsed.series;
        seriesSequence = parsed.sequence;
        return;
      }
    }

    // A standalone 4-digit number is a year when plausible, otherwise an
    // ordinal if it leads.
    if (/^\d+$/.test(segment)) {
      if (multiSegment && isYearToken(segment)) {
        if (year === null) year = Number(segment);
        return;
      }
      if (index === 0 && ordinal === null) {
        ordinal = Number(segment);
        return;
      }
    }

    let text = segment;
    if (index === 0) {
      const split = splitLeadingOrdinal(segment);
      if (split.ordinal !== null) {
        ordinal = split.ordinal;
        text = tidy(split.rest);
        if (text) collectionRemainder = text;
      }
    }

    // A trailing year glued to the last segment ("… - 1992" already handled,
    // but "Title 1992" appears too).
    const trailingYear = text.match(/^(.*\S)\s+(\d{4})$/);
    if (trailingYear && isYearToken(trailingYear[2]) && year === null) {
      year = Number(trailingYear[2]);
      text = tidy(trailingYear[1]);
      // With no sibling segment to corroborate it, a trailing 4-digit number
      // is genuinely ambiguous: `Space 1969` loses half its name this way,
      // while `Snow Crash 1992` is correctly cleaned. The parser cannot tell
      // them apart, so it declines to be confident and lets the review table
      // decide rather than pushing a guess to ABS.
      if (rawSegments.length === 1) soleSegmentYearStripped = true;
    }

    if (text) remaining.push(text);
  });

  // The author segment, when we can prove which one it is.
  let author: string | null = null;
  let authorConfirmed = false;
  const authorKey = knownAuthor ? nameKey(knownAuthor) : '';
  const titleSegments: string[] = [];
  for (const segment of remaining) {
    if (authorKey && !author && nameKey(segment) === authorKey) {
      author = segment;
      authorConfirmed = true;
      continue;
    }
    titleSegments.push(segment);
  }

  /**
   * Positional author inference, for the books this feature exists to help.
   *
   * When the catalogue has no author, matching against `knownAuthor` can never
   * fire, so an author sitting in the title was previously discarded — meaning
   * a full-library run recovered zero authors, the opposite of the intent.
   *
   * Inferring is only safe where the shape is unambiguous. Requiring a year
   * segment pins the `<ordinal> - <title> - <author> - <year>` convention, and
   * excluding an inline-ordinal remainder keeps
   * `3 Past Midnight - The Library Policeman` (no year, collection prefix)
   * from having "Past Midnight" mistaken for an author. Confidence stays
   * `low`, so the dry-run review table is the human gate before any write.
   */
  let authorInferred = false;
  if (!authorConfirmed && year !== null && !collectionRemainder && titleSegments.length === 2) {
    author = titleSegments.pop() ?? null;
    authorInferred = author !== null;
  }

  // Everything was consumed (e.g. the title was only an ordinal) — keep the
  // cleaned original rather than returning nothing.
  let candidates = titleSegments.length > 0 ? titleSegments : [cleaned];

  // Demote a collection remainder below the sibling segments (see the
  // `collectionRemainder` note above). Only when a sibling exists to prefer.
  if (collectionRemainder && candidates.length > 1) {
    const others = candidates.filter((c) => c !== collectionRemainder);
    if (others.length > 0) candidates = [...others, collectionRemainder];
  }

  /**
   * Demote series/volume labels below segments that name a work.
   *
   * `Martha Wells - The Murderbot Diaries 07 - System Collapse` confirms the
   * author, removes that segment, and then took the FIRST of what remained —
   * "The Murderbot Diaries 07". Because `authorConfirmed` forces `high`, the
   * wrong title skipped the review gate entirely and was pushed to ABS as the
   * book's name. Five real books were caught mid-push this way; the same shape
   * turned *Dragons of Autumn Twilight* into "Chronicles 01".
   *
   * Reorder rather than discard: the label is still a legitimate lookup
   * candidate, and `candidateTitles` feeds a provider that verifies matches.
   * A stable partition, so relative order inside each group survives.
   */
  if (candidates.length > 1) {
    const works = candidates.filter((c) => !looksLikeSeriesLabel(c));
    const labels = candidates.filter((c) => looksLikeSeriesLabel(c));
    if (works.length > 0 && labels.length > 0) candidates = [...works, ...labels];
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    // titleKey, not nameKey — word order matters in a title.
    const key = titleKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  // Confident when the author was *confirmed* against the catalogue, or when
  // no ambiguity remains about which segment is the title. A positionally
  // inferred author is explicitly not enough — it stays `low` so a human sees
  // it in the review table before it is written.
  const confidence: 'high' | 'low' =
    !soleSegmentYearStripped && (authorConfirmed || (deduped.length === 1 && !authorInferred))
      ? 'high'
      : 'low';

  return {
    original,
    normalizedTitle: deduped[0] ?? cleaned,
    candidateTitles: deduped.length > 0 ? deduped : [cleaned],
    author,
    year,
    ordinal,
    series,
    seriesSequence,
    confidence,
  };
}
