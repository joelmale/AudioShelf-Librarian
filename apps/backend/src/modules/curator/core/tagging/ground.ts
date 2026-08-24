/**
 * Deterministic entity grounding (librarian engine plan §3, "Ground entities").
 *
 * `character`/`setting` candidates from the generous propose pass are
 * matched against a book's grounded allowlist (`book_entities`, populated by
 * enrichment — never by the tagger). A confident match repairs the tag to
 * the allowlist's canonical form and marks it `external:<sources>`. An
 * unmatched character is dropped whenever the book *has* a person allowlist
 * at all — that's the hallucination filter, since a wrong canonical name is
 * far more expensive to find and fix than a dropped tag. Only when the book
 * has NO person allowlist at all do we fall back to a weak substring check
 * against the description. Settings are more forgiving: a generic
 * unmatched setting (`coastal-town`) is a legitimate tag on its own, so it's
 * always kept as `llm-open` rather than dropped.
 *
 * The `allowlist` passed in here MUST be the full `book_entities` set for the
 * book, never `{ notableOnly: true }`. Notability (`enrichment/
 * entityNotability.ts`) exists purely to keep the *card* readable — it says
 * nothing about whether an entity is real, and a 697-entry concordance list
 * rejects a fabricated character exactly as reliably as a clean 5-entry cast
 * list. Narrowing this allowlist would quietly punch a hole in the
 * hallucination filter for every book with a large entity list. See
 * `./compose.ts`'s call site and `BookEntity`'s docblock in `../types.ts`.
 */
import { matchEntity, normalizeTokens } from '../enrichment/entityMatcher.js';
import type { EnrichedEntity } from '../enrichment/types.js';
import type { BookEntity, GeneratedTag, TagCategory } from '../types.js';
import { dedupeCanonicalTags, normalizeTagForm, type CanonicalTag } from './canonicalize.js';

function toEnrichedEntities(allowlist: BookEntity[]): EnrichedEntity[] {
  return allowlist.map((e) => ({ entity: e.entity, kind: e.kind }));
}

/** `external:<sorted, +-joined sources>` for the allowlist entry backing a match. */
function externalSource(allowlist: BookEntity[], entity: string, kind: BookEntity['kind']): `external:${string}` {
  const matched = allowlist.find((e) => e.entity === entity && e.kind === kind);
  const sources = matched ? [...matched.sources].sort() : [];
  return `external:${sources.join('+')}`;
}

function groundCharacter(
  tag: GeneratedTag,
  allowlist: BookEntity[],
  enriched: EnrichedEntity[],
  description: string | null,
): CanonicalTag | null {
  const match = matchEntity(tag.tag, enriched, ['person']);
  if (match) {
    return {
      tag: normalizeTagForm(match.entity),
      category: 'character',
      confidence: tag.confidence,
      source: externalSource(allowlist, match.entity, match.kind),
    };
  }

  const hasPersonAllowlist = allowlist.some((e) => e.kind === 'person');
  if (hasPersonAllowlist) {
    // Hallucination filter: the book has a real character allowlist and this
    // candidate isn't on it (even fuzzily) — drop rather than guess.
    return null;
  }

  // No allowlist at all for this book: fall back to a weak substring gate
  // against the description instead of blind trust.
  const spaceForm = normalizeTokens(tag.tag).join(' ');
  if (spaceForm !== '' && description !== null && description.toLowerCase().includes(spaceForm)) {
    return { tag: normalizeTagForm(tag.tag), category: 'character', confidence: tag.confidence, source: 'llm-open' };
  }
  return null;
}

function groundSetting(tag: GeneratedTag, allowlist: BookEntity[], enriched: EnrichedEntity[]): CanonicalTag {
  const match = matchEntity(tag.tag, enriched, ['place']);
  if (match) {
    return {
      tag: normalizeTagForm(match.entity),
      category: 'setting',
      confidence: tag.confidence,
      source: externalSource(allowlist, match.entity, match.kind),
    };
  }
  // Generic settings ("coastal-town") are legitimate on their own — never dropped.
  return { tag: normalizeTagForm(tag.tag), category: 'setting', confidence: tag.confidence, source: 'llm-open' };
}

/**
 * Ground character/setting candidates against a book's entity allowlist.
 * `tags` should already be filtered to `category === 'character' | 'setting'`
 * (see `./compose.ts`); any other category passed in is defensively kept as
 * `llm-open` in its normalized form.
 */
export function groundEntityTags(
  tags: GeneratedTag[],
  allowlist: BookEntity[],
  description: string | null,
): CanonicalTag[] {
  const enriched = toEnrichedEntities(allowlist);
  const out: CanonicalTag[] = [];

  for (const tag of tags) {
    if (tag.category === 'character') {
      const grounded = groundCharacter(tag, allowlist, enriched, description);
      if (grounded) out.push(grounded);
      continue;
    }
    if (tag.category === 'setting') {
      out.push(groundSetting(tag, allowlist, enriched));
      continue;
    }
    const fallbackCategory: TagCategory = tag.category;
    out.push({ tag: normalizeTagForm(tag.tag), category: fallbackCategory, confidence: tag.confidence, source: 'llm-open' });
  }

  return dedupeCanonicalTags(out);
}
