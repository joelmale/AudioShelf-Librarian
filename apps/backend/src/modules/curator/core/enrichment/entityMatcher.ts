/**
 * Deterministic entity matcher (librarian engine plan §3, "Ground entities").
 *
 * The generous llama pass proposes character/place tags in whatever surface
 * form it feels like — misspelled, kebab-cased, camelCased, first-name-only.
 * This module repairs those candidates against a book's *grounded* allowlist
 * (entities pulled from an external provider like Open Library) or rejects
 * them outright. It is deliberately conservative: a wrong canonical name
 * poisons the tag graph (wrong character forever attached to the book, wrong
 * facet counts, wrong search results) in a way that is far more expensive to
 * find and fix than simply dropping an unverified tag. So whenever more than
 * one allowlist entry could plausibly be what the LLM meant, we refuse to
 * guess and return `null` — silence is recoverable, a false canonical name
 * usually isn't.
 *
 * Example: the LLM proposes `"Ben Hannigan"` for Stephen King's *IT*. The
 * real allowlist has `"Benjamin Hanscom"` (kid nicknamed Ben) and, in this
 * book, no other character whose first name repairs to "ben" *and* whose
 * surname shares a 3+ character prefix with "hannigan". Exactly one entry
 * qualifies, so we repair to the canonical `"Benjamin Hanscom"`. Had the
 * allowlist also contained e.g. a "Benjamin Hanlon", both entries would pass
 * the repair rules and we would return `null` instead of picking one.
 */
import type { EntityKind, EnrichedEntity } from './types.js';

export interface EntityMatch {
  entity: string;
  kind: EntityKind;
  exact: boolean;
}

const ALL_KINDS: EntityKind[] = ['person', 'place', 'time'];

/**
 * Normalize a raw candidate/allowlist string into comparable tokens.
 *
 * camelCase/PascalCase input is split on lower->upper boundaries *before*
 * lowercasing (so `"BenHannigan"` becomes tokens `["ben", "hannigan"]`, not
 * one fused token). After that, the string is lowercased and every run of
 * non-alphanumeric characters (spaces, hyphens, punctuation) collapses to a
 * single separator before splitting into tokens.
 */
export function normalizeTokens(input: string): string[] {
  const camelSplit = input.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const lowered = camelSplit.toLowerCase();
  const spaced = lowered.replace(/[^a-z0-9]+/g, ' ').trim();
  if (spaced === '') return [];
  return spaced.split(' ');
}

/** Equal, or one token is a >=3-char prefix of the other. */
function tokenEq(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 3 && longer.startsWith(shorter);
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** tokenEq, OR the two tokens share a common prefix of >=3 characters. */
function surnameFuzzy(a: string, b: string): boolean {
  return tokenEq(a, b) || commonPrefixLength(a, b) >= 3;
}

/**
 * Match an LLM-proposed entity candidate against a book's grounded
 * allowlist. Returns the canonical allowlist entry (exact or repaired), or
 * `null` when nothing matches unambiguously.
 *
 * `kinds` restricts which allowlist entries are eligible to match (default:
 * all kinds).
 */
export function matchEntity(
  candidate: string,
  allowlist: EnrichedEntity[],
  kinds?: EntityKind[],
): EntityMatch | null {
  const permittedKinds = kinds ?? ALL_KINDS;
  const pool = allowlist.filter((entry) => permittedKinds.includes(entry.kind));

  const candidateTokens = normalizeTokens(candidate);
  if (candidateTokens.length === 0) return null;

  const poolNorm = pool.map((entry) => ({ entry, tokens: normalizeTokens(entry.entity) }));

  // 1. Exact: normalized token sequences match verbatim.
  const candidateJoined = candidateTokens.join(' ');
  for (const { entry, tokens } of poolNorm) {
    if (tokens.join(' ') === candidateJoined) {
      return { entity: entry.entity, kind: entry.kind, exact: true };
    }
  }

  // 2. Repair: only for multi-token candidates against multi-token entries.
  if (candidateTokens.length < 2) return null;

  const firstCandidate = candidateTokens[0];
  const lastCandidate = candidateTokens[candidateTokens.length - 1];

  const repairMatches = poolNorm.filter(({ tokens }) => {
    if (tokens.length < 2) return false;
    const firstEntry = tokens[0];
    const lastEntry = tokens[tokens.length - 1];
    return tokenEq(firstCandidate, firstEntry) && surnameFuzzy(lastCandidate, lastEntry);
  });

  // Uniqueness rule: a wrong canonical name is worse than an unverified tag,
  // so any ambiguity (zero or multiple candidates) means we drop, not guess.
  if (repairMatches.length !== 1) return null;

  const { entry } = repairMatches[0];
  return { entity: entry.entity, kind: entry.kind, exact: false };
}
