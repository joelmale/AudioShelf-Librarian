/**
 * Reject a recommendation reason that is about a different book.
 *
 * WHY THIS EXISTS. Plan §5.4 rule 4 preserves the model's reason sentence
 * verbatim, and the evidence allowlist in `recommendations.ts` guarantees the
 * book IDENTITY is real. Nothing checked the prose. Observed on the real
 * library on 2026-08-28, all in one answer:
 *
 *   - the card for `Florida Straits` opened "'Sunburn' is another novel…"
 *   - the card for `Sunburn` opened "'Tropical Depression' is a compelling…"
 *   - `The Bullet That Missed` by Richard Osman was described as
 *     "'The Bullet That Missed' from Stephen King"
 *
 * Every book was real and correctly retrieved; every sentence was about
 * something else. That is worse than no sentence, because a wrong-but-fluent
 * justification is exactly what makes a reader stop trusting the whole panel.
 *
 * ── The check is grounded in the retrieved set, never in world knowledge ────
 * Both rules below compare the reason against OTHER CANDIDATES FROM THIS
 * SEARCH. That keeps the test cheap, explainable, and free of any "does this
 * claim about the world hold" judgment the system is in no position to make:
 * a reason that quotes another retrieved book's title, or credits another
 * retrieved book's author while never naming this book's own, is wrong by
 * construction rather than by opinion.
 *
 * A rejected reason is REPLACED, not dropped — see `recommendations.ts`,
 * which substitutes the same matched-tag template the deterministic fallback
 * path uses. Showing a card with no explanation at all would trade one
 * failure for another.
 *
 * ── Deliberately conservative ──────────────────────────────────────────────
 * A reason mentioning a series name, a comparison ("if you liked X"), or a
 * title this search never returned is LEFT ALONE. False positives here are
 * not free: they replace a good human-sounding sentence with a mechanical
 * one. The rules only fire on a demonstrable mix-up inside the slate.
 */

/** Case/punctuation-insensitive comparison key. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

/**
 * Titles as an author might shorten them: `Sunburn: Key West, Book 03` is
 * quoted in prose as `Sunburn`, so the stored subtitle must not defeat the
 * match. Returns the full normalized title plus the part before the first
 * colon when that part is substantial enough to be distinctive.
 */
function titleKeys(title: string): string[] {
  const full = normalize(title);
  const keys = [full];
  const head = normalize(title.split(':')[0] ?? '');
  // Two characters is not a title, it is a coincidence waiting to happen.
  if (head.length > 3 && head !== full) keys.push(head);
  return keys;
}

/** Quoted spans in the reason: 'like this', "like this", or ‘like this’. */
function quotedPhrases(reason: string): string[] {
  const out: string[] = [];
  const patterns = [/‘([^’]{2,120})’/g, /“([^”]{2,120})”/g, /"([^"]{2,120})"/g, /'([^']{2,120})'/g];
  for (const pattern of patterns) {
    for (const match of reason.matchAll(pattern)) {
      const inner = match[1];
      if (inner) out.push(inner);
    }
  }
  return out;
}

export interface ReasonSubject {
  title: string;
  author: string | null;
}

/**
 * True when `reason` is demonstrably about a book other than `subject`.
 *
 * `others` is the rest of the retrieved slate. See the module docblock for
 * why the comparison is scoped to it.
 */
export function reasonIsAboutAnotherBook(
  reason: string,
  subject: ReasonSubject,
  others: readonly ReasonSubject[]
): boolean {
  const text = normalize(reason);
  if (text === '') return false;

  const ownTitleKeys = new Set(titleKeys(subject.title));
  const ownAuthor = subject.author ? normalize(subject.author) : null;

  // Rule A — the reason quotes a title belonging to a different candidate,
  // and never quotes this book's own. Quoting is the strong signal: prose
  // that puts another slate title in quotation marks is describing it.
  const quoted = quotedPhrases(reason).map(normalize).filter((phrase) => phrase !== '');
  if (quoted.length > 0) {
    const quotesOwn = quoted.some((phrase) => ownTitleKeys.has(phrase));
    if (!quotesOwn) {
      const otherTitleKeys = new Set(others.flatMap((other) => titleKeys(other.title)));
      for (const key of ownTitleKeys) otherTitleKeys.delete(key);
      if (quoted.some((phrase) => otherTitleKeys.has(phrase))) return true;
    }
  }

  // Rule B — the reason credits another candidate's author without ever
  // naming this book's. Two different authors in one sentence is normal
  // ("for readers of X"); naming only the wrong one is not.
  if (ownAuthor === null || !text.includes(ownAuthor)) {
    for (const other of others) {
      if (!other.author) continue;
      const otherAuthor = normalize(other.author);
      if (otherAuthor === '' || otherAuthor === ownAuthor) continue;
      if (text.includes(otherAuthor)) return true;
    }
  }

  return false;
}

/**
 * A plain reason built from the tags the ranker actually scored on. Used when
 * the model's own sentence is rejected, and by the deterministic fallback
 * path — one wording for both, so a substituted card never looks like a
 * different class of result.
 */
export function matchedTagReason(matchedTags: readonly string[]): string {
  const matched = matchedTags.slice(0, 4).join(', ');
  return matched
    ? `Ranked highly for this request on ${matched}.`
    : 'Ranked highly for this request by overall similarity.';
}
