import { createHash } from 'node:crypto';

/**
 * Generate a deterministic, opaque candidate ID retaining source identity
 * and source-native ID when present, with a stable fallback to normalized title/author.
 */
export function generateCandidateId(
  source: string,
  sourceItemId?: string | null,
  title?: string,
  author?: string
): string {
  const normSource = (source || 'unknown').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
  const rawKey = sourceItemId && sourceItemId.trim().length > 0
    ? sourceItemId.trim()
    : `${(title ?? '').trim().toLowerCase()}::${(author ?? '').trim().toLowerCase()}`;
  const hash = createHash('sha256').update(`${normSource}:${rawKey}`).digest('hex').slice(0, 16);
  return `cand_${normSource}_${hash}`;
}
