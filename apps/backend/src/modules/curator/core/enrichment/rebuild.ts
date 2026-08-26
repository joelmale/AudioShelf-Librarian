/**
 * Rebuilding a book's grounded-entity allowlist from its cached
 * `external_metadata` rows.
 *
 * Extracted from `enricher.ts` so `rederive.ts` can use it without importing
 * the runner (and, more importantly, without a second copy — this codebase
 * has already paid for byte-identical copies of matching logic drifting
 * apart; see the note on `normalizeForMatching` in
 * `providers/openLibrary.ts`).
 *
 * Reads only from the cache and never fetches, which is what lets a re-derive
 * run recompute notability for the whole library at zero network cost.
 */
import { scoreNotability } from './entityNotability.js';
import type { CuratorDb } from '../db.js';
import type { EnrichedEntity, EnrichmentPayload, EntityKind } from './types.js';

const VALID_KINDS: ReadonlySet<EntityKind> = new Set(['person', 'place', 'time']);

export function isEnrichmentPayload(value: unknown): value is EnrichmentPayload {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as { entities?: unknown }).entities);
}

/**
 * Rebuild a book's grounded-entity allowlist from every cached 'ok'
 * `external_metadata` row (not just the providers fetched this run).
 * Defensive against malformed/legacy stored payloads: rows whose payload
 * isn't a well-shaped `EnrichmentPayload` (or lacks an `entities` array) are
 * skipped rather than throwing.
 *
 * Also scores and persists `notable` (see `entityNotability.ts`) for every
 * entity in the rebuilt set. `libraryFrequency`/`librarySize` are computed
 * ONCE per run (by the caller, from `book_entities` as it stood before this
 * run's rebuilds) rather than per book — recomputing per book would make a
 * book's notability depend on how far the concurrent pool has gotten through
 * the rest of the library, which is nondeterministic under `p-limit`.
 *
 * Because this reads only from the cache and never fetches, a plain
 * enrichment re-run (no due providers, nothing to look up) still recomputes
 * `notable` for every book from its already-cached payloads — so a change to
 * the scoring rules (or the constants in entityNotability.ts) fixes the
 * whole library's notability flags for zero network cost.
 */
export function rebuildBookEntities(
  db: CuratorDb,
  bookId: string,
  description: string | null,
  libraryFrequency: Map<string, number>,
  librarySize: number
): number {
  const okRows = db.getExternalMetadata(bookId).filter((row) => row.status === 'ok');

  const merged = new Map<string, { entity: string; kind: EntityKind; sources: Set<string> }>();
  for (const row of okRows) {
    if (!isEnrichmentPayload(row.payload)) continue;
    for (const candidate of row.payload.entities as EnrichedEntity[]) {
      const entity = candidate?.entity?.trim();
      if (!entity || !VALID_KINDS.has(candidate.kind)) continue;
      const key = `${candidate.kind}:${entity.toLowerCase()}`;
      const existing = merged.get(key);
      if (existing) {
        existing.sources.add(row.provider);
      } else {
        merged.set(key, { entity, kind: candidate.kind, sources: new Set([row.provider]) });
      }
    }
  }

  const candidates = [...merged.values()].map((v) => ({
    entity: v.entity,
    kind: v.kind,
    sources: [...v.sources].sort(),
  }));

  const scored = scoreNotability({ entities: candidates, description, libraryFrequency, librarySize });
  const notableByKey = new Map(scored.map((s) => [`${s.kind}:${s.entity.toLowerCase()}`, s.notable]));
  const entities = candidates.map((c) => ({
    ...c,
    notable: notableByKey.get(`${c.kind}:${c.entity.toLowerCase()}`) ?? true,
  }));

  db.replaceBookEntities(bookId, entities);
  return entities.length;
}

