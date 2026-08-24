import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards the /api/librarian prefix.
 *
 * The librarian router mounts at `/api/librarian` (apps/backend/src/index.ts:
 * `api.use("/librarian", createLibrarianRouter(...))`), so every route it
 * defines is reachable only under that prefix. Five callers in api.ts omitted
 * it and requested e.g. `/api/health/library`, which does not match any route,
 * falls through to the SPA static handler, and returns index.html with a 200.
 * `await res.json()` then dies on `Unexpected token '<'`.
 *
 * Nothing else catches this. TypeScript sees a valid string, the request
 * "succeeds" with a 200, and the only symptom is a component rendering its
 * empty state — which is exactly how the Desk health panel sat broken while
 * looking merely unhealthy.
 */
const source = readFileSync(resolve(__dirname, './api.ts'), 'utf8');

/** Route paths owned by the librarian router, from its own definitions. */
const LIBRARIAN_OWNED = [
  'health/library',
  'downloads/queue',
  'downloads/pipeline',
  'recently-added',
  'realign/scan',
  'realign/execute',
];

describe('api.ts route prefixes', () => {
  it.each(LIBRARIAN_OWNED)('requests %s under /librarian/', (path) => {
    // Every occurrence of the path must be preceded by /librarian.
    const bare = new RegExp(`'/${path.replace(/\//g, '\\/')}'`);
    expect(source, `'/${path}' is missing the /librarian prefix`).not.toMatch(bare);
    expect(source).toContain(`'/librarian/${path}'`);
  });

  it('keeps /health on the app root, which is genuinely not under /api', () => {
    // index.ts registers app.get("/health") outside the /api router, so this
    // one is a raw fetch rather than an http() call and must stay that way.
    expect(source).toContain(`health: () => fetch('/health')`);
  });
});
