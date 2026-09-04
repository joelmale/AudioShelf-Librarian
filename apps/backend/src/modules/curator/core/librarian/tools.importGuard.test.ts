/**
 * Readiness item I — "the tool layer must never call `buildTagSummary`" —
 * proven as an IMPORT-GRAPH assertion, not a grep of today's call sites. A
 * grep only knows about code that exists right now; the next implementer who
 * adds a helper import without adding a call would sail straight past it.
 * This test walks the real, on-disk, TRANSITIVE relative-import closure of
 * every librarian retrieval entrypoint and asserts `buildTagSummary` (and its
 * home file, `core/collectionEngine.ts`) is unreachable from any of them —
 * so it keeps holding no matter how the tool layer grows, as long as nothing
 * re-opens a path to that file.
 *
 * GUARDED ENTRYPOINT SET — deliberately explicit, not "everything under
 * mcp/tools/" or "everything under core/librarian/":
 *
 *   - core/librarian/tools.ts        (this piece — the librarian retrieval
 *                                      tool registry, readiness item I)
 *   - mcp/tools/queryLibrary.ts       (the existing librarian retrieval tool
 *                                      exposed over MCP: query_library,
 *                                      get_book_tags, retag_book)
 *   - mcp/tools/librarian.ts          (adapter over the internal registry)
 *   - core/recommendations.ts         (Scout's retrieval-first engine)
 *   - api/routes/recommendations.ts   (Scout's HTTP entrypoint)
 *
 * `mcp/tools/generateCollections.ts` and `mcp/tools/pushCollections.ts` are
 * DELIBERATELY EXCLUDED, and must stay excluded — do not "fix" this by
 * widening the set to all of `mcp/tools/`. Both already import
 * `core/collectionEngine.ts` directly (for `generateFromTemplate`/
 * `generateCustom`/`TEMPLATES`/`pushCollection`), and that is legitimate:
 * they are collection-*authoring* tools (the human-curated collections
 * feature), not librarian *retrieval* tools. Readiness item I is about the
 * librarian's own tool loop never falling back to "serialize the whole
 * library into a prompt" when it means to retrieve incrementally — it says
 * nothing about the pre-existing collection-generation feature, which has
 * its own, different, one-shot-over-the-whole-library design. Including
 * those two files here would make this test fail against code the
 * requirement was never about.
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** apps/backend/src/modules/curator — used only to print short, readable
 *  paths in failure messages. */
const CURATOR_ROOT = path.resolve(THIS_DIR, '..', '..');

const GUARDED_ENTRYPOINTS = [
  path.join(THIS_DIR, 'tools.ts'),
  path.resolve(THIS_DIR, '..', '..', 'mcp', 'tools', 'queryLibrary.ts'),
  path.resolve(THIS_DIR, '..', '..', 'mcp', 'tools', 'librarian.ts'),
  path.resolve(THIS_DIR, '..', 'recommendations.ts'),
  path.resolve(THIS_DIR, '..', '..', 'api', 'routes', 'recommendations.ts'),
];

const COLLECTION_ENGINE = path.resolve(THIS_DIR, '..', 'collectionEngine.ts');

/** Print an absolute path as `core/librarian/tools.ts` etc. for messages. */
function short(absPath: string): string {
  return path.relative(CURATOR_ROOT, absPath).split(path.sep).join('/');
}

/**
 * Every `import`/`export ... from` (including `import type`) specifier
 * literally written at the start of a line in `filePath`, in source order.
 * Anchoring to the start of a line (allowing leading whitespace) is what
 * keeps this from matching prose in a docblock — e.g. services.ts's own
 * "`src/mcp/` imports ONLY from `src/core/`" sentence starts with `*`, not
 * `import`, so it is never a candidate.
 */
function extractImportSpecifiers(filePath: string): string[] {
  const text = fs.readFileSync(filePath, 'utf8');
  const specifiers: string[] = [];
  // `import ... from '...'` / `export ... from '...'` (covers `import type`,
  // `export type`, `export * from`, `export { x } from`, multi-line brace
  // lists — `[^;]` matches newlines too, so this spans a wrapped import).
  const fromRe = /^[ \t]*(?:import|export)\s+[^;]*?from\s*['"]([^'"]+)['"]/gm;
  // Bare side-effect import: `import '...'` (no `from`).
  const bareRe = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
  // Dynamic import: `import('...')`. Not used anywhere in this codebase
  // today as far as this closure goes, but a walker that misses it would be
  // exactly the "opaque failure" this test exists to avoid.
  const dynamicRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [fromRe, bareRe, dynamicRe]) {
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (spec) specifiers.push(spec);
    }
  }
  return specifiers;
}

/**
 * Resolve a relative import specifier from `fromFile` to an absolute path on
 * disk. This repo's source imports use `.js` extensions (ESM/NodeNext style)
 * that map to `.ts` files on disk, so `./x.js` → `./x.ts`, and a directory
 * specifier maps to `./x/index.ts`.
 *
 * Returns `null` only for a non-relative (bare package) specifier, which the
 * caller skips outright. A RELATIVE specifier that fails to resolve to a
 * real file THROWS rather than being skipped — silently dropping an
 * unresolvable relative import would be exactly the kind of walker bug that
 * makes the prohibition below pass vacuously.
 */
function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // bare package specifier — not followed
  const dir = path.dirname(fromFile);
  const withoutExt = specifier.replace(/\.(js|jsx|mjs|cjs)$/, '');
  const base = path.resolve(dir, withoutExt);
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `tools.importGuard.test.ts: could not resolve relative import "${specifier}" from ${short(fromFile)} ` +
      `(tried ${candidates.map(short).join(', ')}). Fix the resolver — do not skip it, that would make the ` +
      `import-guard test pass vacuously.`
  );
}

interface Closure {
  /** Every absolute file path reached from the entrypoint, entrypoint included. */
  files: Set<string>;
  /** file → the file that first imported it, for path reconstruction. Absent for the entrypoint itself. */
  importedFrom: Map<string, string>;
}

/** BFS over the transitive relative-import graph starting at `entry`. Guards
 *  cycles via the `files` visited-set; skips `*.test.ts` (never legitimately
 *  imported by production code, guarded against defensively per spec). */
function walkClosure(entry: string): Closure {
  const files = new Set<string>([entry]);
  const importedFrom = new Map<string, string>();
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const spec of extractImportSpecifiers(current)) {
      const resolved = resolveImport(current, spec);
      if (resolved === null) continue; // bare package specifier
      if (resolved.endsWith('.test.ts')) continue;
      if (files.has(resolved)) continue; // cycle guard / already-visited
      files.add(resolved);
      importedFrom.set(resolved, current);
      queue.push(resolved);
    }
  }
  return { files, importedFrom };
}

/** Reconstruct the entry→target import chain as an array of absolute paths. */
function chainTo(closure: Closure, entry: string, target: string): string[] {
  const chain = [target];
  let cur = target;
  while (cur !== entry) {
    const prev = closure.importedFrom.get(cur);
    if (prev === undefined) break; // should not happen if target is genuinely in the closure
    chain.push(prev);
    cur = prev;
  }
  chain.reverse();
  return chain;
}

function formatChain(chain: string[]): string {
  return chain.map(short).join(' → ');
}

/** Whole-word (not substring) occurrences of `buildTagSummary` in `filePath`. */
function mentionsBuildTagSummary(filePath: string): boolean {
  const text = fs.readFileSync(filePath, 'utf8');
  return /\bbuildTagSummary\b/.test(text);
}

describe('librarian tool layer — no path to buildTagSummary (readiness item I)', () => {
  for (const entry of GUARDED_ENTRYPOINTS) {
    describe(short(entry), () => {
      const closure = walkClosure(entry);

      it('never imports core/collectionEngine.ts, directly or transitively', () => {
        if (closure.files.has(COLLECTION_ENGINE)) {
          const chain = formatChain(chainTo(closure, entry, COLLECTION_ENGINE));
          expect.fail(
            `${short(entry)} has an import path to core/collectionEngine.ts, which readiness item I ` +
              `forbids for the librarian tool layer:\n  ${chain}`
          );
        }
        expect(closure.files.has(COLLECTION_ENGINE)).toBe(false);
      });

      it('never mentions the identifier buildTagSummary anywhere in its import closure', () => {
        const offender = [...closure.files].find(mentionsBuildTagSummary);
        if (offender !== undefined) {
          const chain =
            offender === entry ? short(entry) : formatChain(chainTo(closure, entry, offender));
          expect.fail(
            `buildTagSummary is referenced in ${short(offender)}, reachable from ${short(entry)}:\n  ${chain}`
          );
        }
        expect(offender).toBeUndefined();
      });
    });
  }

  /**
   * Self-check: proves the walker actually walks transitively, rather than
   * (say) only recording an entrypoint's direct imports — a walker with that
   * bug would make the two prohibition tests above pass VACUOUSLY, which is
   * exactly the class of bug decision #15 (docs/architecture/decisions.md)
   * warns about: "a test that filtered survivors through a hardcoded id
   * list... passed with the feature deleted."
   *
   * The edge asserted is real, found by reading the actual files rather than
   * assumed: `core/librarian/tools.ts` imports `core/librarian/coverage.ts`
   * directly, and `coverage.ts` imports `core/readiness.ts` directly — so
   * `core/readiness.ts` is reachable from `tools.ts` ONLY via that two-hop
   * path, never as a direct import of `tools.ts` itself.
   */
  it('self-check: the walker follows a real multi-hop chain (tools.ts → coverage.ts → readiness.ts)', () => {
    const entry = path.join(THIS_DIR, 'tools.ts');
    const readiness = path.resolve(THIS_DIR, '..', 'readiness.ts');
    const closure = walkClosure(entry);

    // The transitive closure DOES reach readiness.ts.
    expect(closure.files.has(readiness)).toBe(true);

    // But NOT as a direct import of the entrypoint — proving the walker did
    // more than record tools.ts's own top-level import list.
    const directSpecifiers = extractImportSpecifiers(entry)
      .map((s) => resolveImport(entry, s))
      .filter((p): p is string => p !== null);
    expect(directSpecifiers).not.toContain(readiness);

    const chain = chainTo(closure, entry, readiness);
    expect(formatChain(chain)).toBe('core/librarian/tools.ts → core/librarian/coverage.ts → core/readiness.ts');
    expect(chain.length).toBeGreaterThan(2); // i.e. genuinely multi-hop, not direct
  });
});
