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

/** Compare names ignoring case, punctuation, and spacing. */
function nameKey(value: string): string {
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

  rawSegments.forEach((segment, index) => {
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

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = nameKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  // Confident when the author was *confirmed* against the catalogue, or when
  // no ambiguity remains about which segment is the title. A positionally
  // inferred author is explicitly not enough — it stays `low` so a human sees
  // it in the review table before it is written.
  const confidence: 'high' | 'low' =
    authorConfirmed || (deduped.length === 1 && !authorInferred) ? 'high' : 'low';

  return {
    original,
    normalizedTitle: deduped[0] ?? cleaned,
    candidateTitles: deduped.length > 0 ? deduped : [cleaned],
    author,
    year,
    ordinal,
    confidence,
  };
}
