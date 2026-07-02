/**
 * Collection routes: generate (templates synchronously, custom via a cancellable
 * operation), preview, approve/reject, edit, reorder, push, delete, sync-check.
 * Imports only core + sibling api.
 */
import { Router } from 'express';

import {
  generateCustom,
  generateFromTemplate,
  pushCollection,
  TEMPLATES,
} from '../../core/collectionEngine.js';
import { NotFoundError, toAppError } from '../../core/errors.js';
import type { CollectionStatus, ConflictPolicy } from '../../core/types.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

const POLICIES: ConflictPolicy[] = ['skip', 'overwrite', 'rename'];
const STATUSES: CollectionStatus[] = ['proposed', 'approved', 'pushed', 'rejected'];

export function createCollectionsRouter(services: ApiServices): Router {
  const router = Router();
  const { db, absClient, llmClient, operations, logger } = services;

  function withBooks(collectionId: number) {
    const books = db
      .getCollectionBooksDetailed(collectionId)
      .map((b) => ({ ...b, tags: db.getTagsForBook(b.id) }));
    return books;
  }

  router.get(
    '/collections',
    asyncHandler(async (req, res) => {
      const status = STATUSES.find((s) => s === req.query.status);
      res.json(db.listCollections(status));
    })
  );

  router.get(
    '/collections/templates',
    asyncHandler(async (_req, res) => {
      res.json(TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, usesClaude: t.usesClaude })));
    })
  );

  router.post(
    '/collections/generate',
    asyncHandler(async (req, res) => {
      const body = (req.body as { templateIds?: string[]; customPrompt?: string }) ?? {};
      const created = [];
      for (const tid of body.templateIds ?? []) {
        if (tid === 'custom') continue;
        created.push(generateFromTemplate(db, tid, { logger }).collection);
      }

      let operationId: string | undefined;
      if (body.customPrompt && body.customPrompt.trim() !== '') {
        const controller = operations.create('generate');
        operationId = controller.id;
        void generateCustom(llmClient, db, body.customPrompt, { controller, logger })
          .then((r) =>
            controller.markCompleted({
              collectionId: r.collection.id,
              books: r.books.length,
              droppedBookIds: r.droppedBookIds ?? [],
            })
          )
          .catch((err: unknown) => {
            const e = toAppError(err);
            controller.markError({ code: e.code, message: e.message });
          });
      }

      res.status(operationId ? 202 : 200).json({ collections: created, operationId });
    })
  );

  router.post(
    '/collections/push-all',
    asyncHandler(async (req, res) => {
      const policy = POLICIES.find((p) => p === (req.body as { policy?: unknown })?.policy) ?? 'skip';
      const approved = db.listCollections('approved');
      const results = [];
      const errors = [];
      for (const col of approved) {
        try {
          results.push(await pushCollection(absClient, db, col.id, { policy, logger }));
        } catch (err) {
          const e = toAppError(err);
          errors.push({ collectionId: col.id, code: e.code, message: e.message });
        }
      }
      res.json({ results, errors });
    })
  );

  router.get(
    '/collections/:id',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(String(req.params.id), 10);
      const collection = db.getCollection(id);
      if (!collection) throw new NotFoundError(`No collection ${req.params.id}`);
      res.json({ ...collection, books: withBooks(id) });
    })
  );

  router.post(
    '/collections/:id/approve',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(String(req.params.id), 10);
      if (!db.getCollection(id)) throw new NotFoundError(`No collection ${req.params.id}`);
      db.updateCollectionStatus(id, 'approved');
      res.json(db.getCollection(id));
    })
  );

  router.post(
    '/collections/:id/reject',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(String(req.params.id), 10);
      if (!db.getCollection(id)) throw new NotFoundError(`No collection ${req.params.id}`);
      db.updateCollectionStatus(id, 'rejected');
      res.json(db.getCollection(id));
    })
  );

  router.patch(
    '/collections/:id',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(String(req.params.id), 10);
      if (!db.getCollection(id)) throw new NotFoundError(`No collection ${req.params.id}`);
      const body = (req.body as { name?: string; description?: string | null }) ?? {};
      const meta: { name?: string; description?: string | null } = {};
      if (typeof body.name === 'string') meta.name = body.name;
      if ('description' in body) meta.description = body.description ?? null;
      db.updateCollectionMeta(id, meta);
      res.json(db.getCollection(id));
    })
  );

  router.post(
    '/collections/:id/reorder',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(String(req.params.id), 10);
      if (!db.getCollection(id)) throw new NotFoundError(`No collection ${req.params.id}`);
      const bookIds = (req.body as { bookIds?: string[] })?.bookIds ?? [];
      db.updateCollectionBookOrder(
        id,
        bookIds.map((bookId, i) => ({ bookId, sortOrder: i }))
      );
      res.json({ ...db.getCollection(id), books: withBooks(id) });
    })
  );

  router.post(
    '/collections/:id/push',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(String(req.params.id), 10);
      const policy = POLICIES.find((p) => p === (req.body as { policy?: unknown })?.policy) ?? 'skip';
      const result = await pushCollection(absClient, db, id, { policy, logger });
      res.json(result);
    })
  );

  router.post(
    '/collections/:id/sync-abs',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(String(req.params.id), 10);
      const collection = db.getCollection(id);
      if (!collection) throw new NotFoundError(`No collection ${req.params.id}`);
      if (!collection.absCollectionId) {
        res.json({ inSync: false, reason: 'not pushed yet' });
        return;
      }
      const libraries = await absClient.getLibraries();
      const libraryId = libraries[0]?.id;
      if (!libraryId) {
        res.json({ inSync: false, reason: 'no ABS library' });
        return;
      }
      const remote = (await absClient.getCollections(libraryId)).find(
        (c) => c.id === collection.absCollectionId
      );
      res.json({
        inSync: Boolean(remote) && remote?.name === collection.name,
        reason: remote ? (remote.name === collection.name ? 'in sync' : 'name differs') : 'missing in ABS',
      });
    })
  );

  router.delete(
    '/collections/:id',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(String(req.params.id), 10);
      if (!db.getCollection(id)) throw new NotFoundError(`No collection ${req.params.id}`);
      db.deleteCollection(id);
      res.json({ deleted: id });
    })
  );

  return router;
}
