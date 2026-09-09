import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';
import { RevisionConflictError } from '../../core/errors.js';
import type { IntentType } from '../../core/types.js';

const SetIntentSchema = z.object({
  candidateId: z.string().trim().min(1),
  intent: z.enum(['want', 'later', 'pass']),
  expectedRevision: z.number().int().nonnegative().optional(),
  requestId: z.string().trim().min(1).optional(),
  notes: z.string().optional(),
  candidate: z
    .object({
      title: z.string().trim().min(1),
      author: z.string().trim().min(1),
      source: z.string().trim().min(1),
      sourceItemId: z.string().optional(),
      sourceUrl: z.string().optional(),
      coverUrl: z.string().optional(),
      description: z.string().optional(),
      narrator: z.string().optional(),
      rawMetadata: z.record(z.unknown()).optional(),
    })
    .optional(),
});

const UndoIntentSchema = z.object({
  candidateId: z.string().trim().min(1),
  requestId: z.string().trim().min(1).optional(),
});

export function createCandidatesRouter(services: ApiServices): Router {
  const router = Router();

  function getActor(req: Request): { actorId: string; isShared: boolean } {
    const subject = req.principal?.subject;
    if (subject && subject !== 'internal') {
      return { actorId: subject, isShared: false };
    }
    return { actorId: 'internal', isShared: true };
  }

  // Batch query intents for candidate IDs (or all active candidate intents for actor)
  router.get(
    '/candidates/intents',
    asyncHandler(async (req: Request, res: Response) => {
      const { actorId, isShared } = getActor(req);
      const rawIds = req.query.candidateIds;
      let candidateIds: string[] | undefined;
      if (typeof rawIds === 'string') {
        candidateIds = rawIds.split(',').map((s) => s.trim()).filter(Boolean);
      } else if (Array.isArray(rawIds)) {
        candidateIds = rawIds.map(String).map((s) => s.trim()).filter(Boolean);
      }

      const intents = services.db.getCandidateIntents(actorId, candidateIds);
      res.json({
        success: true,
        actor: actorId,
        isShared,
        intents,
      });
    })
  );

  // Set or update triage intent with revision tracking and duplicate requestId idempotency
  router.post(
    '/candidates/intent',
    asyncHandler(async (req: Request, res: Response) => {
      const { actorId, isShared } = getActor(req);
      const parsed = SetIntentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid intent payload', details: parsed.error.issues });
      }

      const { candidateId, intent, expectedRevision, requestId, notes, candidate } = parsed.data;

      try {
        const result = services.db.setCandidateIntent({
          actorId,
          candidateId,
          intent: intent as IntentType,
          expectedRevision,
          requestId,
          notes,
          candidateMetadata: candidate,
        });

        res.json({
          success: true,
          actor: actorId,
          isShared,
          intent: result.intent,
          changed: result.changed,
          duplicate: !result.changed,
        });
      } catch (err: unknown) {
        if (err instanceof RevisionConflictError) {
          return res.status(409).json({
            error: 'revision_conflict',
            message: err.message,
            code: 'CONFLICT',
            currentRevision: err.currentRevision,
            currentIntent: err.currentIntent,
          });
        }
        throw err;
      }
    })
  );

  // Reversible undo of triage mutation
  router.post(
    '/candidates/intent/undo',
    asyncHandler(async (req: Request, res: Response) => {
      const { actorId, isShared } = getActor(req);
      const parsed = UndoIntentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid undo payload', details: parsed.error.issues });
      }

      const { candidateId, requestId } = parsed.data;

      const result = services.db.undoCandidateIntent({
        actorId,
        candidateId,
        requestId,
      });

      res.json({
        success: true,
        actor: actorId,
        isShared,
        intent: result.intent,
        previousIntent: result.previousIntent,
        restoredIntent: result.intent?.intent ?? null,
        changed: result.changed,
      });
    })
  );

  // Retrieve saved candidates filtered by intent (want, later, pass)
  router.get(
    '/candidates/saved',
    asyncHandler(async (req: Request, res: Response) => {
      const { actorId, isShared } = getActor(req);
      const rawIntent = req.query.intent;
      const intent = rawIntent === 'want' || rawIntent === 'later' || rawIntent === 'pass'
        ? (rawIntent as IntentType)
        : undefined;

      const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
      const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);

      const items = services.db.listSavedCandidates(actorId, { intent, limit, offset });

      // Compute counts for tab headers
      const allIntents = services.db.getCandidateIntents(actorId);
      const values = Object.values(allIntents);
      const counts = {
        all: values.length,
        want: values.filter((i) => i.intent === 'want').length,
        later: values.filter((i) => i.intent === 'later').length,
        pass: values.filter((i) => i.intent === 'pass').length,
      };

      res.json({
        success: true,
        actor: actorId,
        isShared,
        items,
        counts,
        totals: counts,
      });
    })
  );

  // Retrieve source snapshots and status
  router.get(
    '/candidates/sources',
    asyncHandler(async (_req: Request, res: Response) => {
      const snapshots = services.db.getSourceSnapshots();
      const bySource: Record<string, unknown> = {};
      for (const s of snapshots) {
        bySource[s.source] = s;
      }
      res.json({
        success: true,
        sources: snapshots,
        bySource,
        ...bySource,
      });
    })
  );

  return router;
}
