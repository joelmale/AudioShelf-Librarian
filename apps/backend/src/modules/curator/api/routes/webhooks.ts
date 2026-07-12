import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http.js';
import { handleWebhookEvent } from '../../core/webhookHandler.js';
import type { ApiServices } from '../services.js';
import { timingSafeEqual } from 'node:crypto';

const webhookSchema = z.object({
  event: z.string(),
  id: z.string().min(1).optional(),
}).passthrough();

export function createWebhooksRouter(services: ApiServices): Router {
  const RouterInstance = Router();

  RouterInstance.post(
    '/webhooks/abs',
    asyncHandler(async (req, res) => {
      if (process.env.WEBHOOK_ENABLED?.toLowerCase() !== 'true') return res.status(404).json({ error: 'Webhook disabled' });
      const expected = process.env.ABS_WEBHOOK_SECRET || '';
      const supplied = String(req.headers['x-audioshelf-webhook-secret'] || '');
      if (expected.length < 32 || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        return res.status(401).json({ error: 'Invalid webhook secret' });
      }
      const payload = webhookSchema.safeParse(req.body);
      
      if (!payload.success) {
        services.logger.warn('Invalid webhook payload received', {
          issues: payload.error.issues,
        });
        return res.status(400).json({ error: 'Invalid payload' });
      }

      const event = payload.data.event;
      const eventId=payload.data.id ?? String(req.headers['x-event-id']??'');
      if(!eventId)return res.status(400).json({error:'Webhook event id required'});
      if(!services.db.claimWebhookEvent(eventId))return res.status(200).json({success:true,deduplicated:true});

      await handleWebhookEvent(event, payload.data, {
        absClient: services.absClient,
        db: services.db,
        logger: services.logger,
      });

      res.status(200).json({ success: true });
    })
  );

  return RouterInstance;
}
