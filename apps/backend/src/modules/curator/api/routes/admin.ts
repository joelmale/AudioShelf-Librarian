/**
 * Production endpoints: cost stats (6.2), ABS token test (6.6), and backup
 * export/import (6.7). Import is idempotent — re-importing does not duplicate.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Router } from 'express';

import { toErrorPayload } from '../../core/errors.js';
import type { GeneratedTag, TagSource } from '../../core/types.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

// Per-MTok pricing (USD) for the cost estimate. Tagging dominates and runs on
// Haiku; this is an estimate, not billing truth.
const HAIKU_IN = 1.0;
const HAIKU_OUT = 5.0;

function extractUsage(detail: unknown): { input: number; output: number } {
  if (detail && typeof detail === 'object' && 'tokensUsed' in detail) {
    const u = (detail as { tokensUsed?: { inputTokens?: number; outputTokens?: number } }).tokensUsed;
    if (u) return { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0 };
  }
  return { input: 0, output: 0 };
}

export function createAdminRouter(services: ApiServices): Router {
  const router = Router();
  const { db, absClient } = services;

  router.get(
    '/stats/cost',
    asyncHandler(async (_req, res) => {
      let input = 0;
      let output = 0;
      for (const log of db.allLogs()) {
        const u = extractUsage(log.detail);
        input += u.input;
        output += u.output;
      }
      const estimatedCostUsd = (input * HAIKU_IN + output * HAIKU_OUT) / 1_000_000;
      res.json({
        totalInputTokens: input,
        totalOutputTokens: output,
        estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
        note: 'Estimate based on Haiku pricing; tagging dominates token spend.',
      });
    })
  );

  router.get(
    '/settings/test-abs',
    asyncHandler(async (_req, res) => {
      const start = Date.now();
      try {
        const probe = await absClient.testConnection();
        res.json({ ok: probe.ok, libraryCount: probe.libraryCount, responseMs: Date.now() - start });
      } catch (err) {
        // Report the typed failure (e.g. ABS_AUTH for an expired token) without a 5xx.
        res.json({ ok: false, responseMs: Date.now() - start, ...toErrorPayload(err) });
      }
    })
  );

  /**
   * Download a consistent snapshot of curator.db.
   *
   * curator.db is the system of record for tags, entities, embeddings and
   * feedback (the ABS push is only a mirror), so this is the whole dataset —
   * useful for working the retrieval problem locally instead of against the
   * running instance. Secrets are NOT in here: they live in a separate
   * `secrets.json` outside the database.
   *
   * The download is produced with `VACUUM INTO` rather than by copying the
   * file, because a copy silently omits whatever is still in the WAL — which
   * on a live instance is routinely megabytes of the most recent writes. It
   * is written to the OS temp dir, not DATA_DIR, so a failed request cannot
   * leave a stray database beside the live one where the acceptance harness's
   * own guards would then have to reason about it.
   *
   * The filename deliberately contains "snapshot": `retrieval/
   * acceptanceSnapshot.ts` refuses any database whose basename does not, so
   * this file can be handed straight to `npm run acceptance:retrieval`.
   */
  router.get(
    '/database/snapshot',
    asyncHandler(async (_req, res) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'curator-snapshot-'));
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `curator-snapshot-${stamp}.db`;
      const filePath = path.join(dir, filename);
      let payload: Buffer;
      try {
        db.vacuumInto(filePath);
        // Read fully, then delete, then respond. Streaming the file straight
        // to the client and deleting afterwards leaks the temp copy on
        // Windows, where `rm` fails while the read stream still holds the
        // handle; the cleanup then throws after the response has already been
        // sent, so nothing surfaces and the file simply stays. At ~15-20 MB
        // for this library, buffering is the cheaper correctness.
        payload = await readFile(filePath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      res.setHeader('Content-Type', 'application/vnd.sqlite3');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(payload.length));
      res.end(payload);
    })
  );

  router.get(
    '/export/tags',
    asyncHandler(async (_req, res) => {
      res.setHeader('Content-Disposition', 'attachment; filename="curator-tags.json"');
      res.json(db.exportTags());
    })
  );

  router.get(
    '/export/collections',
    asyncHandler(async (_req, res) => {
      res.setHeader('Content-Disposition', 'attachment; filename="curator-collections.json"');
      res.json(db.exportCollections());
    })
  );

  router.post(
    '/import',
    asyncHandler(async (req, res) => {
      const body = (req.body as {
        tags?: { bookId: string; tags: Array<GeneratedTag & { source?: TagSource }> }[];
        collections?: { name: string; description: string | null; theme: string; bookIds: string[] }[];
      }) ?? {};
      const now = Date.now();
      let tagsImported = 0;
      let tagsSkipped = 0;
      let collectionsImported = 0;

      // Tags: replace-not-append keeps re-import idempotent; unknown books skipped.
      for (const entry of body.tags ?? []) {
        if (!db.getBook(entry.bookId)) {
          tagsSkipped += 1;
          continue;
        }
        // Older exports predate the `source` column; default to 'llm-open' so
        // re-importing a legacy backup stays idempotent.
        db.replaceBookTags(
          entry.bookId,
          entry.tags.map((t) => ({ ...t, source: t.source ?? 'llm-open' })),
          now
        );
        tagsImported += 1;
      }

      // Collections: match by name → update in place; else create. Idempotent.
      for (const c of body.collections ?? []) {
        const present = db.existingBookIds(c.bookIds);
        const validIds = c.bookIds.filter((id) => present.has(id));
        const existing = db.findCollectionsByName(c.name)[0];
        const id = existing
          ? (db.updateCollectionMeta(existing.id, { description: c.description }), existing.id)
          : db.insertCollection({ name: c.name, description: c.description, theme: c.theme, createdAt: now });
        db.setCollectionBooks(
          id,
          validIds.map((bookId, i) => ({ bookId, sortOrder: i }))
        );
        collectionsImported += 1;
      }

      res.json({ tagsImported, tagsSkipped, collectionsImported });
    })
  );

  return router;
}
