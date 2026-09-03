import type { TagCategory, VocabTerm } from '../types.js';
import type { CuratorDb } from '../db.js';
import { canonicalizeTags } from './canonicalize.js';
import {
  MAX_TERMS_PER_FACET_ROW,
  facetsForProvider,
  normalizeSubjectCandidate,
  surfaceFacetTerms,
} from '../enrichment/subjectFacets.js';

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

function compact(value: string): string {
  return normalized(value).replace(/-/g, '');
}

function singular(value: string): string {
  const parts = normalized(value).split('-');
  const last = parts.at(-1) ?? '';
  if (last.endsWith('ies') && last.length > 4) parts[parts.length - 1] = `${last.slice(0, -3)}y`;
  else if (/(?:sses|shes|ches|xes|zes)$/.test(last) && last.length > 4) parts[parts.length - 1] = last.slice(0, -2);
  else if (last.endsWith('s') && !last.endsWith('ss') && last.length > 3) parts[parts.length - 1] = last.slice(0, -1);
  return parts.join('-');
}

function editDistance(a: string, b: string): number {
  const distance = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) distance[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) distance[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      distance[i][j] = Math.min(
        distance[i - 1][j] + 1,
        distance[i][j - 1] + 1,
        distance[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        distance[i][j] = Math.min(distance[i][j], distance[i - 2][j - 2] + 1);
      }
    }
  }
  return distance[a.length][b.length];
}

/** Conservative, deterministic suggestions only; a person still confirms an alias. */
export function suggestVocabAliases(term: string, category: TagCategory, vocabulary: VocabTerm[]): string[] {
  const source = normalized(term);
  const candidates = vocabulary
    .filter((candidate) => candidate.category === category && ['seed', 'promoted'].includes(candidate.status))
    .map((candidate) => {
      const target = normalized(candidate.term);
      let score: number | null = null;
      if (source !== target && compact(source) === compact(target)) score = 0;
      else if (source !== target && singular(source) === singular(target)) score = 1;
      else if (
        source.length >= 5 &&
        target.length >= 5 &&
        Math.abs(source.length - target.length) <= 1 &&
        source[0] === target[0] &&
        editDistance(source, target) === 1
      ) score = 2;
      return score === null ? null : { term: candidate.term, score };
    })
    .filter((candidate): candidate is { term: string; score: number } => candidate !== null)
    .sort((a, b) => a.score - b.score || a.term.localeCompare(b.term));
  return [...new Set(candidates.map((candidate) => candidate.term))].slice(0, 3);
}

/** Terms present in more than one live category require individual review. */
export function categoryCollisionTerms(vocabulary: VocabTerm[]): Set<string> {
  const categories = new Map<string, Set<TagCategory>>();
  for (const row of vocabulary) {
    if (row.status === 'rejected') continue;
    const set = categories.get(row.term) ?? new Set<TagCategory>();
    set.add(row.category);
    categories.set(row.term, set);
  }
  return new Set([...categories].filter(([, set]) => set.size > 1).map(([term]) => term));
}

/** Reconstruct the book evidence for one provider-cache proposal without
 * writing tags or refreshing provider data. Mirrors promoteSubjects' routing,
 * stoplist-before-cap ordering, and canonicalization. */
export function enrichmentProposalBookIds(db: CuratorDb, term: string, category: TagCategory): string[] {
  const bookIds = new Set<string>();
  for (const row of db.getExternalMetadataForActiveBooks()) {
    if (row.status !== 'ok' || !row.payload || typeof row.payload !== 'object') continue;
    for (const facet of facetsForProvider(row.provider)) {
      if (facet.category !== category) continue;
      const survivors: string[] = [];
      const seen = new Set<string>();
      for (const segment of surfaceFacetTerms(facet.extract(row.payload as Record<string, unknown>))) {
        const candidate = normalizeSubjectCandidate(segment);
        if (candidate === null || seen.has(candidate)) continue;
        seen.add(candidate);
        survivors.push(candidate);
      }
      for (const candidate of survivors.slice(0, MAX_TERMS_PER_FACET_ROW)) {
        const [canonical] = canonicalizeTags([{ tag: candidate, category, confidence: 1 }], db);
        if (canonical?.tag === term && canonical.source === 'llm-open') bookIds.add(row.bookId);
      }
    }
  }
  return [...bookIds];
}
