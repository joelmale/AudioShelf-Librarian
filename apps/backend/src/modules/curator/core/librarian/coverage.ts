/**
 * Library-readiness disclosure attachment (readiness item D, part 3 — "the
 * librarian states materially low coverage in its answer", the §8.6 honesty
 * posture applied at library level).
 *
 * Extracted out of `mcp/tools/queryLibrary.ts`'s private `libraryCoverage`
 * helper so it has exactly one source. `query_library` and the librarian's
 * own `search_library` tool (readiness item I) both attach a coverage
 * disclosure to every retrieval result — D's guarantee is that a
 * disclosing result is single-sourced; two independent copies of this
 * function would let them drift apart silently, and a caveat that only
 * SOMETIMES appears on a low-coverage result is worse than none. Behavior is
 * unchanged from the original: same shape, same "omit entirely when
 * `disclosure === null`" rule.
 *
 * Takes a narrow dep interface rather than `mcp/services.ts`'s `McpServices`
 * on purpose — this module lives under `core/` and must not depend on the
 * MCP-facing service bundle (or, transitively, the MCP SDK types it drags
 * in). See `core/librarian/tools.ts`'s docblock for why that boundary
 * matters here specifically.
 */
import type { ReadinessDb } from '../readiness.js';
import { computeLibraryReadiness } from '../readiness.js';
import { TAG_SCHEMA_VERSION } from '../types.js';

export interface LibraryCoverageDeps {
  db: ReadinessDb;
  /** Same value as `Config.embeddingModel`. An empty string means the env
   *  var was set but blank, which must read as "no model configured"
   *  (Unknown), never as a confident 0% — see `computeLibraryReadiness`. */
  embeddingModel: string;
}

/**
 * Computes the current library-readiness snapshot and, when coverage is
 * materially low, returns it as a `libraryCoverage` field to spread onto a
 * retrieval result. Returns `{}` (nothing to spread) when coverage is
 * healthy enough that a caveat would be noise — a disclosure present on
 * every answer stops being read, which would defeat the feature.
 */
export function libraryCoverage(deps: LibraryCoverageDeps): { libraryCoverage: unknown } | Record<string, never> {
  const readiness = computeLibraryReadiness(deps.db, {
    schemaVersion: TAG_SCHEMA_VERSION,
    // Empty string means EMBEDDING_MODEL was set but blank; null makes the
    // embedded metric report Unknown instead of a confident 0% (invariant 5).
    embeddingModel: deps.embeddingModel || null,
  });
  if (readiness.disclosure === null) return {};
  return {
    libraryCoverage: {
      disclosure: readiness.disclosure,
      totalBooks: readiness.totalBooks,
      unmeasured: readiness.unmeasured,
      metrics: readiness.metrics.map((m) => ({
        key: m.key,
        // `null` means Unknown — the check could not succeed. Do NOT read it
        // as zero.
        pct: m.pct,
        covered: m.covered,
        unknown: m.unknown,
        // Covered-but-out-of-date. Distinct from `unknown` (we cannot tell)
        // and from uncovered (never done): these books have data that is
        // actively wrong. `null` means staleness itself is unknowable here.
        ...(m.stale !== undefined ? { stale: m.stale } : {}),
        total: m.total,
        status: m.status,
        ...(m.note ? { note: m.note } : {}),
      })),
    },
  };
}
