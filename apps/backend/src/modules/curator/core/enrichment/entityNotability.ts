/**
 * Entity notability scoring (librarian engine plan, "book_entities serves two
 * masters" fix).
 *
 * `book_entities` is populated from providers' mention indexes, not cast
 * lists — Open Library's `person` facet in particular is a concordance: on
 * the user's real library, "It" carries 697 entries (`God`, `Jones`,
 * `Chopin`, `Amelia Earhart` alongside the actual cast), "The Library
 * Policeman" 130, while ordinary genre fiction sits at 3–8. The table has to
 * serve two callers with opposite needs:
 *   - validation (`tagging/ground.ts`, rejecting LLM-fabricated characters)
 *     wants every entity ever seen — high recall, nothing deleted;
 *   - presentation (the book card, entity display) wants only the real
 *     cast — high precision, or the concordance noise drowns the card's
 *     actual semantic signal (mood/setting lines).
 *
 * Rather than two tables, every entity is kept and this module decides which
 * ones are worth surfacing. Pure and dependency-free (no DB access) so it is
 * fully unit-testable; the DB-facing wiring lives in `enricher.ts`.
 *
 * ── Rules (each with its own reasoning) ───────────────────────────────────
 *  - **Small lists are trusted wholesale.** At or below {@link SMALL_LIST}
 *    (12) every entity is notable, unconditionally, cap included. Measured
 *    clean casts run 3–8 entities; a list that short is already a cast, not
 *    an index — scoring it would only risk dropping a real character who
 *    happens to score low (a one-off mononym, no description hit).
 *  - **+{@link DESCRIPTION_MATCH_SCORE} for a description mention.** A name
 *    that appears (case-insensitively) in the book's own description is
 *    almost always a protagonist — the strongest cheap signal available,
 *    since a synopsis has limited room and spends it on the leads.
 *  - **+{@link MULTI_TOKEN_SCORE} for a multi-token name — positive only,
 *    never a filter.** A two-plus-word name ("Benjamin Hanscom") is more
 *    often a real character than a single common word swept up by a
 *    concordance ("God", "Jones"). But this must never become a penalty for
 *    the inverse case: `Pennywise`, `Murderbot`, and `Portia` are legitimate
 *    one-word character names, so a mononym simply doesn't get the bonus —
 *    it isn't marked down for it.
 *  - **+{@link CORROBORATION_SCORE} for 2+ providers.** Independent sources
 *    agreeing on the same name is real (if weak) evidence it's a genuine
 *    entity rather than one provider's indexing quirk.
 *  - **{@link HIGH_FREQUENCY_PENALTY} for appearing on more than ~1% of the
 *    library (or {@link FREQUENCY_MIN_BOOKS}, whichever is larger).** This is
 *    the key discriminator: `God`, `Jones`, `Chopin` recur across dozens of
 *    unrelated books because they're common words/names a concordance
 *    catches, not because the library is full of crossover fiction. A real
 *    character is very rarely also a character (or a common noun) in
 *    unrelated books.
 *  - **Notable when the total score is >= {@link NOTABLE_THRESHOLD}.**
 *  - **Hard cap {@link MAX_NOTABLE} (20) per book**, highest score first,
 *    breaking ties on plain codepoint order of the entity string (never
 *    `localeCompare` — ICU collation isn't guaranteed stable across
 *    environments, and this feeds `book_entities`, a persisted table). A
 *    697-entry list can have far more than 20 entities that clear the
 *    threshold; the cap is what actually keeps the card readable.
 */
import type { EntityKind } from './types.js';

/** At or below this many entities, the whole list is trusted as a cast — see
 *  the module docblock. Exported so it can be tuned without touching logic. */
export const SMALL_LIST = 12;

/** Per-book ceiling on notable entities once a list is large enough to score. */
export const MAX_NOTABLE = 20;

/** Score threshold at/above which a scored entity is notable. */
export const NOTABLE_THRESHOLD = 2;

export const DESCRIPTION_MATCH_SCORE = 2;
export const MULTI_TOKEN_SCORE = 1;
export const CORROBORATION_SCORE = 1;
export const HIGH_FREQUENCY_PENALTY = -2;

/** The high-frequency penalty applies above max(librarySize * this ratio, {@link FREQUENCY_MIN_BOOKS}). */
export const FREQUENCY_RATIO = 0.01;
export const FREQUENCY_MIN_BOOKS = 5;

export interface NotabilityInput {
  entities: Array<{ entity: string; kind: EntityKind; sources: string[] }>;
  description: string | null;
  /** normalized entity -> how many distinct books in the library carry it */
  libraryFrequency: Map<string, number>;
  /** total active books, for scaling the frequency signal */
  librarySize: number;
}

export interface ScoredEntity {
  entity: string;
  kind: EntityKind;
  notable: boolean;
  score: number;
}

/** Plain codepoint comparator — see the module docblock for why not `localeCompare`. */
function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for "Benjamin Hanscom" (two tokens), false for "Pennywise" (one) — a
 *  positive-only signal, see the module docblock. */
function isMultiToken(entity: string): boolean {
  return entity.trim().split(/\s+/).filter(Boolean).length > 1;
}

function normalize(entity: string): string {
  return entity.trim().toLowerCase();
}

function scoreOne(
  entity: { entity: string; kind: EntityKind; sources: string[] },
  description: string | null,
  libraryFrequency: Map<string, number>,
  librarySize: number
): number {
  let score = 0;
  const normalized = normalize(entity.entity);

  if (normalized !== '' && description && description.toLowerCase().includes(normalized)) {
    score += DESCRIPTION_MATCH_SCORE;
  }
  if (isMultiToken(entity.entity)) {
    score += MULTI_TOKEN_SCORE;
  }
  if (entity.sources.length > 1) {
    score += CORROBORATION_SCORE;
  }

  const frequencyThreshold = Math.max(librarySize * FREQUENCY_RATIO, FREQUENCY_MIN_BOOKS);
  const frequency = libraryFrequency.get(normalized) ?? 0;
  if (frequency > frequencyThreshold) {
    score += HIGH_FREQUENCY_PENALTY;
  }

  return score;
}

/**
 * Score every entity in `input.entities` and flag the notable subset.
 *
 * Small lists (<= {@link SMALL_LIST}) are trusted wholesale: every entity is
 * notable regardless of score. Larger lists are scored per-entity, marked
 * notable at score >= {@link NOTABLE_THRESHOLD}, then capped at
 * {@link MAX_NOTABLE} — an entity that clears the threshold but loses the
 * cap's ranking still reports its real score, just with `notable: false`.
 */
export function scoreNotability(input: NotabilityInput): ScoredEntity[] {
  const scored = input.entities.map((e) => ({
    entity: e.entity,
    kind: e.kind,
    score: scoreOne(e, input.description, input.libraryFrequency, input.librarySize),
  }));

  if (input.entities.length <= SMALL_LIST) {
    return scored.map((s) => ({ ...s, notable: true }));
  }

  const ranked = scored
    .map((s, index) => ({ ...s, index }))
    .filter((s) => s.score >= NOTABLE_THRESHOLD)
    .sort((a, b) => b.score - a.score || compareCodepoint(a.entity, b.entity));

  const notableIndices = new Set(ranked.slice(0, MAX_NOTABLE).map((s) => s.index));

  return scored.map((s, index) => ({ ...s, notable: notableIndices.has(index) }));
}
